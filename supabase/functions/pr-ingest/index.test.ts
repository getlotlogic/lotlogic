import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { normalizePlate } from "./normalize.ts";

Deno.test("normalizePlate uppercases and strips non-alphanumerics", () => {
  assertEquals(normalizePlate("abc-123"), "ABC123");
  assertEquals(normalizePlate("xyz 789"), "XYZ789");
  assertEquals(normalizePlate("  fm046sc  "), "FM046SC");
  assertEquals(normalizePlate(""), "");
});
