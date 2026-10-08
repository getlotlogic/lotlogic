// Monotonic ticket gate for "latest request wins". Each call to take() issues
// the next number; a response may be applied only while its ticket is still the
// most recent one issued.
export function latestGate() {
  let n = 0;
  return { take: () => ++n, isCurrent: (t) => t === n };
}

// Run `apply` only if `ticket` is still the newest one the gate issued.
// Returns whether it ran. Every setState that follows an await goes through
// this, so a slow poll can never put back what a newer action removed.
export function applyIfCurrent(gate, ticket, apply) {
  if (!gate.isCurrent(ticket)) return false;
  apply();
  return true;
}
