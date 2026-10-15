// ── Plate normalization, shared by the three public registration pages ──────
// Moved verbatim out of ./register.js (Task F3) so that pure modules — the
// /apt/ flow model (./aptFlow.js) and the Node tests that import it — can use
// the very same normalizer. ./register.js reads `document` while it loads, so
// nothing outside a browser page can import it; this module touches no DOM.
// ./register.js re-exports both names, so every existing import is unchanged.

// Drivers helpfully append the plate's state/province — "PB36041 ON",
// "3874552 NC", "P886417 ONTARIO". The camera never reads a state suffix,
// so a stored suffix makes the plate permanently unmatchable (observed in
// production: PB36041ON registered, then re-registered correctly 20 min
// later). Byte-identical in visit.html and resident.html; apt.html didn't
// have this constant at all (see normalizePlate below).
export const REGION_TOKENS = new Set((
  'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC ' +
  'AB BC MB NB NL NS NT NU ON PE QC SK YT ' +
  'ALABAMA ALASKA ARIZONA ARKANSAS CALIFORNIA COLORADO CONNECTICUT DELAWARE FLORIDA GEORGIA HAWAII IDAHO ILLINOIS INDIANA IOWA KANSAS KENTUCKY LOUISIANA MAINE MARYLAND MASSACHUSETTS MICHIGAN MINNESOTA MISSISSIPPI MISSOURI MONTANA NEBRASKA NEVADA OHIO OKLAHOMA OREGON PENNSYLVANIA TENNESSEE TEXAS UTAH VERMONT VIRGINIA WASHINGTON WISCONSIN WYOMING ' +
  'ONTARIO QUEBEC ALBERTA SASKATCHEWAN MANITOBA YUKON'
).split(' '));
['NEW HAMPSHIRE','NEW JERSEY','NEW MEXICO','NEW YORK','NORTH CAROLINA','NORTH DAKOTA','SOUTH CAROLINA','SOUTH DAKOTA','RHODE ISLAND','WEST VIRGINIA','NOVA SCOTIA','NEW BRUNSWICK','BRITISH COLUMBIA','PRINCE EDWARD','NORTHWEST TERRITORIES'].forEach(r => REGION_TOKENS.add(r));

// DIVERGENCE (resolved as a deliberate superset — Open Decision 4, brief
// step 2): visit.html and resident.html strip a trailing state/region token
// before uppercasing and stripping non-alphanumerics; apt.html's
// normalizePlate was just `(s || '').toUpperCase().replace(/[^A-Z0-9]/g,
// '')` with no region strip and no REGION_TOKENS at all. The three original
// bodies:
//   visit.html / resident.html (identical):
//     function normalizePlate(s) {
//       let tokens = String(s || '').trim().toUpperCase().split(/[\s,.\-\/]+/).filter(Boolean);
//       let changed = true;
//       while (changed && tokens.length > 1) {
//         changed = false;
//         const last = tokens[tokens.length - 1];
//         const lastTwo = tokens.length > 2 ? tokens[tokens.length - 2] + ' ' + last : null;
//         if (lastTwo && REGION_TOKENS.has(lastTwo)) { tokens.pop(); tokens.pop(); changed = true; }
//         else if (REGION_TOKENS.has(last)) { tokens.pop(); changed = true; }
//       }
//       return tokens.join('').replace(/[^A-Z0-9]/g, '');
//     }
//   apt.html:
//     function normalizePlate(s) {
//       return (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
//     }
// Taking the region-strip version as the superset for all three pages.
// camera-snapshot/index.ts and the backend normalize WITHOUT the region
// strip, so this is a real behaviour change on apt.html: an apartment
// resident/guest who types a plate with a trailing state name will now
// match a camera read where they previously would not (a strict
// improvement — it can only make a previously-unmatchable plate matchable).
// Flagged in task-17-report.md for a yes before merging, per the brief.
export function normalizePlate(s) {
  let tokens = String(s || '').trim().toUpperCase().split(/[\s,.\-\/]+/).filter(Boolean);
  let changed = true;
  // tokens.length > 1 guard: never strip the entry down to nothing — a
  // back plate typed as just "SD" survives here and is rejected by
  // validation instead ("that looks like a state, not a plate").
  while (changed && tokens.length > 1) {
    changed = false;
    const last = tokens[tokens.length - 1];
    const lastTwo = tokens.length > 2 ? tokens[tokens.length - 2] + ' ' + last : null;
    if (lastTwo && REGION_TOKENS.has(lastTwo)) { tokens.pop(); tokens.pop(); changed = true; }
    else if (REGION_TOKENS.has(last)) { tokens.pop(); changed = true; }
  }
  return tokens.join('').replace(/[^A-Z0-9]/g, '');
}
