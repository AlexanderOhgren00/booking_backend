import { createHash, randomUUID } from "node:crypto";

const HOLD_MS = 15 * 60 * 1000;
const campaignTypes = ["per_player_fixed", "per_player_percentage", "total_fixed", "total_percentage"];

export class GiftCardCheckoutError extends Error {
  constructor(status, code, quote) {
    super(code);
    this.status = status;
    this.quote = quote;
  }
}

export function toMinor(value) {
  const amount = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("Invalid money amount");
  return amount;
}

export function slotPriceMinor(slot, players) {
  const minimum = Number(slot.baseCost) || 850;
  const regular = players === 2 ? Math.max(minimum, players * 395) : players * 395;
  const discount = parseInt(slot.discount, 10);
  let price = regular;
  if (discount && !slot.discountCode && !campaignTypes.includes(slot.discountType)) {
    if (slot.discountType === "%") price = regular * (1 - discount / 100);
    else if (slot.discountType === "SEK") price = regular - discount;
    else price = players * discount;
    if (players === 2) price = Math.max(minimum, price);
  }
  const offer = parseFloat(slot.offer);
  if (offer > 0) price = Math.min(price, offer);
  return toMinor(price);
}

export function allocateGiftCards(totalMinor, cards) {
  let providerMinor = totalMinor;
  const allocations = [];
  for (const { reference, balanceMinor } of cards) {
    const amountMinor = Math.min(providerMinor, balanceMinor);
    if (amountMinor > 0) allocations.push({ reference, amountMinor });
    providerMinor -= amountMinor;
  }
  return { totalMinor, providerMinor, allocations };
}

function distribute(slots, allocations) {
  const result = slots.map(slot => ({ ...slot, giftCardAllocations: [], providerMinor: slot.priceMinor }));
  // Allocate cards across rooms in cart order, without duplicating a card's applied amount.
  let slotIndex = 0;
  for (const { reference, amountMinor } of allocations) {
    let remaining = amountMinor;
    while (remaining > 0) {
      const slot = result[slotIndex];
      const amount = Math.min(remaining, slot.providerMinor);
      if (amount > 0) slot.giftCardAllocations.push({ reference, amountMinor: amount });
      slot.providerMinor -= amount;
      remaining -= amount;
      if (!slot.providerMinor) slotIndex += 1;
    }
  }
  return result;
}

function inputFor(body) {
  const { attemptId, slots, giftCardReferences, method, expectedTotalMinor, expectedProviderMinor, expectedAllocations } = body;
  const customer = Object.fromEntries(
    ["name", "number", "email", "firstName", "lastName", "phonePrefix", "phoneNumber", "address", "city", "postalCode"]
      .map(field => [field, typeof body.customer?.[field] === "string" ? body.customer[field].trim().slice(0, 254) : ""])
  );
  if (typeof attemptId !== "string" || !/^[a-f0-9-]{36}$/i.test(attemptId) ||
      !Array.isArray(slots) || slots.length < 1 || slots.length > 25 ||
      slots.some(slot => typeof slot?.timeSlotId !== "string" || slot.timeSlotId.length > 160 ||
        !Number.isInteger(slot.players) || slot.players < 2 || slot.players > 6) ||
      new Set(slots.map(slot => slot.timeSlotId)).size !== slots.length ||
      !Array.isArray(giftCardReferences) || giftCardReferences.length < 1 || giftCardReferences.length > 20 ||
      giftCardReferences.some(reference => typeof reference !== "string" || !reference.trim() || reference.length > 64) ||
      !["giftcard", "swish", "swish-mobile", "nets", "riverty"].includes(method) ||
      !Number.isSafeInteger(expectedTotalMinor) || !Number.isSafeInteger(expectedProviderMinor) ||
      !Array.isArray(expectedAllocations) || expectedAllocations.length > 20 ||
      expectedAllocations.some(item => typeof item?.reference !== "string" ||
        !Number.isSafeInteger(item.amountMinor) || item.amountMinor <= 0) ||
      !customer.name || !/^\+?[0-9 -]{7,20}$/.test(customer.number) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) {
    throw new GiftCardCheckoutError(400, "INVALID_CHECKOUT");
  }
  const references = giftCardReferences.map(reference => reference.trim());
  if (new Set(references.map(reference => reference.toLowerCase())).size !== references.length) throw new GiftCardCheckoutError(400, "DUPLICATE_GIFT_CARD");
  return {
    attemptId, slots, references, method, customer, expectedTotalMinor, expectedProviderMinor,
    expectedAllocations: expectedAllocations.map(({ reference, amountMinor }) => ({ reference, amountMinor }))
  };
}

export async function prepareGiftCardCheckout(db, client, body) {
  const input = inputFor(body);
  const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const attempts = db.collection("giftCardCheckouts");
  return client.withSession(session => session.withTransaction(async () => {
    const existing = await attempts.findOne({ _id: input.attemptId }, { session });
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new GiftCardCheckoutError(409, "CHECKOUT_CHANGED");
      return { attempt: existing, created: false };
    }

    const bookings = db.collection("bookings");
    const giftcards = db.collection("giftcards");
    const storedSlots = await bookings.find({ timeSlotId: { $in: input.slots.map(slot => slot.timeSlotId) } }, { session }).toArray();
    const slots = input.slots.map(({ timeSlotId, players }) => {
      const stored = storedSlots.find(slot => slot.timeSlotId === timeSlotId);
      if (stored?.available !== true) throw new GiftCardCheckoutError(409, "SLOT_UNAVAILABLE");
      const { year, month, day, category, time } = stored;
      return { timeSlotId, players, priceMinor: slotPriceMinor(stored, players), year, month, day, category, time };
    });

    const storedCards = await giftcards.find({ reference: { $in: input.references } }, { session }).toArray();
    const cards = input.references.map(reference => {
      const card = storedCards.find(item => item.reference === reference && item.payed);
      const balanceMinor = card ? Math.max(0, toMinor(card.totalAmount) - (card.heldMinor ?? 0)) : 0;
      return { reference, balanceMinor };
    });
    const quote = allocateGiftCards(slots.reduce((sum, slot) => sum + slot.priceMinor, 0), cards);
    if (cards.some(card => card.balanceMinor <= 0) || quote.totalMinor !== input.expectedTotalMinor ||
        quote.providerMinor !== input.expectedProviderMinor ||
        JSON.stringify(quote.allocations) !== JSON.stringify(input.expectedAllocations) ||
        (quote.providerMinor > 0 && input.method === "giftcard")) {
      throw new GiftCardCheckoutError(409, "QUOTE_CHANGED", { ...quote, cards, slots });
    }

    const now = new Date();
    const full = quote.providerMinor === 0;
    const swish = input.method.startsWith("swish");
    const attempt = {
      _id: input.attemptId, fingerprint, ...quote,
      slots: distribute(slots, quote.allocations).map(slot => ({
        ...slot, giftCardAllocations: slot.giftCardAllocations.map(({ reference, amountMinor }) => ({
          cardId: storedCards.find(card => card.reference === reference)._id,
          maskedReference: "•••• " + reference.slice(-4), amountMinor
        }))
      })),
      bookingKey: randomUUID(),
      customer: input.customer,
      bookingRef: randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase(),
      method: full ? "giftcard" : input.method,
      state: full ? "settled" : "prepared",
      paymentId: !full && swish ? randomUUID().replaceAll("-", "").toUpperCase() : null,
      callbackIdentifier: !full && swish ? randomUUID() : null,
      createdAt: now, expiresAt: new Date(+now + HOLD_MS),
      ...(full && { settledAt: now })
    };
    await attempts.insertOne(attempt, { session });
    for (const { reference, amountMinor } of attempt.allocations) {
      await giftcards.updateOne({ reference }, full
        ? [{ $set: {
          totalAmount: { $round: [{ $subtract: ["$totalAmount", amountMinor / 100] }, 2] }, updatedAt: now
        } }]
        : { $inc: { heldMinor: amountMinor } }, { session });
    }
    for (const slot of attempt.slots) {
      const update = await bookings.updateOne({ timeSlotId: slot.timeSlotId, available: true }, { $set: {
        available: full ? false : "occupied",
        bookedBy: input.customer.name, email: input.customer.email, number: input.customer.number,
        players: slot.players, bookingRef: attempt.bookingRef, paymentId: attempt.paymentId,
        cost: slot.priceMinor / 100, payed: full ? "Presentkort" : false,
        bookedAt: now.toISOString(), updatedAt: now,
        originalCost: null, discountCode: null, giftCardReference: null,
        giftCardCheckoutId: attempt.bookingKey, giftCardSlotId: slot.timeSlotId,
        giftCardAllocations: full ? slot.giftCardAllocations : [],
        providerPaidMinor: full ? 0 : null
      } }, { session });
      if (update.matchedCount !== 1) throw new GiftCardCheckoutError(409, "SLOT_UNAVAILABLE");
    }
    return { attempt, created: true };
  }));
}

export async function settleGiftCardCheckout(db, client, id, confirmedMinor) {
  return client.withSession(session => session.withTransaction(async () => {
    const attempts = db.collection("giftCardCheckouts");
    const attempt = await attempts.findOne({ _id: id }, { session });
    if (!attempt || attempt.providerMinor !== confirmedMinor) throw new GiftCardCheckoutError(409, "PAYMENT_AMOUNT_MISMATCH");
    if (attempt.state === "settled") return { attempt, changed: false };
    if (!["starting", "pending", "charging", "cancelling"].includes(attempt.state)) {
      throw new GiftCardCheckoutError(409, "PAYMENT_STATE_CONFLICT");
    }
    const now = new Date();
    for (const { reference, amountMinor } of attempt.allocations) {
      const result = await db.collection("giftcards").updateOne(
        { reference, heldMinor: { $gte: amountMinor }, $expr: {
          $gte: [{ $round: [{ $multiply: ["$totalAmount", 100] }, 0] }, amountMinor]
        } },
        [{ $set: {
          totalAmount: { $round: [{ $subtract: ["$totalAmount", amountMinor / 100] }, 2] },
          heldMinor: { $subtract: ["$heldMinor", amountMinor] }, updatedAt: now
        } }], { session }
      );
      if (result.matchedCount !== 1) throw new Error("Gift card hold is missing");
    }
    for (const slot of attempt.slots) {
      const result = await db.collection("bookings").updateOne(
        { timeSlotId: slot.timeSlotId, available: "occupied", giftCardCheckoutId: attempt.bookingKey },
        { $set: {
          available: false, payed: attempt.method.startsWith("swish") ? "Swish" : "Nets Easy",
          cost: slot.providerMinor / 100, originalCost: slot.priceMinor / 100,
          providerPaidMinor: slot.providerMinor, giftCardAllocations: slot.giftCardAllocations,
          paymentId: attempt.paymentId, bookedAt: now.toISOString(), updatedAt: now
        } }, { session }
      );
      if (result.matchedCount !== 1) throw new Error("Reserved slot is missing");
    }
    await attempts.updateOne({ _id: id }, { $set: { state: "settled", settledAt: now } }, { session });
    return { attempt: { ...attempt, state: "settled", settledAt: now }, changed: true };
  }));
}

export async function releaseGiftCardCheckout(db, client, id, states) {
  return client.withSession(session => session.withTransaction(async () => {
    const attempts = db.collection("giftCardCheckouts");
    const attempt = await attempts.findOne({ _id: id, state: { $in: states } }, { session });
    if (!attempt) return false;
    for (const { reference, amountMinor } of attempt.allocations) {
      const result = await db.collection("giftcards").updateOne(
        { reference, heldMinor: { $gte: amountMinor } }, { $inc: { heldMinor: -amountMinor } }, { session }
      );
      if (result.matchedCount !== 1) throw new Error("Gift card hold is missing");
    }
    await db.collection("bookings").updateMany({ giftCardCheckoutId: attempt.bookingKey, available: "occupied" }, {
      $set: { available: true, cost: 0, players: 0, bookedBy: null, number: null, email: null,
        payed: null, bookedAt: null, bookingRef: null, paymentId: null, updatedAt: new Date() },
      $unset: { giftCardCheckoutId: "", giftCardSlotId: "", giftCardAllocations: "", providerPaidMinor: "" }
    }, { session });
    await attempts.updateOne({ _id: id }, { $set: { state: "cancelled", cancelledAt: new Date() } }, { session });
    return true;
  }));
}

export function checkoutResult(attempt) {
  const paymentMethod = attempt.method === "giftcard" ? "Presentkort"
    : attempt.method.startsWith("swish") ? "Swish" : "Nets Easy";
  return {
    state: attempt.state, paymentMethod, paymentId: attempt.paymentId,
    bookingRef: attempt.bookingRef, totalMinor: attempt.totalMinor, providerMinor: attempt.providerMinor,
    giftCardMinor: attempt.totalMinor - attempt.providerMinor,
    paymentRequestToken: attempt.paymentRequestToken,
    slots: attempt.slots.map(({ timeSlotId, year, month, day, category, time, priceMinor, players }) =>
      ({ timeSlotId, year, month, day, category, time, priceMinor, players }))
  };
}

const bookingTransferFields = [
  "available", "players", "cost", "originalCost", "discountCode", "bookedBy", "payed", "number", "email",
  "info", "paymentId", "bookingRef", "bookedAt", "giftCardCheckoutId", "giftCardAllocations",
  "giftCardSlotId", "providerPaidMinor"
];

function bookingTransfer(source) {
  return Object.fromEntries(bookingTransferFields.map(field => [field, source[field] ?? null]));
}

export async function moveGiftCardBooking(db, client, sourceId, destinationId) {
  return client.withSession(session => session.withTransaction(async () => {
    const bookings = db.collection("bookings");
    const source = await bookings.findOne({ timeSlotId: sourceId, available: false, giftCardCheckoutId: { $type: "string" } }, { session });
    if (!source) throw new GiftCardCheckoutError(404, "BOOKING_NOT_FOUND");
    const moved = await bookings.updateOne({ timeSlotId: destinationId, available: true },
      { $set: { ...bookingTransfer(source), updatedAt: new Date() } }, { session });
    if (!moved.matchedCount) throw new GiftCardCheckoutError(409, "SLOT_UNAVAILABLE");
    await bookings.updateOne({ _id: source._id }, { $set: {
      available: true, players: 0, cost: 0, bookedBy: null, number: null, email: null,
      payed: null, info: null, bookedAt: null, originalCost: null, discountCode: null,
      giftCardReference: null, paymentId: null, bookingRef: null, updatedAt: new Date()
    }, $unset: { giftCardCheckoutId: "", giftCardSlotId: "", giftCardAllocations: "", providerPaidMinor: "" } }, { session });
    return { sourceId, destinationId, bookingRef: source.bookingRef };
  }));
}

export async function restoreGiftCardBooking(db, client, backupId, timeSlotId) {
  return client.withSession(session => session.withTransaction(async () => {
    const backup = await db.collection("backup").findOne({ _id: backupId, timeSlotId }, { session });
    if (!backup?.giftCardCheckoutId || !backup.giftCardSlotId || backup.available !== false) {
      throw new GiftCardCheckoutError(404, "BOOKING_NOT_FOUND");
    }
    // A backup can only restore the specific slot allocation it represents.
    const attempts = db.collection("giftCardCheckouts");
    const attempt = await attempts.findOneAndUpdate({ bookingKey: backup.giftCardCheckoutId, state: "settled" },
      { $currentDate: { lastRestoreAt: true } }, { session });
    const originalSlot = attempt?.slots.find(slot => slot.timeSlotId === backup.giftCardSlotId);
    if (!originalSlot) throw new GiftCardCheckoutError(409, "PAYMENT_STATE_CONFLICT");
    const bookings = db.collection("bookings");
    const active = await bookings.findOne({
      giftCardCheckoutId: backup.giftCardCheckoutId, giftCardSlotId: backup.giftCardSlotId, available: false
    }, { session });
    if (active?.timeSlotId === timeSlotId) return { bookingRef: active.bookingRef };
    if (active) throw new GiftCardCheckoutError(409, "SLOT_UNAVAILABLE");
    const updated = await bookings.updateOne({ timeSlotId, available: true }, { $set: {
      ...bookingTransfer(backup), giftCardAllocations: originalSlot.giftCardAllocations,
      providerPaidMinor: originalSlot.providerMinor, updatedAt: new Date(), confirmedFromSenaste: true
    } }, { session });
    if (!updated.matchedCount) throw new GiftCardCheckoutError(409, "SLOT_UNAVAILABLE");
    await db.collection("backup").updateOne({ _id: backupId }, { $set: { restoredAt: new Date() } }, { session });
    return { bookingRef: backup.bookingRef };
  }));
}

export async function archiveGiftCardBooking(db, client, timeSlotId) {
  return client.withSession(session => session.withTransaction(async () => {
    const bookings = db.collection("bookings");
    const booking = await bookings.findOne({ timeSlotId, available: false, giftCardCheckoutId: { $type: "string" } }, { session });
    if (!booking) throw new GiftCardCheckoutError(404, "BOOKING_NOT_FOUND");
    const { _id, ...snapshot } = booking;
    await db.collection("backup").insertOne({
      ...snapshot, backupSource: "canceled", backupCreatedAt: new Date().toISOString()
    }, { session });
    return bookings.updateOne({ _id }, { $set: {
      available: true, players: 0, cost: 0, bookedBy: null, number: null, email: null,
      payed: null, info: null, bookedAt: null, originalCost: null, discountCode: null, giftCardReference: null,
      paymentId: null, bookingRef: null, updatedAt: new Date()
    }, $unset: { giftCardCheckoutId: "", giftCardSlotId: "", giftCardAllocations: "", providerPaidMinor: "" } }, { session });
  }));
}
