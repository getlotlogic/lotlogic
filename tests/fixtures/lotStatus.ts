/**
 * The State of the Lot contract (spec 2026-10-15-lot-status §2), served from
 * the browser's own network layer so the Lot status tab and the Lookup
 * timeline are tested without the backend (task S7 builds the real routes in
 * parallel to exactly this JSON). Plates, cars, times and reasons only - the
 * payloads never carry a name, unit, phone or document, and neither does this.
 *
 * "Now" is 11:15 PM ET on Thu Oct 15 2026, the 11 pm driver the spec opens
 * with, so a pass ending at 11:40 PM and one at 12:10 AM both fall in the
 * next four hours.
 */
import type { Page, Route } from '@playwright/test';

export const AS_OF = '2026-10-16T03:15:00Z'; // 11:15 PM EDT, Thu Oct 15
const asOf = Date.parse(AS_OF);
const iso = (offsetMs: number) => new Date(asOf + offsetMs).toISOString();
const H = 3600_000;
const M = 60_000;

export const PROPERTY_ID = '11111111-1111-4111-8111-111111111111';

export function lotStatusFixture() {
  return {
    property: { id: PROPERTY_ID, name: 'Spring Lake Apartments', address: '100 Lake Rd, Charlotte, NC', property_type: 'apartment' },
    as_of: AS_OF,
    counts: {
      registered_long_term: 1, short_term_active: 1, pending_protected: 1, holds_active: 1, open_requests: 1,
      towable: 3, expired_24h: 2, expiring_4h: 2, long_term_expired: 1,
    },
    // soonest to lapse first, nulls last
    do_not_tow: [
      { plate: 'SHT5555', vehicle: 'red Mazda CX-5', reason: 'short_term', until: iso(25 * M), ref: null },
      { plate: 'HLD0001', vehicle: 'black Ford F-150', reason: 'hold', until: iso(2 * H), ref: 'H-0012' },
      { plate: 'PND1111', vehicle: 'gray Kia Soul', reason: 'pending', until: iso(30 * H), ref: null },
      { plate: 'LTR2222', vehicle: 'blue Subaru Outback', reason: 'long_term', until: null, ref: null },
    ],
    // longest expired first
    towable: [
      { plate: 'OLD1234', vehicle: '', kind: 'long_term', expired_at: iso(-50 * H), hours_expired: 50, last_check: null },
      { plate: 'ABC1234', vehicle: 'white Honda Civic', kind: 'short_term', expired_at: iso(-3 * H), hours_expired: 3,
        last_check: { at: iso(-1 * H), verdict: 'tow' } },
      { plate: 'DEF5678', vehicle: 'silver Toyota Camry', kind: 'short_term', expired_at: iso(-90 * M), hours_expired: 1,
        last_check: { at: iso(-10 * M), verdict: 'not_registered' } },
    ],
    expiring_soon: [
      { plate: 'XYZ789', vehicle: 'silver Toyota Camry', kind: 'short_term', until: iso(25 * M), minutes_left: 25 },
      { plate: 'LNG4321', vehicle: 'green Jeep Wrangler', kind: 'short_term', until: iso(55 * M), minutes_left: 55 },
    ],
    recent: { filed_24h: 3, approved_24h: 2, rejected_24h: 1, checks_24h: 7, towed_7d: 1 },
    open_requests: [
      { ref: 'H-0012', kind: 'hold', plate: 'HLD0001', vehicle: 'black Ford F-150', created_at: iso(-4 * H), status: 'active', expires_at: iso(2 * H) },
    ],
  };
}

export type LotStatus = ReturnType<typeof lotStatusFixture>;

/** Newest first, the kinds and detail lines the spec gives. */
export function timelineFixture(plate = 'ABC1234') {
  return {
    plate,
    events: [
      { at: iso(-1 * H), kind: 'check', detail: 'DO NOT TOW - parking pass', ref: null, surface: 'slack' },
      { at: iso(-3 * H), kind: 'pass_expired', detail: 'short-term parking pass, 24 h', ref: null, surface: null },
      { at: iso(-27 * H), kind: 'hold_opened', detail: 'hold H-0012 opened by Office', ref: 'H-0012', surface: 'dashboard' },
      { at: iso(-27 * H - 5 * M), kind: 'pass_filed', detail: 'short-term parking pass, 24 h', ref: null, surface: 'public_form' },
    ],
  };
}

export interface Served {
  lotStatusHits: () => number;
  lastQuery: () => URLSearchParams | null;
}

/**
 * Serve the two endpoints. `status` / `timeline` are the bodies (or a status
 * code to fail with); every request is counted so a refresh can be proven.
 */
export async function serveLotStatus(
  page: Page,
  opts: { status?: unknown | number; timeline?: unknown | number } = {},
): Promise<Served> {
  let hits = 0;
  let last: URLSearchParams | null = null;
  const answer = (route: Route, body: unknown) => {
    if (typeof body === 'number') {
      return route.fulfill({ status: body, contentType: 'application/json', body: JSON.stringify({ detail: 'unavailable' }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  };
  await page.route('**/apartment/passes/lot-status**', (route) => {
    hits += 1;
    last = new URL(route.request().url()).searchParams;
    return answer(route, opts.status ?? lotStatusFixture());
  });
  await page.route('**/apartment/passes/timeline**', (route) => {
    const plate = new URL(route.request().url()).searchParams.get('plate') ?? 'ABC1234';
    return answer(route, opts.timeline ?? timelineFixture(plate));
  });
  return { lotStatusHits: () => hits, lastQuery: () => last };
}
