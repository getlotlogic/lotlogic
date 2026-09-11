// ── Haptic feedback ──────────────────────────────────────────
export function haptic(style = 'light') {
  if (!navigator.vibrate) return;
  if (style === 'heavy') navigator.vibrate(30);
  else if (style === 'medium') navigator.vibrate(15);
  else navigator.vibrate(8);
}

// ── In-app notification system (replaces SMS dependency) ─────
export const NotifyManager = (() => {
  let _audioCtx = null;

  function _getPrefs() {
    try {
      const raw = localStorage.getItem('lotlogic_notify_prefs');
      return raw ? JSON.parse(raw) : { sound: true, browser: true, volume: 0.4 };
    } catch { return { sound: true, browser: true, volume: 0.4 }; }
  }
  function _setPrefs(p) {
    try { localStorage.setItem('lotlogic_notify_prefs', JSON.stringify(p)); } catch {}
  }

  function getPrefs() { return _getPrefs(); }
  function updatePrefs(patch) { const p = { ..._getPrefs(), ...patch }; _setPrefs(p); return p; }

  // Two-tone chime via Web Audio API — no external audio files needed
  function playChime() {
    const prefs = _getPrefs();
    if (!prefs.sound) return;
    try {
      if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = _audioCtx;
      if (ctx.state === 'suspended') ctx.resume();
      const now = ctx.currentTime;

      // First tone: C6 (1047 Hz)
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.connect(gain1); gain1.connect(ctx.destination);
      osc1.frequency.value = 1047;
      osc1.type = 'sine';
      gain1.gain.setValueAtTime(prefs.volume, now);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
      osc1.start(now); osc1.stop(now + 0.15);

      // Second tone: E6 (1319 Hz) — 100ms later, slightly longer
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.connect(gain2); gain2.connect(ctx.destination);
      osc2.frequency.value = 1319;
      osc2.type = 'sine';
      gain2.gain.setValueAtTime(prefs.volume, now + 0.1);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      osc2.start(now + 0.1); osc2.stop(now + 0.35);
    } catch (e) { console.warn('Chime failed:', e); }
  }

  // Urgent double-chime for reminders
  function playUrgentChime() {
    playChime();
    setTimeout(playChime, 500);
  }

  // Browser Notification API
  function browserNotify(title, body, tag) {
    const prefs = _getPrefs();
    if (!prefs.browser) return;
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    try {
      new Notification(title, {
        body,
        tag: tag || 'lotlogic-violation',
        icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🅿️</text></svg>',
        renotify: true,
        requireInteraction: false,
      });
    } catch (e) { console.warn('Browser notification failed:', e); }
  }

  // Request browser notification permission (must be user-gesture triggered)
  async function requestPermission() {
    if (!('Notification' in window)) return 'unsupported';
    if (Notification.permission === 'granted') return 'granted';
    if (Notification.permission === 'denied') return 'denied';
    return await Notification.requestPermission();
  }

  function getPermission() {
    if (!('Notification' in window)) return 'unsupported';
    return Notification.permission;
  }

  // Main entry: fire notification for a new violation
  function notifyNewViolation(violation) {
    const zone = violation.zone_id || 'Unknown zone';
    const type = violation.violation_type || 'Recently expired';
    const desc = [violation.vehicle_color, violation.vehicle_type && violation.vehicle_type !== 'car' ? violation.vehicle_type : 'vehicle'].filter(Boolean).join(' ');

    playChime();
    haptic('heavy');
    browserNotify(
      `New ${type}`,
      `${desc} in ${zone}`,
      `violation-${violation.id}`,
    );
  }

  // Fire notification for a reminder (more urgent)
  function notifyReminder(violation) {
    const zone = violation.zone_id || 'Unknown zone';
    playUrgentChime();
    haptic('heavy');
    browserNotify(
      '30-min reminder',
      `${zone} — still waiting for action`,
      `reminder-${violation.id}`,
    );
  }

  return { getPrefs, updatePrefs, playChime, playUrgentChime, browserNotify, requestPermission, getPermission, notifyNewViolation, notifyReminder };
})();
