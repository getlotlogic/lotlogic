-- 2026-06-03-tow-evidence-bucket.sql
--
-- Provision the Supabase Storage bucket that holds walk-around evidence
-- photos (operator-captured plate shots at tow time). One-time ops script,
-- not a versioned schema migration — buckets live in `storage.*` and we
-- don't track those in the migrations chain.
--
-- Apply order:
--   1. Apply migrations/026_alpr_violations_tow_evidence.sql first (columns
--      that the upload flow writes to).
--   2. Run this file in Supabase Studio SQL editor.
--   3. Deploy `supabase/functions/walk-around-ocr/` (uses bucket name below).
--
-- Why a private bucket: tow evidence is sensitive (plates, possibly drivers
-- in frame). Anonymous read would let anyone with a URL pull every tow
-- photo we've taken. Operators access via the dashboard JWT; the weekly
-- owner email uses backend-signed URLs (24h TTL).

-- ── Bucket ────────────────────────────────────────────────────────────
-- public=false → no anon reads. file_size_limit caps a single upload at
-- 4 MiB (modern phone camera at ~85% JPEG quality lands ~150-400 KB).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'tow-evidence',
  'tow-evidence',
  false,
  4 * 1024 * 1024,
  ARRAY['image/jpeg', 'image/png', 'image/heic', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ── RLS policies on storage.objects for this bucket ──────────────────
-- Object path convention: `{property_id}/{yyyymmdd}/{uuid}.jpg`
-- The property_id at the top of the path lets RLS scope reads/writes by
-- tenant without a separate table join.

-- Authenticated upload: any logged-in operator/owner whose JWT carries an
-- owner_id or partner_id can write objects under their own property
-- folder. (The exact property-access check is enforced backend-side when
-- the upload URL is minted; this RLS is a defense-in-depth backstop.)
DROP POLICY IF EXISTS "tow_evidence_authenticated_insert" ON storage.objects;
CREATE POLICY "tow_evidence_authenticated_insert"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'tow-evidence'
    AND (auth.jwt() ->> 'owner_id' IS NOT NULL
      OR auth.jwt() ->> 'partner_id' IS NOT NULL)
  );

-- Authenticated read scoped by JWT property access.
-- The first path segment is the property_id; we check it matches a
-- property the JWT's owner_id or partner_id can see. Same join the
-- backend uses for scope.assert_property_access().
DROP POLICY IF EXISTS "tow_evidence_authenticated_select" ON storage.objects;
CREATE POLICY "tow_evidence_authenticated_select"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'tow-evidence'
    AND EXISTS (
      SELECT 1
      FROM public.properties p
      WHERE p.id::text = split_part(name, '/', 1)
        AND (
          p.owner_id::text = (auth.jwt() ->> 'owner_id')
          OR EXISTS (
            SELECT 1 FROM public.lots l
            WHERE l.property_id = p.id
              AND l.partner_id::text = (auth.jwt() ->> 'partner_id')
          )
        )
    )
  );

-- No DELETE policy — evidence is append-only. If a photo needs to be
-- removed (legal request, accidental upload of bystander), the
-- service_role does it manually.

COMMENT ON POLICY "tow_evidence_authenticated_insert" ON storage.objects IS
  'Walk-around evidence uploads. Path convention: {property_id}/{yyyymmdd}/{uuid}.jpg. Backend mints the upload URL after validating property access.';
