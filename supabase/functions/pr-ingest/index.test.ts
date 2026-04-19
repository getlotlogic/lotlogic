import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { normalizePlate } from "./normalize.ts";

Deno.test("normalizePlate uppercases and strips non-alphanumerics", () => {
  assertEquals(normalizePlate("abc-123"), "ABC123");
  assertEquals(normalizePlate("xyz 789"), "XYZ789");
  assertEquals(normalizePlate("  fm046sc  "), "FM046SC");
  assertEquals(normalizePlate(""), "");
});

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
