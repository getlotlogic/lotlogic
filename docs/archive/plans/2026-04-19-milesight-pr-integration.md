# Milesight SC211 → Plate Recognizer Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single Supabase edge function `pr-ingest` that receives Plate Recognizer webhooks (multipart with image + JSON), stores the JPEG in R2, writes to `plate_events`, runs allowlist matching, and creates `alpr_violations` for unmatched plates.

**Architecture:** One edge function, three internal helpers (R2 uploader, allowlist matcher, plate normalizer), one test file with dependency-injected fakes. PR webhook → URL-secret check → multipart parse → camera lookup → score gate → R2 upload → DB inserts → allowlist match → optional violation insert → 200. Spec at `docs/superpowers/specs/2026-04-19-milesight-pr-integration-design.md`.

**Tech Stack:** Deno (Supabase Edge Functions runtime), TypeScript, `@supabase/supabase-js@2`, `aws4fetch` for R2 SigV4, Deno's built-in `Deno.test` for unit tests.

---

## File Structure

| Path | Purpose |
|---|---|
| `supabase/functions/pr-ingest/index.ts` | `Deno.serve` handler; URL-secret check; orchestrates the pipeline; chooses 200 vs 401 vs 500 |
| `supabase/functions/pr-ingest/pipeline.ts` | Pure orchestration: parse multipart → lookup camera → filter → R2 upload → DB inserts. Takes a `Deps` interface so tests inject fakes. |
| `supabase/functions/pr-ingest/r2.ts` | `uploadJpegToR2(deps, key, bytes)` — SigV4 PutObject via `aws4fetch` |
| `supabase/functions/pr-ingest/match.ts` | `matchPlate(db, propertyId, normalizedPlate)` — checks resident_plates, visitor_passes, parking_registrations in order |
| `supabase/functions/pr-ingest/normalize.ts` | `normalizePlate(text)` — uppercase + strip non-alphanumerics |
| `supabase/functions/pr-ingest/types.ts` | `PrWebhookPayload`, `PrResult`, `Deps`, `MatchOutcome`, etc. |
| `supabase/functions/pr-ingest/deno.json` | Deno import map / lint config |
| `supabase/functions/pr-ingest/index.test.ts` | All unit tests (single file is enough; ~10 cases) |
| `supabase/functions/pr-ingest/fixtures/pr-webhook-sample.json` | Real-shape PR JSON payload for tests |
| `supabase/functions/pr-ingest/fixtures/tiny.jpg` | 1 KB fake JPEG bytes for multipart tests |

Why this split: `pipeline.ts` is the only file doing real work, so it's the only thing tests need to drive. Everything else is either a tiny pure helper (`normalize`, `match`) or an external-call wrapper (`r2`). The handler in `index.ts` is just plumbing and stays untested at the unit level (covered by smoke + E2E).

---

## Task 0: Pre-flight checks (BLOCKING — needs human action)

**Files:** none (env / external systems)

- [ ] **Step 1: Confirm R2 access keys are obtainable**

The spec needs `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` to upload via the S3 API. Currently missing from `.env.local` (per the file). Get them from the Cloudflare dashboard:

- Cloudflare → R2 → Manage R2 API Tokens → Create API token
- Permissions: Object Read & Write
- Specify bucket: `parking-snapshots`
- Save the Access Key ID + Secret as `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` to `/Users/gabe/lotlogic/.env.local`

If this step is skipped, every R2 upload in Tasks 4 and onward will hit a 401 from R2 and the unit tests pass but the deployed function logs nothing but failures.

- [ ] **Step 2: Pick & note the R2 public base URL**

In Cloudflare → R2 → `parking-snapshots` → Settings → Public Access. Enable "Allow public access via r2.dev." Cloudflare returns a URL of shape `https://pub-<hash>.r2.dev`. Save as `R2_PUBLIC_BASE_URL` in `.env.local`. This is what we concatenate with the object key to populate `plate_events.image_url`.

- [ ] **Step 3: Generate `PR_INGEST_URL_SECRET`**

```bash
openssl rand -hex 16
```

Save the output as `PR_INGEST_URL_SECRET` in `.env.local`. This is the trailing path segment in the webhook URL we'll give to PR.

---

## Task 1: Scaffold the edge function

**Files:**
- Create: `supabase/functions/pr-ingest/index.ts`
- Create: `supabase/functions/pr-ingest/deno.json`

- [ ] **Step 1: Create the deno.json with the import map**

Write `supabase/functions/pr-ingest/deno.json`:

```json
{
  "imports": {
    "std/": "https://deno.land/std@0.224.0/",
    "@supabase/supabase-js": "jsr:@supabase/supabase-js@2",
    "aws4fetch": "https://esm.sh/aws4fetch@1.0.20"
  }
}
```

- [ ] **Step 2: Create a stub handler that returns 404**

Write `supabase/functions/pr-ingest/index.ts`:

```ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

Deno.serve(async (req: Request) => {
  return new Response(
    JSON.stringify({ ok: false, error: "not implemented" }),
    { status: 404, headers: { "Content-Type": "application/json" } }
  );
});
```

- [ ] **Step 3: Verify it parses with Deno**

Run from repo root:

```bash
deno check supabase/functions/pr-ingest/index.ts
```

Expected: no output (success). If `deno` isn't installed, install via `brew install deno`.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/pr-ingest/index.ts supabase/functions/pr-ingest/deno.json
git commit -m "feat(pr-ingest): scaffold edge function"
```

---

## Task 2: Plate normalization

**Files:**
- Create: `supabase/functions/pr-ingest/normalize.ts`
- Create: `supabase/functions/pr-ingest/index.test.ts`

- [ ] **Step 1: Write the failing test**

Write `supabase/functions/pr-ingest/index.test.ts`:

```ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { normalizePlate } from "./normalize.ts";

Deno.test("normalizePlate uppercases and strips non-alphanumerics", () => {
  assertEquals(normalizePlate("abc-123"), "ABC123");
  assertEquals(normalizePlate("xyz 789"), "XYZ789");
  assertEquals(normalizePlate("  fm046sc  "), "FM046SC");
  assertEquals(normalizePlate(""), "");
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd supabase/functions/pr-ingest && deno test --allow-net=deno.land,esm.sh,jsr.io
```

Expected: FAIL — module `./normalize.ts` not found.

- [ ] **Step 3: Write the minimal implementation**

Write `supabase/functions/pr-ingest/normalize.ts`:

```ts
export function normalizePlate(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, "");
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd supabase/functions/pr-ingest && deno test --allow-net=deno.land,esm.sh,jsr.io
```

Expected: PASS, 1 test.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/pr-ingest/normalize.ts supabase/functions/pr-ingest/index.test.ts
git commit -m "feat(pr-ingest): plate normalization helper"
```

---

## Task 3: Type definitions

**Files:**
- Create: `supabase/functions/pr-ingest/types.ts`
- Modify: `supabase/functions/pr-ingest/index.test.ts`

- [ ] **Step 1: Write failing type-shape test**

Append to `supabase/functions/pr-ingest/index.test.ts`:

```ts
import type { PrWebhookPayload, PrResult, Deps } from "./types.ts";

Deno.test("PrWebhookPayload has expected shape (compile-time check)", () => {
  const sample: PrWebhookPayload = {
    hook: { target: "https://x", id: 1, event: "image.done" },
    data: {
      filename: "x.jpg",
      timestamp: "2026-04-19T15:00:00Z",
      camera_id: "trillium-front-gate",
      results: [],
    },
  };
  assertEquals(sample.data.camera_id, "trillium-front-gate");
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd supabase/functions/pr-ingest && deno test --allow-net=deno.land,esm.sh,jsr.io
```

Expected: FAIL — `./types.ts` not found.

- [ ] **Step 3: Create types.ts**

Write `supabase/functions/pr-ingest/types.ts`:

```ts
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
```

- [ ] **Step 4: Run to verify pass**

```bash
cd supabase/functions/pr-ingest && deno test --allow-net=deno.land,esm.sh,jsr.io
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/pr-ingest/types.ts supabase/functions/pr-ingest/index.test.ts
git commit -m "feat(pr-ingest): type definitions"
```

---

## Task 4: Allowlist matcher

**Files:**
- Create: `supabase/functions/pr-ingest/match.ts`
- Modify: `supabase/functions/pr-ingest/index.test.ts`

- [ ] **Step 1: Write failing tests for resident match, visitor match, no match**

Append to `supabase/functions/pr-ingest/index.test.ts`:

```ts
import { matchPlate } from "./match.ts";
import { createClient } from "@supabase/supabase-js";

// Build an in-memory fake of the SupabaseClient.from(...).select(...).eq(...) chain
// that returns a fixed array of rows. This mirrors only the shape we use.
function fakeDb(tables: Record<string, any[]>) {
  return {
    from(table: string) {
      const rows = tables[table] ?? [];
      const builder: any = {
        _filtered: rows,
        select() { return builder; },
        eq(col: string, val: any) {
          builder._filtered = builder._filtered.filter((r: any) => r[col] === val);
          return builder;
        },
        gte(col: string, val: any) {
          builder._filtered = builder._filtered.filter((r: any) => r[col] >= val);
          return builder;
        },
        lt(col: string, val: any) {
          builder._filtered = builder._filtered.filter((r: any) => r[col] < val);
          return builder;
        },
        limit(n: number) {
          builder._filtered = builder._filtered.slice(0, n);
          return Promise.resolve({ data: builder._filtered, error: null });
        },
      };
      return builder;
    },
  } as any;
}

const PROPERTY = "00000000-0000-0000-0000-000000000001";
const NOW = new Date("2026-04-19T15:00:00Z");

Deno.test("matchPlate returns resident when resident_plates has active row", async () => {
  const db = fakeDb({
    resident_plates: [
      { id: "r1", property_id: PROPERTY, plate_text: "ABC-123", active: true },
    ],
    visitor_passes: [],
    parking_registrations: [],
  });
  const r = await matchPlate(db, PROPERTY, "ABC123", NOW);
  assertEquals(r.kind, "resident");
  if (r.kind === "resident") assertEquals(r.resident_plate_id, "r1");
});

Deno.test("matchPlate returns visitor_pass when active pass exists", async () => {
  const db = fakeDb({
    resident_plates: [],
    visitor_passes: [{
      id: "v1", property_id: PROPERTY, plate_text: "abc 123",
      valid_from: "2026-04-19T14:00:00Z", valid_until: "2026-04-19T20:00:00Z",
      cancelled_at: null,
    }],
    parking_registrations: [],
  });
  const r = await matchPlate(db, PROPERTY, "ABC123", NOW);
  assertEquals(r.kind, "visitor_pass");
});

Deno.test("matchPlate returns unmatched when nothing applies", async () => {
  const db = fakeDb({ resident_plates: [], visitor_passes: [], parking_registrations: [] });
  const r = await matchPlate(db, PROPERTY, "ABC123", NOW);
  assertEquals(r.kind, "unmatched");
});

Deno.test("matchPlate skips cancelled visitor_pass", async () => {
  const db = fakeDb({
    resident_plates: [],
    visitor_passes: [{
      id: "v1", property_id: PROPERTY, plate_text: "ABC123",
      valid_from: "2026-04-19T14:00:00Z", valid_until: "2026-04-19T20:00:00Z",
      cancelled_at: "2026-04-19T14:30:00Z",
    }],
    parking_registrations: [],
  });
  const r = await matchPlate(db, PROPERTY, "ABC123", NOW);
  assertEquals(r.kind, "unmatched");
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
cd supabase/functions/pr-ingest && deno test --allow-net=deno.land,esm.sh,jsr.io
```

Expected: FAIL — `./match.ts` not found.

- [ ] **Step 3: Implement matchPlate**

Write `supabase/functions/pr-ingest/match.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePlate } from "./normalize.ts";
import type { MatchOutcome } from "./types.ts";

export async function matchPlate(
  db: SupabaseClient,
  propertyId: string,
  normalizedPlate: string,
  now: Date,
): Promise<MatchOutcome> {
  // resident_plates: property_id + active + normalized plate match
  const residents = await db
    .from("resident_plates")
    .select("id,plate_text,active,property_id")
    .eq("property_id", propertyId)
    .eq("active", true)
    .limit(50);
  if (residents.error) throw residents.error;
  for (const row of residents.data ?? []) {
    if (normalizePlate(row.plate_text ?? "") === normalizedPlate) {
      return { kind: "resident", resident_plate_id: row.id };
    }
  }

  // visitor_passes: property_id + plate normalized match + valid_from <= now < valid_until + cancelled_at IS NULL
  const passes = await db
    .from("visitor_passes")
    .select("id,plate_text,property_id,valid_from,valid_until,cancelled_at")
    .eq("property_id", propertyId)
    .limit(200);
  if (passes.error) throw passes.error;
  for (const row of passes.data ?? []) {
    if (row.cancelled_at) continue;
    const from = row.valid_from ? new Date(row.valid_from) : null;
    const until = row.valid_until ? new Date(row.valid_until) : null;
    if (from && now < from) continue;
    if (until && now >= until) continue;
    if (normalizePlate(row.plate_text ?? "") === normalizedPlate) {
      return { kind: "visitor_pass", visitor_pass_id: row.id };
    }
  }

  // parking_registrations: same property_id + plate_number match + status='active' + now < expires_at
  const regs = await db
    .from("parking_registrations")
    .select("id,plate_number,property_id,status,expires_at")
    .eq("property_id", propertyId)
    .eq("status", "active")
    .limit(200);
  if (regs.error) throw regs.error;
  for (const row of regs.data ?? []) {
    const expires = row.expires_at ? new Date(row.expires_at) : null;
    if (expires && now >= expires) continue;
    if (normalizePlate(row.plate_number ?? "") === normalizedPlate) {
      return { kind: "self_registered" };
    }
  }

  return { kind: "unmatched" };
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
cd supabase/functions/pr-ingest && deno test --allow-net=deno.land,esm.sh,jsr.io
```

Expected: PASS, 6 tests total (2 prior + 4 new).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/pr-ingest/match.ts supabase/functions/pr-ingest/index.test.ts
git commit -m "feat(pr-ingest): allowlist matcher (resident/visitor/registration)"
```

---

## Task 5: R2 uploader

**Files:**
- Create: `supabase/functions/pr-ingest/r2.ts`
- Modify: `supabase/functions/pr-ingest/index.test.ts`

- [ ] **Step 1: Write a failing test for the uploader factory shape**

We test the factory produces the right URL on success and surfaces an error on failure. The actual SigV4 call is mocked via a `fetch` injection.

Append to `supabase/functions/pr-ingest/index.test.ts`:

```ts
import { makeR2Uploader } from "./r2.ts";

Deno.test("makeR2Uploader returns public URL on 200", async () => {
  const fakeFetch = async (_url: string, _init: RequestInit) =>
    new Response("", { status: 200 });
  const upload = makeR2Uploader({
    accountId: "acct",
    bucket: "parking-snapshots",
    accessKeyId: "AKIA",
    secretAccessKey: "secret",
    publicBaseUrl: "https://pub-x.r2.dev",
    fetchImpl: fakeFetch as any,
  });
  const r = await upload("foo/bar.jpg", new Uint8Array([1, 2, 3]));
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.url, "https://pub-x.r2.dev/foo/bar.jpg");
});

Deno.test("makeR2Uploader surfaces error on 4xx", async () => {
  const fakeFetch = async () => new Response("denied", { status: 403 });
  const upload = makeR2Uploader({
    accountId: "acct",
    bucket: "parking-snapshots",
    accessKeyId: "AKIA",
    secretAccessKey: "secret",
    publicBaseUrl: "https://pub-x.r2.dev",
    fetchImpl: fakeFetch as any,
  });
  const r = await upload("foo/bar.jpg", new Uint8Array([1]));
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.error.includes("403"), true);
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
cd supabase/functions/pr-ingest && deno test --allow-net=deno.land,esm.sh,jsr.io
```

Expected: FAIL — `./r2.ts` not found.

- [ ] **Step 3: Implement r2.ts**

Write `supabase/functions/pr-ingest/r2.ts`:

```ts
import { AwsClient } from "aws4fetch";
import type { R2Uploader } from "./types.ts";

export type R2Config = {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string;
  fetchImpl?: typeof fetch;
};

export function makeR2Uploader(cfg: R2Config): R2Uploader {
  const aws = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const endpoint = `https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}`;
  const f = cfg.fetchImpl ?? fetch;

  return async (key, bytes) => {
    const url = `${endpoint}/${encodeKey(key)}`;
    const signed = await aws.sign(new Request(url, {
      method: "PUT",
      body: bytes,
      headers: { "Content-Type": "image/jpeg" },
    }));
    const res = await f(signed);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `R2 PutObject ${res.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true, url: `${cfg.publicBaseUrl}/${encodeKey(key)}` };
  };
}

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
cd supabase/functions/pr-ingest && deno test --allow-net=deno.land,esm.sh,jsr.io
```

Expected: PASS, 8 tests total.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/pr-ingest/r2.ts supabase/functions/pr-ingest/index.test.ts
git commit -m "feat(pr-ingest): R2 uploader (S3 SigV4 PutObject)"
```

---

## Task 6: Pipeline — happy path

**Files:**
- Create: `supabase/functions/pr-ingest/pipeline.ts`
- Create: `supabase/functions/pr-ingest/fixtures/pr-webhook-sample.json`
- Create: `supabase/functions/pr-ingest/fixtures/tiny.jpg`
- Modify: `supabase/functions/pr-ingest/index.test.ts`

- [ ] **Step 1: Create the test fixtures**

Write `supabase/functions/pr-ingest/fixtures/pr-webhook-sample.json`:

```json
{
  "hook": { "target": "https://x", "id": 1, "event": "image.done" },
  "data": {
    "filename": "test.jpg",
    "timestamp": "2026-04-19T15:00:00Z",
    "camera_id": "trillium-front-gate",
    "results": [
      {
        "plate": "fm046sc",
        "score": 0.91,
        "dscore": 0.99,
        "box": { "xmin": 100, "ymin": 200, "xmax": 300, "ymax": 280 },
        "region": { "code": "us-ga", "score": 0.85 }
      }
    ],
    "processing_time": 123
  }
}
```

Create the tiny JPEG fixture:

```bash
printf '\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00\xff\xd9' \
  > supabase/functions/pr-ingest/fixtures/tiny.jpg
```

- [ ] **Step 2: Write failing test for happy-path pipeline**

This test builds a real multipart Request and runs `runPipeline` with stubbed deps. We expect: R2 upload called once, plate_events insert called once with expected fields, alpr_violations insert called once (no allowlist hit).

Append to `supabase/functions/pr-ingest/index.test.ts`:

```ts
import { runPipeline } from "./pipeline.ts";
import type { Deps } from "./types.ts";

const CAMERA_ROW = {
  id: "cam-uuid-1",
  property_id: PROPERTY,
  api_key: "trillium-front-gate",
  active: true,
};

function makePipelineDb(opts: {
  cameras?: any[];
  residents?: any[];
  passes?: any[];
  regs?: any[];
  recentEvents?: any[];   // for dedup query
  inserts?: { plateEvents: any[]; violations: any[] };
}) {
  const inserts = opts.inserts ?? { plateEvents: [], violations: [] };
  return {
    from(table: string) {
      const rows: any[] =
        table === "alpr_cameras" ? (opts.cameras ?? [])
        : table === "resident_plates" ? (opts.residents ?? [])
        : table === "visitor_passes" ? (opts.passes ?? [])
        : table === "parking_registrations" ? (opts.regs ?? [])
        : table === "plate_events" ? (opts.recentEvents ?? [])
        : [];
      const builder: any = {
        _filtered: rows,
        select() { return builder; },
        eq(c: string, v: any) { builder._filtered = builder._filtered.filter((r: any) => r[c] === v); return builder; },
        gte(c: string, v: any) { builder._filtered = builder._filtered.filter((r: any) => new Date(r[c]) >= new Date(v)); return builder; },
        lt() { return builder; },
        limit(n: number) {
          builder._filtered = builder._filtered.slice(0, n);
          return Promise.resolve({ data: builder._filtered, error: null });
        },
        maybeSingle() {
          return Promise.resolve({ data: builder._filtered[0] ?? null, error: null });
        },
        insert(row: any) {
          if (table === "plate_events") inserts.plateEvents.push(row);
          if (table === "alpr_violations") inserts.violations.push(row);
          return {
            select() {
              return {
                single() {
                  return Promise.resolve({
                    data: { id: `${table}-uuid-${inserts.plateEvents.length + inserts.violations.length}`, ...row },
                    error: null,
                  });
                },
              };
            },
          };
        },
      };
      return builder;
    },
  } as any;
}

async function buildMultipartRequest() {
  const sample = JSON.parse(
    await Deno.readTextFile(new URL("./fixtures/pr-webhook-sample.json", import.meta.url)),
  );
  const jpeg = await Deno.readFile(new URL("./fixtures/tiny.jpg", import.meta.url));
  const fd = new FormData();
  fd.append("json", JSON.stringify(sample));
  fd.append("upload", new Blob([jpeg], { type: "image/jpeg" }), "snap.jpg");
  return new Request("https://x.supabase.co/functions/v1/pr-ingest/SECRET", {
    method: "POST",
    body: fd,
  });
}

Deno.test("happy path: unknown plate creates plate_events + alpr_violations", async () => {
  const inserts = { plateEvents: [] as any[], violations: [] as any[] };
  const r2Calls: Array<{ key: string; bytes: Uint8Array }> = [];
  const deps: Deps = {
    db: makePipelineDb({ cameras: [CAMERA_ROW], inserts }),
    r2: async (key, bytes) => { r2Calls.push({ key, bytes }); return { ok: true, url: `https://pub-x.r2.dev/${key}` }; },
    env: { PR_MIN_SCORE: 0.8, PR_DEDUP_WINDOW_SECONDS: 0 },
    now: () => NOW,
  };
  const req = await buildMultipartRequest();
  const result = await runPipeline(req, deps);
  assertEquals(result.status, 200);
  assertEquals(inserts.plateEvents.length, 1);
  assertEquals(inserts.plateEvents[0].plate_text, "FM046SC");
  assertEquals(inserts.plateEvents[0].normalized_plate, "FM046SC");
  assertEquals(inserts.plateEvents[0].image_url, r2Calls[0] ? `https://pub-x.r2.dev/${r2Calls[0].key}` : null);
  assertEquals(inserts.violations.length, 1);
  assertEquals(inserts.violations[0].plate_text, "FM046SC");
});
```

- [ ] **Step 3: Run to verify failure**

```bash
cd supabase/functions/pr-ingest && deno test --allow-net=deno.land,esm.sh,jsr.io --allow-read=./fixtures
```

Expected: FAIL — `./pipeline.ts` not found.

- [ ] **Step 4: Implement runPipeline (happy path only)**

Write `supabase/functions/pr-ingest/pipeline.ts`:

```ts
import { normalizePlate } from "./normalize.ts";
import { matchPlate } from "./match.ts";
import type { Deps, PrWebhookPayload } from "./types.ts";

export type PipelineResult = {
  status: number;
  body: Record<string, unknown>;
};

export async function runPipeline(req: Request, deps: Deps): Promise<PipelineResult> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    return { status: 200, body: { ok: false, reason: "multipart_parse_failed", detail: String(err) } };
  }

  const jsonField = form.get("json");
  const upload = form.get("upload");
  if (typeof jsonField !== "string") {
    return { status: 200, body: { ok: false, reason: "missing_json_field" } };
  }

  let payload: PrWebhookPayload;
  try {
    payload = JSON.parse(jsonField);
  } catch (err) {
    return { status: 200, body: { ok: false, reason: "json_parse_failed", detail: String(err) } };
  }

  const cameraId = payload.data.camera_id;
  if (!cameraId) {
    return { status: 200, body: { ok: false, reason: "missing_camera_id" } };
  }

  const cameraQ = await deps.db
    .from("alpr_cameras")
    .select("id,property_id,api_key,active")
    .eq("api_key", cameraId)
    .eq("active", true)
    .limit(1);
  if (cameraQ.error) throw cameraQ.error;
  const camera = (cameraQ.data ?? [])[0];
  if (!camera) {
    return { status: 200, body: { ok: false, reason: "unknown_camera_id", camera_id: cameraId } };
  }

  const surviving = (payload.data.results ?? []).filter((r) => r.score >= deps.env.PR_MIN_SCORE);
  if (surviving.length === 0) {
    return { status: 200, body: { ok: true, events: 0, reason: "all_below_threshold" } };
  }

  const uploadBytes = upload instanceof Blob ? new Uint8Array(await upload.arrayBuffer()) : null;

  let eventCount = 0;
  let violationCount = 0;

  for (const result of surviving) {
    const plateUpper = result.plate.toUpperCase();
    const normalized = normalizePlate(result.plate);
    const epochMs = deps.now().getTime();
    const dateStr = deps.now().toISOString().slice(0, 10);
    const key = `${camera.property_id}/${dateStr}/${camera.api_key}-${epochMs}-${plateUpper}.jpg`;

    let imageUrl: string | null = null;
    let imageError: string | null = null;
    if (uploadBytes) {
      const upRes = await deps.r2(key, uploadBytes);
      if (upRes.ok) imageUrl = upRes.url;
      else imageError = upRes.error;
    }

    // Dedup check
    let dedupSuppressed = false;
    if (deps.env.PR_DEDUP_WINDOW_SECONDS > 0) {
      const since = new Date(deps.now().getTime() - deps.env.PR_DEDUP_WINDOW_SECONDS * 1000).toISOString();
      const recent = await deps.db
        .from("plate_events")
        .select("id,property_id,normalized_plate,created_at")
        .eq("property_id", camera.property_id)
        .eq("normalized_plate", normalized)
        .gte("created_at", since)
        .limit(1);
      if (recent.error) throw recent.error;
      if ((recent.data ?? []).length > 0) dedupSuppressed = true;
    }

    let outcome = dedupSuppressed
      ? { kind: "dedup_suppressed" as const }
      : await matchPlate(deps.db, camera.property_id, normalized, deps.now());

    const matchStatus = outcome.kind;
    const matchReason = outcome.kind === "dedup_suppressed" ? "within window" : null;

    const eventRow: Record<string, unknown> = {
      camera_id: camera.id,
      property_id: camera.property_id,
      plate_text: plateUpper,
      normalized_plate: normalized,
      confidence: result.score,
      image_url: imageUrl,
      event_type: "alpr",
      raw_data: { ...result, _pr_payload: payload.data, ...(imageError ? { image_upload_error: imageError } : {}) },
      match_status: matchStatus,
      match_reason: matchReason,
      matched_at: outcome.kind !== "unmatched" && outcome.kind !== "dedup_suppressed" ? deps.now().toISOString() : null,
      ...(outcome.kind === "resident" ? { resident_plate_id: outcome.resident_plate_id } : {}),
      ...(outcome.kind === "visitor_pass" ? { visitor_pass_id: outcome.visitor_pass_id } : {}),
    };

    const evIns = await deps.db.from("plate_events").insert(eventRow).select().single();
    if (evIns.error) throw evIns.error;
    eventCount++;

    if (outcome.kind === "unmatched") {
      const vIns = await deps.db.from("alpr_violations").insert({
        property_id: camera.property_id,
        plate_event_id: evIns.data.id,
        plate_text: plateUpper,
        status: "pending",
        violation_type: "alpr_unmatched",
      }).select().single();
      if (vIns.error) throw vIns.error;
      violationCount++;
    }
  }

  return { status: 200, body: { ok: true, events: eventCount, violations: violationCount } };
}
```

- [ ] **Step 5: Run tests to verify happy path passes**

```bash
cd supabase/functions/pr-ingest && deno test --allow-net=deno.land,esm.sh,jsr.io --allow-read=./fixtures
```

Expected: PASS, 9 tests. The new "happy path" test should pass.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/pr-ingest/pipeline.ts supabase/functions/pr-ingest/fixtures supabase/functions/pr-ingest/index.test.ts
git commit -m "feat(pr-ingest): pipeline orchestrator (happy path)"
```

---

## Task 7: Pipeline — match-hit cases (resident, visitor)

**Files:** `supabase/functions/pr-ingest/index.test.ts`

- [ ] **Step 1: Add tests for match-hit cases (no violation insert expected)**

Append to `supabase/functions/pr-ingest/index.test.ts`:

```ts
Deno.test("resident match: writes plate_events with status='resident', no violation", async () => {
  const inserts = { plateEvents: [] as any[], violations: [] as any[] };
  const deps: Deps = {
    db: makePipelineDb({
      cameras: [CAMERA_ROW],
      residents: [{ id: "r1", property_id: PROPERTY, plate_text: "fm046sc", active: true }],
      inserts,
    }),
    r2: async (key) => ({ ok: true, url: `https://pub-x.r2.dev/${key}` }),
    env: { PR_MIN_SCORE: 0.8, PR_DEDUP_WINDOW_SECONDS: 0 },
    now: () => NOW,
  };
  const req = await buildMultipartRequest();
  const result = await runPipeline(req, deps);
  assertEquals(result.status, 200);
  assertEquals(inserts.plateEvents.length, 1);
  assertEquals(inserts.plateEvents[0].match_status, "resident");
  assertEquals(inserts.plateEvents[0].resident_plate_id, "r1");
  assertEquals(inserts.violations.length, 0);
});

Deno.test("visitor pass match: writes plate_events with status='visitor_pass', no violation", async () => {
  const inserts = { plateEvents: [] as any[], violations: [] as any[] };
  const deps: Deps = {
    db: makePipelineDb({
      cameras: [CAMERA_ROW],
      passes: [{
        id: "v1", property_id: PROPERTY, plate_text: "FM046SC",
        valid_from: "2026-04-19T14:00:00Z", valid_until: "2026-04-19T20:00:00Z",
        cancelled_at: null,
      }],
      inserts,
    }),
    r2: async (key) => ({ ok: true, url: `https://pub-x.r2.dev/${key}` }),
    env: { PR_MIN_SCORE: 0.8, PR_DEDUP_WINDOW_SECONDS: 0 },
    now: () => NOW,
  };
  const req = await buildMultipartRequest();
  const result = await runPipeline(req, deps);
  assertEquals(result.status, 200);
  assertEquals(inserts.plateEvents[0].match_status, "visitor_pass");
  assertEquals(inserts.plateEvents[0].visitor_pass_id, "v1");
  assertEquals(inserts.violations.length, 0);
});
```

- [ ] **Step 2: Run to verify pass**

```bash
cd supabase/functions/pr-ingest && deno test --allow-net=deno.land,esm.sh,jsr.io --allow-read=./fixtures
```

Expected: PASS, 11 tests.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/pr-ingest/index.test.ts
git commit -m "test(pr-ingest): cover resident and visitor-pass match outcomes"
```

---

## Task 8: Pipeline — failure / edge cases

**Files:** `supabase/functions/pr-ingest/index.test.ts`

- [ ] **Step 1: Add tests for unknown camera, low score, R2 failure, dedup**

Append to `supabase/functions/pr-ingest/index.test.ts`:

```ts
Deno.test("unknown camera_id returns 200 + reason, no inserts", async () => {
  const inserts = { plateEvents: [] as any[], violations: [] as any[] };
  const deps: Deps = {
    db: makePipelineDb({ cameras: [], inserts }),
    r2: async () => ({ ok: false, error: "should not be called" }),
    env: { PR_MIN_SCORE: 0.8, PR_DEDUP_WINDOW_SECONDS: 0 },
    now: () => NOW,
  };
  const req = await buildMultipartRequest();
  const result = await runPipeline(req, deps);
  assertEquals(result.status, 200);
  assertEquals(result.body.reason, "unknown_camera_id");
  assertEquals(inserts.plateEvents.length, 0);
});

Deno.test("all results below PR_MIN_SCORE: no inserts, 200", async () => {
  const inserts = { plateEvents: [] as any[], violations: [] as any[] };
  const deps: Deps = {
    db: makePipelineDb({ cameras: [CAMERA_ROW], inserts }),
    r2: async (key) => ({ ok: true, url: `https://pub-x.r2.dev/${key}` }),
    env: { PR_MIN_SCORE: 0.99, PR_DEDUP_WINDOW_SECONDS: 0 },  // sample fixture has score 0.91
    now: () => NOW,
  };
  const req = await buildMultipartRequest();
  const result = await runPipeline(req, deps);
  assertEquals(result.status, 200);
  assertEquals(inserts.plateEvents.length, 0);
});

Deno.test("R2 upload failure: still writes plate_events with image_url=null", async () => {
  const inserts = { plateEvents: [] as any[], violations: [] as any[] };
  const deps: Deps = {
    db: makePipelineDb({ cameras: [CAMERA_ROW], inserts }),
    r2: async () => ({ ok: false, error: "R2 PutObject 503: backend down" }),
    env: { PR_MIN_SCORE: 0.8, PR_DEDUP_WINDOW_SECONDS: 0 },
    now: () => NOW,
  };
  const req = await buildMultipartRequest();
  const result = await runPipeline(req, deps);
  assertEquals(result.status, 200);
  assertEquals(inserts.plateEvents.length, 1);
  assertEquals(inserts.plateEvents[0].image_url, null);
  assertEquals(inserts.plateEvents[0].raw_data.image_upload_error.includes("503"), true);
});

Deno.test("dedup window > 0 and recent event exists: skips violation insert", async () => {
  const inserts = { plateEvents: [] as any[], violations: [] as any[] };
  const recent = [{ id: "pe1", property_id: PROPERTY, normalized_plate: "FM046SC", created_at: "2026-04-19T14:59:30Z" }];
  const deps: Deps = {
    db: makePipelineDb({ cameras: [CAMERA_ROW], recentEvents: recent, inserts }),
    r2: async (key) => ({ ok: true, url: `https://pub-x.r2.dev/${key}` }),
    env: { PR_MIN_SCORE: 0.8, PR_DEDUP_WINDOW_SECONDS: 300 },
    now: () => NOW,
  };
  const req = await buildMultipartRequest();
  const result = await runPipeline(req, deps);
  assertEquals(result.status, 200);
  assertEquals(inserts.plateEvents.length, 1);
  assertEquals(inserts.plateEvents[0].match_status, "dedup_suppressed");
  assertEquals(inserts.violations.length, 0);
});
```

- [ ] **Step 2: Run tests**

```bash
cd supabase/functions/pr-ingest && deno test --allow-net=deno.land,esm.sh,jsr.io --allow-read=./fixtures
```

Expected: PASS, 15 tests.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/pr-ingest/index.test.ts
git commit -m "test(pr-ingest): cover unknown-camera, low-score, R2-fail, dedup"
```

---

## Task 9: Wire up the handler

**Files:** `supabase/functions/pr-ingest/index.ts`

- [ ] **Step 1: Replace the stub handler with real wiring**

Overwrite `supabase/functions/pr-ingest/index.ts`:

```ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { runPipeline } from "./pipeline.ts";
import { makeR2Uploader } from "./r2.ts";

const URL_SECRET = Deno.env.get("PR_INGEST_URL_SECRET") ?? "";
const PR_MIN_SCORE = Number(Deno.env.get("PR_MIN_SCORE") ?? "0.8");
const PR_DEDUP_WINDOW_SECONDS = Number(Deno.env.get("PR_DEDUP_WINDOW_SECONDS") ?? "0");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const R2_ACCOUNT_ID = Deno.env.get("R2_ACCOUNT_ID")!;
const R2_BUCKET_NAME = Deno.env.get("R2_BUCKET_NAME") ?? "parking-snapshots";
const R2_ACCESS_KEY_ID = Deno.env.get("R2_ACCESS_KEY_ID")!;
const R2_SECRET_ACCESS_KEY = Deno.env.get("R2_SECRET_ACCESS_KEY")!;
const R2_PUBLIC_BASE_URL = Deno.env.get("R2_PUBLIC_BASE_URL")!;

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const r2 = makeR2Uploader({
  accountId: R2_ACCOUNT_ID,
  bucket: R2_BUCKET_NAME,
  accessKeyId: R2_ACCESS_KEY_ID,
  secretAccessKey: R2_SECRET_ACCESS_KEY,
  publicBaseUrl: R2_PUBLIC_BASE_URL,
});

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return json(405, { ok: false, error: "method_not_allowed" });
  }

  // The function is mounted at /functions/v1/pr-ingest. Anything after that is treated as the secret.
  const url = new URL(req.url);
  const trailing = url.pathname.replace(/^\/functions\/v1\/pr-ingest\/?/, "");
  if (!URL_SECRET || trailing !== URL_SECRET) {
    return json(401, { ok: false, error: "unauthorized" });
  }

  try {
    const { status, body } = await runPipeline(req, {
      db,
      r2,
      env: { PR_MIN_SCORE, PR_DEDUP_WINDOW_SECONDS },
      now: () => new Date(),
    });
    return json(status, body);
  } catch (err) {
    // DB/insert errors get 500 so PR retries. Anything else should already have been
    // converted to 200 inside runPipeline. We log loudly so it shows up in `supabase functions logs`.
    console.error("pr-ingest unhandled error:", err);
    return json(500, { ok: false, error: "internal_error", detail: String(err) });
  }
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
```

- [ ] **Step 2: Type-check**

```bash
deno check supabase/functions/pr-ingest/index.ts
```

Expected: no output (success). If any unresolved imports appear, the deno.json import map needs adjustment.

- [ ] **Step 3: Run the full test suite to confirm nothing broke**

```bash
cd supabase/functions/pr-ingest && deno test --allow-net=deno.land,esm.sh,jsr.io --allow-read=./fixtures
```

Expected: 15 tests pass.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/pr-ingest/index.ts
git commit -m "feat(pr-ingest): wire pipeline + R2 + DB into Deno.serve handler"
```

---

## Task 10: Set Supabase secrets

**Files:** none (env on the Supabase project)

- [ ] **Step 1: Source env and push secrets**

The user already has `SUPABASE_ACCESS_TOKEN` in `.env.local`. Run:

```bash
source /Users/gabe/lotlogic/.env.local
curl -s -w "\nHTTP %{http_code}\n" -X POST \
  "https://api.supabase.com/v1/projects/nzdkoouoaedbbccraoti/secrets" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(cat <<EOF
[
  {"name":"PR_INGEST_URL_SECRET","value":"$PR_INGEST_URL_SECRET"},
  {"name":"PR_MIN_SCORE","value":"0.8"},
  {"name":"PR_DEDUP_WINDOW_SECONDS","value":"0"},
  {"name":"R2_ACCOUNT_ID","value":"$CLOUDFLARE_ACCOUNT_ID"},
  {"name":"R2_BUCKET_NAME","value":"$R2_BUCKET_NAME"},
  {"name":"R2_ACCESS_KEY_ID","value":"$R2_ACCESS_KEY_ID"},
  {"name":"R2_SECRET_ACCESS_KEY","value":"$R2_SECRET_ACCESS_KEY"},
  {"name":"R2_PUBLIC_BASE_URL","value":"$R2_PUBLIC_BASE_URL"}
]
EOF
)"
```

Expected: `HTTP 201`. If 4xx, the missing var name is in the error body.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are already injected by the runtime — don't push those.

---

## Task 11: Deploy the edge function

**Files:** none (deploy step)

- [ ] **Step 1: Deploy via the Supabase MCP**

Use `mcp__supabase__deploy_edge_function` with:

- `project_id`: `nzdkoouoaedbbccraoti`
- `name`: `pr-ingest`
- `entrypoint_path`: `index.ts`
- `verify_jwt`: `false` (PR can't attach our JWT)
- `files`: array of `{ name, content }` for every file in `supabase/functions/pr-ingest/` EXCEPT the `index.test.ts`, the `fixtures/` directory, and `deno.json` (re-encode `deno.json` only if needed by the deploy)

If the MCP rejects the deploy, fall back to the Management API:

```bash
source /Users/gabe/lotlogic/.env.local
cd supabase/functions/pr-ingest
zip -r /tmp/pr-ingest.zip index.ts pipeline.ts r2.ts match.ts normalize.ts types.ts deno.json
curl -s -X POST "https://api.supabase.com/v1/projects/nzdkoouoaedbbccraoti/functions/deploy?slug=pr-ingest&verify_jwt=false" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/zip" \
  --data-binary @/tmp/pr-ingest.zip
```

- [ ] **Step 2: Verify the function is listed**

Use `mcp__supabase__list_edge_functions` for project `nzdkoouoaedbbccraoti`. Expected: a new entry with slug `pr-ingest`, `verify_jwt: false`, `status: ACTIVE`.

- [ ] **Step 3: Smoke test the URL secret guard**

```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST \
  "https://nzdkoouoaedbbccraoti.supabase.co/functions/v1/pr-ingest/wrong-secret" \
  -H "Content-Type: multipart/form-data; boundary=x" \
  -d ""
```

Expected: `HTTP 401` with `{"ok":false,"error":"unauthorized"}`.

---

## Task 12: Remove the R2 wipe-all lifecycle rule

**Files:** none (R2 config)

> **CRITICAL ORDERING:** This MUST run AFTER Task 11 (the function exists) and BEFORE the PR webhook is configured. If the rule stays active, every snapshot the function writes is auto-deleted within 24h.

- [ ] **Step 1: Remove the rule**

```bash
wrangler r2 bucket lifecycle remove parking-snapshots wipe-all
```

Expected: `Removed lifecycle rule 'wipe-all' from bucket 'parking-snapshots'.`

- [ ] **Step 2: Verify only the default rule remains**

```bash
wrangler r2 bucket lifecycle list parking-snapshots
```

Expected: only `Default Multipart Abort Rule` listed. No `wipe-all`.

---

## Task 13: Configure the PR webhook (manual, in PR dashboard)

**Files:** none (PR config)

- [ ] **Step 1: Configure the webhook**

In the Plate Recognizer dashboard → Webhooks → Add:

- **Target URL:** `https://nzdkoouoaedbbccraoti.supabase.co/functions/v1/pr-ingest/<PR_INGEST_URL_SECRET>` (the value from Task 0 Step 3)
- **Mode:** Webhook with Image (multipart with image)
- **Event:** `image.done`

Save the webhook.

- [ ] **Step 2: Fire the dashboard's "Test" button**

In the PR dashboard, use the "Send test event" / "Test webhook" button. This POSTs a synthetic payload to our endpoint.

- [ ] **Step 3: Verify the test event landed**

Check Supabase function logs:

```bash
source /Users/gabe/lotlogic/.env.local
curl -s "https://api.supabase.com/v1/projects/nzdkoouoaedbbccraoti/functions/pr-ingest/logs" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" | tail -50
```

Or via MCP: `mcp__supabase__get_logs` with `service: edge-function`.

Expected: a `200` response with body `{"ok": true, ...}` OR `{"ok": false, "reason": "unknown_camera_id", ...}` (if PR's test event uses a `camera_id` we haven't registered yet — that's fine, it proved the pipeline ran).

---

## Task 14: Register one real camera and run end-to-end

**Files:** none (DB + camera config)

- [ ] **Step 1: Insert an alpr_cameras row for the test SC211**

Use `mcp__supabase__execute_sql`:

```sql
INSERT INTO alpr_cameras (id, property_id, name, api_key, active)
VALUES (gen_random_uuid(), '<existing property uuid>', 'Test SC211', 'lotlogic-test-cam-1', true)
RETURNING id, api_key, property_id;
```

Replace `<existing property uuid>` with the uuid of the property the camera belongs to (look up via `SELECT id, name FROM properties LIMIT 5`).

- [ ] **Step 2: Configure the SC211**

In the SC211 web UI:

- Settings → Event → Vehicle Detection → enable ANPR + motion trigger
- Settings → Event → Notification → HTTP:
  - URL: `https://api.platerecognizer.com/v1/plate-reader/`
  - Method: `POST`
  - Body type: `multipart/form-data`
  - Token field: `Authorization: Token <your PR API token>`
  - **camera_id field**: `lotlogic-test-cam-1` (must match what was inserted in Step 1)
  - Trigger: on Vehicle Detection event (NOT continuous)

- [ ] **Step 3: Drive a vehicle past the camera; verify**

Wait ~30 seconds after the vehicle passes, then:

```sql
SELECT id, plate_text, image_url, match_status, created_at
FROM plate_events
ORDER BY created_at DESC
LIMIT 3;
```

Expected: at least one row with the vehicle's plate, an `image_url` pointing at `https://pub-…r2.dev/...`, `match_status` = `unmatched` (assuming the plate isn't on any allowlist).

```sql
SELECT id, plate_text, status, violation_type, created_at
FROM alpr_violations
ORDER BY created_at DESC
LIMIT 3;
```

Expected: a corresponding `alpr_violations` row with `status='pending'`, `violation_type='alpr_unmatched'`.

Open the `image_url` in a browser → the JPEG should render.

---

## Task 15: Flip dedup on, update CLAUDE.md

**Files:** `CLAUDE.md`, Supabase secrets

- [ ] **Step 1: Set PR_DEDUP_WINDOW_SECONDS=300**

```bash
source /Users/gabe/lotlogic/.env.local
curl -s -w "\nHTTP %{http_code}\n" -X PATCH \
  "https://api.supabase.com/v1/projects/nzdkoouoaedbbccraoti/secrets" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '[{"name":"PR_DEDUP_WINDOW_SECONDS","value":"300"}]'
```

Expected: `HTTP 200` or `HTTP 201`.

- [ ] **Step 2: Replace the GUTTED placeholder in CLAUDE.md**

In `CLAUDE.md`, find the line under `## Architecture`:

```
- **Camera-based ALPR / Plate Recognizer ingest**: GUTTED 2026-04-19, full redesign in progress. ...
```

Replace with:

```
- **Camera-based ALPR / Plate Recognizer ingest**: Milesight SC211 → Plate Recognizer (api.platerecognizer.com/v1/plate-reader/) → `pr-ingest` edge fn (multipart with image). `pr-ingest` writes JPEG to R2 `parking-snapshots`, inserts `plate_events`, runs allowlist match against `resident_plates`/`visitor_passes`/`parking_registrations`, and inserts `alpr_violations` for unmatched plates. Camera-to-property mapping via `alpr_cameras.api_key` (free-text). Tow-confirm fan-out and partner dispatch are NOT wired — separate redesign. Spec: `docs/superpowers/specs/2026-04-19-milesight-pr-integration-design.md`.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude.md): document new Milesight → PR → pr-ingest flow"
```

---

## Self-review

Skim back over this plan against the spec, looking for:

1. **Spec coverage:** every requirement in the spec (URL-secret check, multipart parse, camera lookup, score gate, R2 upload, plate_events insert, dedup, allowlist match, alpr_violations insert, error rules, configuration, rollout) has a task. ✓
2. **Placeholders:** no `TODO`, no "implement X", no "write tests for the above" without code. Code blocks present in every code step. ✓
3. **Type consistency:** `Deps`, `R2Uploader`, `MatchOutcome`, `runPipeline` shapes match between `types.ts`, `pipeline.ts`, `index.ts`. `matchPlate` signature `(db, propertyId, normalizedPlate, now)` consistent everywhere. ✓
4. **Critical ordering:** Task 12 (remove lifecycle rule) explicitly gated to run AFTER deploy and BEFORE PR webhook config. ✓
