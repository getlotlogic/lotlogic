// Verdict presentation — spec §5.5's table. Pure and framework-free so a
// truck's tow verdict can be unit-tested without a browser: every caller
// (the Lookup page today; Slack later) renders the same {signal, glyph,
// tone, reason} for a given (verdict, detail, scope), so "DO NOT TOW" and
// "ELIGIBLE TO TOW" never drift between surfaces.
//
// `tone` is one of 'go' | 'stop' | 'amber' | 'neutral' — the caller maps
// 'go'/'stop' to the `--verdict-go`/`--verdict-stop` tokens (dashboard.html
// :root/.theme-light) with fixed inks (#0E0F11 on go, #F5F5F0 on stop —
// these never flip with theme: a solid safety color needs the same ink in
// both themes), and 'amber' to the existing `--accent` token with the new
// `--verdict-amber-ink` token. A verdict is for ONE property — spec §5.5's
// opening rule — so nothing here ever renders a cross-property match as a
// green DO NOT TOW; that's why `on_file_elsewhere` and `grouped` exist.

const UNKNOWN = Object.freeze({
  signal: "Can't read this answer — check in LotLogic",
  glyph: '?',
  tone: 'amber',
  reason: '',
});

function fmtClock(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function hoursAgo(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.round((Date.now() - d.getTime()) / 3600000));
}

// Short per-property descriptor for a grouped card's lines[] — signal words
// stay for the urgent verdicts (hold / hold_unconfirmed / tow_requested) so
// a scanning eye still catches TOW REQUESTED; the quiet ones read as plain
// English, matching the spec's own grouped example verbatim ("parking
// pass", not "DO NOT TOW", for a plain pass).
function groupedLine(match) {
  const d = match?.detail || {};
  switch (match?.verdict) {
    case 'hold': return `DO NOT TOW${d.ref ? ' ' + d.ref : ''}`;
    case 'hold_unconfirmed': return `HOLD — NOT CONFIRMED${d.ref ? ' ' + d.ref : ''}`;
    case 'resident':
    case 'guest': return 'parking pass';
    case 'expired_guest': return 'parking pass expired';
    case 'tow_requested': return `TOW REQUESTED${d.ref ? ' ' + d.ref : ''}`;
    default: return "can't read this answer";
  }
}

export function verdictPresentation(verdict, detail, scope) {
  const d = detail || {};
  switch (verdict) {
    case 'hold': {
      const bits = [`Hold ${d.ref || ''} by ${d.property_name || 'the property'} · until ${d.expires_local || ''}`];
      if (d.note) bits.push(`"${d.note}"`);
      if (d.placed_at) bits.push(`placed by the office ${fmtClock(d.placed_at)}`);
      return { signal: 'DO NOT TOW', glyph: '✋', tone: 'go', reason: bits.join(' · ') };
    }
    case 'resident':
    case 'guest': {
      let reason = `Parking pass · ${d.property_name || 'the property'}`;
      if (d.hours_left != null) reason += ` · ${d.hours_left}h left`;
      return { signal: 'DO NOT TOW', glyph: '✓', tone: 'go', reason };
    }
    case 'expired_guest': {
      const ago = d.hours_ago != null ? d.hours_ago : hoursAgo(d.valid_until || d.expires_at);
      let reason = 'Parking pass expired';
      if (ago != null) reason += ` ${ago}h ago`;
      reason += ` · ${d.property_name || 'the property'}`;
      return { signal: 'ELIGIBLE TO TOW', glyph: '!', tone: 'amber', reason };
    }
    case 'tow_requested': {
      const when = d.placed_at || d.created_at;
      const bits = [`Requested by ${d.property_name || 'the property'} office${when ? ' ' + fmtClock(when) : ''}`];
      if (d.note) bits.push(`"${d.note}"`);
      if (d.ref) bits.push(d.ref);
      return { signal: 'TOW REQUESTED', glyph: '🚨', tone: 'stop', reason: bits.join(' · ') };
    }
    case 'not_registered': {
      const reason = scope === 'all'
        ? 'No parking pass or hold at any N Style property'
        : `No parking pass or hold at ${d.property_name || 'this property'}`;
      return { signal: 'ELIGIBLE TO TOW', glyph: '✗', tone: 'stop', reason };
    }
    case 'hold_unconfirmed': {
      const bits = [`Hold ${d.ref || ''} by ${d.property_name || 'the property'} (not yet confirmed by N Style)`];
      if (d.signed_up_by) bits.push(`signed up by ${d.signed_up_by}${d.signup_phone ? ' · ' + d.signup_phone : ''}`);
      if (d.expires_local) bits.push(`until ${d.expires_local}`);
      return { signal: 'HOLD — PROPERTY NOT CONFIRMED', glyph: '⚠', tone: 'amber', reason: bits.join(' · ') };
    }
    case 'on_file_elsewhere': {
      const name = d.property_name || 'another property';
      return {
        signal: `ON FILE AT ${name.toUpperCase()}`,
        glyph: 'ⓘ',
        tone: 'amber',
        reason: `Pass or hold is for ${name}, not this lot`,
        propertyId: d.property_id ?? null,
        propertyName: name,
      };
    }
    case 'grouped': {
      const matches = Array.isArray(d.matches) ? d.matches : [];
      return { signal: null, glyph: null, tone: 'neutral', reason: '', lines: matches.map(m => `At ${m.property_name}: ${groupedLine(m)}`) };
    }
    default:
      return { ...UNKNOWN };
  }
}

// `verdict_for_partner` (Task 8) never returns `on_file_elsewhere` — it's a
// client-side overlay (spec §5.5, final paragraph): when scope = All and
// the remembered property isn't among the matches, a single signal word
// would read as a verdict for THIS lot when it isn't one, so the Lookup
// page renders the amber "on file elsewhere" card instead. With no
// remembered property to compare against, there's no "this lot" to protect
// — render the backend's own answer unchanged.
export function resolveAllScopeResult(result, rememberedPropertyId) {
  const matches = Array.isArray(result?.matches) ? result.matches : [];
  if (matches.length === 0) return { verdict: 'not_registered', detail: {} };

  if (rememberedPropertyId && !matches.some(m => m.property_id === rememberedPropertyId)) {
    const top = matches[0]; // backend orders verified-first, then by VERDICT_ORDER
    return { verdict: 'on_file_elsewhere', detail: { property_id: top.property_id, property_name: top.property_name } };
  }

  if (result?.verdict === 'grouped') return { verdict: 'grouped', detail: { matches } };

  const m = matches.find(x => x.property_id === rememberedPropertyId) || matches[0];
  return { verdict: result?.verdict, detail: m?.detail || {} };
}

// Partner's apartments + (when available) "All <company> properties" —
// Task 20 Step 2: the route doesn't exist on the live backend until Task 8
// ships, so the All option is rendered only once a probe has proven it's
// there (`partnerLookupAvailable`).
export function scopeOptions({ properties, partnerLookupAvailable, companyName } = {}) {
  const opts = (properties || []).map(p => ({ value: p.id, label: p.name || p.address || p.id }));
  if (partnerLookupAvailable) {
    opts.push({ value: 'all', label: companyName ? `All ${companyName} properties` : 'All properties' });
  }
  return opts;
}
