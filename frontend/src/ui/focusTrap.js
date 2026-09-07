import React, { useState, useEffect, useCallback, useRef, useMemo, memo } from 'react';

// ── Focus trap for modal dialogs ─────────────────────────────
// Minimal a11y helper for <div role="dialog">-style overlays. Responsibilities:
//   1. Stash document.activeElement when the modal opens
//   2. Move focus to the first focusable element inside the container
//   3. Keep Tab / Shift+Tab cycling inside the container
//   4. Close on ESC (via onClose)
//   5. Restore focus to the previously-focused element on unmount
// `containerRef` must point at the outermost modal surface. Pass `isOpen=true`
// to activate; pass a falsy `onClose` to suppress ESC handling.
const FOCUSABLE_SELECTOR = [
  'a[href]', 'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function useFocusTrap(containerRef, isOpen, onClose) {
  useEffect(() => {
    if (!isOpen) return undefined;
    const previouslyFocused = document.activeElement;
    const container = containerRef.current;
    if (!container) return undefined;

    // Focus the first autofocus target, else the first focusable element,
    // else the container itself (as a non-focusable fallback we still want the
    // keyboard trap to work).
    function getFocusable() {
      return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR))
        .filter(el => !el.hasAttribute('disabled') && el.offsetParent !== null);
    }

    const autoEl = container.querySelector('[autofocus]');
    const initial = autoEl || getFocusable()[0] || container;
    try { initial.focus({ preventScroll: true }); } catch {}

    function onKey(e) {
      if (e.key === 'Escape' && typeof onClose === 'function') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusable = getFocusable();
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !container.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      // Restore focus to the triggering element so keyboard users land back
      // where they started. Guard against the element being unmounted
      // (focus() on a detached node silently no-ops but can still throw in
      // jsdom / older Safari).
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        try { previouslyFocused.focus({ preventScroll: true }); } catch {}
      }
    };
  }, [containerRef, isOpen, onClose]);
}

// Monotonically increasing counter for auto-generated DOM ids. Used by modal
// dialogs to wire aria-labelledby / aria-describedby without asking callers to
// manage ids. Ok to be a global — it's just a render-time counter.
let __uidCounter = 0;
export function useUid(prefix = 'uid') {
  const ref = useRef(null);
  if (ref.current === null) {
    __uidCounter += 1;
    ref.current = `${prefix}-${__uidCounter}`;
  }
  return ref.current;
}
