/**
 * The composer's client-side "confirm your email first" gate (spec §3.5).
 *
 * Tow, photo, and a hold on a property N Style has not confirmed yet all need
 * a verified email. When /auth/me has already said the email is unverified the
 * composer asks for the code without a round trip; otherwise the server's 422
 * is the gate.
 *
 * `afterVerify` is the resume a VerifyEmailSheet fires on success. It runs in
 * the same tick as that success, from the closure of the render that asked —
 * where `emailVerified` is still false — so it must skip this gate or it would
 * only ask again and never place the request. The server's 422 stays the gate.
 */
export function mustVerifyFirst({ kind, isPending, emailVerified, afterVerify = false }) {
  const gated = kind !== 'hold' || !!isPending;
  return gated && emailVerified === false && !afterVerify;
}

/** The callback handed to `onNeedVerify`: re-run `submit` past the gate. */
export function verifyResume(submit) {
  return () => submit(null, { afterVerify: true });
}
