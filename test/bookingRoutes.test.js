import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './routeHarness.js';

const campaign = { code: 'K85GN9YS2', key: 'K85GN9YS2', usageType: 'infinite', usedCount: 0, usedBy: ['payment-1'] };
const booking = (extra = {}) => ({
  year: 2026, month: 'October', day: 4, category: 'SCHOOL OF MAGIC', time: '11:00',
  timeSlotId: '2026-October-4-SCHOOL OF MAGIC-11:00', available: 'occupied',
  paymentId: 'payment-1', cost: 2370, players: 6, discount: 25,
  email: 'test@example.invalid', bookedBy: 'Test Customer', bookingRef: 'TEST01', ...extra
});
const swish = (id = 'payment-1', amount = '1778', status = 'PAID') => ({ id, amount, status, message: 'Test booking' });
const nets = (id = 'payment-1', amount = 177800) => ({ event: 'payment.checkout.completed', data: { paymentId: id, order: { amount: { amount }, reference: 'TEST01', orderItems: [] } } });
const state = (extra = {}) => ({ paymentId: 'payment-1', date: new Date(), discountCode: campaign.code, data: [booking()], ...extra });

test('production booking handlers with isolated MongoDB', { skip: !process.env.MONGODB_TEST_URI }, async t => {
  async function fixture(seed) {
    const h = await createHarness(seed);
    t.after(() => h.close());
    return h;
  }

  for (const [method, url, payload] of [['Swish', '/swish/callback', swish()], ['Nets Easy', '/eventCreated', nets()]]) {
    await t.test(`${method}: correct cost, audit, receipt, persistent campaign, duplicate callback`, async () => {
      const h = await fixture({ bookings: [booking()], discounts: [campaign], paymentStates: [state()] });
      const first = await h.request('post', url, { body: payload });
      assert.equal(first.statusCode, 200, JSON.stringify(h.errors));
      const paid = await h.db.collection('bookings').findOne({ paymentId: 'payment-1' });
      assert.equal(paid.cost, 1778);
      assert.equal(paid.originalCost, 2370);
      assert.equal(paid.discountCode, campaign.code);
      assert.equal(paid.payed, method);
      assert.equal(paid.available, false);
      const discount = await h.db.collection('discounts').findOne({ code: campaign.code });
      assert.deepEqual(discount.usedBy, []);
      assert.equal(discount.usedCount, 1);
      assert.equal(h.mail.length, 1);
      assert.match(h.mail[0].html, /SEK 2370/);
      assert.match(h.mail[0].html, /-SEK 592/);
      assert.match(h.mail[0].html, /SEK 1778/);
      const providerCount = h.provider.length;
      assert.equal((await h.request('post', url, { body: payload })).statusCode, 200);
      assert.equal(h.provider.length, providerCount, 'retry must not charge again');
      assert.equal(h.mail.length, 1);
      assert.equal((await h.db.collection('discounts').findOne({ code: campaign.code })).usedCount, 1);
      assert.equal(h.errors.length, 0);
    });

    await t.test(`${method}: multi-slot payment shares match provider and no per-slot floor`, async () => {
      const h = await fixture({
        bookings: [booking({ cost: 850 }), booking({ cost: 850, day: 5, timeSlotId: 'second-slot' })],
        discounts: [campaign], paymentStates: [state()]
      });
      const body = method === 'Swish' ? swish('payment-1', '850') : nets('payment-1', 85000);
      await h.request('post', url, { body });
      const paid = await h.db.collection('bookings').find({ paymentId: 'payment-1' }).toArray();
      assert.deepEqual(paid.map(b => b.cost), [425, 425]);
      assert.ok(paid.every(b => b.originalCost === 850 && b.discountCode === campaign.code));
    });

    await t.test(`${method}: ordinary and gift-card payments retain payment totals and balances`, async () => {
      const h = await fixture({
        bookings: [booking({ cost: 1185, players: 3, discount: 0, giftCardReference: 'TEST-GC' })],
        giftcards: [{ reference: 'TEST-GC', totalAmount: 500, payed: true }], paymentStates: [state({ discountCode: null })]
      });
      const body = method === 'Swish' ? swish('payment-1', '685') : nets('payment-1', 68500);
      await h.request('post', url, { body });
      assert.equal((await h.db.collection('giftcards').findOne({ reference: 'TEST-GC' })).totalAmount, 0);
      const paid = await h.db.collection('bookings').findOne({ paymentId: 'payment-1' });
      assert.equal(paid.cost, 685);
      assert.equal(paid.originalCost, 1185);
      assert.equal(paid.discountCode, null);
      await h.request('post', url, { body });
      assert.equal((await h.db.collection('giftcards').findOne({ reference: 'TEST-GC' })).totalAmount, 0);
    });

    await t.test(`${method}: legacy scalar discount holds and single-use codes`, async () => {
      const h = await fixture({ bookings: [booking()], discounts: [{ ...campaign, usageType: 'single_use', usedBy: 'payment-1' }] });
      await h.request('post', url, { body: payload });
      assert.equal((await h.db.collection('bookings').findOne({})).discountCode, campaign.code);
      const discount = await h.db.collection('discounts').findOne({});
      assert.equal(discount.isActive, false);
      assert.equal(discount.usedCount, 1);
      assert.deepEqual(discount.usedBy, []);
    });

    await t.test(`${method}: simultaneous duplicate callbacks process payment once`, async () => {
      const h = await fixture({ bookings: [booking()], discounts: [campaign], paymentStates: [state()] });
      await Promise.all([1, 2, 3].map(() => h.request('post', url, { body: payload })));
      assert.equal(h.mail.length, 1);
      assert.equal(h.provider.filter(([url]) => typeof url === 'string' && url.endsWith('/charges')).length, method === 'Swish' ? 0 : 1);
      assert.equal((await h.db.collection('discounts').findOne({})).usedCount, 1);
    });

    await t.test(`${method}: undiscounted payment stores unchanged cost and a null code`, async () => {
      const h = await fixture({ bookings: [booking({ discount: 0 })], paymentStates: [state({ discountCode: null })] });
      await h.request('post', url, { body: method === 'Swish' ? swish('payment-1', '2370') : nets('payment-1', 237000) });
      const paid = await h.db.collection('bookings').findOne({});
      assert.equal(paid.cost, 2370);
      assert.equal(paid.originalCost, 2370);
      assert.equal(paid.discountCode, null);
      assert.equal(h.mail.length, 1);
      assert.doesNotMatch(h.mail[0].html, /-SEK/);
    });
  }

  await t.test('concurrent shared campaign checkouts preserve both payment references', async () => {
    const a = booking();
    const b = booking({ day: 5, timeSlotId: '2026-October-5-SCHOOL OF MAGIC-11:00', paymentId: 'payment-2' });
    const h = await fixture({ bookings: [a, b], discounts: [{ ...campaign, usedBy: 'legacy-hold' }] });
    await Promise.all([a, b].map(item => h.request('post', '/v1/payments/:paymentId/initialize', {
      params: { paymentId: item.paymentId }, body: { discountApplied: campaign.code, combinedData: [item] }
    })));
    assert.deepEqual(new Set((await h.db.collection('discounts').findOne({})).usedBy), new Set(['legacy-hold', 'payment-1', 'payment-2']));
    await h.request('post', '/swish/callback', { body: swish() });
    assert.deepEqual(new Set((await h.db.collection('discounts').findOne({})).usedBy), new Set(['legacy-hold', 'payment-2']));
    await h.request('post', '/eventCreated', { body: nets('payment-2') });
    const discount = await h.db.collection('discounts').findOne({});
    assert.equal(discount.usedCount, 2);
    assert.deepEqual(discount.usedBy, ['legacy-hold']);
    assert.ok((await h.db.collection('bookings').find({}).toArray()).every(b => b.discountCode === campaign.code && b.cost === 1778));
    assert.equal(h.errors.length, 0);
  });

  for (const mode of ['admin cancel', 'admin refund', 'user cancel', 'declined', 'error', 'expired']) {
    await t.test(`${mode} clears all paid data and allows clean rebooking`, async () => {
      const isAdmin = mode.startsWith('admin');
      const h = await fixture({
        bookings: [booking({ available: isAdmin ? false : 'occupied', originalCost: 2370, discountCode: campaign.code, giftCardReference: 'TEST-GC' })],
        discounts: [campaign], paymentStates: [state({ date: new Date(Date.now() - 31 * 60000) })]
      });
      if (isAdmin) {
        await h.request('patch', '/checkout', { query: { fromAdmin: 'true', action: mode === 'admin cancel' ? 'cancel' : undefined }, body: {
          ...booking(), available: true, cost: 0, players: 0, payed: null, paymentId: null
        } });
      } else if (mode === 'user cancel') {
        await h.request('delete', '/v1/payments/:paymentId/cancel', { params: { paymentId: 'payment-1' } });
      } else if (mode === 'expired') {
        await h.intervals.find(fn => fn.name === 'cleanUpPaymentStates')();
      } else {
        await h.request('post', '/swish/callback', { body: swish('payment-1', '1778', mode.toUpperCase()) });
      }
      let freed = await h.db.collection('bookings').findOne({});
      for (const field of ['originalCost', 'discountCode', 'paymentId', 'giftCardReference', 'bookingRef']) assert.equal(freed[field], null, field);
      assert.equal(freed.cost, 0);
      assert.equal(freed.discount, 0);
      assert.equal(freed.available, true);
      if (!isAdmin) {
        const discount = await h.db.collection('discounts').findOne({});
        assert.equal(discount.usedCount, 0);
        assert.deepEqual(discount.usedBy, []);
      }
      const rebook = await h.request('patch', '/checkout', { body: { ...booking(), discount: 0, cost: 1185, players: 3, paymentId: 'next-customer' } });
      assert.equal(rebook.statusCode, 200);
      freed = await h.db.collection('bookings').findOne({});
      assert.equal(freed.originalCost, null);
      assert.equal(freed.discountCode, null);
      assert.equal(freed.cost, 1185);
    });
  }

  await t.test('ordinary admin edits preserve pricing audit and allow explicit price edits', async () => {
    const h = await fixture({ bookings: [booking({ available: false, cost: 1778, originalCost: 2370, discountCode: campaign.code, payed: 'Swish' })] });
    await h.request('patch', '/checkout', { query: { fromAdmin: 'true' }, body: { ...booking(), cost: 1700, available: false, info: 'New notes', players: 5 } });
    const edited = await h.db.collection('bookings').findOne({});
    assert.equal(edited.cost, 1700);
    assert.equal(edited.originalCost, 2370);
    assert.equal(edited.discountCode, campaign.code);
    assert.equal(edited.info, 'New notes');
  });

  await t.test('admin cancelling an unpaid campaign hold clears its percentage', async () => {
    const h = await fixture({ bookings: [booking()], paymentStates: [state()] });
    await h.request('patch', '/checkout', { query: { fromAdmin: 'true', action: 'cancel' }, body: {
      ...booking(), available: true, cost: 0, players: 0, payed: null
    } });
    const freed = await h.db.collection('bookings').findOne({});
    assert.equal(freed.discount, 0);
    assert.equal(freed.paymentId, null);
  });

  for (const route of ['/changeTime', '/bulkChangeTime']) {
    await t.test(`${route} keeps paid cost and campaign audit; rejects occupied target`, async () => {
      const h = await fixture({ bookings: [booking({ available: false, cost: 1778, originalCost: 2370, discountCode: campaign.code })] });
      const change = { year: 2026, month: 'October', day: 4, category: 'SCHOOL OF MAGIC', oldTime: '11:00', newTime: '12:30' };
      assert.equal((await h.request('patch', route, { body: route === '/changeTime' ? change : { updates: [change] } })).statusCode, 200);
      const moved = await h.db.collection('bookings').findOne({});
      assert.equal(moved.cost, 1778);
      assert.equal(moved.originalCost, 2370);
      assert.equal(moved.discountCode, campaign.code);
      assert.equal(moved.time, '12:30');
      await h.db.collection('bookings').insertOne(booking({ time: '14:00', timeSlotId: '2026-October-4-SCHOOL OF MAGIC-14:00' }));
      const conflict = { ...change, oldTime: '12:30', newTime: '14:00' };
      const result = await h.request('patch', route, { body: route === '/changeTime' ? conflict : { updates: [conflict] } });
      if (route === '/changeTime') assert.equal(result.statusCode, 400);
      else assert.equal(result.body.modifiedCount, 0);
      assert.equal((await h.db.collection('bookings').findOne({ time: '12:30' })).cost, 1778);
    });
  }

  await t.test('date move copies paid audit to destination and clears source', async () => {
    const paid = booking({ available: false, cost: 1778, originalCost: 2370, discountCode: campaign.code, payed: 'Swish' });
    const target = booking({ day: 5, timeSlotId: '2026-October-5-SCHOOL OF MAGIC-11:00', available: true, paymentId: null, cost: 0 });
    const h = await fixture({ bookings: [paid, target] });
    await h.request('patch', '/checkout', { query: { fromAdmin: 'true' }, body: { ...paid, day: 5, timeSlotId: target.timeSlotId } });
    await h.request('patch', '/checkout', { query: { fromAdmin: 'true' }, body: { ...paid, available: true, cost: 0, players: 0, payed: null } });
    const moved = await h.db.collection('bookings').findOne({ day: 5 });
    const source = await h.db.collection('bookings').findOne({ day: 4 });
    assert.equal(moved.cost, 1778);
    assert.equal(moved.originalCost, 2370);
    assert.equal(moved.discountCode, campaign.code);
    assert.equal(source.originalCost, null);
    assert.equal(source.discountCode, null);
    assert.equal(source.paymentId, null);
  });

  await t.test('restore from Senaste preserves supplied audit or clears stale fields', async () => {
    const h = await fixture({ bookings: [booking({ available: true, originalCost: 999, discountCode: 'OLD' })] });
    const body = { timeSlotId: booking().timeSlotId, bookingData: { ...booking(), payed: 'Swish', cost: 1778, originalCost: 2370, discountCode: campaign.code }, originalBookedAt: '2026-09-22 12:00:00' };
    assert.equal((await h.request('post', '/confirmBookingFromSenaste', { body })).statusCode, 200);
    let restored = await h.db.collection('bookings').findOne({});
    assert.equal(restored.cost, 1778);
    assert.equal(restored.originalCost, 2370);
    assert.equal(restored.discountCode, campaign.code);
    assert.equal(restored.bookedAt, body.originalBookedAt);
    await h.db.collection('bookings').updateOne({}, { $set: { available: true } });
    body.bookingData = booking();
    await h.request('post', '/confirmBookingFromSenaste', { body });
    restored = await h.db.collection('bookings').findOne({});
    assert.equal(restored.originalCost, null);
    assert.equal(restored.discountCode, null);
  });

  await t.test('late failed callback and user cancel cannot free a paid booking', async () => {
    const h = await fixture({ bookings: [booking({ available: false, payed: 'Swish', cost: 1778, originalCost: 2370, discountCode: campaign.code })] });
    await h.request('post', '/swish/callback', { body: swish('payment-1', '1778', 'ERROR') });
    assert.equal((await h.request('delete', '/v1/payments/:paymentId/cancel', { params: { paymentId: 'payment-1' } })).statusCode, 409);
    const paid = await h.db.collection('bookings').findOne({});
    assert.equal(paid.cost, 1778);
    assert.equal(paid.available, false);
  });

  await t.test('expired state never clears a slot now held by another payment', async () => {
    const h = await fixture({ bookings: [booking({ paymentId: 'new-owner' })], paymentStates: [state({ date: new Date(Date.now() - 31 * 60000) })] });
    await h.intervals.find(fn => fn.name === 'cleanUpPaymentStates')();
    const held = await h.db.collection('bookings').findOne({});
    assert.equal(held.paymentId, 'new-owner');
    assert.equal(held.available, 'occupied');
    assert.equal(held.cost, 2370);
  });

  await t.test('full gift-card checkout clears stale audit and retains gift-card balance behavior', async () => {
    const h = await fixture({
      bookings: [booking({ available: true, discountCode: 'OLD', originalCost: 999 })],
      giftcards: [{ reference: 'TEST-GC', totalAmount: 2000, payed: true }]
    });
    const data = booking();
    await h.request('post', '/confirm-with-giftcard', { body: {
      combinedData: [{ ...data, categoryName: data.category, time: { time: data.time, cost: 1185, players: 3 } }],
      giftCardReference: 'TEST-GC', totalCost: 1185, name: 'Test', number: '0700000000', email: 'test@example.invalid'
    } });
    const paid = await h.db.collection('bookings').findOne({});
    assert.equal(paid.cost, 1185);
    assert.equal(paid.payed, 'Presentkort');
    assert.equal(paid.discountCode, null);
    assert.equal(paid.originalCost, null);
    assert.equal(paid.paymentId, null);
    assert.equal((await h.db.collection('giftcards').findOne({})).totalAmount, 815);
  });

  await t.test('invoice checkout clears old paid audit without running payment finalization', async () => {
    const h = await fixture({ bookings: [booking({ available: true, paymentId: null, originalCost: 999, discountCode: 'OLD' })] });
    const response = await h.request('patch', '/checkout', { body: { ...booking(), available: false, payed: 'ej betalat', paymentId: null, discount: 0 } });
    assert.equal(response.statusCode, 200);
    const invoice = await h.db.collection('bookings').findOne({});
    assert.equal(invoice.cost, 2370);
    assert.equal(invoice.payed, 'ej betalat');
    assert.equal(invoice.originalCost, null);
    assert.equal(invoice.discountCode, null);
    assert.equal(h.provider.length, 0);
  });

  await t.test('Swish DB error returns a retryable response without changing the booking', async () => {
    const h = await fixture({ bookings: [booking()], discounts: [campaign], paymentStates: [state()] });
    const collection = h.db.collection.bind(h.db);
    h.db.collection = name => {
      const value = collection(name);
      if (name === 'bookings') value.bulkWrite = async () => { throw new Error('Test DB failure'); };
      return value;
    };
    assert.equal((await h.request('post', '/swish/callback', { body: swish() })).statusCode, 500);
    h.db.collection = collection;
    assert.equal((await h.db.collection('bookings').findOne({})).cost, 2370);
    assert.equal(h.mail.length, 0);
    await h.request('post', '/swish/callback', { body: swish() });
    assert.equal((await h.db.collection('bookings').findOne({})).cost, 1778);
  });

  await t.test('Swish retry after booking write failure deducts gift card only once', async () => {
    const h = await fixture({
      bookings: [booking({ cost: 1185, discount: 0, giftCardReference: 'TEST-GC' })],
      giftcards: [{ reference: 'TEST-GC', totalAmount: 2000, payed: true }],
      paymentStates: [state({ discountCode: null })]
    });
    const collection = h.db.collection.bind(h.db);
    h.db.collection = name => {
      const value = collection(name);
      if (name === 'bookings') value.bulkWrite = async () => { throw new Error('Test DB failure'); };
      return value;
    };
    const body = swish('payment-1', '685');
    assert.equal((await h.request('post', '/swish/callback', { body })).statusCode, 500);
    h.db.collection = collection;
    assert.equal((await h.db.collection('giftcards').findOne({})).totalAmount, 1500);
    await h.request('post', '/swish/callback', { body });
    const giftCard = await h.db.collection('giftcards').findOne({});
    assert.equal(giftCard.totalAmount, 1500);
    assert.deepEqual(giftCard.appliedBookingPayments, ['payment-1']);
    assert.equal((await h.db.collection('bookings').findOne({})).cost, 685);
  });
});
