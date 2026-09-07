import React from 'react';
const { useState, useEffect, useCallback, useRef, useMemo, memo } = React;
import { supabase } from '../lib/supabase.js';
import { db } from '../lib/db.js';
import { fmtDate, fmtTime } from '../lib/format.js';
import { useIntervalFetch } from '../hooks.js';
import { useFocusTrap, useUid } from '../ui/focusTrap.js';
import { ConfirmActionModal } from '../ui/Dialog.jsx';

// ── Confirmation review — billing_status queues per alpr_violations row ────
// Classifies each row by the same CASE logic as the DB view
// v_violation_billing_status (raw strings), then maps to 7 display buckets:
//   fraud / verify / unreported_confirmed / confirmed / pending / no_tow /
//   held_or_forced. Polls every 15s.

// Mirrors v_violation_billing_status (migration 20260418011558_tow_confirmation.sql:55-66)
// for all DB-backed buckets — returns the RAW status string so any code that
// compares against the DB view's output stays in lockstep. One INTENTIONAL
// divergence: the leading `cooldown` branch below is a client-only bucket the
// live view does NOT emit (cooldown rows are segregated in the UI; the backend
// billing query excludes them separately). Do NOT collapse buckets here; that's
// render-time formatting, see displayBucketFor below.
function computeBillingStatus(v) {
  const a = v.action_taken;
  const conf = !!v.tow_confirmed_at;
  const dispatched = v.dispatched_at ? new Date(v.dispatched_at) : null;
  // Cooldown AUTO-FLAG rows are never tow-eligible and never enter the
  // QuickBooks pipeline. Visually segregated into their own queue so operators
  // don't confuse them with billable tow events. The backend billing query
  // excludes them separately (violation_type='cooldown' AND action_taken!='tow').
  // A cooldown row with a RECORDED TOW (action_taken='tow', from the Parking
  // Log "tow" button via POST /violations/record-tow) is real enforcement and
  // must bill like any other tow — let it fall through to the normal
  // classification below (it resolves to 'confirmed' once tow_confirmed_at is set).
  if (v.violation_type === 'cooldown' && v.action_taken !== 'tow') return 'cooldown_breach';
  if (v.left_before_tow_at)                     return 'left_before_tow';
  if (a === 'plate_correction')                 return 'no_tow';
  if (a === 'tow'     && conf)                  return 'confirmed';
  if (a == null       && conf)                  return 'unreported_confirmed';
  if (a === 'tow'     && !conf)                 return 'reported_unconfirmed';
  if (a === 'no_tow'  && conf)                  return 'disputed';
  if (a === 'no_tow'  && !conf)                 return 'no_tow';
  if (a == null && dispatched && (Date.now() - dispatched.getTime()) > 24 * 3600 * 1000) return 'no_tow_timeout';
  return 'pending';
}

// Pure raw-status → display-bucket mapper. Keeps classification (which matches
// the DB view verbatim) separate from the 7-queue UI grouping. Operator-override
// rows (billing_held_at / force_bill_at) are handled at call-site, not here.
function displayBucketFor(rawStatus) {
  switch (rawStatus) {
    case 'left_before_tow':       return 'left_before_tow';
    case 'disputed':              return 'fraud';
    case 'reported_unconfirmed':  return 'verify';
    case 'unreported_confirmed':  return 'unreported_confirmed';
    case 'confirmed':             return 'confirmed';
    case 'pending':               return 'pending';
    case 'no_tow':                return 'no_tow';
    case 'no_tow_timeout':        return 'no_tow';
    case 'manually_held':         return 'held_or_forced';
    case 'force_billed':          return 'held_or_forced';
    case 'cooldown_breach':       return 'cooldown_breach';
    default:                      return 'pending';
  }
}

// Visible queue ordering for the UI (urgency-first). Keyed by display bucket.
// Glyphs make the tone distinguishable without relying on color alone
// (WCAG 1.4.1 — Use of Color). Mirror glyphs are used by status chips below.
const REVIEW_QUEUES = [
  { id: 'left_before_tow',      title: 'Left before tow',       desc: 'Vehicle exited after dispatch but before the tow truck arrived.',  empty: 'No vehicles exited before the tow truck arrived in this window.',               tone: 'amber', glyph: '\u25C6' /* ◆ */ },
  { id: 'fraud',                title: 'Possible fraud',        desc: 'Camera and partner disagree. Review before billing.',             empty: 'No disputes \u2014 partners and cameras agree on every tow.',                  tone: 'red',   glyph: '!'  },
  { id: 'verify',               title: 'Needs verification',    desc: 'Partner reported a tow but no camera sighting. Confirm manually.', empty: 'No pending manual verifications.',                                            tone: 'amber', glyph: '\u25C6' /* ◆ */ },
  { id: 'unreported_confirmed', title: 'Unreported confirmed',  desc: 'Camera confirmed a tow but partner never responded.',              empty: 'No camera-confirmed tows missing partner action.',                             tone: 'amber', glyph: '\u25C6' },
  { id: 'confirmed',            title: 'Confirmed',             desc: 'Happy path — ready to bill on the weekly run.',                    empty: 'No newly-confirmed tows this window. Check Earnings for history.',              tone: 'green', glyph: '\u2713' /* ✓ */ },
  { id: 'pending',              title: 'Pending',               desc: 'Still waiting on partner response and camera sighting.',           empty: 'Nothing pending. Next dispatch will appear here automatically.',               tone: 'gray',  glyph: '\u2014' /* — */ },
  { id: 'cooldown_breach',      title: 'Cooldown breach',       desc: 'Pass holder re-registered inside the 24h cooldown. Not billable.',      empty: 'No cooldown breaches in this window.',                                          tone: 'gray',  glyph: '\u2014' },
  { id: 'no_tow',               title: 'No tow',                desc: 'Partner said no-tow, or dispatched >24h with no sighting.',        empty: 'No cancelled / no-tow records in this window.',                                tone: 'gray',  glyph: '\u2014' },
  { id: 'held_or_forced',       title: 'Held / force-billed',   desc: 'Operator overrides — frozen or force-billed rows.',                empty: 'No operator overrides. Nothing frozen, nothing force-billed.',                 tone: 'blue',  glyph: '\u275A\u275A' /* ❚❚ */ },
];

const TONE_COLORS = {
  red:   { fg: '#ef4444', bg: 'rgba(239,68,68,.12)',  border: 'rgba(239,68,68,.3)' },
  amber: { fg: '#f59e0b', bg: 'rgba(245,158,11,.12)', border: 'rgba(245,158,11,.3)' },
  green: { fg: '#10b981', bg: 'rgba(16,185,129,.12)', border: 'rgba(16,185,129,.3)' },
  gray:  { fg: '#9ca3af', bg: 'rgba(156,163,175,.12)',border: 'rgba(156,163,175,.3)' },
  blue:  { fg: '#60a5fa', bg: 'rgba(96,165,250,.12)', border: 'rgba(96,165,250,.3)' },
  purple:{ fg: '#a78bfa', bg: 'rgba(167,139,250,.12)',border: 'rgba(167,139,250,.3)' },
};

function channelIcon(ch) {
  if (ch === 'email_action')       return { label: 'Email',     icon: '\u2709' };  // envelope
  if (ch === 'sms_reply')          return { label: 'SMS',       icon: '\uD83D\uDCAC' }; // speech bubble
  if (ch === 'dashboard')          return { label: 'Dashboard', icon: '\u2630' };  // hamburger
  if (ch === 'dashboard_override') return { label: 'Override',  icon: '\u270E' };  // pencil
  return null;
}

// Endpoint key → db method. One place to add/rename a violation override
// without touching the modal plumbing.
const OPERATOR_ACTION_CALLERS = {
  'force-bill':      (id, reason) => db.forceBillViolation(id, reason),
  'mark-no-tow':     (id, reason) => db.markViolationNoTow(id, reason),
  'pause-billing':   (id, reason) => db.pauseViolationBilling(id, reason),
  'resume-billing':  (id)         => db.resumeViolationBilling(id),
};

// Evidence thumbnail. 80x60 on desktop, 56x42 on mobile. When `src` is present
// the element is a button that opens the shared lightbox; when missing it
// falls back to a neutral placeholder with the plate text centered.
// Props:
//   src       - image URL (nullable)
//   plate     - plate text for the placeholder + fallback alt text
//   label     - short descriptor rendered under the thumb ("Plate", "Tow")
//   onOpen    - (src, caption, downloadHref) => void, called when clicked
//   timestamp - ISO timestamp used in the lightbox caption
function EvidenceThumb({ src, plate, label, onOpen, timestamp, mobile }) {
  const dim = mobile ? { w: 56, h: 42, fs: 10 } : { w: 80, h: 60, fs: 11 };
  const caption = (plate || '—') + ' · ' + (label || 'snapshot') +
    (timestamp ? ' · ' + fmtDate(timestamp) + ' ' + fmtTime(timestamp) : '');
  const commonBoxStyle = {
    width: dim.w, height: dim.h, borderRadius: 6, border: '1px solid var(--border)',
    overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--bg-inset)', flexShrink: 0,
  };
  if (!src) {
    // Placeholder: monospace plate text centered on inset bg. Stays a div so
    // it isn't mistaken for an interactive element.
    return React.createElement('div', {
      role: 'img',
      'aria-label': (label || 'snapshot') + ' unavailable for ' + (plate || 'unknown plate'),
      title: 'No snapshot available',
      style: Object.assign({}, commonBoxStyle, {
        fontFamily: 'ui-monospace, Menlo, monospace', fontSize: dim.fs,
        fontWeight: 700, color: 'var(--text-faint)', letterSpacing: '.02em',
      }),
    }, plate || '—');
  }
  return React.createElement('button', {
    type: 'button',
    onClick: (e) => { e.stopPropagation(); onOpen && onOpen(src, caption, src); },
    'aria-label': 'Enlarge ' + (label || 'snapshot') + ' for ' + (plate || 'unknown plate'),
    title: caption,
    style: Object.assign({}, commonBoxStyle, {
      cursor: 'zoom-in', padding: 0, position: 'relative',
    }),
  },
    React.createElement('img', {
      src,
      alt: (label || 'snapshot') + ' for ' + (plate || 'unknown plate'),
      loading: 'lazy',
      style: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
    }),
  );
}

// Full-screen image viewer. Reuses the focus-trap + ESC handling from PR #75
// via the shared useFocusTrap hook so keyboard users can dismiss the overlay
// the same way they dismiss ConfirmActionModal.
function ImageLightbox({ src, caption, downloadHref, onClose }) {
  const dialogRef = useRef(null);
  const titleId = useUid('lightbox-title');
  useFocusTrap(dialogRef, true, onClose);
  return React.createElement('div', {
    onClick: onClose,
    style: {
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,.82)', zIndex: 1100,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    },
  },
    React.createElement('div', {
      ref: dialogRef,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': titleId,
      tabIndex: -1,
      onClick: (e) => e.stopPropagation(),
      style: { maxWidth: 'min(1100px, 98vw)', maxHeight: '92vh', display: 'flex', flexDirection: 'column', gap: 10, outline: 'none' },
    },
      React.createElement('img', {
        src,
        alt: caption || 'Evidence snapshot',
        style: { maxWidth: '100%', maxHeight: '80vh', objectFit: 'contain', borderRadius: 6, border: '1px solid rgba(255,255,255,.12)' },
      }),
      React.createElement('div', {
        style: {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 10, color: '#f9fafb', fontSize: 12,
        },
      },
        React.createElement('div', { id: titleId, style: { flex: 1, minWidth: 0, opacity: .9 } }, caption || 'Evidence snapshot'),
        React.createElement('div', { style: { display: 'flex', gap: 8, flexShrink: 0 } },
          downloadHref && React.createElement('a', {
            href: downloadHref,
            target: '_blank',
            rel: 'noopener noreferrer',
            download: '',
            style: {
              fontSize: 11, fontWeight: 700, padding: '5px 10px', borderRadius: 6,
              border: '1px solid rgba(255,255,255,.25)', background: 'rgba(255,255,255,.08)',
              color: '#f9fafb', textDecoration: 'none',
            },
          }, 'Download'),
          React.createElement('button', {
            type: 'button',
            onClick: onClose,
            'aria-label': 'Close image viewer',
            autoFocus: true,
            style: {
              fontSize: 11, fontWeight: 700, padding: '5px 10px', borderRadius: 6,
              border: '1px solid rgba(255,255,255,.25)', background: 'rgba(255,255,255,.08)',
              color: '#f9fafb', cursor: 'pointer',
            },
          }, 'Close'),
        ),
      ),
    ),
  );
}

// Vertical 5-step review timeline: Detected, Dispatched, Acted, Confirmed,
// Invoiced. Each step has a filled dot if the event occurred, hollow
// otherwise. Timestamps render local time, channel icon decorates the
// "Acted" step so operators can tell how the partner responded at a glance.
function TimelineStrip({ row }) {
  const detectedAt = (row._plate_event && row._plate_event.created_at) || row.created_at;
  const dispatchedAt = row.dispatched_at || row.sms_sent_at;
  const actedAt = row.action_at;
  const confirmedAt = row.tow_confirmed_at;
  const invoicedAt = row.invoiced_at;
  const channel = channelIcon(row.action_channel);
  const evidence = row.tow_confirmation || null;

  const steps = [
    { key: 'detected',   label: 'Detected',   at: detectedAt,  icon: null },
    { key: 'dispatched', label: 'Dispatched', at: dispatchedAt, icon: channel && (row.sms_sent_at && !row.dispatched_at) ? { icon: '\uD83D\uDCAC', label: 'SMS' } : null, note: row.dispatched_at ? null : (row.sms_sent_at ? 'SMS only' : null) },
    { key: 'acted',      label: 'Acted',      at: actedAt,      icon: channel, note: row.action_taken || null },
    { key: 'confirmed',  label: 'Confirmed',  at: confirmedAt,  icon: confirmedAt ? { icon: '\uD83D\uDCF7', label: 'camera_sighting' } : null, note: evidence && typeof evidence.delta_seconds === 'number' ? `plate Δ +${Math.round(evidence.delta_seconds)}s` : null },
    { key: 'invoiced',   label: 'Invoiced',   at: invoicedAt,   icon: null,  note: row.quickbooks_invoice_id ? ('QB ' + String(row.quickbooks_invoice_id).slice(0, 8)) : null },
  ];

  return React.createElement('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 3, margin: '6px 0 4px', paddingLeft: 2 },
  },
    steps.map((s, idx) => {
      const happened = !!s.at;
      return React.createElement('div', {
        key: s.key,
        style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: happened ? 'var(--text-muted)' : 'var(--text-faint)' },
      },
        React.createElement('span', {
          'aria-hidden': true,
          style: {
            display: 'inline-block', width: 9, height: 9, borderRadius: 999,
            background: happened ? TONE_COLORS.green.fg : 'transparent',
            border: '1.5px solid ' + (happened ? TONE_COLORS.green.fg : 'var(--border)'),
            flexShrink: 0,
          },
        }),
        React.createElement('span', { style: { width: 78, flexShrink: 0, color: happened ? 'var(--text-secondary)' : 'var(--text-faint)', fontWeight: 600 } }, s.label),
        React.createElement('span', { style: { flex: 1 } },
          happened
            ? (fmtDate(s.at) + '  ' + fmtTime(s.at))
            : '\u2014',
        ),
        s.icon && React.createElement('span', {
          title: 'Via ' + s.icon.label,
          style: { display: 'inline-flex', alignItems: 'center', gap: 3, padding: '0 5px', borderRadius: 4, background: 'var(--bg-inset)', border: '1px solid var(--border)', color: 'var(--text-muted)' },
        }, s.icon.icon),
        s.note && React.createElement('span', {
          style: { fontSize: 10, color: 'var(--text-faint)', fontStyle: 'italic' },
        }, s.note),
      );
    }),
  );
}

// Pass-on-this-plate panel. Surfaces a visitor_pass row that matches the
// violation's plate — diagnostic for disputes because if a legit pass
// exists, the tow likely shouldn't have happened.
function PassContextPanel({ pass }) {
  if (!pass) return null;
  const validFrom = pass.valid_from ? (fmtDate(pass.valid_from) + ' ' + fmtTime(pass.valid_from)) : '—';
  const validUntil = pass.valid_until ? (fmtDate(pass.valid_until) + ' ' + fmtTime(pass.valid_until)) : '—';
  const activeNow = pass.status === 'active' && pass.valid_until
    ? new Date(pass.valid_until).getTime() > Date.now() : false;
  const tone = activeNow ? TONE_COLORS.amber : TONE_COLORS.gray;
  const bits = [];
  if (pass.visitor_name) bits.push({ label: 'Pass holder', value: pass.visitor_name });
  if (pass.company_name) bits.push({ label: '', value: pass.company_name });
  if (pass.parking_spot) bits.push({ label: 'spot', value: pass.parking_spot });
  return React.createElement('div', {
    style: {
      margin: '6px 0 2px', padding: '6px 8px', borderRadius: 6,
      background: tone.bg, border: `1px solid ${tone.border}`,
      fontSize: 11, color: 'var(--text-secondary)', display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center',
    },
  },
    React.createElement('span', {
      style: { fontWeight: 700, color: tone.fg, textTransform: 'uppercase', letterSpacing: '.04em', fontSize: 10 },
    }, activeNow ? 'Active pass on this plate' : 'Past pass on this plate'),
    bits.map((b, i) => React.createElement('span', { key: i },
      b.label ? (b.label + ' ') : '',
      React.createElement('strong', { style: { color: 'var(--text-primary)' } }, b.value),
    )),
    pass.policy_acknowledged_at && React.createElement('span', { title: 'Policy acknowledged at ' + new Date(pass.policy_acknowledged_at).toLocaleString() },
      'policy ', React.createElement('span', { style: { color: TONE_COLORS.green.fg } }, '\u2713'), ' ', fmtTime(pass.policy_acknowledged_at),
    ),
    React.createElement('span', null, 'valid ', validFrom, ' \u2192 ', validUntil),
  );
}

export function ConfirmationReviewView({ user, lots, partnersProp }) {
  const [rows, setRows] = React.useState(null);
  const [err, setErr] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [actingId, setActingId] = React.useState(null);
  const [expanded, setExpanded] = React.useState(() => new Set(['fraud', 'verify']));
  // Staged operator action waiting on modal confirmation. null == closed.
  // Shape: { violationId, plate, endpoint, label, destructive }
  const [pendingAction, setPendingAction] = React.useState(null);
  // Image viewer (lightbox) state — null or { src, caption, downloadHref }.
  const [lightbox, setLightbox] = React.useState(null);
  // Filter state. `rangeDays` drives the `created_at` lower bound. The
  // property selector is owner-only — partners are scoped to their own
  // tow_company_id via RLS anyway.
  const [rangeDays, setRangeDays] = React.useState(7);
  const [propertyFilter, setPropertyFilter] = React.useState('all');
  const partnerName = React.useMemo(() => {
    const m = {};
    (partnersProp || []).forEach(p => { m[p.id] = p.company_name || p.contact_name; });
    return m;
  }, [partnersProp]);
  // Property lookup map (id → {name, tow_company_id}). Populated from the
  // `properties` pre-query in refresh — feeds the property filter dropdown
  // and provides fallback labels if the FK join doesn't hydrate.
  const [propMap, setPropMap] = React.useState({});
  // True when the violations fetch hit its page ceiling. Never let a
  // truncated queue read as an empty one on a surface that gates billing.
  const [truncated, setTruncated] = React.useState(false);

  const ownerId = user?.id;
  const role = user?._role === 'partner' ? 'partner' : 'owner';

  const refresh = React.useCallback(async (silent = false) => {
    if (!ownerId || !supabase) { setRows([]); return; }
    if (!silent) setBusy(true);
    setErr('');
    try {
      const propCol = role === 'partner' ? 'tow_company_id' : 'owner_id';
      const propQ = await supabase.from('properties').select('id, name, owner_id, tow_company_id').eq(propCol, ownerId);
      if (propQ.error) throw new Error(propQ.error.message);
      const props = propQ.data || [];
      const propIds = props.map(p => p.id);
      const pm = {};
      props.forEach(p => { pm[p.id] = { name: p.name, tow_company_id: p.tow_company_id }; });
      setPropMap(pm);
      if (propIds.length === 0) { setRows([]); return; }
      // Window is driven by the operator-selected range, clamped 1-90 days.
      const winDays = Math.max(1, Math.min(90, rangeDays || 7));
      const since = new Date(Date.now() - winDays * 86400000).toISOString();
      // PAGE, don't cap. These rows drive the seven Confirmation Review queues,
      // and those queues gate invoicing. A single .limit(400) over an
      // operator-selectable window (up to 90 days, multi-property) silently
      // dropped the OLDEST rows — precisely the ones aging toward the weekly
      // invoicing run — so "Possible fraud: 0" could mean "not fetched" while
      // reading as "all clear". There is no truncation banner on this surface
      // to catch it either.
      const VIOL_PAGE = 500;
      const VIOL_MAX_PAGES = 20; // 10k rows; guards a runaway query
      const baseRows = [];
      let violTruncated = false;
      for (let page = 0; page < VIOL_MAX_PAGES; page++) {
        const { data, error } = await supabase
          .from('alpr_violations')
          .select('id, property_id, plate_text, status, action_taken, action_channel, action_at, tow_confirmed_at, tow_confirmation, billing_held_at, force_bill_at, invoiced_at, dispatched_at, sms_sent_at, violation_type, created_at, notes, plate_event_id, quickbooks_invoice_id, properties(name, tow_company_id)')
          .in('property_id', propIds)
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .range(page * VIOL_PAGE, page * VIOL_PAGE + VIOL_PAGE - 1);
        if (error) throw new Error(error.message);
        baseRows.push(...(data || []));
        if (!data || data.length < VIOL_PAGE) break;
        if (page === VIOL_MAX_PAGES - 1) violTruncated = true;
      }
      // Surfaced in the UI — if we ever DO truncate, say so rather than
      // letting a short queue read as an empty one.
      setTruncated(violTruncated);

      // Batch-fetch joined plate_events in two buckets:
      //   (1) the original detection snapshot (alpr_violations.plate_event_id)
      //   (2) the truck-sighting snapshot (tow_confirmation.truck_entry_event_id)
      // One .in() query covers both — O(1) round-trips regardless of row count.
      const plateEventIds = Array.from(new Set(baseRows.map(r => r.plate_event_id).filter(Boolean)));
      const truckEventIds = Array.from(new Set(baseRows
        .map(r => r.tow_confirmation && r.tow_confirmation.truck_entry_event_id)
        .filter(Boolean)));
      const allEventIds = Array.from(new Set([...plateEventIds, ...truckEventIds]));
      const eventsById = {};
      if (allEventIds.length > 0) {
        const { data: events, error: eventsErr } = await supabase
          .from('plate_events')
          .select('id, image_url, confidence, event_type, created_at')
          .in('id', allEventIds);
        if (eventsErr) throw new Error(eventsErr.message);
        (events || []).forEach(ev => { eventsById[ev.id] = ev; });
      }

      // Batch-fetch the most recent visitor_pass per (property_id, plate_text)
      // pair present in the current row set. RLS already restricts reads to
      // the caller's properties so the wide-in is safe.
      const plateTexts = Array.from(new Set(baseRows.map(r => (r.plate_text || '').trim().toUpperCase()).filter(Boolean)));
      const passesByKey = {};
      if (plateTexts.length > 0 && propIds.length > 0) {
        // Paged, not capped. A truncated join here is worse than a missing
        // row: the violation renders with NO matching pass, which in a queue
        // whose entire purpose is "was this truck actually registered when we
        // towed it" is indistinguishable from "there was never a pass" — a
        // fraud-queue false positive pointed at a real customer.
        const PASS_PAGE = 500;
        const passes = [];
        for (let page = 0; page < 20; page++) {
          const { data: chunk, error: passesErr } = await supabase
            .from('visitor_passes')
            .select('id, property_id, plate_text, visitor_name, company_name, parking_spot, phone, valid_from, valid_until, status, policy_acknowledged_at, stay_days, created_at')
            .in('property_id', propIds)
            .in('plate_text', plateTexts)
            .order('created_at', { ascending: false })
            .range(page * PASS_PAGE, page * PASS_PAGE + PASS_PAGE - 1);
          if (passesErr) throw new Error(passesErr.message);
          passes.push(...(chunk || []));
          if (!chunk || chunk.length < PASS_PAGE) break;
        }
        (passes || []).forEach(p => {
          const key = p.property_id + '|' + (p.plate_text || '').trim().toUpperCase();
          // First write wins — passes are ordered newest-first.
          if (!passesByKey[key]) passesByKey[key] = p;
        });
      }

      const enriched = baseRows.map(r => {
        const plateEv = r.plate_event_id ? eventsById[r.plate_event_id] : null;
        const truckEvId = r.tow_confirmation && r.tow_confirmation.truck_entry_event_id;
        const truckEv = truckEvId ? eventsById[truckEvId] : null;
        const passKey = r.property_id + '|' + (r.plate_text || '').trim().toUpperCase();
        const pass = passesByKey[passKey] || null;
        return { ...r, _plate_event: plateEv, _truck_event: truckEv, _pass: pass };
      });
      setRows(enriched);
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [ownerId, role, rangeDays]);

  // Poll every 15 s per spec. Runs once immediately on mount (no race
  // against the first interval tick) and on every `refresh` identity change.
  useIntervalFetch(() => refresh(true), 15000, [refresh]);

  // Fire the currently-staged action through the db helper for the chosen
  // endpoint. `reason` is the trimmed textarea value (may be empty).
  async function confirmPendingAction(reason) {
    if (!pendingAction) return;
    const { violationId, endpoint } = pendingAction;
    const caller = OPERATOR_ACTION_CALLERS[endpoint];
    if (!caller) {
      alert(`Unknown operator action: ${endpoint}`);
      return;
    }
    setActingId(violationId);
    try {
      await caller(violationId, reason || undefined);
      setPendingAction(null);
      await refresh(true);
    } catch (e) {
      alert(e.message);
    } finally {
      setActingId(null);
    }
  }

  // Group rows into display buckets WITHOUT mutating the source rows.
  // Operator overrides (held / force-billed, still un-invoiced) go to the
  // held_or_forced bucket regardless of raw billing status.
  // Rows filtered by the property selector (owner-only; partners see their
  // entire scope via RLS). Done as a derived value so toggling the filter
  // doesn't trigger a refetch.
  const filteredRows = React.useMemo(() => {
    if (!rows) return rows;
    if (propertyFilter === 'all') return rows;
    return rows.filter(r => r.property_id === propertyFilter);
  }, [rows, propertyFilter]);

  const grouped = React.useMemo(() => {
    const buckets = Object.fromEntries(REVIEW_QUEUES.map(q => [q.id, []]));
    (filteredRows || []).forEach(r => {
      const overridden = r.billing_held_at || r.force_bill_at;
      const bucketId = (overridden && !r.invoiced_at)
        ? 'held_or_forced'
        : displayBucketFor(computeBillingStatus(r));
      if (buckets[bucketId]) buckets[bucketId].push(r);
    });
    return buckets;
  }, [filteredRows]);

  const totalCount = (filteredRows || []).length;

  // Summary strip counts. Keep them as a single useMemo so the header doesn't
  // recompute on every keystroke in the reason modal.
  const summary = React.useMemo(() => {
    const r = rows || [];
    return {
      total: r.length,
      fraud: (grouped.fraud || []).length,
      confirmed: (grouped.confirmed || []).length,
      verify: (grouped.verify || []).length,
      unreported: (grouped.unreported_confirmed || []).length,
      pending: (grouped.pending || []).length,
      held: (grouped.held_or_forced || []).length,
    };
  }, [rows, grouped]);

  function toggleQueue(id) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function renderRow(r) {
    const channel = channelIcon(r.action_channel);
    // Resolve the partner (tow company) name with a chain of fallbacks so we
    // never show a raw uuid slice like "abc12345…" in the row metadata. The
    // partnerName map is built from the owner's lots' enforcement_partners;
    // propMap covers the property's denormalised tow_company_id; the FK join
    // on alpr_violations.properties is the last resort. If all three miss we
    // fall back to em-dash rather than a uuid chunk.
    const towCompanyId = r.properties?.tow_company_id || (propMap[r.property_id] && propMap[r.property_id].tow_company_id);
    const partner = towCompanyId
      ? (partnerName[towCompanyId] || '—')
      : '—';
    const propName = r.properties?.name || (propMap[r.property_id] && propMap[r.property_id].name) || '—';
    const evidence = r.tow_confirmation || null;
    const isActing = actingId === r.id;
    const plateEv = r._plate_event;
    const truckEv = r._truck_event;
    const plateConfPct = plateEv && typeof plateEv.confidence === 'number'
      ? Math.round(plateEv.confidence * 100) : null;
    const openLightbox = (src, caption, href) => setLightbox({ src, caption, downloadHref: href });

    // Action set depends on current state. Held rows get Resume; force-billed
    // rows are read-only here (they're heading to invoicing). Everything else
    // gets the three primary overrides. `destructive` endpoints require a
    // reason in the modal and render with a red Confirm button.
    // Partners have zero server-side permission on these endpoints (they
    // 400/403), so the view is purely read-only evidence for them.
    // Cooldown AUTO-FLAG rows are NEVER billable — they're a gate-deny event,
    // no tow ever happens. Suppress the destructive actions entirely so
    // an operator can't accidentally force-bill or invoice one. The
    // QuickBooks weekly cron also excludes cooldown auto-flags
    // (violation_type='cooldown' AND action_taken!='tow'), but the UI gate
    // is the more visible guardrail. A cooldown row with a RECORDED TOW
    // (action_taken='tow') is real enforcement: computeBillingStatus no longer
    // returns 'cooldown_breach' for it, so it flows through the normal billable
    // actions like any other confirmed tow.
    const isCooldownBreach = computeBillingStatus(r) === 'cooldown_breach';
    const actions = [];
    if (role !== 'partner' && !isCooldownBreach) {
      if (r.billing_held_at) {
        actions.push({ key: 'resume-billing', label: 'Resume billing', primary: true });
      } else if (!r.invoiced_at) {
        if (!r.force_bill_at) {
          actions.push({ key: 'force-bill', label: 'Bill anyway', primary: true, destructive: true });
        }
        actions.push({ key: 'mark-no-tow', label: 'Mark no-tow', destructive: true });
        actions.push({ key: 'pause-billing', label: 'Pause billing' });
      }
    }

    return React.createElement('div', { className: 'cr-row', 
      key: r.id,
      style: {
        padding: '10px 12px', borderBottom: '1px solid var(--border)',
        display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 10, alignItems: 'start',
      },
    },
      // Column 1: evidence thumbnails (plate snapshot + optional truck sighting)
      React.createElement('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center' },
      },
        React.createElement('div', { style: { display: 'flex', gap: 4 } },
          React.createElement(EvidenceThumb, {
            src: plateEv && plateEv.image_url,
            plate: r.plate_text,
            label: 'Plate',
            timestamp: (plateEv && plateEv.created_at) || r.created_at,
            onOpen: openLightbox,
          }),
          (truckEv || (evidence && evidence.truck_plate)) && React.createElement(EvidenceThumb, {
            src: truckEv && truckEv.image_url,
            plate: (evidence && evidence.truck_plate) || '',
            label: 'Camera saw truck',
            timestamp: (truckEv && truckEv.created_at) || r.tow_confirmed_at,
            onOpen: openLightbox,
          }),
        ),
      ),
      React.createElement('div', { style: { minWidth: 0 } },
        React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 4 } },
          React.createElement('span', {
            style: {
              fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 13, fontWeight: 700,
              background: 'var(--bg-inset)', padding: '2px 8px', borderRadius: 6,
              border: '1px solid var(--border)', color: 'var(--text-primary)',
            }
          }, r.plate_text || '—'),
          plateConfPct != null && React.createElement('span', {
            title: 'Plate Recognizer OCR confidence',
            style: { fontSize: 11, color: 'var(--text-faint)' },
          }, plateConfPct + '% OCR'),
          r.billing_held_at && React.createElement('span', {
            style: {
              fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 10,
              background: TONE_COLORS.blue.bg, color: TONE_COLORS.blue.fg,
              border: `1px solid ${TONE_COLORS.blue.border}`, textTransform: 'uppercase', letterSpacing: '.04em',
            }
          },
            React.createElement('span', { 'aria-hidden': true, style: { marginRight: 4 } }, '\u275A\u275A'),
            'Held by operator',
          ),
          r.force_bill_at && React.createElement('span', {
            style: {
              fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 10,
              background: TONE_COLORS.purple.bg, color: TONE_COLORS.purple.fg,
              border: `1px solid ${TONE_COLORS.purple.border}`, textTransform: 'uppercase', letterSpacing: '.04em',
            }
          },
            React.createElement('span', { 'aria-hidden': true, style: { marginRight: 4 } }, '\u26A1' /* ⚡ */),
            'Force-billed',
          ),
          r.invoiced_at && React.createElement('span', {
            style: {
              fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 10,
              background: TONE_COLORS.green.bg, color: TONE_COLORS.green.fg,
              border: `1px solid ${TONE_COLORS.green.border}`, textTransform: 'uppercase', letterSpacing: '.04em',
            }
          },
            React.createElement('span', { 'aria-hidden': true, style: { marginRight: 4 } }, '\u2713'),
            'Invoiced',
          ),
        ),
        React.createElement('div', { style: { fontSize: 12, color: 'var(--text-muted)', marginBottom: 2 } },
          // Owner view: "Property — Partner: Acme Tow" (owners manage
          // multiple properties and want to know which partner handled the
          // tow). Partner view: just the property name (they already know
          // the partner is themselves).
          role === 'partner'
            ? propName
            : propName + ' \u2014 Partner: ' + partner,
        ),
        // Compact chip row — kept for quick scanning even though the full
        // timeline below captures the same channel + delta data.
        React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-faint)' } },
          channel && React.createElement('span', {
            title: `Via ${channel.label}`,
            style: { display: 'inline-flex', alignItems: 'center', gap: 3, padding: '1px 6px', borderRadius: 4, background: 'var(--bg-inset)', border: '1px solid var(--border)' },
          }, channel.icon, ' ', channel.label),
          r.action_taken && React.createElement('span', null, 'Partner: ', React.createElement('strong', { style: { color: 'var(--text-secondary)' } }, r.action_taken)),
          evidence && evidence.truck_plate && React.createElement('span', {
            style: { padding: '1px 6px', borderRadius: 4, background: TONE_COLORS.green.bg, color: TONE_COLORS.green.fg, border: `1px solid ${TONE_COLORS.green.border}` },
            title: 'Camera sighting that confirmed this tow',
          }, '\uD83D\uDE9A ', evidence.truck_plate),
          // Delta chip — first-class on disputed rows, still useful elsewhere.
          evidence && typeof evidence.delta_seconds === 'number' && React.createElement('span', {
            title: 'Seconds between partner action and camera sighting',
            style: {
              padding: '1px 6px', borderRadius: 4, fontWeight: 700,
              background: displayBucketFor(computeBillingStatus(r)) === 'fraud' ? TONE_COLORS.red.bg : TONE_COLORS.amber.bg,
              color:      displayBucketFor(computeBillingStatus(r)) === 'fraud' ? TONE_COLORS.red.fg : TONE_COLORS.amber.fg,
              border: '1px solid ' + (displayBucketFor(computeBillingStatus(r)) === 'fraud' ? TONE_COLORS.red.border : TONE_COLORS.amber.border),
            },
          }, `\u0394 ${evidence.delta_seconds >= 0 ? '+' : ''}${Math.round(evidence.delta_seconds)}s`),
        ),
        // Timeline + pass + evidence JSON
        React.createElement(TimelineStrip, { row: r }),
        React.createElement(PassContextPanel, { pass: r._pass }),
        evidence && React.createElement('details', {
          style: { marginTop: 4, fontSize: 11 },
        },
          React.createElement('summary', {
            style: { cursor: 'pointer', color: 'var(--text-faint)', userSelect: 'none' },
          }, 'Evidence JSON'),
          React.createElement('pre', {
            style: {
              margin: '4px 0 0', padding: 8, background: 'var(--bg-inset)',
              border: '1px solid var(--border)', borderRadius: 6,
              fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11,
              color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              maxHeight: 260, overflow: 'auto',
            },
          }, JSON.stringify(evidence, null, 2)),
        ),
      ),
      React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' } },
        actions.length === 0 ? React.createElement('span', { style: { fontSize: 11, color: 'var(--text-faint)' } }, 'No actions') :
        // force-bill and mark-no-tow are one-way destructive operator overrides
        // with real billing implications. They render with a red outline + red
        // text on transparent (distinct from neutral pause/resume pills) and a
        // leading "!" glyph so the visual weight matches the stakes. Hover
        // tints to rgba(239,68,68,.1) per the UX spec.
        actions.map(a => React.createElement('button', {
          key: a.key,
          className: a.destructive ? 'cr-btn-destructive' : 'cr-btn-neutral',
          disabled: isActing,
          onClick: () => setPendingAction({
            violationId: r.id,
            plate: r.plate_text || '',
            endpoint: a.key,
            label: a.label,
            destructive: !!a.destructive,
          }),
        },
          // Leading "!" glyph on destructive actions — visual weight that matches stakes.
          // aria-hidden so screen readers don't announce "exclamation mark" before the label.
          a.destructive && React.createElement('span', { 'aria-hidden': true, style: { marginRight: 4, fontWeight: 800 } }, '!'),
          isActing && actingId === r.id ? '…' : a.label,
        )),
      ),
    );
  }

  return React.createElement('div', null,
    React.createElement('h2', { style: { fontSize: 18, fontWeight: 700, marginBottom: 4, color: 'var(--text-primary)' } }, 'Confirmation review'),
    React.createElement('p', { style: { fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 } },
      'Per-pass billing review. Disputes and verification candidates at the top. Refreshes every 15s.'),

    // Read-only banner for partners — their endpoints 400/403 server-side,
    // so they see evidence only. Disputes go through the owner.
    role === 'partner' && React.createElement('div', {
      style: {
        background: 'rgba(96,165,250,.08)', border: '1px solid rgba(96,165,250,.25)',
        borderRadius: 10, padding: '10px 14px', marginBottom: 12,
        fontSize: 13, color: 'var(--text-primary)', display: 'flex', gap: 10, alignItems: 'flex-start',
      }
    },
      React.createElement('span', { 'aria-hidden': true, style: { fontSize: 14, color: '#FBBF24', lineHeight: 1.2 } }, '\u2139' /* ℹ */),
      React.createElement('div', null,
        React.createElement('strong', { style: { fontWeight: 700 } }, 'Read-only.'),
        ' Your owner handles billing overrides. To contest a row, ',
        React.createElement('a', {
          href: 'mailto:gabriel@lotlogicparking.com?subject=Billing%20review%20question',
          style: { color: '#FBBF24', textDecoration: 'underline', fontWeight: 600 },
        }, 'email LotView support'),
        '.',
      ),
    ),

    err && React.createElement('div', {
      style: { background: 'rgba(239,68,68,.1)', border: '1px solid rgba(239,68,68,.3)', color: '#ef4444', padding: 10, borderRadius: 8, fontSize: 13, marginBottom: 12 }
    }, err),

    // Filter bar — date-range + property selector (owner-only). The 15s
    // polling stays put; the Refresh button in the summary strip is for
    // impatient operators who don't want to wait for the next tick.
    React.createElement('div', {
      style: {
        display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center',
        marginBottom: 10, fontSize: 12, color: 'var(--text-muted)',
      }
    },
      React.createElement('label', {
        style: { display: 'flex', alignItems: 'center', gap: 6 },
      },
        React.createElement('span', { style: { fontSize: 11, color: 'var(--text-faint)' } }, 'Range'),
        React.createElement('select', {
          value: String(rangeDays),
          onChange: e => setRangeDays(Number(e.target.value) || 7),
          style: { fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-inset)', color: 'var(--text-primary)' },
        },
          React.createElement('option', { value: '1' }, 'Last 24h'),
          React.createElement('option', { value: '7' }, 'Last 7 days'),
          React.createElement('option', { value: '14' }, 'Last 14 days'),
          React.createElement('option', { value: '30' }, 'Last 30 days'),
          React.createElement('option', { value: '90' }, 'Last 90 days'),
        ),
      ),
      role === 'owner' && Object.keys(propMap).length > 0 && React.createElement('label', {
        style: { display: 'flex', alignItems: 'center', gap: 6 },
      },
        React.createElement('span', { style: { fontSize: 11, color: 'var(--text-faint)' } }, 'Property'),
        React.createElement('select', {
          value: propertyFilter,
          onChange: e => setPropertyFilter(e.target.value),
          style: { fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-inset)', color: 'var(--text-primary)', maxWidth: 260 },
        },
          React.createElement('option', { value: 'all' }, 'All properties'),
          Object.entries(propMap)
            .sort((a, b) => (a[1].name || '').localeCompare(b[1].name || ''))
            .map(([id, p]) => React.createElement('option', { key: id, value: id }, p.name || id.slice(0, 8))),
        ),
      ),
      propertyFilter !== 'all' && React.createElement('button', {
        onClick: () => setPropertyFilter('all'),
        style: { fontSize: 11, padding: '3px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' },
      }, 'Clear filter'),
    ),

    // Summary strip — at-a-glance verdict on whether this screen needs
    // attention. Fraud and Needs-verification are called out in tone colors
    // because those are the rows that actually block the weekly billing run.
    React.createElement('div', {
      style: {
        display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center',
        marginBottom: 10, fontSize: 12, color: 'var(--text-muted)',
        padding: '10px 12px', background: 'var(--bg-card)',
        border: '1px solid var(--border)', borderRadius: 10,
      }
    },
      React.createElement('span', { style: { fontWeight: 700, color: 'var(--text-primary)' } },
        rows === null ? 'Loading…' : (summary.total + ' row' + (summary.total === 1 ? '' : 's') + ' in last ' + rangeDays + ' day' + (rangeDays === 1 ? '' : 's'))),
      rows !== null && summary.fraud > 0 && React.createElement('span', {
        style: {
          fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
          background: TONE_COLORS.red.bg, color: TONE_COLORS.red.fg, border: `1px solid ${TONE_COLORS.red.border}`,
        }
      }, summary.fraud + ' possible fraud'),
      rows !== null && summary.verify > 0 && React.createElement('span', {
        style: {
          fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
          background: TONE_COLORS.amber.bg, color: TONE_COLORS.amber.fg, border: `1px solid ${TONE_COLORS.amber.border}`,
        }
      }, summary.verify + ' needs verification'),
      rows !== null && summary.confirmed > 0 && React.createElement('span', {
        style: {
          fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
          background: TONE_COLORS.green.bg, color: TONE_COLORS.green.fg, border: `1px solid ${TONE_COLORS.green.border}`,
        }
      }, summary.confirmed + ' confirmed'),
      rows !== null && summary.held > 0 && React.createElement('span', {
        style: {
          fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
          background: TONE_COLORS.blue.bg, color: TONE_COLORS.blue.fg, border: `1px solid ${TONE_COLORS.blue.border}`,
        }
      }, summary.held + ' held / force-billed'),
      // Only claim "all clear" when we actually saw the whole window.
      rows !== null && !truncated && summary.total > 0 && summary.fraud === 0 && summary.verify === 0 && React.createElement('span', {
        style: { color: TONE_COLORS.green.fg, fontSize: 11, fontWeight: 600 },
      }, 'All clear — no disputes in this window.'),
      React.createElement('span', { style: { flex: 1 } }),
      React.createElement('button', {
        onClick: () => refresh(false), disabled: busy,
        style: { fontSize: 11, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', cursor: busy ? 'wait' : 'pointer' }
      }, busy ? 'Refreshing…' : 'Refresh now'),
    ),

    // Honest truncation notice. A short queue must never be mistaken for an
    // empty one on the surface that decides who gets invoiced.
    truncated && React.createElement('div', {
      style: {
        fontSize: 12, fontWeight: 600, padding: '8px 12px', borderRadius: 8,
        background: TONE_COLORS.amber.bg, color: TONE_COLORS.amber.fg,
        border: `1px solid ${TONE_COLORS.amber.border}`, marginBottom: 10,
      },
    }, 'This window has more violations than we loaded. The queue counts below are incomplete — narrow the date range for an accurate review.'),

    rows === null ? null :
    REVIEW_QUEUES.map(q => {
      const items = grouped[q.id] || [];
      const tone = TONE_COLORS[q.tone] || TONE_COLORS.gray;
      const isOpen = expanded.has(q.id);
      return React.createElement('div', {
        key: q.id,
        style: {
          background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12,
          marginBottom: 10, overflow: 'hidden',
        }
      },
        React.createElement('button', {
          onClick: () => toggleQueue(q.id),
          'aria-expanded': isOpen,
          'aria-label': `${q.title} — ${items.length} item${items.length === 1 ? '' : 's'} — ${isOpen ? 'collapse' : 'expand'}`,
          style: {
            width: '100%', textAlign: 'left', background: 'transparent', border: 'none',
            padding: '12px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10,
          },
        },
          React.createElement('span', {
            'aria-hidden': true,
            style: {
              fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 999,
              background: tone.bg, color: tone.fg, border: `1px solid ${tone.border}`,
              textTransform: 'uppercase', letterSpacing: '.04em', minWidth: 48, textAlign: 'center',
            }
          }, items.length),
          React.createElement('div', { style: { flex: 1, minWidth: 0 } },
            React.createElement('div', { style: { fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' } },
              q.glyph
                ? React.createElement(React.Fragment, null,
                    React.createElement('span', { 'aria-hidden': true, style: { color: tone.fg, marginRight: 6, fontWeight: 800 } }, q.glyph),
                    q.title,
                  )
                : q.title,
            ),
            React.createElement('div', { style: { fontSize: 12, color: 'var(--text-muted)', marginTop: 2 } }, q.desc),
          ),
          React.createElement('span', { 'aria-hidden': true, style: { color: 'var(--text-faint)', fontSize: 12 } }, isOpen ? '▾' : '▸'),
        ),
        isOpen && items.length > 0 && React.createElement('div', { style: { borderTop: '1px solid var(--border)' } },
          items.map(renderRow),
        ),
        isOpen && items.length === 0 && React.createElement('div', {
          style: { padding: '10px 14px', fontSize: 12, color: 'var(--text-faint)', borderTop: '1px solid var(--border)' }
        }, q.empty || 'Nothing here.'),
      );
    }),
    pendingAction && React.createElement(ConfirmActionModal, {
      key: 'action-modal-' + pendingAction.violationId + '-' + pendingAction.endpoint,
      plate: pendingAction.plate,
      actionLabel: pendingAction.label,
      description: React.createElement(React.Fragment, null,
        'Applies to plate ',
        React.createElement('strong', { style: { color: 'var(--text-primary)' } }, pendingAction.plate || '—'),
        '. Logged as an operator override.'
      ),
      confirmLabel: pendingAction.label,
      confirmColor: pendingAction.destructive ? '#ef4444' : undefined,
      requireReason: pendingAction.destructive,
      reasonPlaceholder: pendingAction.destructive ? 'Reason (required)' : 'Reason (optional)',
      submitting: actingId === pendingAction.violationId,
      onConfirm: (reason) => confirmPendingAction(reason),
      onCancel: () => { if (actingId !== pendingAction.violationId) setPendingAction(null); },
    }),
    lightbox && React.createElement(ImageLightbox, {
      key: 'cr-lightbox-' + lightbox.src,
      src: lightbox.src,
      caption: lightbox.caption,
      downloadHref: lightbox.downloadHref,
      onClose: () => setLightbox(null),
    }),
  );
}
