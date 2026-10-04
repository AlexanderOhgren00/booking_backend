// Defaults to read-only. Apply only explicitly selected, reviewed payment IDs.
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { pathToFileURL } from 'node:url';
import { computePaidShares } from '../bookingPricing.js';

export function planDiscountBackfill(bookings, { code, percentage, since }) {
  const groups = new Map();
  for (const booking of bookings) {
    const group = groups.get(booking.paymentId) || [];
    group.push(booking);
    groups.set(booking.paymentId, group);
  }
  const plans = [];
  const skipped = [];
  for (const [paymentId, group] of groups) {
    const eligible = paymentId && group.every(b => b.available === false &&
      ['Swish', 'Nets Easy'].includes(b.payed) && b.discount === percentage &&
      b.bookedAt >= since && b.originalCost == null && !b.discountCode && !b.giftCardReference &&
      Number.isFinite(Number(b.cost)) && Number(b.cost) > 0);
    if (!eligible) {
      skipped.push({ paymentId, reason: 'Mixed, already stamped, or ineligible payment group' });
      continue;
    }
    const listTotal = group.reduce((sum, b) => sum + Number(b.cost), 0);
    const expectedPaid = Math.max(Math.ceil(listTotal * (1 - percentage / 100)), 850);
    if (expectedPaid > listTotal) {
      skipped.push({ paymentId, reason: 'Computed payment would increase the stored price' });
      continue;
    }
    const shares = computePaidShares(group, expectedPaid);
    plans.push({ paymentId, code, listTotal, expectedPaid, bookings: group.map((b, index) => ({
      _id: b._id, bookingRef: b.bookingRef, timeSlotId: b.timeSlotId,
      originalCost: Number(b.cost), cost: shares[index], bookedAt: b.bookedAt, payed: b.payed
    })) });
  }
  return { plans, skipped };
}

async function main() {
  const args = process.argv.slice(2);
  const value = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
  const code = value('--code', 'K85GN9YS2');
  const percentage = Number(value('--percentage', '25'));
  const since = value('--since', '2026-09-15');
  if (!code || !Number.isFinite(percentage) || percentage <= 0 || percentage >= 100 || !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    throw new Error('Provide a code, percentage between 0 and 100, and YYYY-MM-DD start date');
  }
  const apply = args.includes('--apply');
  const selected = value('--payment-ids', '').split(',').filter(Boolean);
  if (apply && !selected.length) throw new Error('--apply requires --payment-ids with reviewed provider payment IDs');
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');

  const client = new MongoClient(process.env.MONGODB_URI);
  try {
    await client.connect();
    const db = client.db('Mintescaperoom');
    const bookings = db.collection('bookings');
    const campaign = await db.collection('discounts').findOne({ $or: [{ code }, { key: code }] }, {
      projection: { code: 1, key: 1, usageType: 1, isActive: 1, usedCount: 1, usedBy: 1 }
    });
    const filter = { available: false, payed: { $in: ['Swish', 'Nets Easy'] },
      discount: percentage, bookedAt: { $gte: since }, paymentId: { $ne: null },
      originalCost: null, discountCode: null, giftCardReference: null };
    if (selected.length) filter.paymentId = { $in: selected };
    const candidates = await bookings.find(filter, { projection: { paymentId: 1 } }).toArray();
    const ids = [...new Set(candidates.map(b => b.paymentId))];
    // Include the complete payment, so a partial candidate group cannot be repriced.
    const documents = ids.length ? await bookings.find({ paymentId: { $in: ids } }, { projection: {
      cost: 1, originalCost: 1, discountCode: 1, discount: 1, payed: 1, available: 1,
      bookedAt: 1, paymentId: 1, giftCardReference: 1, bookingRef: 1, timeSlotId: 1,
      year: 1, month: 1, day: 1, time: 1, category: 1
    } }).toArray() : [];
    const result = planDiscountBackfill(documents, { code, percentage, since });
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', campaign: {
      exists: !!campaign, usageType: campaign?.usageType, isActive: campaign?.isActive,
      usedCount: campaign?.usedCount, usedByType: Array.isArray(campaign?.usedBy) ? 'array' : typeof campaign?.usedBy
    }, candidateBookings: candidates.length, ...result }, null, 2));
    if (!apply) return;
    const plannedIds = new Set(result.plans.map(plan => plan.paymentId));
    if (selected.some(id => !plannedIds.has(id))) throw new Error('Some selected payment IDs are ineligible; no changes applied');
    await client.withSession(async session => {
      await session.withTransaction(async () => {
        for (const plan of result.plans) {
          const operations = plan.bookings.map(booking => ({ updateOne: {
            filter: { _id: booking._id, paymentId: plan.paymentId, cost: booking.originalCost,
              available: false, payed: booking.payed, bookedAt: booking.bookedAt, discount: percentage,
              originalCost: null, discountCode: null, giftCardReference: null },
            update: { $set: { cost: booking.cost, originalCost: booking.originalCost, discountCode: code, updatedAt: new Date() } }
          } }));
          const result = await bookings.bulkWrite(operations, { session });
          if (result.matchedCount !== operations.length) throw new Error(`Payment ${plan.paymentId} changed since review; transaction aborted`);
        }
      });
    });
    console.log(`Applied ${result.plans.length} reviewed payment groups`);
  } finally {
    await client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
