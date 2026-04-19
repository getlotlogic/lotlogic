-- Relax CHECK constraints to match the vocabulary used by pr-ingest.
--
-- plate_events.match_status: the edge function emits the raw match kind
-- ('resident', 'visitor_pass', 'self_registered', 'unmatched',
-- 'dedup_suppressed') rather than the legacy 'matched' umbrella. Keep the
-- legacy values so historical rows stay valid.
--
-- alpr_violations.violation_type: pr-ingest creates unmatched-plate rows
-- with type 'alpr_unmatched'. The legacy values ('unregistered',
-- 'overstay') were written by the now-deleted pipeline and are preserved.

ALTER TABLE plate_events DROP CONSTRAINT IF EXISTS plate_events_match_status_ck;
ALTER TABLE plate_events ADD CONSTRAINT plate_events_match_status_ck
    CHECK (match_status = ANY (ARRAY[
        'pending',
        'matched',
        'low_confidence',
        'grace_window',
        'unmatched',
        'camera_suspended',
        'review_needed',
        'resident',
        'visitor_pass',
        'self_registered',
        'dedup_suppressed'
    ]));

ALTER TABLE alpr_violations DROP CONSTRAINT IF EXISTS alpr_violations_violation_type_ck;
ALTER TABLE alpr_violations ADD CONSTRAINT alpr_violations_violation_type_ck
    CHECK (violation_type = ANY (ARRAY[
        'unregistered',
        'overstay',
        'alpr_unmatched'
    ]));
