import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { bundleEvidence } from "./no_reg_violations.ts";

Deno.test("module loads and exports are wired", () => {
  assertEquals(typeof bundleEvidence, "function");
});
