// Helpers for the no_registration_violations lifecycle.
// Used by:
//  - weak_plate_reads.ts flushGroup (insert/update on unmatched bursts)
//  - cron-no-reg-sweep (status transitions)
//
// See: docs/superpowers/specs/2026-05-14-sc211-possible-no-registration-design.md

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

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
export async function findOpenViolation(_db: SupabaseClient, _args: {
  property_id: string;
  normalized_plate: string;
  within_hours: number;
}): Promise<NoRegViolationRow | null> { throw new Error("not implemented"); }

export async function insertViolation(_db: SupabaseClient, _args: {
  property_id: string;
  normalized_plate: string;
  raw_plate: string;
  best_confidence: number;
  first_seen_at: Date;
  last_seen_at: Date;
  presence_strength: "brief" | "lingered";
  evidence: EvidenceItem[];
  weak_read_ids: string[];
}): Promise<NoRegViolationRow> { throw new Error("not implemented"); }

export async function updateViolation(_db: SupabaseClient, _id: string, _patch: {
  last_seen_at?: Date;
  exit_seen_at?: Date | null;
  presence_strength?: "brief" | "lingered";
  best_confidence?: number;
  evidence_append?: EvidenceItem[];
  weak_read_ids_append?: string[];
}): Promise<void> { throw new Error("not implemented"); }

export function bundleEvidence(_claimedRows: Array<{
  id: string;
  image_url: string;
  seen_at: string;
  confidence: number;
  camera_id: string;
  source?: "sidecar" | "pr_cloud";
}>): EvidenceItem[] { throw new Error("not implemented"); }

export async function findPassForPlateInWindow(_db: SupabaseClient, _args: {
  property_id: string;
  normalized_plate: string;
  window_start: Date;
  window_end: Date;
}): Promise<{ id: string; normalized_plate: string } | null> {
  throw new Error("not implemented");
}
