import test from 'node:test';
import assert from 'node:assert/strict';
import { planDiscountBackfill } from '../scripts/backfillDiscountPrices.js';

const options = { code: 'K85GN9YS2', percentage: 25, since: '2026-09-15' };
const booking = extra => ({ cost: 2370, available: false, payed: 'Swish', paymentId: 'p1',
  discount: 25, bookedAt: '2026-09-22 11:00:00', bookingRef: 'NC6XOE', ...extra });

test('backfill proposes NC6XOE cost 1778 and preserves list price', () => {
  const { plans } = planDiscountBackfill([booking()], options);
  assert.equal(plans[0].expectedPaid, 1778);
  assert.equal(plans[0].bookings[0].originalCost, 2370);
  assert.equal(plans[0].bookings[0].cost, 1778);
});

test('backfill skips stamped, gift-card, mixed, unpaid, and pre-campaign groups', () => {
  for (const extra of [
    { originalCost: 2370 }, { discountCode: options.code }, { giftCardReference: 'GC' },
    { payed: 'ej betalat' }, { bookedAt: '2026-09-14' }, { available: true }, { discount: 300 }
  ]) {
    const result = planDiscountBackfill([booking(), booking(extra)], options);
    assert.equal(result.plans.length, 0);
    assert.equal(result.skipped.length, 1);
  }
});

test('backfill keeps exact cart total, accepts both providers, and is idempotent', () => {
  const group = [booking({ cost: 2370 }), booking({ cost: 1580, payed: 'Nets Easy' })];
  const { plans } = planDiscountBackfill(group, options);
  assert.equal(plans[0].expectedPaid, 2963);
  assert.equal(plans[0].bookings.reduce((sum, b) => sum + b.cost, 0), 2963);
  const stamped = group.map((b, i) => ({ ...b, ...plans[0].bookings[i], discountCode: options.code }));
  assert.equal(planDiscountBackfill(stamped, options).plans.length, 0);
});
