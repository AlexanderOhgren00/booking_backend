const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

const pendingCallbacks = new Map();

export function serializePaymentCallback(handler) {
  return async (req, res) => {
    const paymentId = req.body?.id || req.body?.data?.paymentId;
    if (!paymentId) return handler(req, res);
    const previous = pendingCallbacks.get(paymentId);
    let finish;
    const current = new Promise(resolve => { finish = resolve; });
    pendingCallbacks.set(paymentId, current);
    try {
      if (previous) await previous;
      return await handler(req, res);
    } finally {
      finish();
      if (pendingCallbacks.get(paymentId) === current) pendingCallbacks.delete(paymentId);
    }
  };
}

export function computePaidShares(bookings, amountPaid) {
  const amount = Number(amountPaid);
  if (amountPaid == null || amountPaid === "" || !Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(Math.round(amount * 100))) {
    throw new Error("Invalid confirmed payment amount");
  }
  if (!bookings.length) return [];

  // Checkout normally charges whole SEK. Preserve that rounding, but support
  // provider amounts with ore without losing any of the confirmed payment.
  const scale = Number.isInteger(amount) ? 1 : 100;
  const total = Math.round(amount * scale);
  const weights = bookings.map(booking => {
    const weight = Number(booking.originalCost ?? booking.cost ?? 0);
    if (!Number.isFinite(weight) || weight < 0) throw new Error("Invalid booking cost");
    return weight;
  });
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const shares = weights.map(weight => Math.floor(total * (weightSum ? weight / weightSum : 1 / bookings.length)));
  const slotKey = booking => [booking.year, String(MONTHS.indexOf(booking.month)).padStart(2, "0"),
    String(booking.day).padStart(2, "0"), booking.time, booking.category, String(booking._id)].join("|");
  const order = bookings.map((booking, index) => ({
    index,
    fraction: total * (weightSum ? weights[index] / weightSum : 1 / bookings.length) - shares[index],
    key: slotKey(booking)
  })).sort((a, b) => b.fraction - a.fraction || a.key.localeCompare(b.key));
  const remainder = total - shares.reduce((sum, share) => sum + share, 0);
  for (let i = 0; i < remainder; i++) shares[order[i].index]++;
  return shares.map(share => share / scale);
}

// Older initialize calls wrote a scalar; new calls keep every concurrent hold.
const heldPayments = {
  $cond: [
    { $isArray: "$usedBy" }, "$usedBy",
    { $cond: [{ $eq: [{ $type: "$usedBy" }, "string"] }, ["$usedBy"], []] }
  ]
};

export async function holdDiscount(db, code, paymentId) {
  return db.collection("discounts").updateOne(
    { $or: [{ code }, { key: code }] },
    [{ $set: { usedBy: { $setUnion: [heldPayments, { $literal: [paymentId] }] }, updatedAt: "$$NOW" } }]
  );
}

export async function getPaymentDiscount(db, paymentId, bookings) {
  const state = await db.collection("paymentStates").findOne({ paymentId });
  const code = state?.discountCode || bookings.find(booking => booking.discountCode)?.discountCode;
  const doc = code
    ? await db.collection("discounts").findOne({ $or: [{ code }, { key: code }] })
    : await db.collection("discounts").findOne({ usedBy: paymentId });
  return { doc, code: code || doc?.code || doc?.key || null };
}

export async function releaseDiscount(db, paymentId, completed = false, discountDoc = null) {
  const discounts = db.collection("discounts");
  const fields = {
    usedBy: { $setDifference: [heldPayments, { $literal: [paymentId] }] },
    updatedAt: "$$NOW"
  };
  if (completed) fields.usedCount = { $add: [{ $ifNull: ["$usedCount", 0] }, 1] };
  // Preserve single-use records for audit; validation already rejects inactive codes.
  if (completed && discountDoc?.usageType === "single_use") fields.isActive = false;
  // Matching the hold makes retries a no-op and preserves other checkouts.
  return discounts.updateMany({ usedBy: paymentId }, [{ $set: fields }]);
}

export function paidBookingUpdates(bookings, amountPaid, paymentId, method, bookedAt, discountCode) {
  const shares = computePaidShares(bookings, amountPaid);
  return bookings.map((booking, index) => ({ updateOne: {
    filter: { _id: booking._id, paymentId, payed: { $ne: method } },
    update: { $set: {
      available: false, payed: method, updatedAt: new Date(), bookedAt,
      cost: shares[index], originalCost: booking.originalCost ?? booking.cost,
      discountCode: discountCode ?? null
    } }
  } }));
}
