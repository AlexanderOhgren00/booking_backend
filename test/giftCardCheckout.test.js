import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { allocateGiftCards, moveGiftCardBooking, restoreGiftCardBooking, slotPriceMinor } from '../giftCardCheckout.js';
import { createHarness } from './routeHarness.js';

const cardRefs = ['demo-a111', 'demo-b222', 'demo-c333'];
const customer = { name: 'Test Customer', firstName: 'Test', lastName: 'Customer', number: '0700000000', email: 'test@example.invalid' };

const slot = (day, time = '12:00') => ({
  year: 2027, month: 'January', day, time, category: 'SCHOOL OF MAGIC',
  timeSlotId: `2027-January-${day}-SCHOOL OF MAGIC-${time}`, available: true, cost: 0,
  players: 0, baseCost: 850, discount: 0, paymentId: null
});

function cart(slots, balances, method = 'giftcard', attemptId = randomUUID()) {
  const total = slots.length * 85000;
  const cards = cardRefs.map((reference, i) => ({ reference, balanceMinor: balances[i] * 100 }));
  const quote = allocateGiftCards(total, cards);
  return { attemptId, method, customer, slots: slots.map(({ timeSlotId }) => ({ timeSlotId, players: 2 })),
    giftCardReferences: [...cardRefs], expectedTotalMinor: total, expectedProviderMinor: quote.providerMinor,
    expectedAllocations: quote.allocations };
}

test('gift-card allocation caps the last redemption and uses authoritative room prices', () => {
  assert.deepEqual(allocateGiftCards(120000, [
    { reference: 'a', balanceMinor: 30000 }, { reference: 'b', balanceMinor: 40000 }, { reference: 'c', balanceMinor: 70000 }
  ]), { totalMinor: 120000, providerMinor: 0, allocations: [
    { reference: 'a', amountMinor: 30000 }, { reference: 'b', amountMinor: 40000 }, { reference: 'c', amountMinor: 50000 }
  ] });
  assert.equal(slotPriceMinor({ baseCost: 920, discount: 15, discountType: '%' }, 3), 100725);
  assert.equal(slotPriceMinor({ baseCost: 850, discount: 25, discountType: 'total_percentage', offer: 1200 }, 4), 120000);
  assert.equal(slotPriceMinor({ baseCost: 920, discount: 300, discountType: 'baspris' }, 2), 92000);
});

test('transactional multi-card booking routes', { skip: !process.env.MONGODB_TEST_URI }, async t => {
  const submit = (h, body) => h.request('post', '/gift-card-checkouts', { body });
  async function fixture(slots, balances) {
    const h = await createHarness({ bookings: slots, giftcards: cardRefs.map((reference, i) => ({
      reference, totalAmount: balances[i], payed: true, purchaserEmail: 'private@example.invalid'
    })) });
    t.after(() => h.close());
    return h;
  }

  async function cards(h) {
    return h.db.collection('giftcards').find({}).sort({ reference: 1 }).toArray();
  }
  const balancesOf = records => records.map(record => record.totalAmount);
  const holdsOf = records => records.map(record => record.heldMinor ?? 0);

  await t.test('full coverage spends three cards once and supports admin lookup, move and restore', async () => {
    const chosen = slot(10);
    const destination = slot(11);
    const h = await fixture([chosen, destination], [250, 300, 500]);
    const lookup = await h.request('get', '/booking-gift-cards/:reference', { params: { reference: cardRefs[0].toUpperCase() } });
    assert.deepEqual(JSON.parse(JSON.stringify(lookup.body)), { reference: cardRefs[0], balanceMinor: 25000 });
    const body = cart([chosen], [250, 300, 500]);
    const [first, retry] = await Promise.all([submit(h, body), submit(h, body)]);
    assert.equal(first.statusCode, 200, JSON.stringify(h.errors));
    assert.equal(retry.statusCode, 200, JSON.stringify(h.errors));
    assert.equal(first.body.bookingRef, retry.body.bookingRef);
    assert.equal(first.body.state, 'settled');
    assert.equal(first.body.paymentMethod, 'Presentkort');
    assert.deepEqual(balancesOf(await cards(h)), [0, 0, 200]);
    assert.equal(h.provider.length, 0);
    assert.equal(h.mail.length, 1);
    assert.match(h.mail[0].html, /Betalt med presentkort/);
    const paid = await h.db.collection('bookings').findOne({ timeSlotId: chosen.timeSlotId });
    assert.equal(paid.cost, 850);
    assert.equal(paid.giftCardAllocations.length, 3);
    assert.equal(paid.giftCardAllocations[2].amountMinor, 30000);
    assert.equal(paid.giftCardAllocations[0].reference, undefined);
    assert.notEqual(paid.giftCardCheckoutId, body.attemptId);
    const used = await h.request('get', '/giftcards/used-references');
    assert.deepEqual([...used.body.references], []);
    const user = await h.db.collection('users').insertOne({ privilage: 'topAdmin' });
    h.context.jwt.verify = token => {
      assert.equal(token, 'test-token');
      return { userId: user.insertedId };
    };
    const headers = { authorization: 'Bearer test-token' };
    const references = await h.request('get', '/giftcards/used-references', { headers });
    assert.deepEqual([...references.body.references].sort(), cardRefs);
    for (const reference of cardRefs) {
      const response = await h.request('get', '/giftcard/:reference/bookings', { params: { reference }, headers });
      assert.equal(response.body.results[0].timeSlotId, chosen.timeSlotId);
    }
    await moveGiftCardBooking(h.db, h.context.client, chosen.timeSlotId, destination.timeSlotId);
    const moved = await h.db.collection('bookings').findOne({ timeSlotId: destination.timeSlotId });
    assert.deepEqual(moved.giftCardAllocations, paid.giftCardAllocations);
    const cancelled = await h.request('patch', '/checkout', { headers,
      query: { fromAdmin: 'true', action: 'cancel' }, body: { ...destination }
    });
    assert.equal(cancelled.statusCode, 200);
    assert.equal((await h.db.collection('bookings').findOne({ timeSlotId: destination.timeSlotId })).giftCardCheckoutId, undefined);
    const archived = await h.db.collection('backup').findOne({ timeSlotId: destination.timeSlotId });
    assert.deepEqual(archived.giftCardAllocations, paid.giftCardAllocations);
    const restored = await h.request('post', '/confirmBookingFromSenaste', { headers, body: {
      timeSlotId: destination.timeSlotId, backupId: archived._id.toString(), bookingData: { giftCardCheckoutId: moved.giftCardCheckoutId }
    } });
    assert.equal(restored.statusCode, 200);
    await restoreGiftCardBooking(h.db, h.context.client, archived._id, destination.timeSlotId);
    assert.deepEqual((await h.db.collection('bookings').findOne({ timeSlotId: destination.timeSlotId })).giftCardAllocations, paid.giftCardAllocations);
    assert.deepEqual(balancesOf(await cards(h)), [0, 0, 200]);
  });

  for (const method of ['swish', 'swish-mobile']) {
    await t.test(method + ' protects pending holds and settles verified callbacks once', async () => {
      const chosen = slot(12);
      const h = await fixture([chosen, slot(13)], [100, 150, 200]);
      let provider;
      h.context.axios = { create: () => ({ async put(url, body) {
        provider = body;
        return { status: 201, headers: { paymentrequesttoken: 'test-token', location: 'test-location' } };
      } }) };
      const result = await submit(h, cart([chosen], [100, 150, 200], method));
      assert.equal(result.statusCode, 200, JSON.stringify(h.errors));
      assert.equal(result.body.state, 'pending');
      assert.equal(provider.amount, '400.00');
      assert.equal(method === 'swish-mobile' ? !provider.payerAlias : provider.payerAlias === '46700000000', true);
      assert.deepEqual(holdsOf(await cards(h)), [10000, 15000, 20000]);
      const other = await submit(h, cart([slot(13)], [100, 150, 200], method));
      assert.equal(other.statusCode, 409);
      assert.equal(other.body.code, 'QUOTE_CHANGED');
      const body = { id: result.body.paymentId, status: 'PAID', amount: '400.00', currency: 'SEK' };
      const verified = { callbackidentifier: provider.callbackIdentifier };
      assert.equal((await h.request('post', '/swish/callback', { body })).statusCode, 403);
      assert.notEqual((await h.request('post', '/swish/callback', { body: { ...body, amount: '1.00' }, headers: verified })).statusCode, 200);
      assert.deepEqual(balancesOf(await cards(h)), [100, 150, 200]);
      const callbacks = await Promise.all(Array.from({ length: 2 }, () => h.request('post', '/swish/callback', { body, headers: verified })));
      assert.ok(callbacks.every(response => response.statusCode === 200), JSON.stringify(h.errors));
      assert.deepEqual(holdsOf(await cards(h)), [0, 0, 0]);
      assert.deepEqual(balancesOf(await cards(h)), [0, 0, 0]);
      const paid = await h.db.collection('bookings').findOne({ timeSlotId: chosen.timeSlotId });
      assert.equal(paid.payed, 'Swish');
      assert.equal(paid.cost, 400);
      assert.equal(paid.originalCost, 850);
    });
  }

  await t.test('Nets uses server totals and reconciles an ambiguous charge without charging again', async () => {
    const slots = [slot(14), slot(15)];
    const h = await fixture(slots, [350, 450, 500]);
    let order;
    let captured = false;
    let charges = 0;
    h.context.fetch = async (url, options) => {
      const reply = (data, status = 200) => ({ status, ok: status < 400, json: async () => data });
      if (url.endsWith('/v1/payments')) {
        order = JSON.parse(options.body);
        return reply({ paymentId: 'nets-multi' }, 201);
      }
      if (url.endsWith('/charges')) {
        charges++;
        assert.deepEqual(JSON.parse(options.body), { amount: 40000 });
        assert.match(options.headers['Idempotency-Key'], /-charge$/);
        captured = true;
        throw new Error('simulated response loss after capture');
      }
      return reply({ payment: { summary: { reservedAmount: 40000, chargedAmount: captured ? 40000 : 0 } } });
    };
    const result = await submit(h, cart(slots, [350, 450, 500], 'nets'));
    assert.equal(result.body.state, 'pending');
    assert.equal(order.order.amount, 40000);
    assert.equal(order.order.items.reduce((sum, item) => sum + item.grossTotalAmount, 0), 40000);
    const event = { event: 'payment.checkout.completed', data: { paymentId: 'nets-multi' } };
    assert.equal((await h.request('post', '/eventCreated', { body: event })).statusCode, 500);
    assert.deepEqual(balancesOf(await cards(h)), [350, 450, 500]);
    assert.equal((await h.request('post', '/eventCreated', { body: event })).statusCode, 200);
    assert.equal((await h.request('post', '/eventCreated', { body: event })).statusCode, 200);
    assert.equal(charges, 1);
    assert.deepEqual(balancesOf(await cards(h)), [0, 0, 0]);
    const bookings = await h.db.collection('bookings').find({}).toArray();
    assert.equal(bookings.reduce((sum, booking) => sum + booking.cost, 0), 400);
    assert.equal(bookings.flatMap(booking => booking.giftCardAllocations).reduce((sum, card) => sum + card.amountMinor, 0), 130000);
  });

  await t.test('provider cancellation releases holds but a payment that wins the race confirms', async () => {
    const chosen = slot(16);
    const h = await fixture([chosen], [100, 150, 200]);
    let paymentStatus = 'CANCELLED';
    h.context.axios = { create: () => ({
      put: async () => ({ status: 201, headers: {} }),
      patch: async () => ({ status: 200 }),
      get: async () => ({ status: 200, data: { status: paymentStatus, currency: 'SEK', amount: '400.00' } })
    }) };
    const attempt = cart([chosen], [100, 150, 200], 'swish');
    await submit(h, attempt);
    const cancel = async body => h.request('delete', '/gift-card-checkouts/:attemptId', { params: { attemptId: body.attemptId } });
    assert.equal((await cancel(attempt)).body.state, 'cancelled');
    assert.equal((await cancel(attempt)).body.state, 'cancelled');
    assert.deepEqual(holdsOf(await cards(h)), [0, 0, 0]);
    assert.deepEqual(balancesOf(await cards(h)), [100, 150, 200]);
    assert.equal((await h.db.collection('bookings').findOne({})).available, true);
    paymentStatus = 'PAID';
    const second = cart([chosen], [100, 150, 200], 'swish');
    await submit(h, second);
    assert.equal((await cancel(second)).body.state, 'settled');
    assert.deepEqual(balancesOf(await cards(h)), [0, 0, 0]);
  });

  await t.test('concurrent attempts cannot split-spend credit or partially book a cart', async () => {
    const first = slot(17), second = slot(18), taken = { ...slot(19), available: false };
    const h = await fixture([first, second, taken], [250, 300, 500]);
    const unavailable = await submit(h, cart([first, taken], [250, 300, 500], 'swish'));
    assert.equal(unavailable.body.code, 'SLOT_UNAVAILABLE');
    assert.equal((await h.db.collection('bookings').findOne({ timeSlotId: first.timeSlotId })).available, true);
    const duplicate = cart([first], [250, 300, 500]);
    duplicate.giftCardReferences[1] = duplicate.giftCardReferences[0].toUpperCase();
    assert.equal((await submit(h, duplicate)).body.code, 'DUPLICATE_GIFT_CARD');
    const results = await Promise.all([submit(h, cart([first], [250, 300, 500])), submit(h, cart([second], [250, 300, 500]))]);
    assert.deepEqual(results.map(result => result.statusCode).sort(), [200, 409]);
    assert.deepEqual(balancesOf(await cards(h)), [0, 0, 200]);
  });
});
