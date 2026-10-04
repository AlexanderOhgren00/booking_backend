import test from 'node:test';
import assert from 'node:assert/strict';
import { computePaidShares } from '../bookingPricing.js';

const slot = (cost, day = 4, time = '11:00') => ({ cost, year: 2026, month: 'October', day, time });

test('NC6XOE records the provider amount, including checkout ceiling', () => {
  assert.deepEqual(computePaidShares([slot(2370)], 1778), [1778]);
});

test('multiple slots use proportional whole-SEK shares summing to the payment', () => {
  assert.deepEqual(computePaidShares([slot(2370), slot(1580)], 2963), [1778, 1185]);
  assert.deepEqual(computePaidShares([slot(850, 5), slot(850, 4)], 1275), [637, 638]);
  assert.deepEqual(computePaidShares([slot(850), slot(850)], 850), [425, 425]);
});

test('tie breaking is stable when database order changes', () => {
  const bookings = [slot(850, 6), slot(850, 4), slot(850, 5)];
  const forward = computePaidShares(bookings, 1000);
  const reverse = computePaidShares([...bookings].reverse(), 1000).reverse();
  assert.deepEqual(forward, reverse);
  assert.deepEqual(forward, [333, 334, 333]);
});

test('retries use original costs, without redistributing already stamped shares', () => {
  assert.deepEqual(computePaidShares([
    { ...slot(1778), originalCost: 2370 }, { ...slot(1185), originalCost: 1580 }
  ], 2963), [1778, 1185]);
});

test('fractional payments preserve ore and zero payments are supported', () => {
  assert.deepEqual(computePaidShares([slot(100), slot(100)], 100.01), [50.01, 50]);
  assert.deepEqual(computePaidShares([slot(100), slot(100)], 0), [0, 0]);
  assert.deepEqual(computePaidShares([slot(0), slot(0)], 5), [3, 2]);
});

test('reject malformed amounts/costs before any writes', () => {
  for (const amount of [NaN, Infinity, -1, '1778invalid', null, undefined, '']) {
    assert.throws(() => computePaidShares([slot(2370)], amount));
  }
  for (const cost of [-1, Infinity, 'invalid']) {
    assert.throws(() => computePaidShares([slot(cost)], 10));
  }
});

test('many cart shapes conserve the exact total and produce nonnegative shares', () => {
  for (let count = 1; count <= 15; count++) {
    for (let total = 0; total <= 5000; total += 37) {
      const bookings = Array.from({ length: count }, (_, i) => slot(850 + (i * 173) % 1520, i + 1));
      for (const amount of [total, total + 0.13]) {
        const shares = computePaidShares(bookings, amount);
        assert.equal(shares.reduce((sum, share) => sum + Math.round(share * 100), 0), Math.round(amount * 100));
        assert.ok(shares.every(share => share >= 0));
      }
    }
  }
});
