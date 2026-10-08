# Party discounts for a single date

In admin, open **Partyrabatter**, change **Gäller för** to **Datum**, choose a
calendar date, set the existing group price cap, and select rooms and times.
For the anniversary on Monday, 12 October 2026, select `2026-10-12`.
The price is chosen by the administrator; installing this feature does not
create or apply an anniversary offer automatically.

The existing **Månad och veckodag** option keeps its recurring behavior.
Date mode sends `{ date: "2026-10-12", category, time }` in the existing
`PATCH /bulk-update-offers` request. It targets that exact year, month and day.
Only `available: true` slots receive the `offer` field; occupied/paid bookings,
other rooms, times, dates and years are preserved. No documents are deleted.

Requests are fully validated before any writes or background work. Invalid or
impossible dates return HTTP 400, without falling back to a recurring offer.
Immediate and background processing share the same filters. Zero matching or
modified slots are reported as zero. The admin handles the immediate offer
notification as well as the existing background completion notification,
bypassing its old cached booking data when refreshing the current day.

Customer runtime code, payment requests, and existing party-price calculation
are unchanged. Tests execute the actual admin controls, backend routes, player
selection, and payment completion functions with isolated local MongoDB and
mocked providers/email. They cover desktop/mobile Swish, card, and the retained
Nets private-invoice branch, including the existing party cap and bonus-player
behavior. The existing Swish reservation clears its offer metadata after using
the cap; the confirmed paid cost remains correct and this behavior is preserved.

Additional cases cover other dates/years/rooms/times, occupied and paid slots,
leap days, malformed mixed requests, recurring selection, background chunks,
zero matches, retry after errors, and disabled controls during save. The wider
payment/edit/cancel/reschedule regression suite is also run.

Run backend tests with a local `MONGODB_TEST_URI` using `npm test`. From
`booking_backend`, run client integration tests with the same local URI:

```text
node --test ../mint_website/test/paymentAlternatives.test.mjs
```

These integration tests require the three sibling repositories and their local
dependencies. Run admin tests with `npm test` in `mint_admin`, and build with
`npx vite build`. Without the isolated Mongo URI, database tests explicitly skip.
Validation never starts the production server or sends real payments or email.

Validation result: 78 backend/client tests and 11 admin tests passed, with no
skips or failures. The admin production build, party component lint, backend
syntax checks and whitespace checks passed. Existing CSS and bundle-size build
warnings are unchanged.

Deploy the backend date support before the admin UI. No database migration or
production database modification is needed to install the feature. Live gateway
acceptance is outside the local test run.
