import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { bundleEvidence } from "./no_reg_violations.ts";

Deno.test("module loads and exports are wired", () => {
  assertEquals(typeof bundleEvidence, "function");
});

Deno.test("bundleEvidence: maps weak_plate_reads rows to evidence items", () => {
  const rows = [
    { id: "r1", image_url: "https://r2/a.jpg", seen_at: "2026-05-14T08:14:03Z", confidence: 0.78, camera_id: "cam_s1" },
    { id: "r2", image_url: "https://r2/b.jpg", seen_at: "2026-05-14T08:14:07Z", confidence: 0.94, camera_id: "cam_s1", source: "pr_cloud" as const },
  ];
  const out = bundleEvidence(rows);
  assertEquals(out.length, 2);
  assertEquals(out[0], { url: "https://r2/a.jpg", taken_at: "2026-05-14T08:14:03Z", confidence: 0.78, camera_id: "cam_s1", source: "sidecar" });
  assertEquals(out[1], { url: "https://r2/b.jpg", taken_at: "2026-05-14T08:14:07Z", confidence: 0.94, camera_id: "cam_s1", source: "pr_cloud" });
});
