export function fmtVisitDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
export function fmtStay(hours) {
  if (hours == null) return '';
  const days = Math.floor(hours / 24);
  return days >= 1 ? `${days}d` : `${Math.round(hours)}h`;
}
export function fmtCooldownDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
export function fmtHrsShort(h) {
  if (h == null || isNaN(h)) return '';
  if (h < 1) return '<1h';
  return `${Math.round(h)}h`;
}

