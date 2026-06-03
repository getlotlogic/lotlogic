-- 026_alpr_violations_tow_evidence.sql
--
-- Adds tow-evidence columns to alpr_violations so the upcoming walk-around
-- feature can attach an operator-captured photo + audit metadata to every
-- tow. Pairs with the Supabase Storage bucket `tow-evidence` and the
-- `walk-around-ocr` edge function.
--
-- Why each column:
--   evidence_photo_url    — public URL of the photo stored in `tow-evidence`
--                           (private bucket, served via signed URL in the
--                           weekly report email). Optional: legacy violations
--                           created from camera-snapshot alone won't have it.
--   evidence_captured_by  — lot_owner_id / partner_id who took the photo,
--                           for the anti-theft audit trail. References
--                           auth.users so we cover both owner and partner
--                           accounts without a polymorphic FK.
--   evidence_captured_at  — when the operator took the photo, not when the
--                           violation row was created. The two diverge when
--                           a walk-around catches a truck the cameras missed.
--   evidence_plate_text   — what the operator captured / OCR returned for the
--                           plate visible in the photo. Stored separately
--                           from `plate_text` because the photo plate and the
--                           session plate can disagree (front vs rear, ALPR
--                           misread); preserves both for review.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. Safe to re-apply.

ALTER TABLE public.alpr_violations
  ADD COLUMN IF NOT EXISTS evidence_photo_url text,
  ADD COLUMN IF NOT EXISTS evidence_captured_by uuid,
  ADD COLUMN IF NOT EXISTS evidence_captured_at timestamptz,
  ADD COLUMN IF NOT EXISTS evidence_plate_text text;

COMMENT ON COLUMN public.alpr_violations.evidence_photo_url IS
  'Walk-around evidence photo URL (Supabase Storage tow-evidence bucket). Captured by the operator at tow time; absent on camera-only violations.';
COMMENT ON COLUMN public.alpr_violations.evidence_captured_by IS
  'auth.users.id of the operator who took the photo. Audit trail for the anti-theft / weekly tow report.';
COMMENT ON COLUMN public.alpr_violations.evidence_captured_at IS
  'When the photo was captured (operator phone clock). Distinct from created_at which is when the violation row was inserted.';
COMMENT ON COLUMN public.alpr_violations.evidence_plate_text IS
  'Normalized plate text extracted from the evidence photo (OCR result). May differ from plate_text when ALPR and the operator''s photo see different plates.';

-- Index by captured_at for the weekly report's date-range scan.
CREATE INDEX IF NOT EXISTS alpr_violations_evidence_captured_at_idx
  ON public.alpr_violations (evidence_captured_at DESC)
  WHERE evidence_captured_at IS NOT NULL;
