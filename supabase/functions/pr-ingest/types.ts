import type { SupabaseClient } from "@supabase/supabase-js";

export type PrBox = { xmin: number; ymin: number; xmax: number; ymax: number };

export type PrResult = {
  plate: string;
  score: number;
  dscore?: number;
  box?: PrBox;
  region?: { code: string; score: number };
  candidates?: Array<{ plate: string; score: number }>;
  vehicle?: { score: number; type: string; box: PrBox };
  // mmc-conditional fields are passed through as raw_data; not modeled strictly
};

export type PrWebhookPayload = {
  hook: { target: string; id: number; event: string };
  data: {
    filename: string;
    timestamp: string;
    camera_id: string | null;
    results: PrResult[];
    usage?: { calls: number; max_calls: number };
    processing_time?: number;
  };
};

export type R2Uploader = (key: string, bytes: Uint8Array) => Promise<{
  ok: true;
  url: string;
} | {
  ok: false;
  error: string;
}>;

export type Deps = {
  db: SupabaseClient;
  r2: R2Uploader;
  env: {
    PR_MIN_SCORE: number;
    PR_DEDUP_WINDOW_SECONDS: number;
  };
  now: () => Date;
};

export type MatchOutcome =
  | { kind: "resident"; resident_plate_id: string }
  | { kind: "visitor_pass"; visitor_pass_id: string }
  | { kind: "self_registered" }
  | { kind: "unmatched" };
