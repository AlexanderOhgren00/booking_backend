import { GiftCardCheckoutError, releaseGiftCardCheckout, settleGiftCardCheckout, toMinor } from "./giftCardCheckout.js";

const netsRoot = "https://api.dibspayment.eu/v1/payments";
const swishRoot = "https://cpc.getswish.net/swish-cpcapi/api";
const callbackRoot = "https://mintbackend-0066444807ba.herokuapp.com";
const websiteRoot = "https://mintescaperoom.se";
const swishTerminal = ["ERROR", "DECLINED", "CANCELLED"];

export function netsGiftCardOrder(attempt) {
  const { customer, slots, bookingRef, providerMinor, totalMinor, method } = attempt;
  const items = slots.map(slot => {
    const net = Math.round(slot.priceMinor / 1.25);
    return {
      reference: slot.timeSlotId, name: slot.category, quantity: 1, unit: "booking",
      unitPrice: net, taxRate: 2500, taxAmount: slot.priceMinor - net,
      grossTotalAmount: slot.priceMinor, netTotalAmount: net
    };
  });
  const credit = providerMinor - totalMinor;
  items.push({ reference: "GIFT_CARD", name: "Presentkort", quantity: 1, unit: "st",
    unitPrice: credit, taxRate: 0, taxAmount: 0, grossTotalAmount: credit, netTotalAmount: credit });
  const address = { addressLine1: customer.address, postalCode: customer.postalCode, city: customer.city, country: "SWE" };
  return {
    order: { items, amount: providerMinor, currency: "SEK", reference: bookingRef },
    checkout: {
      url: websiteRoot + "/checkout", integrationType: "EmbeddedCheckout",
      termsUrl: websiteRoot + "/anvandarvillkor", merchantHandlesConsumerData: true, countryCode: "SWE",
      consumer: {
        email: customer.email, privatePerson: { firstName: customer.firstName, lastName: customer.lastName },
        ...(customer.phonePrefix && customer.phoneNumber && { phoneNumber: { prefix: customer.phonePrefix, number: customer.phoneNumber } }),
        ...(method === "riverty" && { shippingAddress: address, billingAddress: address })
      }
    },
    notifications: { webHooks: [{ eventname: "payment.checkout.completed", url: callbackRoot + "/eventCreated" }] },
    paymentMethodsConfiguration: method === "riverty"
      ? [{ name: "EasyInvoice", enabled: true }, { name: "EasyInstallment", enabled: true }]
      : [{ name: "Swish", enabled: false }]
  };
}

export function createGiftCardProviders({ db, client, fetch, netsKey, swishClient, onSettled }) {
  const attempts = db.collection("giftCardCheckouts");
  const byPayment = paymentId => typeof paymentId === "string" && paymentId.length
    ? attempts.findOne({ paymentId }) : null;

  const netsRequest = (path = "", { method = "GET", body, idempotencyKey } = {}) =>
    fetch(netsRoot + path, {
      method, signal: AbortSignal.timeout(12000),
      headers: { Authorization: netsKey, "Content-Type": "application/json",
        ...(idempotencyKey && { "Idempotency-Key": idempotencyKey }) },
      ...(body && { body: JSON.stringify(body) })
    });

  async function settle(attempt, amount) {
    const result = await settleGiftCardCheckout(db, client, attempt._id, amount);
    if (result.changed) await onSettled(result.attempt);
    return result.attempt;
  }

  async function start(attempt) {
    if (attempt.state !== "prepared") return attempt;
    const claimed = await attempts.findOneAndUpdate({ _id: attempt._id, state: "prepared" },
      { $set: { state: "starting" } }, { returnDocument: "after" });
    if (!claimed) return attempts.findOne({ _id: attempt._id });
    const swish = claimed.method.startsWith("swish");
    let paymentId = claimed.paymentId;
    let paymentRequestToken;
    if (swish) {
      const mobile = claimed.method === "swish-mobile";
      const phone = claimed.customer.number.replace(/[ -]/g, "").replace(/^0/, "46").replace(/^\+/, "");
      const response = await swishClient().put(swishRoot + "/v2/paymentrequests/" + paymentId, {
        payeePaymentReference: paymentId, payeeAlias: "1230047647", currency: "SEK",
        callbackUrl: callbackRoot + "/swish/callback", callbackIdentifier: claimed.callbackIdentifier,
        amount: (claimed.providerMinor / 100).toFixed(2), message: "Mint Escape Room " + claimed.bookingRef,
        ...(!mobile && { payerAlias: phone })
      }, { validateStatus: () => true });
      if (response.status !== 201) {
        if ([400, 401, 403, 422].includes(response.status)) {
          await releaseGiftCardCheckout(db, client, claimed._id, ["starting"]);
        }
        throw new GiftCardCheckoutError(502, "PAYMENT_START_FAILED");
      }
      paymentRequestToken = response.headers.paymentrequesttoken ?? response.headers.location;
    } else {
      const response = await netsRequest("", { method: "POST", body: netsGiftCardOrder(claimed), idempotencyKey: claimed._id });
      if (!response.ok) {
        if ([400, 401, 403, 422].includes(response.status)) {
          await releaseGiftCardCheckout(db, client, claimed._id, ["starting"]);
        }
        throw new GiftCardCheckoutError(502, "PAYMENT_START_FAILED");
      }
      ({ paymentId } = await response.json());
      if (typeof paymentId !== "string" || !paymentId) throw new Error("Nets did not return a payment ID");
    }

    return client.withSession(session => session.withTransaction(async () => {
      const updated = await attempts.findOneAndUpdate({ _id: claimed._id, state: "starting" },
        { $set: { state: "pending", paymentId, ...(paymentRequestToken && { paymentRequestToken }) } },
        { session, returnDocument: "after" });
      if (!updated) return attempts.findOne({ _id: claimed._id }, { session });
      if (!swish) await db.collection("bookings").updateMany({ giftCardCheckoutId: claimed.bookingKey },
        { $set: { paymentId } }, { session });
      return updated;
    }));
  }

  async function netsPayment(attempt) {
    const response = await netsRequest("/" + encodeURIComponent(attempt.paymentId));
    if (!response.ok) throw new Error("Could not verify Nets payment");
    const { payment } = await response.json();
    if (!payment?.summary) throw new Error("Nets payment summary is missing");
    return payment;
  }

  async function completeNets(attempt) {
    if (attempt.state === "settled" || attempt.state === "cancelled") return attempt;
    const { summary } = await netsPayment(attempt);
    if (summary.chargedAmount === attempt.providerMinor) return settle(attempt, summary.chargedAmount);
    if (summary.chargedAmount > 0 || summary.reservedAmount !== attempt.providerMinor) {
      throw new GiftCardCheckoutError(409, "PAYMENT_AMOUNT_MISMATCH");
    }
    if (attempt.state === "pending") {
      attempt = await attempts.findOneAndUpdate({ _id: attempt._id, state: "pending" },
        { $set: { state: "charging" } }, { returnDocument: "after" }) ?? await attempts.findOne({ _id: attempt._id });
    }
    if (attempt.state !== "charging") return attempt;
    const response = await netsRequest("/" + encodeURIComponent(attempt.paymentId) + "/charges", {
      method: "POST", body: { amount: attempt.providerMinor }, idempotencyKey: attempt._id + "-charge"
    });
    if (!response.ok) throw new Error("Nets charge is awaiting reconciliation");
    const { summary: verified } = await netsPayment(attempt);
    if (verified.chargedAmount !== attempt.providerMinor) throw new Error("Nets charge is awaiting confirmation");
    return settle(attempt, verified.chargedAmount);
  }

  async function completeSwish(attempt, payment) {
    if (payment.status === "PAID") {
      if (payment.currency !== "SEK") throw new GiftCardCheckoutError(409, "PAYMENT_AMOUNT_MISMATCH");
      return settle(attempt, toMinor(payment.amount));
    }
    if (swishTerminal.includes(payment.status)) {
      await releaseGiftCardCheckout(db, client, attempt._id, ["starting", "pending", "cancelling"]);
    }
    return attempts.findOne({ _id: attempt._id });
  }

  async function cancel(attempt, expired = false) {
    if (["cancelled", "settled"].includes(attempt.state)) return attempt;
    if (attempt.state === "prepared" || (expired && attempt.state === "starting" && !attempt.paymentId)) {
      await releaseGiftCardCheckout(db, client, attempt._id, [attempt.state]);
      return attempts.findOne({ _id: attempt._id });
    }
    if (attempt.state === "charging") return completeNets(attempt);
    if (attempt.state === "starting" && !expired) return attempt;
    const claimed = await attempts.findOneAndUpdate({ _id: attempt._id, state: { $in: ["pending", "starting"] } },
      { $set: { state: "cancelling" } }, { returnDocument: "after" });
    attempt = claimed ?? await attempts.findOne({ _id: attempt._id });
    if (attempt.state !== "cancelling") return attempt;
    if (attempt.method.startsWith("swish")) {
      const client = swishClient();
      const url = swishRoot + "/v1/paymentrequests/" + attempt.paymentId;
      await client.patch(url, [{ op: "replace", path: "/status", value: "cancelled" }],
        { headers: { "Content-Type": "application/json-patch+json" }, validateStatus: () => true });
      const response = await client.get(url, { validateStatus: () => true });
      if (response.status === 200) return completeSwish(attempt, response.data);
      if (response.status !== 404 || !expired) return attempt;
    } else {
      const { summary } = await netsPayment(attempt);
      if (summary.chargedAmount === attempt.providerMinor) return settle(attempt, summary.chargedAmount);
      if (summary.chargedAmount > 0) return attempt;
      if (summary.reservedAmount === attempt.providerMinor) {
        // An authorization won the race. Capture and confirm the booked slots.
        const resumed = await attempts.findOneAndUpdate({ _id: attempt._id, state: "cancelling" },
          { $set: { state: "charging" } }, { returnDocument: "after" });
        return completeNets(resumed ?? await attempts.findOne({ _id: attempt._id }));
      }
      const response = await netsRequest("/" + encodeURIComponent(attempt.paymentId) + "/terminate", { method: "PUT" });
      if (!response.ok) return attempt;
      const { summary: final } = await netsPayment(attempt);
      if (final.chargedAmount === attempt.providerMinor) return settle(attempt, final.chargedAmount);
      if (final.reservedAmount > 0 || final.chargedAmount > 0) return attempt;
    }
    await releaseGiftCardCheckout(db, client, attempt._id, ["cancelling"]);
    return attempts.findOne({ _id: attempt._id });
  }
  return { byPayment, start, completeNets, completeSwish, cancel };
}
