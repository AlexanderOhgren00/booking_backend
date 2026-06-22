// ---------------------------------------------------------------------------
// Short-TTL in-memory cache for the per-day booking-slot query.
// The booking page hammers GET /bookings/:year/:month/:day with identical
// requests (many users viewing the same day in the same few seconds). This
// cache collapses those repeated reads to memory hits without changing the
// response: the cached payload is the exact same array the DB query returns.
//
// Correctness: the cache is fully cleared on every broadcast() (i.e. whenever
// any slot-mutating event fires), and entries also expire after
// BOOKINGS_CACHE_TTL_MS as a backstop, so availability can never be served
// stale beyond that window.
// ---------------------------------------------------------------------------
export const BOOKINGS_CACHE_TTL_MS = 20 * 1000;

const bookingsCache = new Map(); // key: "year-month-day" -> { data, expires }

export function getCachedBookings(key) {
  const hit = bookingsCache.get(key);
  if (hit && hit.expires > Date.now()) {
    return hit.data;
  }
  if (hit) bookingsCache.delete(key); // expired
  return null;
}

export function setCachedBookings(key, data) {
  bookingsCache.set(key, { data, expires: Date.now() + BOOKINGS_CACHE_TTL_MS });
}

export function clearBookingsCache() {
  bookingsCache.clear();
}
