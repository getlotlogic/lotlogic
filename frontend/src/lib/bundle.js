// ── Truck-plaza vehicle-event bundling ───────────────────────────────────
// Takes raw plate_events at a property and groups them into "vehicle events"
// — one per physical truck that passed through. Rule (operator-approved
// 2026-05-21, see memory/project_truck_plaza_pass_lifecycle.md):
//   • Same camera: join if gap ≤ 5s OR (gap ≤ 60s AND plate Lev≤2 / substring
//     of any plate already in the bundle).
//   • Cross-camera: join if gap ≤ 10s to any prior camera's last seen.
// Returns bundles in a shape compatible with the existing no_registration_
// violations row UI: { id, raw_plate, first_seen_at, last_seen_at, evidence,
// presence_strength, ... } so the rendering code doesn't have to change.
export function bundleVehicleEvents(plateEvents, verifiedPairs = []) {
  // verifiedPairs: { plate_a, plate_b } rows from inferred_plate_pairs
  // where verified_at IS NOT NULL AND dismissed_at IS NULL. These are
  // operator-confirmed identities — two plate strings that belong to
  // the SAME physical vehicle. Because license plates are unique vehicle
  // IDs, two reads of the two plates in a verified pair within any
  // reasonable parking-stay window can only be the same truck. So we
  // merge them aggressively (4-hour window) without the FP risk that
  // unverified-pair merging would carry.
  const synonymOf = new Map(); // plate -> Set<plate>
  for (const { plate_a, plate_b } of verifiedPairs) {
    if (!plate_a || !plate_b) continue;
    if (!synonymOf.has(plate_a)) synonymOf.set(plate_a, new Set([plate_a]));
    if (!synonymOf.has(plate_b)) synonymOf.set(plate_b, new Set([plate_b]));
    synonymOf.get(plate_a).add(plate_b);
    synonymOf.get(plate_b).add(plate_a);
  }
  function platesAreSynonyms(p1, p2) {
    if (!p1 || !p2 || p1 === p2) return p1 === p2;
    return synonymOf.get(p1)?.has(p2) === true;
  }
  // 4 hours covers a typical short truck-plaza stay end-to-end (driver
  // pulls in → registers → eats / sleeps → drives out). Reads of the
  // two plates of a verified pair within this window collapse to one
  // vehicle event.
  const SYNONYM_WINDOW_SEC = 4 * 60 * 60;

  function lev(a, b) {
    if (!a || !b) return Math.max((a || '').length, (b || '').length);
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > 3) return 99;
    const m = a.length, n = b.length;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) {
      const curr = [i, ...Array(n).fill(0)];
      for (let j = 1; j <= n; j++) {
        const cost = a[i-1] === b[j-1] ? 0 : 1;
        curr[j] = Math.min(curr[j-1] + 1, prev[j] + 1, prev[j-1] + cost);
      }
      prev = curr;
    }
    return prev[n];
  }
  function similar(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a))) return true;
    if (a.length >= 4 && b.length >= 4 && lev(a, b) <= 2) return true;
    return false;
  }

  const events = [...plateEvents]
    .filter(e => e && e.created_at)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  const bundles = [];
  for (const ev of events) {
    const evTs = new Date(ev.created_at).getTime() / 1000;
    const plate = ev.normalized_plate || '';
    let placed = false;
    // Scan back through recent bundles. The verified-synonym window
    // (4h) means we may need to merge into a bundle several hours old,
    // so the lookback has to cover that. 200 bundles ≈ 5h at Charlotte
    // traffic (~40 transits/hr), comfortably past the synonym window.
    for (let i = bundles.length - 1; i >= Math.max(0, bundles.length - 200); i--) {
      const b = bundles[i];
      const lastInCam = b.cams[ev.camera_id];
      const lastAny = Math.max(...Object.values(b.cams));
      const plateMatch = plate && [...b.plates].some(p => similar(plate, p));
      // Verified-pair synonym match — operator-confirmed same vehicle.
      // Safe even with a wide window because a plate is a unique
      // vehicle ID; two reads of (plate_a, plate_b) within 4 hours
      // can only be the same physical truck.
      const synonymMatch = plate && [...b.plates].some(p => platesAreSynonyms(plate, p));

      // Same-camera continuation: short gap OR plate-similar within 60s
      // OR verified synonym within the longer window.
      if (lastInCam !== undefined) {
        const gap = evTs - lastInCam;
        if (gap <= 5 || (gap <= 60 && plateMatch) || (gap <= SYNONYM_WINDOW_SEC && synonymMatch)) {
          b.events.push(ev);
          if (plate) b.plates.add(plate);
          b.cams[ev.camera_id] = evTs;
          placed = true;
          break;
        }
      }
      // Cross-camera: a camera this bundle hasn't seen yet, with another
      // camera's read within 10s — OR within the longer window if the
      // plates are a verified synonym pair.
      else if (lastAny !== undefined && ((evTs - lastAny) <= 10 || ((evTs - lastAny) <= SYNONYM_WINDOW_SEC && synonymMatch))) {
        b.events.push(ev);
        if (plate) b.plates.add(plate);
        b.cams[ev.camera_id] = evTs;
        placed = true;
        break;
      }
    }
    if (!placed) {
      bundles.push({
        events: [ev],
        plates: new Set(plate ? [plate] : []),
        cams: { [ev.camera_id]: evTs },
      });
    }
  }

  // Project to the dashboard's expected shape (compatible with the legacy
  // no_registration_violations row consumer).
  return bundles.map(b => {
    const evs = b.events;
    const firstSeen = evs[0].created_at;
    const lastSeen = evs[evs.length - 1].created_at;
    const spanSec = (new Date(lastSeen) - new Date(firstSeen)) / 1000;
    const bestEv = evs.reduce((best, e) =>
      (Number(e.confidence) || 0) > (Number(best?.confidence) || 0) ? e : best,
      evs[0]
    );
    const distinctPlates = [...new Set(evs.map(e => e.normalized_plate).filter(Boolean))];
    const cameras = [...new Set(evs.map(e => e.camera_id))];
    const isLingering = evs.length >= 3 && spanSec >= 60;
    const anyPass = evs.some(e => ['visitor_pass','visitor_pass_fuzzy','overstay'].includes(e.match_status));
    const anyTow = evs.some(e => e.match_status === 'partner_truck');

    return {
      // Stable synthetic id (first plate_event_id) — used as React key.
      id: `bundle-${evs[0].id}`,
      // Compat fields the no-reg row UI expects:
      raw_plate: bestEv.plate_text || bestEv.normalized_plate || '—',
      normalized_plate: bestEv.normalized_plate || '—',
      best_confidence: Number(bestEv.confidence) || 0,
      first_seen_at: firstSeen,
      last_seen_at: lastSeen,
      flagged_at: firstSeen,
      created_at: firstSeen,
      presence_strength: isLingering ? 'lingered' : 'brief',
      status: 'flagged',
      evidence: evs.map(e => ({
        // The plate read's id, not a URL: the dashboard presigns it per render
        // (Wave 2.5 Task 10) instead of pointing an <img> at a permanent
        // public r2.dev address.
        event_id: e.id,
        taken_at: e.created_at,
        confidence: Number(e.confidence) || 0,
        camera_id: e.camera_id,
        source: 'onboard',
      })),
      // New bundle-specific fields the UI can show:
      _bundle: {
        camera_count: cameras.length,
        camera_ids: cameras,
        distinct_plates: distinctPlates,
        is_lingering: isLingering,
        any_pass_matched: anyPass,
        any_tow_matched: anyTow,
        span_seconds: Math.round(spanSec),
        plate_event_ids: evs.map(e => e.id),
      },
    };
  });
}

// Filter to "Possible No Registration Evidence Package" candidates:
// truck genuinely lingered AND no pass match AND no tow match.
// Drive-throughs (singletons / short bursts) and pass-matched vehicles
// stay out of this surface. They're still in plate_events for first-seen
// backfill and other surfaces.
export function filterEvidencePackages(bundles) {
  return bundles.filter(b =>
    b._bundle.is_lingering &&
    !b._bundle.any_pass_matched &&
    !b._bundle.any_tow_matched
  );
}

export function mapsLink(address) {
  return `https://maps.google.com/?q=${encodeURIComponent(address)}`;
}

