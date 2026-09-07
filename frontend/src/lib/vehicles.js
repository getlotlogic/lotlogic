// Vehicle color helpers — YOLO/Plate Recognizer return lowercased names.
// Anything missing / "unknown" is treated as no color so UI can show a neutral tag.
export const VEHICLE_COLOR_HEX = {
  black: '#111827', white: '#f9fafb', silver: '#9ca3af', gray: '#6b7280', grey: '#6b7280',
  red: '#ef4444', blue: '#3b82f6', green: '#22c55e', yellow: '#eab308', orange: '#f97316',
  brown: '#78350f', beige: '#d6c9a3', gold: '#d4af37', tan: '#d2b48c', purple: '#a855f7',
};
export function displayColor(c) {
  if (!c) return '';
  const v = String(c).trim().toLowerCase();
  if (!v || v === '-' || v === 'unknown' || v === 'none') return '';
  return v;
}
export function colorHex(c) {
  const v = displayColor(c);
  return VEHICLE_COLOR_HEX[v] || '#6b7280';
}
// Normalize an onboard MMC attribute (make/model/type) for display: Plate
// Recognizer writes "-" for unknowns. Returns null for those + unknown/none/
// empty so .filter(Boolean) drops them and we never render a bare dash.
export function cleanMmc(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s || s === '-' || s.toLowerCase() === 'unknown' || s.toLowerCase() === 'none') return null;
  return s;
}
// Vehicle body type — Plate Recognizer returns granular types (Sedan / Pickup
// Truck / Big Truck / SUV / Van); onboard returns coarse Truck / Car / Van. Map
// to a clean label + a glyph for an at-a-glance read on the pass card.
export const VEHICLE_TYPE_META = {
  'big truck': ['Big Truck', ''], 'semi': ['Semi', ''], 'truck': ['Truck', ''],
  'pickup truck': ['Pickup', ''], 'pickup': ['Pickup', ''],
  'van': ['Van', '🚐'], 'minivan': ['Minivan', '🚐'],
  'suv': ['SUV', '🚙'], 'sedan': ['Sedan', '🚗'], 'car': ['Car', '🚗'],
  'motorcycle': ['Motorcycle', '🏍️'], 'bus': ['Bus', '🚌'],
};
export function vehicleTypeLabel(t) {
  const c = cleanMmc(t); if (!c) return null;
  const m = VEHICLE_TYPE_META[c.toLowerCase()];
  return m ? m[0] : c.replace(/\b\w/g, ch => ch.toUpperCase());
}
export function vehicleTypeIcon(t) {
  const c = cleanMmc(t); if (!c) return '🚗';
  return (VEHICLE_TYPE_META[c.toLowerCase()] || [null, '🚗'])[1];
}
export function isLowConfColor(c) {
  const v = displayColor(c);
  return !v;
}

