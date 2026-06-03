-- 025_visitor_passes_search_indexes.sql
--
-- Indexes that make the Truck Parking Log smart search fast at the
-- database level. Pair with the FastAPI patch in
-- docs/backend-patches/2026-06-03-parking-log-smart-search.md.
--
-- The frontend (PR #207) already does the search client-side over
-- whatever rows it fetches, which works for any property under ~500
-- passes per date window. These indexes let the BACKEND do the same
-- substring search at scale once the FastAPI route accepts a `q` param,
-- without dragging the whole table window into memory.
--
-- All indexes are CREATE INDEX IF NOT EXISTS — safe to re-apply.
-- pg_trgm GIN indexes accelerate ILIKE '%substring%' queries.
-- Expression indexes (lower(), regexp_replace) match what the frontend
-- normalization does, so the backend OR query plans cleanly.

-- pg_trgm is required for the GIN indexes below. Already enabled in
-- most modern Supabase projects, but safe to ensure.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Plate: GIN trigram index supports substring ILIKE on any chunk of the
-- normalized plate. The frontend strips spaces/hyphens and upper-cases
-- before sending, so the haystack already matches the storage form.
CREATE INDEX IF NOT EXISTS visitor_passes_plate_text_trgm_idx
  ON public.visitor_passes USING gin (plate_text gin_trgm_ops);

-- Driver name: substring ILIKE. visitor_name stored as-typed (mixed case).
CREATE INDEX IF NOT EXISTS visitor_passes_visitor_name_trgm_idx
  ON public.visitor_passes USING gin (visitor_name gin_trgm_ops);

-- Company / carrier name: substring ILIKE.
CREATE INDEX IF NOT EXISTS visitor_passes_company_name_trgm_idx
  ON public.visitor_passes USING gin (company_name gin_trgm_ops);

-- Phone: digits-only expression index. Phone column is E.164
-- ("+15551234567"); operator may type "555 123-4567" or "5551234".
-- The expression `regexp_replace(phone, '\D', '', 'g')` collapses
-- both sides to the same digit-only form, then ILIKE substring works.
CREATE INDEX IF NOT EXISTS visitor_passes_phone_digits_trgm_idx
  ON public.visitor_passes
  USING gin ((regexp_replace(phone, '\D', '', 'g')) gin_trgm_ops);

-- Placard color: low-cardinality enum-like text. lower() expression
-- so case-insensitive equality is index-backed.
CREATE INDEX IF NOT EXISTS visitor_passes_placard_color_lower_idx
  ON public.visitor_passes (lower(placard_color));

-- Parking spot: short text, ILIKE substring.
CREATE INDEX IF NOT EXISTS visitor_passes_parking_spot_trgm_idx
  ON public.visitor_passes USING gin (parking_spot gin_trgm_ops);

-- Reference ID: short generated identifier. Btree on lower() since
-- ref IDs are typically alphanumeric and exact-ish.
CREATE INDEX IF NOT EXISTS visitor_passes_reference_id_lower_idx
  ON public.visitor_passes (lower(reference_id));

-- Optional: composite index for the common "tenant + date range + status"
-- pre-filter that runs before any text search. property_id is already
-- the most-selective filter; this just makes the pagination range cheap.
CREATE INDEX IF NOT EXISTS visitor_passes_property_created_idx
  ON public.visitor_passes (property_id, created_at DESC);

COMMENT ON INDEX public.visitor_passes_plate_text_trgm_idx IS
  'Trigram GIN — supports ILIKE substring on plate_text for the smart search added in PR #207. Apply with FastAPI patch in docs/backend-patches/2026-06-03-parking-log-smart-search.md.';
