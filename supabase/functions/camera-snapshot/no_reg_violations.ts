// Helpers for the no_registration_violations lifecycle.
// Used by:
//  - weak_plate_reads.ts flushGroup (insert/update on unmatched bursts)
//  - cron-no-reg-sweep (status transitions)
//
// See: docs/superpowers/specs/2026-05-14-sc211-possible-no-registration-design.md

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePlate } from "../pr-ingest/normalize.ts";
import { plateSimilar } from "./sessions.ts";

export const EVIDENCE_CAP = 20;
export const LINGER_MS = 10_000;
export const EXIT_GAP_MS = 5 * 60_000;

export type EvidenceItem = {
  url: string;
  taken_at: string;            // ISO timestamp
  confidence: number;
  camera_id: string;
  source: "sidecar" | "pr_cloud";
};

export type NoRegStatus =
  | "pending"
  | "flagged"
  | "resolved_pre_flag"
  | "resolved_late"
  | "dismissed";

export type NoRegViolationRow = {
  id: string;
  property_id: string;
  normalized_plate: string;
  raw_plate: string;
  best_confidence: number;
  presence_strength: "brief" | "lingered";
  first_seen_at: string;
  last_seen_at: string;
  exit_seen_at: string | null;
  status: NoRegStatus;
  flagged_at: string | null;
  resolved_at: string | null;
  resolved_reason: string | null;
  evidence: EvidenceItem[];
  weak_read_ids: string[];
  acted_at: string | null;
  action: "towed" | null;
  created_at: string;
  updated_at: string;
};

// Function signatures — implementations follow.
export async function findOpenViolation(db: SupabaseClient, args: {
  property_id: string;
  normalized_plate: string;
  within_hours: number;
}): Promise<NoRegViolationRow | null> {
  const cutoff = new Date(Date.now() - args.within_hours * 3600_000).toISOString();
  const { data, error } = await db
    .from("no_registration_violations")
    .select("*")
    .eq("property_id", args.property_id)
    .eq("normalized_plate", args.normalized_plate)
    .in("status", ["pending", "flagged"])
    .gt("last_seen_at", cutoff)
    .order("last_seen_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return (data?.[0] as NoRegViolationRow) ?? null;
}

export async function insertViolation(db: SupabaseClient, args: {
  property_id: string;
  normalized_plate: string;
  raw_plate: string;
  best_confidence: number;
  first_seen_at: Date;
  last_seen_at: Date;
  presence_strength: "brief" | "lingered";
  evidence: EvidenceItem[];
  weak_read_ids: string[];
  vehicle_make?:  string | null;
  vehicle_model?: string | null;
  vehicle_color?: string | null;
}): Promise<NoRegViolationRow> {
  const row = {
    property_id: args.property_id,
    normalized_plate: args.normalized_plate,
    raw_plate: args.raw_plate,
    best_confidence: args.best_confidence,
    first_seen_at: args.first_seen_at.toISOString(),
    last_seen_at: args.last_seen_at.toISOString(),
    presence_strength: args.presence_strength,
    status: "pending" as const,
    evidence: args.evidence,
    weak_read_ids: args.weak_read_ids,
    vehicle_make:  args.vehicle_make  ?? null,
    vehicle_model: args.vehicle_model ?? null,
    vehicle_color: args.vehicle_color ?? null,
  };
  const { data, error } = await db
    .from("no_registration_violations")
    .insert(row)
    .select()
    .single();
  if (error) throw error;
  return data as NoRegViolationRow;
}

export async function updateViolation(db: SupabaseClient, id: string, patch: {
  last_seen_at?: Date;
  exit_seen_at?: Date | null;
  presence_strength?: "brief" | "lingered";
  best_confidence?: number;
  evidence_append?: EvidenceItem[];
  weak_read_ids_append?: string[];
}): Promise<void> {
  const { data: current, error: fetchErr } = await db
    .from("no_registration_violations")
    .select("*")
    .eq("id", id)
    .single();
  if (fetchErr) throw fetchErr;

  const update: Record<string, unknown> = {};
  if (patch.last_seen_at) update.last_seen_at = patch.last_seen_at.toISOString();
  if (patch.exit_seen_at !== undefined) {
    update.exit_seen_at = patch.exit_seen_at ? patch.exit_seen_at.toISOString() : null;
  }
  if (patch.presence_strength) update.presence_strength = patch.presence_strength;
  if (patch.best_confidence !== undefined) update.best_confidence = patch.best_confidence;
  if (patch.evidence_append) {
    const merged = [...(current.evidence ?? []), ...patch.evidence_append];
    update.evidence = merged.slice(Math.max(0, merged.length - EVIDENCE_CAP));
  }
  if (patch.weak_read_ids_append) {
    update.weak_read_ids = [...(current.weak_read_ids ?? []), ...patch.weak_read_ids_append];
  }

  const { error: updErr } = await db
    .from("no_registration_violations")
    .update(update)
    .eq("id", id);
  if (updErr) throw updErr;
}

export function bundleEvidence(claimedRows: Array<{
  id: string;
  image_url: string;
  seen_at: string;
  confidence: number;
  camera_id: string;
  source?: "sidecar" | "pr_cloud";
}>): EvidenceItem[] {
  return claimedRows.map((r) => ({
    url: r.image_url,
    taken_at: r.seen_at,
    confidence: r.confidence,
    camera_id: r.camera_id,
    source: r.source ?? "sidecar",
  }));
}

// visitor_passes has no `normalized_plate` column. We fetch raw `plate_text`
// (also `back_plate` / `normalized_back_plate` for two-faced trucks) for all
// passes in the window, normalize client-side, then exact + fuzzy match —
// mirroring findActiveUnexitedPassFuzzy in truck_plaza_exit.ts.
export async function findPassForPlateInWindow(db: SupabaseClient, args: {
  property_id: string;
  normalized_plate: string;
  window_start: Date;
  window_end: Date;
}): Promise<{ id: string; normalized_plate: string } | null> {
  const { data, error } = await db
    .from("visitor_passes")
    .select("id, plate_text, normalized_back_plate")
    .eq("property_id", args.property_id)
    .gte("created_at", args.window_start.toISOString())
    .lte("created_at", args.window_end.toISOString())
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    id: string;
    plate_text: string | null;
    normalized_back_plate: string | null;
  }>;

  const candidates = (r: typeof rows[number]): string[] => {
    const out: string[] = [];
    if (r.plate_text) out.push(normalizePlate(r.plate_text));
    if (r.normalized_back_plate) out.push(r.normalized_back_plate);
    return out;
  };

  // Pass 1: exact normalized match
  for (const r of rows) {
    const norms = candidates(r);
    if (norms.includes(args.normalized_plate)) {
      return { id: r.id, normalized_plate: args.normalized_plate };
    }
  }

  // Pass 2: fuzzy (anchored, OCR-confusion-tolerant). Min length 6 — shorter
  // plates are too loose for the fuzzy matcher (per truck_plaza_exit.ts).
  if (args.normalized_plate.length >= 6) {
    for (const r of rows) {
      const norms = candidates(r);
      if (norms.some((p) => plateSimilar(p, args.normalized_plate, true))) {
        return { id: r.id, normalized_plate: args.normalized_plate };
      }
    }
  }

  return null;
}
