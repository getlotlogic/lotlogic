// Monotonic ticket gate for "latest request wins". Each call to take() issues
// the next number; a response may be applied only while its ticket is still the
// most recent one issued.
export function latestGate() {
  let n = 0;
  return { take: () => ++n, isCurrent: (t) => t === n };
}
