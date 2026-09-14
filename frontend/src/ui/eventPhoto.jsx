import React, { useEffect, useState } from 'react';
import { peekPhotoUrl, photoUrl } from '../lib/db.js';

// ── Rendering a plate read's photograph ──────────────────────────
// Wave 2.5 Task 10. A vehicle photograph used to be a permanent, public
// https://pub-….r2.dev address that Supabase handed to the browser in the same
// row as the plate text; every `<img src>` in the dashboard pointed straight at
// it. Now the data layer returns the plate_events ID and nothing else, and this
// is the only place that turns an id into something an `<img>` can load: one
// authenticated call to db.photoUrl(), which is itself memoised per event.
//
// The consequence render sites have to live with is that a photo URL is no
// longer known synchronously. That is deliberate — a URL that can be known
// without asking is a URL anyone can keep. Where a layout used to reserve
// space on "this row has a photo", it now reserves on the EVENT ID being
// present, which is known at first paint and is exactly as reliable.

/**
 * Resolve one plate read's photograph to a short-lived presigned URL.
 * Returns null while it is loading, and null forever if the read has no
 * photograph. Safe to call with null/undefined — that is the "nothing to
 * resolve" case, not an error, so it can sit at the top of a component whose
 * event id arrives later.
 */
export function usePhotoUrl(eventId) {
  // Seeded from the cache so an already-resolved photo paints on the FIRST
  // render. Without that, a row component whose identity changes every parent
  // render (defined inside its page, as several are) would unmount, remount,
  // and flash an empty tile on every refresh tick even though the URL was
  // already in hand.
  const [url, setUrl] = useState(() => peekPhotoUrl(eventId));
  useEffect(() => {
    let live = true;
    // Reset to whatever THIS event has cached — not to the previous event's
    // URL. Without it, scrolling a reused component shows the previous
    // vehicle's photo until the new one resolves, which is the one failure
    // mode here that is worse than showing no photo at all.
    setUrl(peekPhotoUrl(eventId));
    if (!eventId) return;
    photoUrl(eventId).then(u => { if (live) setUrl(u); });
    return () => { live = false; };
  }, [eventId]);
  return url;
}

/**
 * An `<img>` for one plate read's photograph.
 *
 * Renders `placeholder` (default: nothing) until the URL resolves and whenever
 * the read has no photograph, so a caller that used to write
 * `{ev.image_url && <img src={ev.image_url} …/>}` writes
 * `<EventPhoto eventId={ev.id} …/>` and keeps the same shape.
 */
export function EventPhoto({ eventId, placeholder = null, ...imgProps }) {
  const url = usePhotoUrl(eventId);
  if (!url) return placeholder;
  return <img src={url} loading="lazy" {...imgProps} />;
}
