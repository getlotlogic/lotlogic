import React from 'react';

// ── "N Style didn't recognize…" (spec §3.8, "Not ours") ───────
//
// A rejected property is archived and excluded from `/auth/me.properties`
// outright — Task 14c's owner shape instead lists it under
// `rejected_properties: [{id, name, verification_note}]` so the account's
// next login renders an explanation, not a silent empty list. Shown by
// `ALPRPropertiesPage` in place of the "No lots yet" state whenever
// `properties` is empty and this array isn't.
export function RejectedPropertyNotice({ rejectedProperties, onAddProperty }) {
  const list = Array.isArray(rejectedProperties) ? rejectedProperties : [];
  if (list.length === 0) return null;
  const first = list[0];
  return (
    <div style={{ textAlign: 'center', padding: '32px 16px', color: 'var(--text-muted)' }}>
      <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text-primary)' }}>
        N Style didn't recognize {first.name}.
      </div>
      <div style={{ fontSize: 13, marginTop: 8, lineHeight: 1.5 }}>
        Reply to the email we sent if that's a mistake, or add a property.
      </div>
      {onAddProperty && (
        <button
          onClick={onAddProperty}
          style={{
            marginTop: 14, background: 'rgba(74,222,128,.12)', color: 'var(--text-primary)',
            border: '1px solid rgba(74,222,128,.3)', borderRadius: 8, padding: '8px 16px',
            fontSize: 13, fontWeight: 700, cursor: 'pointer',
          }}
        >Add a property</button>
      )}
    </div>
  );
}
