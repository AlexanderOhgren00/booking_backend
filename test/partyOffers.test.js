import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './routeHarness.js';

const slot = (changes = {}) => ({ year: 2026, month: 'October', day: 12,
  category: 'SCHOOL OF MAGIC', time: '11:00', available: true, offer: null,
  cost: 0, players: 0, ...changes });
const exact = { date: '2026-10-12', category: 'SCHOOL OF MAGIC', time: '11:00' };

test('party offer routes with isolated MongoDB', { skip: !process.env.MONGODB_TEST_URI }, async t => {
  await t.test('one date updates only selected free slots and preserves all booking data', async () => {
    const documents = [slot(), slot({ day: 19 }), slot({ year: 2027 }), slot({ time: '12:30' }),
      slot({ category: 'HAUNTED HOTEL' }), slot({ month: 'November' }),
      slot({ available: 'occupied', cost: 2370, paymentId: 'pending' }),
      slot({ available: false, cost: 1778, originalCost: 2370, discountCode: 'TEST', payed: 'Swish', paymentId: 'paid' })];
    const h = await createHarness({ bookings: documents });
    try {
      const before = await h.db.collection('bookings').find({}).toArray();
      const messages = [];
      let cacheCleared = false;
      h.context.wss.clients.add({ readyState: 1, send: message => messages.push(JSON.parse(message)) });
      h.context.clearBookingsCache = () => { cacheCleared = true; };
      const result = await h.request('patch', '/bulk-update-offers', { body: { updates: [exact], offerValue: 1500 } });
      assert.equal(result.statusCode, 200);
      assert.equal(result.body.totalModified, 1);
      const after = await h.db.collection('bookings').find({}).toArray();
      assert.deepEqual(after, before.map((doc, index) => index === 0 ? { ...doc, offer: 1500 } : doc));
      assert.equal(cacheCleared, true);
      assert.equal(messages[0].type, 'bulkOfferUpdate');
      const read = await h.request('get', '/bookings/:year/:month/:day', { params: { year: '2026', month: 'October', day: '12' } });
      assert.equal(read.statusCode, 200);
      assert.equal(read.body.find(doc => String(doc._id) === String(before[0]._id)).offer, 1500);
      const repeat = await h.request('patch', '/bulk-update-offers', { body: { updates: [exact], offerValue: 1500 } });
      assert.equal(repeat.body.totalModified, 0);
    } finally { await h.close(); }
  });

  await t.test('recurring month/weekday selection retains its existing multi-year scope', async () => {
    const year = new Date().getFullYear();
    const dates = [];
    for (let y = year; y <= 2030; y++) {
      for (let day = 1; day <= 31; day++) dates.push(slot({ year: y, day }));
    }
    const h = await createHarness({ bookings: dates });
    try {
      const response = await h.request('patch', '/bulk-update-offers', { body: {
        updates: [{ month: 'October', weekday: 1, category: exact.category, time: exact.time }], offerValue: 1200
      } });
      assert.equal(response.statusCode, 200);
      for (const booking of await h.db.collection('bookings').find({}).toArray()) {
        const monday = new Date(Date.UTC(booking.year, 9, booking.day)).getUTCDay() === 1;
        assert.equal(booking.offer, monday ? 1200 : null);
      }
    } finally { await h.close(); }
  });

  await t.test('invalid dates and malformed mixed requests fail before any writes', async () => {
    const h = await createHarness({ bookings: [slot()] });
    try {
      const before = await h.db.collection('bookings').find({}).toArray();
      for (const date of ['', null, '2026-02-29', '2026-04-31', '2026-13-12', '2026-10-00', '2026-10-12T00:00:00Z', '0000-01-01', {}]) {
        const response = await h.request('patch', '/bulk-update-offers', { body: {
          updates: [exact, { ...exact, date, month: 'October', weekday: 1 }], offerValue: 1500
        } });
        assert.equal(response.statusCode, 400, JSON.stringify(date));
      }
      for (const body of [{ updates: [], offerValue: 1500 }, { updates: [exact], offerValue: -1 },
        { updates: [exact], offerValue: 1.5 }, { updates: [exact], offerValue: '1500' },
        { updates: [null], offerValue: 1500 }, { updates: [{ ...exact, category: {} }], offerValue: 1500 },
        { updates: [{ time: exact.time, category: exact.category, month: 'wrong', weekday: 1 }], offerValue: 1500 }]) {
        assert.equal((await h.request('patch', '/bulk-update-offers', { body })).statusCode, 400);
      }
      assert.deepEqual(await h.db.collection('bookings').find({}).toArray(), before);
    } finally { await h.close(); }
  });

  await t.test('chunk processing uses the same exact-date and leap-day filters', async () => {
    const h = await createHarness({ bookings: [slot({ year: 2028, month: 'February', day: 29 }),
      slot({ year: 2028, month: 'February', day: 28 }), slot({ year: 2031, day: 12 })] });
    try {
      const result = await h.context.processOfferChunk([
        { ...exact, date: '2028-02-29' }, { ...exact, date: '2031-10-12' }
      ], 1500);
      assert.equal(result.modifiedCount, 2);
      const docs = await h.db.collection('bookings').find({}).toArray();
      assert.deepEqual(docs.map(doc => doc.offer), [1500, null, 1500]);
    } finally { await h.close(); }
  });

  await t.test('large recurring requests finish through background chunks', async () => {
    const year = new Date().getFullYear();
    const day = Array.from({ length: 31 }, (_, i) => i + 1).find(d => new Date(Date.UTC(year, 9, d)).getUTCDay() === 1);
    const h = await createHarness({ bookings: [slot({ year, day }), slot({ year, day: day + 1 })] });
    try {
      h.context.setTimeout = resolve => resolve();
      let finish;
      const complete = new Promise(resolve => { finish = resolve; });
      h.context.wss.clients.add({ readyState: 1, send: value => {
        const message = JSON.parse(value);
        if (message.type === 'bulkOfferComplete' || message.type === 'bulkOfferError') finish(message);
      } });
      const updates = Array.from({ length: 36 }, () => ({ month: 'October', weekday: 1, category: exact.category, time: exact.time }));
      const result = await h.request('patch', '/bulk-update-offers', { body: { updates, offerValue: 1500 } });
      assert.equal(result.body.status, 'processing');
      const message = await complete;
      assert.equal(message.type, 'bulkOfferComplete');
      assert.deepEqual((await h.db.collection('bookings').find({}).toArray()).map(doc => doc.offer), [1500, null]);
    } finally { await h.close(); }
  });
});
