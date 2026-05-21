// cron-plate-pair-learn
//
// Learns inferred_plate_pairs from temporally-correlated cross-camera reads.
// At Charlotte the same truck transits TS4467 (south) and C4467 (north)
// within ~5–10 seconds; TS4467 typically reads the front-grille placard and
// C4467 the rear license plate. Persisting (front_plate ↔ back_plate) lets
// us close out passes when only one of the two plates is on the
// registration, and lets registration backfill suggest the missing plate.
//
// Why this is a cron and not at-ingest:
//   - We want ONE observation per truck transit, not per OCR read. A cluster
//     of 5 plate_events from one drive-through must collapse to 1 observation.
//     Doing this at-ingest requires per-read state and complex dedup;
//     batching naturally clusters then upserts once.
//   - Robust to single OCR misreads: by picking the MODAL plate per camera
//     across PR + onboard-TS reads in a cluster, a one-off mis-OCR doesn't
//     poison the pair.
//   - Cheap. Charlotte produces ~hundreds of reads/hour; bundling a 5-min
//     window is single-digit ms.
//
// Schedule: every 60s via pg_cron.
//
// Window: processes plate_events from the last 10 minutes. Overlapping
// re-runs are safe — the upsert RPC's min-gap parameter (5 min default)
// ensures observations only bump on genuinely-new transits.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// How far back to look on each run. Overlap with prior runs is fine — the
// RPC dedupes per-transit via min-gap.
const LOOKBACK_MS = 10 * 60 * 1000;

// Cluster rules. Match the dashboard's bundleVehicleEvents semantics so
// what the operator sees and what we learn from agree.
const SAME_CAM_GAP_SEC = 5;
const SAME_CAM_PLATE_SIMILAR_GAP_SEC = 60;
// 15s was empirically validated against 44 operator-labeled pairs: 30/32
// pairs in this window were true positives (94% precision), capturing
// 88% of verified pairs vs 68% at 10s and no additional false positives
// vs 10s. Going to 20s reintroduces back-to-back-truck FPs (4 instead
// of 2). See state-of-the-union notes 2026-05-21.
const CROSS_CAM_GAP_SEC = 15;

// Confidence floor on a single read before it's eligible to contribute to a
// modal vote. Below this the read is mostly noise.
const READ_CONF_FLOOR = 0.4;

// Levenshtein distance below which two plates are considered OCR variants
// of each other (not distinct front/back). We won't pair plates whose modal
// representatives are this close — they're almost certainly the same plate
// read by different cameras / sources, not front+back.
const PAIR_DISTINCT_MIN_LEV = 2;

// Plate-shape filter. We learn pairs ONLY for things that look like real
// license plates — never for USDOT numbers, company decals, or vanity text
// the OCR engines occasionally pick up. The PR / Milesight LPRs are tuned
// for plates but still surface decal text like "SUPREM", "RAVENS",
// "UCK1NGC0M" — those are not pair-able with anything.
//
// Rules (intentionally conservative; bias toward dropping ambiguous reads):
//   - Length 5-8 (US plate range; trims partials and over-long OCR strings)
//   - No DOT-/MC-prefix synthetic plates (those are USDOT/MC numbers, not
//     line-of-sight plates, and registration handles them via dedicated columns)
//   - No 5+ consecutive letters (catches vanity words while keeping 4-letter
//     commercial prefixes like QZVH98 that some states actually issue)
function isPlateLike(normalized: string): boolean {
  if (!normalized) return false;
  if (normalized.length < 5 || normalized.length > 8) return false;
  if (/^(DOT|MC)\d+$/.test(normalized)) return false;
  if (/[A-Z]{5,}/.test(normalized)) return false;
  return true;
}

type PlateEvent = {
  id: string;
  property_id: string;
  camera_id: string;
  normalized_plate: string | null;
  confidence: number | null;
  created_at: string;
};

type Bundle = {
  events: PlateEvent[];
  // last seen ts per camera (epoch sec) — used by the same-cam/cross-cam rules
  cams: Map<string, number>;
  plates: Set<string>;
};

function levenshtein(a: string, b: string): number {
  if (!a || !b) return Math.max((a || "").length, (b || "").length);
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 3) return 99;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const curr = [i, ...Array(n).fill(0)];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[n];
}

function similarPlate(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a))) return true;
  if (a.length >= 4 && b.length >= 4 && levenshtein(a, b) <= 2) return true;
  return false;
}

// Bundle events into vehicle-transit clusters. Mirrors
// frontend/dashboard.html::bundleVehicleEvents.
function bundleEvents(events: PlateEvent[]): Bundle[] {
  const sorted = [...events].sort((a, b) =>
    new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );
  const bundles: Bundle[] = [];
  for (const ev of sorted) {
    if (!ev.normalized_plate) continue;
    const ts = new Date(ev.created_at).getTime() / 1000;
    let placed = false;
    // Only scan back ~30 bundles. Older transits are too old to absorb.
    for (let i = bundles.length - 1; i >= Math.max(0, bundles.length - 30); i--) {
      const b = bundles[i];
      const lastInCam = b.cams.get(ev.camera_id);
      const lastAny = Math.max(...Array.from(b.cams.values()));
      const plate = ev.normalized_plate;
      const plateMatchInBundle = Array.from(b.plates).some((p) => similarPlate(plate, p));

      if (lastInCam !== undefined) {
        const gap = ts - lastInCam;
        if (gap <= SAME_CAM_GAP_SEC || (gap <= SAME_CAM_PLATE_SIMILAR_GAP_SEC && plateMatchInBundle)) {
          b.events.push(ev);
          b.plates.add(plate);
          b.cams.set(ev.camera_id, ts);
          placed = true;
          break;
        }
      } else if (lastAny !== undefined && (ts - lastAny) <= CROSS_CAM_GAP_SEC) {
        b.events.push(ev);
        b.plates.add(plate);
        b.cams.set(ev.camera_id, ts);
        placed = true;
        break;
      }
    }
    if (!placed) {
      bundles.push({
        events: [ev],
        cams: new Map([[ev.camera_id, ts]]),
        plates: new Set([ev.normalized_plate]),
      });
    }
  }
  return bundles;
}

// Pick the modal plate for one camera's reads in a cluster.
// Vote = count; tiebreak by sum of confidence (so high-conf reads outweigh
// low-conf in a tie). Returns null if no eligible read.
function modalPlatePerCamera(
  reads: Array<{ plate: string; confidence: number }>,
): string | null {
  if (reads.length === 0) return null;
  const scores = new Map<string, { count: number; totalConf: number }>();
  for (const r of reads) {
    const e = scores.get(r.plate) ?? { count: 0, totalConf: 0 };
    e.count += 1;
    e.totalConf += r.confidence;
    scores.set(r.plate, e);
  }
  const ranked = Array.from(scores.entries()).sort(
    (a, b) => b[1].count - a[1].count || b[1].totalConf - a[1].totalConf,
  );
  return ranked[0][0];
}

// One cluster → up to N pair upserts (one per pair of cross-camera modals).
async function processCluster(
  db: SupabaseClient,
  propertyId: string,
  cluster: Bundle,
): Promise<{ pairs_upserted: number }> {
  // Need 2+ cameras in the cluster for cross-camera pairing.
  if (cluster.cams.size < 2) return { pairs_upserted: 0 };

  // Group reads by camera, applying the confidence floor.
  const byCamera = new Map<string, Array<{ plate: string; confidence: number }>>();
  for (const ev of cluster.events) {
    if (!isPlateLike(ev.normalized_plate ?? "")) continue;
    const conf = Number(ev.confidence ?? 0);
    if (conf < READ_CONF_FLOOR) continue;
    const arr = byCamera.get(ev.camera_id) ?? [];
    arr.push({ plate: ev.normalized_plate as string, confidence: conf });
    byCamera.set(ev.camera_id, arr);
  }

  // Modal plate per camera.
  const cameraModals = new Map<string, string>();
  for (const [camId, reads] of byCamera) {
    const modal = modalPlatePerCamera(reads);
    if (modal) cameraModals.set(camId, modal);
  }
  if (cameraModals.size < 2) return { pairs_upserted: 0 };

  // Use the cluster's last-event time as p_seen_at.
  const seenAtIso = cluster.events[cluster.events.length - 1].created_at;

  // Pairwise across cameras' modals.
  const camIds = Array.from(cameraModals.keys());
  let upserted = 0;
  for (let i = 0; i < camIds.length; i++) {
    for (let j = i + 1; j < camIds.length; j++) {
      const plateI = cameraModals.get(camIds[i])!;
      const plateJ = cameraModals.get(camIds[j])!;
      if (plateI === plateJ) continue;
      // Don't pair OCR variants of the same plate (same plate read by both
      // cameras — not front+back).
      if (levenshtein(plateI, plateJ) < PAIR_DISTINCT_MIN_LEV) continue;

      const { error } = await db.rpc("upsert_inferred_plate_pair", {
        p_property_id: propertyId,
        p_plate_a: plateI,
        p_plate_b: plateJ,
        p_plate_a_camera_id: camIds[i],
        p_plate_b_camera_id: camIds[j],
        p_seen_at: seenAtIso,
      });
      if (error) {
        console.error("upsert_inferred_plate_pair failed", {
          propertyId,
          plateI,
          plateJ,
          error: error.message,
        });
      } else {
        upserted += 1;
      }
    }
  }
  return { pairs_upserted: upserted };
}

export async function learn(db: SupabaseClient, now: Date = new Date()): Promise<{
  events_scanned: number;
  clusters: number;
  pairs_upserted: number;
}> {
  const since = new Date(now.getTime() - LOOKBACK_MS).toISOString();
  const { data: events, error } = await db
    .from("plate_events")
    .select("id, property_id, camera_id, normalized_plate, confidence, created_at")
    .gte("created_at", since)
    .order("property_id", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(5000);
  if (error) throw error;

  const byProp = new Map<string, PlateEvent[]>();
  for (const e of events ?? []) {
    if (!e.property_id) continue;
    const arr = byProp.get(e.property_id) ?? [];
    arr.push(e as PlateEvent);
    byProp.set(e.property_id, arr);
  }

  let totalClusters = 0;
  let totalPairs = 0;
  for (const [propertyId, evs] of byProp) {
    const clusters = bundleEvents(evs);
    totalClusters += clusters.length;
    for (const cluster of clusters) {
      const { pairs_upserted } = await processCluster(db, propertyId, cluster);
      totalPairs += pairs_upserted;
    }
  }

  return {
    events_scanned: events?.length ?? 0,
    clusters: totalClusters,
    pairs_upserted: totalPairs,
  };
}

serve(async (_req) => {
  try {
    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const summary = await learn(db);
    console.log("cron-plate-pair-learn", summary);
    return new Response(JSON.stringify(summary), {
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    console.error("cron-plate-pair-learn failed", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
});
