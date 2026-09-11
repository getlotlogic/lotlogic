import React, { useState } from 'react';
import { answerQuestion } from '../../lib/brainApi.js';

// gate_kind in plain English — nobody at 6am should have to look up what
// "camera_config" means.
const GATE_LABEL = {
  spend: 'needs a spend decision',
  email_customer: 'wants to email a customer',
  camera_config: 'wants to change a camera setting',
  merge: 'wants to merge',
  delete: 'wants to delete something',
  other: 'needs a decision',
};

export function QuestionCard({ question, onAnswered }) {
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function submit() {
    const trimmed = answer.trim();
    if (!trimmed) return;
    setBusy(true);
    setErr(null);
    try {
      await answerQuestion(question.id, trimmed);
      setBusy(false);
      onAnswered?.(question.id);
    } catch (e) {
      setBusy(false);
      setErr(e?.message || 'Could not send the answer.');
    }
  }

  return (
    <div
      data-testid="question"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: 12, marginBottom: 10 }}
    >
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{question.question}</div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
        {question.worker} · {GATE_LABEL[question.gate_kind] || 'needs a decision'}
      </div>
      {question.context && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6, whiteSpace: 'pre-wrap' }}>
          {question.context}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        <input
          type="text"
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder="Your answer"
          disabled={busy}
          style={{
            flex: 1, minWidth: 160, background: 'var(--bg-surface, var(--bg-card))', color: 'var(--text)',
            border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', fontSize: 13,
          }}
        />
        <button
          onClick={submit}
          disabled={busy || !answer.trim()}
          style={{
            fontSize: 12, fontWeight: 700, padding: '6px 14px', borderRadius: 6,
            cursor: busy || !answer.trim() ? 'default' : 'pointer',
            background: 'rgba(34,197,94,.15)', color: '#22c55e', border: '1px solid rgba(34,197,94,.35)',
            opacity: busy || !answer.trim() ? .6 : 1,
          }}
        >
          {busy ? 'Sending…' : 'Answer'}
        </button>
      </div>
      {err && <div style={{ color: '#f87171', fontSize: 12, marginTop: 6 }}>{err}</div>}
    </div>
  );
}

export default QuestionCard;
