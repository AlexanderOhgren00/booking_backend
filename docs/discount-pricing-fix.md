# Discount pricing fix — validation and deployment notes

Payment confirmation stores the provider-confirmed amount in `booking.cost`.
For multiple slots, the amounts are proportional to the reservation costs and
sum exactly to the payment. `originalCost` preserves the reservation price and
`discountCode` preserves the applied code. No historical prices are recomputed
when someone later edits a campaign.

The admin displays the paid amount, the original amount struck through, and the
code. Campaign percentages no longer act as per-player prices in mismatch
checks or the Calculate button. Ordinary/room-discount mismatch checks remain.
Explicit admin price changes remain possible and retain the audit fields.

Date rescheduling carries the audit fields and gift-card reference to the new
slot; clearing the old slot removes them. Time changes retain the same booking
and pricing. Cancellation, refund, failed payment, expiration, conflicting
payment cleanup, and new checkout clear stale payment fields. Senaste restore
carries supplied audit data and clears absent data instead of inheriting it.

Discount holds support concurrent checkouts and legacy scalar `usedBy` values.
Shared codes survive payment. Single-use codes become inactive after payment;
their records are preserved. Failed/abandoned payments release their own holds
without counting a use. **The fix does not delete discount records.** Existing
backup/payment-state cleanup behavior remains part of the application lifecycle.

Duplicate callbacks are checked before Nets charging. Callbacks for the same
payment are serialized within a server process. Gift-card deductions record a
payment marker atomically, so a booking-write failure followed by a retry cannot
deduct twice. Swish booking-write failures return HTTP 500 for retry.

Partial gift-card payments now store the provider-paid amount, as specified by
the discount price plan. Full gift-card bookings retain the existing full-value
cost behavior. Invoice checkout still records its reservation price and unpaid
status; it has no payment callback. Customer checkout code is unchanged.

## Checks performed

- 42 backend tests passed, including the production route handlers against an
  isolated local MongoDB instance. Providers and email delivery were replaced
  by test doubles. No customer payments or emails were sent by these tests.
- 6 admin tests passed, including rendered pricing labels and actual JSX action
  closures for date moves, restore, and edit/view selection.
- Admin production bundle built successfully. Existing CSS `fontSize` and large
  bundle warnings remain unrelated to this fix.
- Syntax and whitespace checks passed.

Backend unit/backfill tests: `npm test` in `booking_backend`.
For all route tests, start an isolated local MongoDB and set
`MONGODB_TEST_URI=mongodb://127.0.0.1:<port>/` before `npm test`. The harness rejects
remote URIs, creates uniquely named test databases, and cleans up only those
local test databases. Without that variable, route tests are skipped explicitly.
Admin tests: `npm test` in `mint_admin`; bundle: `npx vite build`.

## Production read-only findings (2026-10-04)

`K85GN9YS2` exists, is active, has `usageType: infinite`, and currently has
`usedCount: 0` and array `usedBy`. No campaign recreation is needed.

| Booking | Stored cost | Proposed paid cost | Preserved original cost |
| --- | ---: | ---: | ---: |
| NC6XOE | 2370 | 1778 | 2370 |
| 5JKYWO | 2370 | 1778 | 2370 |

The backfill preview identifies two eligible live bookings. It excludes
gift-card, already stamped, unpaid, pre-campaign, and mixed payment groups.
Amounts are inferred from the stored price and 25% campaign formula; verify
each payment against the provider record before applying. NC6XOE's amount
matches the 1778 SEK payment documented in `DISCOUNT_PRICE_FIX_PLAN.md`.
The archive is outside the backfill scope.

Preview from `booking_backend`:

```text
node scripts/backfillDiscountPrices.js
```

The script defaults to read-only and performs **no deletions**. It only updates
explicitly reviewed payment IDs when both `--apply` and `--payment-ids` are
provided. Updates run inside a transaction with original-value checks; a
changed booking aborts the transaction. Re-running skips already stamped rows.

**Validation performed no production writes or deletions. The historical
backfill has not been applied.** Deploy backend before admin, then separately review the
backfill preview against provider records before applying any historical update.
Live provider integration still needs a controlled post-deployment verification.

## Customer frontend trace (follow-up)

The customer runtime code and payment creation requests remain unchanged, as
requested. Tests execute the actual `BookingForm` functions from
`mint_website/src/components/layout/booking/BookingTest.jsx`, route their fetches
into the production backend handlers, and inspect an isolated local MongoDB.
Providers and mail remain test doubles; these are not live gateway acceptance
tests. The actual embedded checkout completion handler is also exercised.

| Alternative | Existing flow | Verified storage behavior |
| --- | --- | --- |
| Swish desktop | Validate price → reserve → initialize → Swish E-Commerce → callback → poll → confirmation | Cost equals callback SEK amount |
| Swish mobile | Same reservation/initialization → Swish M-Commerce token/deep link → callback → poll → confirmation | Cost equals callback SEK amount |
| Card | Validate price → Nets create → reserve → initialize → embedded checkout → callback → verify → confirmation | Cost equals confirmed order amount divided by 100 |
| Private invoice/Riverty | Existing Nets branch and callback; absent from current dropdown but retained in code | Same storage behavior as card |
| Partial gift card + Swish/card/private invoice | Existing provider amount subtracts gift-card credit → callback | Cost equals provider amount; gift-card deduction is recorded once |
| Full gift card, Swish/card selected | Direct `/confirm-with-giftcard`; no provider charge | Existing full-value booking cost and gift-card balance behavior retained |
| Company invoice | Direct unpaid `/checkout`; no provider or payment callback | Existing invoice reservation price retained |

Campaign percentage, fixed-total, fixed-player-price, and player-percentage
discounts were traced. A two-slot campaign was also traced from the frontend's
2963 SEK payment to stored shares of 1778 and 1185 SEK. Actual discount validation
was exercised to verify `discountKey`/`discountUsedBy` reach initialization and
become the persisted payment discount reference.

**Known exception:** company invoice + campaign displays a discounted checkout
total but its existing callback-free path stores the reservation/list cost. The
paid-cost callback fix does not change this unpaid invoice path. It must not be
described as fixing campaign invoice pricing. Customer confirmation still reads
the existing local-storage snapshot; no receipt UI or payment payload was changed.

The original card order line structure was also observed during the trace. It
was preserved at the user's explicit request to keep existing payment behavior;
the test provider checks the amount handed to the callback, not live gateway
validation of those order lines.

68 combined backend/client tests passed with no skips or failures; the 6 admin
tests had also passed. Run client integration tests with a local
`MONGODB_TEST_URI` using:

```text
node --test ../mint_website/test/paymentAlternatives.test.mjs
```

Run that command from `booking_backend` in the shared workspace with frontend
dependencies installed. No production records were changed or deleted during
the trace.
