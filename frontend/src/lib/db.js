import { supabase } from './supabase.js';
import { API, apiFetch, getSessionToken } from './api.js';
import { lotDayBound } from './lotdate.js';

// ── Normalize Supabase violation to app format ───────────────
// Revenue in DB is dollars; multiply by 100 for fmtMoney (cents display)
export function normalizeViolation(v) {
  return {
    ...v,
    our_revenue: v.our_revenue != null ? Math.round(v.our_revenue * 100) : 0,
    gross_revenue: v.gross_revenue != null ? Math.round(v.gross_revenue * 100) : 0,
  };
}

// ── Shared: try loading an image URL, returns true if it loads successfully ──
export async function tryLoadImageUrl(url, timeout = 5000) {
  const img = new Image();
  const ok = await new Promise(r => {
    img.onload = () => r(true);
    img.onerror = () => r(false);
    img.src = url;
    setTimeout(() => r(false), timeout);
  });
  return ok && img.naturalWidth > 0;
}

// ── Shared: resolve best snapshot URL for a camera ────────────
// Tries DB snapshot first (if fresh), then tunnel URL. Returns
// { url, capturedAt, snap } or null. Used by ViolationProofModal's live
// poll so the "Current" photo works even when the puller is down and DB
// snapshots are stale.
export async function resolveCameraSnapshot(cameraId, tunnelSnapshotUrl, maxAgeSec = 120) {
  // 1. Try latest DB snapshot
  if (supabase) {
    try {
      const { data } = await supabase
        .from('snapshots')
        .select('storage_url, url, captured_at, vehicles_detected, raw_detections')
        .eq('camera_id', cameraId)
        .order('captured_at', { ascending: false })
        .limit(1);
      if (data?.[0]) {
        const s = data[0];
        const age = s.captured_at ? (Date.now() - new Date(s.captured_at).getTime()) / 1000 : Infinity;
        const base = s.storage_url || s.url || '';
        if (age < maxAgeSec && base) {
          return { url: base + (base.includes('?') ? '&' : '?') + '_t=' + Date.now(), capturedAt: s.captured_at, snap: s };
        }
      }
    } catch {}
  }
  // 2. Try tunnel snapshot URL directly
  if (tunnelSnapshotUrl) {
    const tUrl = tunnelSnapshotUrl + (tunnelSnapshotUrl.includes('?') ? '&' : '?') + '_t=' + Date.now();
    const ok = await tryLoadImageUrl(tUrl);
    if (ok) return { url: tUrl, capturedAt: new Date().toISOString(), snap: null };
  }
  return null;
}

// ── Supabase data layer (with Rails API fallback) ─────────────
// Real Supabase table names: lot_owners, enforcement_partners, lots, cameras,
// violations, snapshots, camera_zones
// Safety cap on the active-roster query. Not expected to bind — see
// getActiveRoster, which warns if it ever does.
export const ACTIVE_ROSTER_CAP = 500;

export const db = {
  async getOwners(email) {
    if (!supabase) throw new Error('Data service unavailable');
    let q = supabase.from('lot_owners').select('*');
    if (email) q = q.eq('email', email.trim().toLowerCase());
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data || [];
  },
  // db.getPartners removed 2026-04-29 — was a SELECT * on
  // enforcement_partners with no callers, leak surface for revenue_share
  // / boot_fee / tow_fee / notes / quickbooks_customer_id if anyone added
  // a caller. Safe self-fetch lives on the backend at GET /partners/me.
  async getLots(filter = {}) {
    if (!supabase) throw new Error('Data service unavailable');
    let q = supabase.from('lots').select('*').eq('active', true);
    if (filter.owner_id) q = q.eq('owner_id', filter.owner_id);
    if (filter.partner_id) q = q.eq('partner_id', filter.partner_id);
    if (filter.market_id) q = q.eq('market_id', filter.market_id);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data || [];
  },
  async getLotState(lotId) {
    if (!supabase) throw new Error('Data service unavailable');
    // Fetch cameras for this lot
    const { data: cams, error: camErr } = await supabase
      .from('cameras')
      .select('*')
      .eq('lot_id', lotId)
      .eq('active', true);
    if (camErr) throw new Error(camErr.message);

    // Parallel: pending violations count + latest snapshot per camera + camera zones
    const [violRes, ...camData] = await Promise.all([
      supabase.from('violations').select('id, camera_id').eq('lot_id', lotId).in('status', ['pending', 'alerted', 'acknowledged']),
      ...((cams || []).map(cam => Promise.all([
        supabase.from('snapshots').select('*').eq('camera_id', cam.id).order('captured_at', { ascending: false }).limit(1),
        supabase.from('camera_zones').select('*').eq('camera_id', cam.id),
      ]))),
    ]);

    const pendingViols = violRes.data || [];
    const cameras = (cams || []).map((cam, i) => {
      const [snapRes, zonesRes] = camData[i] || [{ data: [] }, { data: [] }];
      const snap = snapRes.data?.[0] || null;
      const zones = (zonesRes.data || []).map(z => ({
        zone_id: z.zone_id,
        label: z.label,
        zone_type: z.zone_type,
        time_limit_minutes: z.time_limit_minutes,
        polygon: z.polygon,
      }));
      const camViols = pendingViols.filter(v => v.camera_id === cam.id).length;
      return {
        camera_id: cam.id,
        camera_name: cam.name,
        online: (cam.status === 'active' || cam.active === true) && (!!cam.ip_address || (cam.last_heartbeat && (Date.now() - new Date(cam.last_heartbeat).getTime()) < 300000)),
        zones,
        deployment_profile: cam.camera_type === 'lte_solar' ? 'lte_solar' : 'wired',
        snapshot_width: cam.snapshot_width || 640,
        snapshot_height: cam.snapshot_height || 360,
        poll_interval_sec: cam.poll_interval_sec || 30,
        bandwidth_budget_mb: cam.bandwidth_budget_mb || null,
        bandwidth_used_mb: cam.bandwidth_used_mb || null,
        last_heartbeat: cam.last_heartbeat,
        channel: cam.channel,
        active_violations: camViols,
        tunnel_snapshot_url: (cam.ip_address && cam.http_snapshot_url) ? (() => { try { const u = new URL(cam.http_snapshot_url); return `https://${cam.ip_address}${u.pathname}${u.search}`; } catch { return null; } })() : null,
        latest_snapshot: snap ? {
          url: (snap.storage_url || snap.url) ? (snap.storage_url || snap.url) + (((snap.storage_url || snap.url).includes('?')) ? '&' : '?') + '_t=' + Date.now() : null,
          captured_at: snap.captured_at,
          vehicles_detected: snap.vehicles_detected || 0,
          people_detected: snap.raw_detections?.detections?.filter(d => d.class === 'person').length || 0,
          plates_read: snap.raw_detections?.detections?.filter(d => d.plate_text).length || 0,
          plate_readings: snap.raw_detections?.detections?.filter(d => d.plate_text).map(d => d.plate_text) || [],
          detections: snap.raw_detections?.detections?.map((d, i) => ({
            id: `det_${i}`,
            type: d.class === 'person' ? 'person' : 'vehicle',
            bbox: d.bbox ? { x: d.bbox[0] * 100, y: d.bbox[1] * 100, w: (d.bbox[2] - d.bbox[0]) * 100, h: (d.bbox[3] - d.bbox[1]) * 100 } : null,
            confidence: d.conf,
            label: d.class,
          })) || [],
        } : null,
      };
    });
    return {
      total_active_violations: pendingViols.length,
      cameras_online: cameras.filter(c => c.online).length,
      cameras_total: cameras.length,
      cameras,
    };
  },
  // Shared: attach snapshot URL + detections to violation rows.
  // If the violation's own snapshot has no storage_url, fall back to
  // the latest snapshot from the same camera that does.
  async _enrichViolations(data) {
    const viols = data.map(v => {
      const snap = v.snapshots;
      const nv = normalizeViolation(v);
      // Priority: violation's own snapshot_url (original detection image),
      // then joined snapshot's storage_url, then null (will fallback below)
      nv._snapshot_url = v.snapshot_url || snap?.storage_url || null;
      nv._detections = snap?.raw_detections?.detections || [];
      delete nv.snapshots;
      return nv;
    });
    // Find violations that need snapshot data: either missing URL or missing detections
    const needsData = viols.filter(v => (!v._snapshot_url || !v._detections?.length) && v.camera_id);
    if (needsData.length > 0 && supabase) {
      try {
        await Promise.all(needsData.map(async v => {
          // First try: fetch by snapshot_id if available
          if (v.snapshot_id) {
            const { data: snap } = await supabase
              .from('snapshots')
              .select('storage_url, raw_detections')
              .eq('id', v.snapshot_id)
              .single();
            if (snap) {
              if (!v._snapshot_url && snap.storage_url) v._snapshot_url = snap.storage_url;
              if (!v._detections?.length) v._detections = snap.raw_detections?.detections || [];
              return;
            }
          }
          // Second try: match by snapshot_url to get detections
          if (v._snapshot_url && !v._detections?.length) {
            const { data: snaps } = await supabase
              .from('snapshots')
              .select('raw_detections')
              .eq('storage_url', v._snapshot_url)
              .limit(1);
            if (snaps?.[0]?.raw_detections?.detections?.length) {
              v._detections = snaps[0].raw_detections.detections;
              return;
            }
          }
          // Third try: snapshot closest to detected_at from the same camera
          if (!v._snapshot_url) {
            const { data: snaps } = await supabase
              .from('snapshots')
              .select('storage_url, raw_detections')
              .eq('camera_id', v.camera_id)
              .not('storage_url', 'is', null)
              .lte('captured_at', v.detected_at)
              .order('captured_at', { ascending: false })
              .limit(1);
            if (snaps?.[0]) {
              v._snapshot_url = snaps[0].storage_url;
              if (!v._detections?.length) v._detections = snaps[0].raw_detections?.detections || [];
            }
          }
        }));
      } catch (e) {
        console.error('Snapshot enrichment failed:', e);
      }
    }
    // Look up the original detection-time snapshot for each violation.
    // violation.snapshot_url may have been overwritten by the backend (old bug),
    // so we always resolve the snapshot closest to detected_at as the true detection image.
    if (supabase) {
      try {
        await Promise.all(viols.map(async v => {
          if (!v.camera_id || !v.detected_at) return;
          const { data: snaps } = await supabase
            .from('snapshots')
            .select('storage_url, raw_detections')
            .eq('camera_id', v.camera_id)
            .not('storage_url', 'is', null)
            .lte('captured_at', v.detected_at)
            .order('captured_at', { ascending: false })
            .limit(1);
          if (snaps?.[0]?.storage_url) {
            v._detection_snapshot_url = snaps[0].storage_url;
            if (!v._detections?.length) {
              v._detections = snaps[0].raw_detections?.detections || [];
            }
          }
        }));
      } catch (e) {
        console.error('Detection snapshot lookup failed:', e);
      }
    }
    return viols;
  },
  async getViolations(lotId) {
    if (!supabase) throw new Error('Data service unavailable');
    const { data, error } = await supabase
      .from('violations')
      .select('*, snapshots:snapshot_id(storage_url, raw_detections)')
      .eq('lot_id', lotId)
      .order('detected_at', { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return this._enrichViolations(data || []);
  },
  async getViolationsByPartner(partnerId) {
    if (supabase) {
      const { data, error } = await supabase
        .from('violations')
        .select('*, snapshots:snapshot_id(storage_url, raw_detections)')
        .eq('partner_id', partnerId)
        .order('detected_at', { ascending: false })
        .limit(500);
      if (!error && data) return this._enrichViolations(data);
    }
    return [];
  },
  async recordAction(violId, action, extra = {}) {
    if (action === 'plate_correction') {
      // Not money and not an enforcement decision: leave it on the direct path.
      if (!supabase) throw new Error('Data service unavailable');
      const { error } = await supabase.from('violations')
        .update({ plate_text: extra.plate_text }).eq('id', violId);
      if (error) throw new Error(error.message || 'Plate update failed');
      return { success: true };
    }
    // Everything else goes through the backend. The fee schedule and the audit
    // row are the server's -- the browser used to compute both, and the audit
    // half went into a table that does not exist.
    await apiFetch(`/violations/${violId}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        status: 'resolved',
        action_taken: action,
        notes: extra.notes || undefined,
      }),
    });
    return { success: true };
  },
  // Mark a violation as departed (vehicle left zone, confirmed by consecutive empty snapshots)
  // Does NOT resolve the violation — operator must still dismiss it manually
  async markDeparted(violId, emptyStreak) {
    if (supabase) {
      const { error } = await supabase.from('violations').update({
        departed_at: new Date().toISOString(),
        empty_streak: emptyStreak,
        status: 'departed',
      }).eq('id', violId);
      if (error) console.error('markDeparted error:', error);
    }
  },
  async getSnapshotUrl(snapshotId) {
    if (!supabase) throw new Error('Data service unavailable');
    const { data, error } = await supabase
      .from('snapshots')
      .select('storage_url')
      .eq('id', snapshotId)
      .single();
    if (error) throw new Error(error.message);
    return { url: data?.storage_url || null };
  },
  async getRevenue(days) {
    if (!supabase) throw new Error('Data service unavailable');
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const { data, error } = await supabase
      .from('violations')
      .select('*')
      .in('status', ['resolved', 'cleared'])
      .gte('detected_at', since);
    if (error) throw new Error(error.message);
    const rows = data || [];
    // Revenue stored as dollars in DB
    const totalOur = rows.reduce((s, v) => s + (v.our_revenue || 0), 0);
    const totalGross = rows.reduce((s, v) => s + (v.gross_revenue || 0), 0);
    const actioned = rows.filter(v => v.action_taken && !['pending', 'plate_correction'].includes(v.action_taken));
    const byAction = {};
    actioned.forEach(v => { byAction[v.action_taken] = (byAction[v.action_taken] || 0) + 1; });
    return {
      our_revenue_cents: Math.round(totalOur * 100), // convert dollars → cents for fmtMoney
      gross_revenue_cents: Math.round(totalGross * 100),
      total_violations: rows.length,
      actions_executed: actioned.length,
      action_rate: rows.length > 0 ? actioned.length / rows.length : 0,
      by_action_type: byAction,
    };
  },
  async addCamera(body) {
    // Cameras table has many required fields (ip_address, port, username, etc.)
    // that vary by camera hardware — always go through the backend API
    return apiFetch('/cameras', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  },
  async updateZones(cameraId, zones) {
    if (!supabase) throw new Error('Data service unavailable');
    // Delete existing zones for this camera, then insert new ones
    const { error: delErr } = await supabase.from('camera_zones').delete().eq('camera_id', cameraId);
    if (delErr) throw new Error('Failed to clear zones: ' + delErr.message);

    if (zones.length > 0) {
      const rows = zones.map(z => ({
        camera_id: cameraId,
        zone_id: z.zone_id,
        label: z.label || z.zone_id,
        zone_type: z.zone_type || 'no_parking',
        time_limit_minutes: z.time_limit_minutes || null,
        polygon: z.polygon,
      }));
      const { error: insErr } = await supabase.from('camera_zones').insert(rows);
      if (insErr) throw new Error('Failed to insert zones: ' + insErr.message);
    }

    // Sync to cameras.zones JSON column (backend detection uses this format)
    // Convert {x,y} percentage objects to [[x,y]] normalized 0-1 arrays
    const backendZones = zones.map((z, i) => ({
      zone_id: z.zone_id,
      violation_type: z.zone_type || 'no_parking',
      max_minutes: z.time_limit_minutes || null,
      space_number: i + 1,
      polygon: (z.polygon || []).map(pt => {
        const px = pt.x != null ? pt.x : (Array.isArray(pt) ? pt[0] * 100 : 0);
        const py = pt.y != null ? pt.y : (Array.isArray(pt) ? pt[1] * 100 : 0);
        return [Math.round(px / 100 * 10000) / 10000, Math.round(py / 100 * 10000) / 10000];
      }),
    }));
    await supabase.from('cameras').update({ zones: backendZones }).eq('id', cameraId);

    return { success: true };
  },
  // Fetch unique enforcement partners linked to a set of lots
  async getPartnersForLots(lots) {
    const partnerIds = [...new Set(lots.map(l => l.partner_id).filter(Boolean))];
    if (partnerIds.length === 0) return [];
    if (supabase) {
      const { data, error } = await supabase
        .from('enforcement_partners')
        .select('*')
        .in('id', partnerIds)
        .eq('active', true);
      if (!error && data) return data;
    }
    return [];
  },
  // Fetch unique enforcement partners linked to an owner — across BOTH the
  // legacy `lots.partner_id` field AND the new `properties.tow_company_id`
  // field. Charlotte-style ALPR-only properties have no `lots` row, so the
  // lots-only path misses them.
  async getPartnersForOwner(ownerId) {
    if (!supabase || !ownerId) return [];
    const [lotsRes, propsRes] = await Promise.all([
      supabase.from('lots').select('partner_id').eq('owner_id', ownerId).eq('active', true),
      supabase.from('properties').select('tow_company_id').eq('owner_id', ownerId),
    ]);
    const ids = new Set([
      ...((lotsRes.data || []).map(l => l.partner_id).filter(Boolean)),
      ...((propsRes.data || []).map(p => p.tow_company_id).filter(Boolean)),
    ]);
    if (ids.size === 0) return [];
    const { data, error } = await supabase
      .from('enforcement_partners')
      .select('*')
      .in('id', [...ids])
      .eq('active', true);
    if (!error && data) return data;
    return [];
  },
  // Platform-admin variant of getPartnersForOwner: every active tow partner
  // referenced by ANY lot or property (no owner filter), so the "View as
  // Partner" switcher lists e.g. N Style Towing (the apartment tow partner on
  // Stevensons, which the leasing office owns — not the admin) alongside NMLD.
  // Admin RLS already returns all rows, so this stays scoped to real partners.
  async getAllPartnersForAdmin() {
    if (!supabase) return [];
    const [lotsRes, propsRes] = await Promise.all([
      supabase.from('lots').select('partner_id').eq('active', true),
      supabase.from('properties').select('tow_company_id, partner_id'),
    ]);
    const ids = new Set([
      ...((lotsRes.data || []).map(l => l.partner_id).filter(Boolean)),
      ...((propsRes.data || []).flatMap(p => [p.tow_company_id, p.partner_id]).filter(Boolean)),
    ]);
    if (ids.size === 0) return [];
    const { data, error } = await supabase
      .from('enforcement_partners').select('*').in('id', [...ids]).eq('active', true);
    if (!error && data) return data;
    return [];
  },
  // ── Permits ────────────────────────────────────────────────
  async getPermits(lotId) {
    if (supabase) {
      const { data, error } = await supabase
        .from('permitted_vehicles')
        .select('*')
        .eq('lot_id', lotId)
        .eq('active', true)
        .order('created_at', { ascending: false });
      if (!error && data) return data;
    }
    return [];
  },
  async addPermit(permit) {
    if (supabase) {
      const { data, error } = await supabase
        .from('permitted_vehicles')
        .insert(permit)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return data;
    }
    throw new Error('Supabase not available');
  },
  async deletePermit(permitId) {
    if (supabase) {
      const { error } = await supabase
        .from('permitted_vehicles')
        .update({ active: false })
        .eq('id', permitId);
      if (error) throw new Error(error.message);
      return { success: true };
    }
    throw new Error('Supabase not available');
  },
  async deleteViolation(violId, isAlpr = false) {
    if (!supabase) throw new Error('Data service unavailable');
    // ALPR violations live in alpr_violations, not violations. The legacy
    // delete path silently no-ops for ALPR rows because the WHERE matches
    // zero rows in the wrong table — no error, no toast feedback, looks
    // like the button does nothing. Branch by isAlpr.
    if (isAlpr) {
      const { error } = await supabase.from('alpr_violations').delete().eq('id', violId);
      if (error) throw new Error(error.message);
      return;
    }
    // Fetch camera_id + zone_id before deleting so we can reset occupancy
    const { data: _vPre } = await supabase.from('violations').select('camera_id, zone_id').eq('id', violId).single();
    const { error } = await supabase.from('violations').delete().eq('id', violId);
    if (error) throw new Error(error.message);
    // Reset zone_occupancy so the next scan can fire a new violation
    if (_vPre?.camera_id && _vPre?.zone_id) {
      await supabase.from('zone_occupancy')
        .update({ violation_triggered: false })
        .eq('camera_id', _vPre.camera_id)
        .eq('zone_id', _vPre.zone_id);
    }
    return { success: true };
  },

  // ── Violation Dedup ───────────────────────────────────────
  async acknowledgeViolation(violId) {
    if (!supabase) throw new Error('Data service unavailable');
    const { data, error } = await supabase
      .from('violations')
      .update({
        status: 'acknowledged',
        acknowledged_at: new Date().toISOString(),
        acknowledged_by: 'dashboard',
      })
      .eq('id', violId)
      .eq('status', 'alerted')
      .select();
    if (error) throw new Error(error.message);
    // Best-effort sync of the same state to the backend.
    try { await apiFetch(`/violations/${violId}/acknowledge`, { method: 'POST' }); } catch (_) {}
    return { success: true, data };
  },

  // ── Analytics ─────────────────────────────────────────────
  async getHourlyStats(lotIds) {
    if (supabase) {
      // Get violations from last 90 days grouped by hour
      const since = new Date(Date.now() - 90 * 86400000).toISOString();
      const { data, error } = await supabase
        .from('violations')
        .select('lot_id, detected_at, action_taken, gross_revenue')
        .in('lot_id', lotIds)
        .gte('detected_at', since);
      if (!error && data) {
        // Build heatmap: day_of_week x hour_of_day → count
        const heatmap = {};
        data.forEach(v => {
          const d = new Date(v.detected_at);
          const dow = d.getDay(); // 0=Sun
          const hour = d.getHours();
          const key = `${dow}-${hour}`;
          heatmap[key] = (heatmap[key] || 0) + 1;
        });
        return { heatmap, total: data.length };
      }
    }
    return { heatmap: {}, total: 0 };
  },
  async getUtilization(lotIds) {
    if (supabase) {
      // Get snapshot vehicle counts from last 7 days
      const since = new Date(Date.now() - 7 * 86400000).toISOString();
      const { data, error } = await supabase
        .from('snapshots')
        .select('lot_id, captured_at, vehicles_detected')
        .in('lot_id', lotIds)
        .gte('captured_at', since)
        .order('captured_at', { ascending: false })
        .limit(5000);
      if (!error && data) {
        // Group by hour of day → avg vehicles
        const byHour = {};
        data.forEach(s => {
          const hour = new Date(s.captured_at).getHours();
          if (!byHour[hour]) byHour[hour] = { sum: 0, count: 0 };
          byHour[hour].sum += (s.vehicles_detected || 0);
          byHour[hour].count++;
        });
        const hourly = {};
        Object.keys(byHour).forEach(h => {
          hourly[h] = Math.round(byHour[h].sum / byHour[h].count * 10) / 10;
        });
        return { hourly, totalSnapshots: data.length };
      }
    }
    return { hourly: {}, totalSnapshots: 0 };
  },
  async getRevenueProjection(lotIds) {
    if (supabase) {
      // Get last 30 days of revenue data for projection
      const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
      const since7 = new Date(Date.now() - 7 * 86400000).toISOString();
      const [res30, res7] = await Promise.all([
        supabase.from('violations').select('gross_revenue, our_revenue, detected_at, action_taken')
          .in('lot_id', lotIds).gte('resolved_at', since30).neq('status', 'pending'),
        supabase.from('violations').select('gross_revenue, our_revenue, detected_at, action_taken')
          .in('lot_id', lotIds).gte('resolved_at', since7).neq('status', 'pending'),
      ]);
      const d30 = res30.data || [];
      const d7 = res7.data || [];
      const rev30 = d30.reduce((s, v) => s + (v.gross_revenue || 0), 0);
      const rev7 = d7.reduce((s, v) => s + (v.gross_revenue || 0), 0);
      const dailyAvg30 = d30.length > 0 ? rev30 / 30 : 0;
      const dailyAvg7 = d7.length > 0 ? rev7 / 7 : 0;
      const viols30 = d30.length;
      const viols7 = d7.length;
      const dailyViols30 = viols30 / 30;
      const dailyViols7 = viols7 / 7;
      return {
        monthlyProjection: Math.round(dailyAvg7 * 30),
        weeklyAvg: Math.round(rev7),
        dailyAvg: Math.round(dailyAvg7),
        trend: dailyAvg7 > dailyAvg30 ? 'up' : dailyAvg7 < dailyAvg30 ? 'down' : 'flat',
        trendPct: dailyAvg30 > 0 ? Math.round(((dailyAvg7 - dailyAvg30) / dailyAvg30) * 100) : 0,
        violationsPerDay: Math.round(dailyViols7 * 10) / 10,
        violTrend: dailyViols7 > dailyViols30 ? 'up' : dailyViols7 < dailyViols30 ? 'down' : 'flat',
        violTrendPct: dailyViols30 > 0 ? Math.round(((dailyViols7 - dailyViols30) / dailyViols30) * 100) : 0,
      };
    }
    return { monthlyProjection: 0, weeklyAvg: 0, dailyAvg: 0, trend: 'flat', trendPct: 0, violationsPerDay: 0, violTrend: 'flat', violTrendPct: 0 };
  },

  // Realtime subscription for violations
  subscribeViolations(lotIds, callback, onError) {
    if (!supabase) { if (onError) onError('Realtime not available'); return null; }
    const channel = supabase.channel('violations-realtime')
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'violations',
      }, payload => {
        if (lotIds.includes(payload.new?.lot_id) || lotIds.includes(payload.old?.lot_id)) {
          callback(payload);
        }
      })
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'snapshots',
      }, payload => {
        // New snapshot from any camera — trigger refresh so frame updates
        callback(payload);
      })
      .subscribe((status) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.error('Realtime subscription failed:', status);
          if (onError) onError(status);
        }
      });
    return channel;
  },

  // ── ALPR Parking Pass System ─────────────────────────────────
  async getProperties(userId, role) {
    if (!userId) return [];
    if (supabase) {
      let q = supabase.from('properties').select('*');
      // Platform admins see every property; RLS still gates non-admins via
      // owner_id / tow_company_id policies. Read the flag from the live
      // session object first (server-fresh from /auth/login or /auth/me)
      // and fall back to JWT decoding for backward-compat with sessions
      // cached before the flag was surfaced on the subject.
      const isAdmin = (() => {
        try {
          const session = JSON.parse(localStorage.getItem('lotlogic_session') || '{}');
          if (session.is_platform_admin === true) return true;
          if (session.is_platform_admin === false) return false;
          const tok = session._token;
          if (!tok) return false;
          const p = JSON.parse(atob(tok.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
          return !!p.is_platform_admin;
        } catch { return false; }
      })();
      if (!isAdmin) {
        if (role === 'partner') q = q.eq('tow_company_id', userId);
        else q = q.eq('owner_id', userId);
      }
      q = q.order('created_at', { ascending: false });
      const { data, error } = await q;
      if (!error && data) return data;
    }
    return [];
  },
  async getProperty(id) {
    if (supabase) {
      const { data, error } = await supabase.from('properties').select('*').eq('id', id).single();
      if (!error && data) return data;
    }
    return null;
  },
  async createProperty(prop) {
    if (supabase) {
      const qrCode = prop.qr_code_id || (prop.name || 'prop').toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 20) + '-' + (crypto.randomUUID ? crypto.randomUUID().slice(0, 12) : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
      const { data, error } = await supabase.from('properties').insert({ ...prop, qr_code_id: qrCode }).select().single();
      if (error) throw new Error(error.message);
      return data;
    }
    return null;
  },
  async deleteProperty(id) {
    if (supabase) {
      const { error } = await supabase.from('properties').delete().eq('id', id);
      if (error) throw new Error(error.message);
      return { success: true };
    }
    return { success: true };
  },
  async updateProperty(id, updates) {
    if (supabase) {
      const { data, error } = await supabase.from('properties').update(updates).eq('id', id).select().single();
      if (error) throw new Error(error.message);
      return data;
    }
    return null;
  },
  async getResidentPlates(propertyId) {
    if (supabase) {
      const { data, error } = await supabase.from('resident_plates').select('*').eq('property_id', propertyId).eq('active', true).order('created_at', { ascending: false });
      if (!error && data) return data;
    }
    return [];
  },
  async addResidentPlate(plate) {
    if (supabase) {
      const normalized = { ...plate, plate_text: (plate.plate_text || '').toUpperCase().replace(/[^A-Z0-9]/g, '') };
      const { data, error } = await supabase.from('resident_plates').insert(normalized).select().single();
      if (error) throw new Error(error.message);
      return data;
    }
    return null;
  },
  async removeResidentPlate(id) {
    if (supabase) {
      const { error } = await supabase.from('resident_plates').update({ active: false }).eq('id', id);
      if (error) throw new Error(error.message);
      return { success: true };
    }
    return { success: true };
  },
  async approveResidentPlate(id) {
    if (supabase) {
      // Approval flips BOTH status and active. The cameras filter on
      // active=true (see findActiveResident in camera-snapshot/sessions.ts);
      // setting only status='approved' would leave the plate unrecognized.
      const { error } = await supabase.from('resident_plates').update({ status: 'approved', active: true }).eq('id', id);
      if (error) throw new Error(error.message);
      return { success: true };
    }
    return { success: true };
  },
  async getVisitorPasses(propertyId, opts = {}) {
    if (supabase) {
      // Pull the joined first-seen plate_event so the Active Pass Tracker can
      // show the camera snapshot of the vehicle BEFORE registration.
      let q = supabase.from('visitor_passes')
        .select('*, first_seen_event:plate_events!visitor_passes_first_seen_event_id_fkey(image_url, created_at)')
        .eq('property_id', propertyId);
      if (opts.status) q = q.eq('status', opts.status);
      q = q.order('created_at', { ascending: false }).limit(opts.limit || 100);
      const { data, error } = await q;
      if (!error && data) {
        // Flatten the join so callers can read p.first_seen_image_url like
        // they do on the parking-log endpoint response.
        return data.map(p => ({
          ...p,
          first_seen_image_url: p.first_seen_event?.image_url || null,
        }));
      }
    }
    return [];
  },
  // ─────────────────────────────────────────────────────────────────────────
  // THE SINGLE SOURCE OF TRUTH for "who is currently registered."
  // Every surface that shows registered passes (the Lots "Registered" count,
  // the Registered drill-down, and the Truck Parking Log's live roster) calls
  // THIS — one query, one definition — so they can never disagree again.
  //
  // The predicate is the canonical one, identical to the backend contract:
  //   status = 'active'  AND  exited_at IS NULL  AND  (valid_until IS NULL OR valid_until > now)
  // No date window. There IS a 500-row safety cap below — it is not expected
  // to bind (this is only trucks currently on the lot; Charlotte runs ~27),
  // but it is a cap, and three surfaces treat this function as the single
  // source of truth for "who is registered". If it ever binds we warn loudly
  // rather than silently under-reporting the roster. RLS scopes
  // visitor_passes to the property's owner AND tow partner, so the same query
  // is correct for every role. Throws on error so callers can keep the last
  // known roster on screen rather than blanking.
  // ─────────────────────────────────────────────────────────────────────────
  async getActiveRoster(propertyId) {
    if (!supabase || !propertyId) return [];
    // Plain, robust query: status='active' AND exited_at IS NULL. The result is
    // small (only trucks currently on the lot), so we apply the in-window check
    // client-side rather than depending on fragile PostgREST or() syntax for
    // the valid_until-null case. Throws on error so the caller keeps the last
    // known roster instead of blanking.
    const { data, error } = await supabase
      .from('visitor_passes')
      .select('*, first_seen_event:plate_events!visitor_passes_first_seen_event_id_fkey(image_url, created_at)')
      .eq('property_id', propertyId)
      .eq('status', 'active')
      .is('exited_at', null)
      .order('created_at', { ascending: false })
      .limit(ACTIVE_ROSTER_CAP);
    if (error) throw error;
    if ((data || []).length >= ACTIVE_ROSTER_CAP) {
      console.warn(`[roster] getActiveRoster hit the ${ACTIVE_ROSTER_CAP}-row cap for property ${propertyId} — the roster is being truncated and counts derived from it are low.`);
    }
    const now = Date.now();
    return (data || [])
      // Canonical window predicate: no expiry, or expiry still ahead of now.
      .filter(p => !p.valid_until || new Date(p.valid_until).getTime() > now)
      .map(p => ({ ...p, first_seen_image_url: p.first_seen_event?.image_url || null }));
  },
  async countVisitorPasses(propertyId) {
    if (supabase) {
      const { count, error } = await supabase
        .from('visitor_passes')
        .select('id', { count: 'exact', head: true })
        .eq('property_id', propertyId);
      if (!error) return count || 0;
    }
    return 0;
  },
  // Backend-backed paginated + filtered log for the Truck Parking Log tab.
  // Returns { items, total, page, page_size } on format=json, or a Blob on format=csv.
  async getParkingLog(propertyId, opts = {}) {
    const params = new URLSearchParams();
    params.set('property_id', propertyId);
    if (opts.format) params.set('format', opts.format);
    if (opts.status) params.set('status', opts.status);
    if (opts.plate) params.set('plate', opts.plate);
    if (opts.company_name) params.set('company', opts.company_name);
    // Both bounds are bare calendar dates (YYYY-MM-DD) the operator picked in
    // the lot, and the backend compares them against `created_at`. A bare date
    // parses to 00:00:00 UTC, which drops every pass created later that same
    // day; stamping the upper bound with `Z` instead ended the day at 19:59:59
    // Eastern, which dropped the entire night shift. Send each bound as a real
    // instant in the LOT's timezone so "through today" means through midnight
    // where the trucks actually are.
    if (opts.date_from) params.set('from_date', lotDayBound(opts.date_from, 'start'));
    if (opts.date_to) params.set('to_date', lotDayBound(opts.date_to, 'end'));
    if (opts.page) params.set('page', String(opts.page));
    if (opts.page_size) params.set('page_size', String(opts.page_size));
    if (opts.format === 'csv') {
      const token = getSessionToken();
      const headers = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const r = await fetch(`${API}/visitor_passes/parking-log?${params}`, { headers });
      if (!r.ok) throw new Error(`Log export failed (${r.status})`);
      return r.blob();
    }
    return apiFetch(`/visitor_passes/parking-log?${params}`);
  },
  // Pay-to-park counters for the log header: today's + this month's collected
  // totals, and how many payments are still settling. Owner or the lot's tow
  // partner; anything else 404s, which the caller treats as "nothing to show".
  // Returns { today: {count, cents}, month_to_date: {count, cents}, pending_recent,
  //           needs_review }. `today`, `month_to_date` and `needs_review` come
  // back null for a tow partner (R42) — the lot's money is the owner's.
  async getPlazaSummary(propertyId) {
    return apiFetch(`/plaza/summary?property_id=${encodeURIComponent(propertyId)}`);
  },
  // Fetch EVERY page of the parking log and concatenate. The backend caps
  // page_size at 500, so any property with more than 500 passes in the window
  // (Charlotte already has >540) would silently lose its OLDEST registrations —
  // unacceptable for the permanent History record. This pages through the whole
  // result set using the `total` the backend reports, with a hard page cap so a
  // bad `total` can never spin forever, and surfaces `truncated` if that cap is
  // ever hit so the UI can say so honestly rather than pretend it's complete.
  async getAllParkingLog(propertyId, opts = {}) {
    const PAGE_SIZE = 500;
    const MAX_PAGES = 60; // 30k rows — far beyond any real truck-plaza history
    let page = 1;
    let all = [];
    let total = 0;
    for (; page <= MAX_PAGES; page++) {
      const res = await this.getParkingLog(propertyId, { ...opts, page, page_size: PAGE_SIZE });
      const items = res.items || res.rows || [];
      total = res.total ?? items.length;
      all = all.concat(items);
      // Stop when the page came back short (last page) or we have everything.
      if (items.length < PAGE_SIZE || all.length >= total) break;
    }
    return { rows: all, total, truncated: all.length < total };
  },
  async cancelVisitorPass(id, reason) {
    return apiFetch(`/visitor_passes/${id}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(reason ? { reason } : {}),
    });
  },
  // Operator overrides on alpr_violations. All are owner-scoped on the
  // backend (POST /violations/{id}/{action}, see routers/violations.py).
  // `reason` flows through to the audit log as notes.
  async forceBillViolation(id, reason) {
    return apiFetch(`/violations/${id}/force-bill`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(reason ? { reason } : {}),
    });
  },
  // Records that a tow happened (action_taken='tow') — allowed for owners AND
  // tow partners. NOT force-bill: that stays an owner-only billing override.
  async recordCooldownTow(passId, reason) {
    return apiFetch(`/violations/record-tow`, {
      method: 'POST',
      body: JSON.stringify({ pass_id: passId, reason: reason || null }),
    });
  },
  async markViolationTowed(id, reason) {
    return apiFetch(`/violations/${id}/mark-towed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(reason ? { reason } : {}),
    });
  },
  async markViolationNoTow(id, reason) {
    return apiFetch(`/violations/${id}/mark-no-tow`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(reason ? { reason } : {}),
    });
  },
  async pauseViolationBilling(id, reason) {
    return apiFetch(`/violations/${id}/pause-billing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(reason ? { reason } : {}),
    });
  },
  async resumeViolationBilling(id) {
    return apiFetch(`/violations/${id}/resume-billing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
  },
  async getALPRCameras(propertyId) {
    if (supabase) {
      const { data, error } = await supabase.from('alpr_cameras').select('*').eq('property_id', propertyId).order('created_at', { ascending: false });
      if (!error && data) return data;
    }
    return [];
  },
  // Open ALPR violations for a property (no_action / unresolved). These
  // are the "no registration" rows — vehicle was in the lot past grace,
  // never registered. Joined with the trigger plate_event for the image.
  // Limit 500 (was 50): properties with backlogged overstays would lose
  // their tow/no-tow buttons on the older 6+ rows because they fell
  // outside the lookup map. Bumped to match the parking-log page size.
  async getOpenAlprViolations(propertyId) {
    if (!supabase || !propertyId) return [];
    const { data, error } = await supabase
      .from('alpr_violations')
      // `normalized_plate` is NOT a column on alpr_violations (was causing a 400
      // / empty result — the tow-button violation map never populated). Embed via
      // the explicit FK constraint name so the join is unambiguous.
      .select('id, plate_text, property_id, plate_event_id, status, action_taken, violation_type, created_at, plate_events!alpr_violations_plate_event_id_fkey(image_url, created_at, alpr_cameras:camera_id(name))')
      .eq('property_id', propertyId)
      .is('action_taken', null)
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) return [];
    return data || [];
  },
  // Most recent camera capture for a plate at a property — used by
  // ActivePassTracker's violations side to show "what does this car look
  // like?" on click. Falls back to normalized_plate match so expired
  // passes still resolve.
  async getLatestPlateEventForPlate(propertyId, plateText) {
    if (!supabase || !propertyId || !plateText) return null;
    const norm = (plateText || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const { data, error } = await supabase
      .from('plate_events')
      .select('id, plate_text, normalized_plate, image_url, created_at, camera_id, alpr_cameras:camera_id(name, location_description)')
      .eq('property_id', propertyId)
      .eq('normalized_plate', norm)
      .not('image_url', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error || !data || data.length === 0) return null;
    return data[0];
  },
  // Best camera frame for a vehicle, tolerant of OCR drift and front/back-plate
  // swaps (truck-plaza rigs register both). Falls back through exact -> back ->
  // fuzzy server-side (latest_vehicle_frame RPC) so pass rows show a picture far
  // more often than an exact front-plate match would. Also returns the frame's
  // make/model/color so a pass with no stored MMC can still display what we saw.
  async getBestVehicleFrame(propertyId, plateText, backPlate, fromTs, untilTs) {
    if (!supabase || !propertyId || !plateText) return null;
    const norm  = (plateText || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const bnorm = (backPlate || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    // Bound to the pass's visit window so we never show a frame from a prior
    // visit (a stale frame is almost never the same stay, and often blank).
    const args = { p_property_id: propertyId, p_plate: norm, p_back_plate: bnorm };
    if (fromTs)  args.p_from  = fromTs;
    if (untilTs) args.p_until = untilTs;
    const { data, error } = await supabase.rpc('latest_vehicle_frame', args);
    if (error || !data || data.length === 0) return null;
    return data[0];
  },
  // Every camera frame linked to a pass (entry, exit, retro-linked — all of
  // them), oldest first. Feeds the PassPhotoStrip; one query per card, lazy.
  async getPassPhotos(passId) {
    if (!supabase || !passId) return [];
    const { data, error } = await supabase
      .from('plate_events')
      // The three box fields let thumbnails crop a busy multi-vehicle frame
      // to the vehicle that actually produced the read (only newer events
      // carry them; older rows crop to nothing = full frame as before).
      .select('id, image_url, created_at, plate_box:raw_data->plate_box, vehicle_box:raw_data->vehicle_box, cam_box:raw_data->cam_box, alpr_cameras:camera_id(name)')
      .eq('visitor_pass_id', passId)
      .not('image_url', 'is', null)
      .order('created_at', { ascending: true })
      .limit(10);
    if (error) throw error;
    return (data || []).map(e => ({ id: e.id, url: e.image_url, at: e.created_at, camera: e.alpr_cameras?.name || null, box: e.vehicle_box || e.cam_box || e.plate_box || null }));
  },
  // The exact camera frame that closed a pass (the exit/departure proof),
  // fetched by the pass's exited_via_plate_event_id. Returns image + camera + time.
  async getExitFrame(plateEventId) {
    if (!supabase || !plateEventId) return null;
    const { data, error } = await supabase
      .from('plate_events')
      .select('image_url, created_at, confidence, alpr_cameras:camera_id(name)')
      .eq('id', plateEventId)
      .maybeSingle();
    if (error || !data || !data.image_url) return null;
    return { image_url: data.image_url, created_at: data.created_at, confidence: data.confidence, camera_name: data.alpr_cameras?.name || null };
  },
  async getRecentPlateEvents(propertyId, limit = 50) {
    if (supabase) {
      const { data, error } = await supabase
        .from('plate_events')
        // plate_events↔plate_sessions has 3 relationships (session_id here, plus
        // entry/exit_plate_event_id back-refs), so a bare plate_sessions(state)
        // embed is ambiguous → 300. Pin the FK we mean (plate_events.session_id).
        .select('id, plate_text, normalized_plate, confidence, image_url, event_type, camera_id, created_at, visitor_pass_id, resident_plate_id, match_status, match_reason, matched_at, session_id, plate_sessions!plate_events_session_id_fkey(state)')
        .eq('property_id', propertyId)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (!error && data) return data;
    }
    return [];
  },
  async getOpenSessions(propertyId) {
    if (supabase) {
      const { data, error } = await supabase
        .from('plate_sessions')
        .select('id, normalized_plate, plate_text, vehicle_type, entered_at, state, visitor_pass_id, resident_plate_id, entry_camera_id, exit_camera_id, violation_id, last_detected_at, exit_hinted_at')
        .eq('property_id', propertyId)
        .is('exited_at', null)
        .order('entered_at', { ascending: false });
      if (!error && data) return data;
    }
    return [];
  },
  async getActiveHolds(propertyId) {
    if (supabase) {
      const { data, error } = await supabase
        .from('plate_holds')
        .select('id, normalized_plate, held_at, hold_until, reason, source_session_id')
        .eq('property_id', propertyId)
        .gt('hold_until', new Date().toISOString())
        .order('held_at', { ascending: false });
      if (!error && data) return data;
    }
    return [];
  },
  async releasePlateHold(holdId) {
    if (supabase) {
      const { error } = await supabase
        .from('plate_holds')
        .update({ hold_until: new Date().toISOString() })
        .eq('id', holdId);
      if (error) throw new Error(error.message);
      return { success: true };
    }
    return { success: true };
  },
  async removeALPRCamera(id) {
    if (supabase) {
      const { error } = await supabase.from('alpr_cameras').delete().eq('id', id);
      if (error) throw new Error(error.message);
      return { success: true };
    }
    return { success: true };
  },
  async registerALPRCamera(cam) {
    if (supabase) {
      const apiKey = 'alpr_' + crypto.randomUUID().replace(/-/g, '');
      const { data, error } = await supabase.from('alpr_cameras').insert({ ...cam, api_key: apiKey }).select().single();
      if (error) throw new Error(error.message);
      return data;
    }
    return null;
  },
  async getALPRViolations(propertyId, status) {
    if (supabase) {
      let q = supabase.from('alpr_violations').select('*, plate_events(image_url, confidence, event_type, camera_id, created_at, usdot_number, mc_number, vehicle_make, vehicle_model, vehicle_color, vehicle_type, alpr_cameras:camera_id(id, name, gate_id))');
      if (propertyId) q = q.eq('property_id', propertyId);
      if (status) q = q.eq('status', status);
      q = q.order('created_at', { ascending: false }).limit(200);
      const { data, error } = await q;
      if (!error && data) return await this._enrichWithPairedSnapshot(data);
    }
    return [];
  },
  async _getPropertyIds(userId, role) {
    if (!supabase || !userId) return [];
    const col = role === 'partner' ? 'tow_company_id' : 'owner_id';
    const { data } = await supabase.from('properties').select('id').eq(col, userId);
    return (data || []).map(p => p.id);
  },
  async getAllALPRViolations(userId, status, role) {
    if (supabase) {
      const propIds = await this._getPropertyIds(userId, role);
      if (propIds.length === 0) return [];
      let q = supabase.from('alpr_violations').select('*, plate_events(image_url, confidence, event_type, camera_id, created_at, usdot_number, mc_number, vehicle_make, vehicle_model, vehicle_color, vehicle_type, alpr_cameras:camera_id(id, name, gate_id)), properties(name, address)').in('property_id', propIds);
      if (status) q = q.eq('status', status);
      q = q.order('created_at', { ascending: false }).limit(200);
      const { data, error } = await q;
      if (!error && data) return await this._enrichWithPairedSnapshot(data);
    }
    return [];
  },

  // For each violation, attach the paired camera's snapshot — the second
  // camera at the same gate that fired motion (with or without OCR)
  // around the same time as the entry plate event. Lets the operator
  // visually verify that BOTH cameras at the gate saw the vehicle, not
  // just one. A single-camera read is structurally ambiguous (front or
  // back of a truck?) — the paired snapshot disambiguates.
  async _enrichWithPairedSnapshot(violations) {
    if (!supabase || !violations.length) return violations;
    // Pull all candidate paired events in one batch. Window: ±60s around
    // each violation's entry time, scoped to the partner camera at the
    // same gate.
    const PAIR_WINDOW_SEC = 60;
    const fetchOne = async (v) => {
      const ev = v.plate_events;
      if (!ev || !ev.created_at) return null;
      const gateId = ev.alpr_cameras?.gate_id;
      const camId = ev.camera_id;
      if (!gateId || !camId) return null;
      const t = new Date(ev.created_at).getTime();
      const lo = new Date(t - PAIR_WINDOW_SEC * 1000).toISOString();
      const hi = new Date(t + PAIR_WINDOW_SEC * 1000).toISOString();
      const { data } = await supabase
        .from('plate_events')
        .select('image_url, created_at, alpr_cameras!inner(gate_id, name)')
        .eq('alpr_cameras.gate_id', gateId)
        .neq('camera_id', camId)
        .not('image_url', 'is', null)
        .gte('created_at', lo)
        .lte('created_at', hi)
        .order('created_at', { ascending: true })
        .limit(1);
      return (data || [])[0] || null;
    };
    const paired = await Promise.all(violations.map(fetchOne));
    violations.forEach((v, i) => {
      v._paired_snapshot_url = paired[i]?.image_url || null;
      v._paired_camera_name = paired[i]?.alpr_cameras?.name || null;
    });
    return violations;
  },
  async updateALPRViolation(id, updates) {
    if (supabase) {
      const { data, error } = await supabase.from('alpr_violations').update(updates).eq('id', id).select().single();
      if (error) throw new Error(error.message);
      return data;
    }
    return null;
  },
  async dispatchALPRViolation(id) {
    // Operator confirms a tow via the dashboard. action_taken='tow' + action_channel='dashboard'
    // are the partner-reply signal; the camera-side confirmation worker writes tow_confirmed_at
    // independently. Both feed into v_violation_billing_status.
    const now = new Date().toISOString();
    return this.updateALPRViolation(id, {
      status: 'dispatched',
      dispatched_at: now,
      action_taken: 'tow',
      action_channel: 'dashboard',
      action_at: now,
    });
  },
  async dismissALPRViolation(id, notes) {
    const now = new Date().toISOString();
    return this.updateALPRViolation(id, {
      status: 'dismissed',
      resolved_at: now,
      action_taken: 'no_tow',
      action_channel: 'dashboard',
      action_at: now,
      notes: notes || 'Dismissed by operator',
    });
  },
  async getTowJobs(opts = {}) {
    if (supabase) {
      let q = supabase.from('tow_jobs').select('*, properties(name), alpr_violations(plate_text)');
      if (opts.propertyId) q = q.eq('property_id', opts.propertyId);
      if (opts.towCompanyId) q = q.eq('tow_company_id', opts.towCompanyId);
      if (opts.status) q = q.eq('status', opts.status);
      q = q.order('created_at', { ascending: false }).limit(opts.limit || 100);
      const { data, error } = await q;
      if (!error && data) return data;
    }
    return [];
  },
  async recordTowJob(job) {
    if (supabase) {
      const fee = parseFloat(job.tow_fee) || 0;
      const rate = job.commission_rate ?? 0.25;
      const commission = Math.round(fee * rate * 100) / 100;
      const { data, error } = await supabase.from('tow_jobs').insert({
        ...job,
        tow_fee: fee,
        commission_rate: rate,
        commission_amount: commission,
        dispatched_at: new Date().toISOString(),
      }).select().single();
      if (error) throw new Error(error.message);
      // Mark violation as resolved (best-effort — tow job is already recorded)
      if (job.violation_id) {
        try { await supabase.from('alpr_violations').update({ status: 'resolved', resolved_at: new Date().toISOString() }).eq('id', job.violation_id); } catch (_) { console.error('Failed to resolve violation after tow job creation'); }
      }
      return data;
    }
    return null;
  },
  async getALPRStats(userId, role) {
    if (supabase) {
      const propIds = await this._getPropertyIds(userId, role);
      if (propIds.length === 0) return { activeViolations: 0, activePasses: 0, towJobsMonth: 0, commissionMonth: 0, properties: 0 };
      const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString();
      const now = new Date().toISOString();
      const [viols, passes, jobs] = await Promise.all([
        supabase.from('alpr_violations').select('id', { count: 'exact', head: true }).in('property_id', propIds).in('status', ['pending', 'dispatched']),
        supabase.from('visitor_passes').select('id', { count: 'exact', head: true }).in('property_id', propIds).eq('status', 'active').gte('valid_until', now),
        supabase.from('tow_jobs').select('commission_amount').in('property_id', propIds).gte('created_at', monthAgo),
      ]);
      const commission = (jobs.data || []).reduce((s, j) => s + (parseFloat(j.commission_amount) || 0), 0);
      return {
        activeViolations: viols.count || 0,
        activePasses: passes.count || 0,
        towJobsMonth: (jobs.data || []).length,
        commissionMonth: commission,
        properties: propIds.length,
      };
    }
    return { activeViolations: 0, activePasses: 0, towJobsMonth: 0, commissionMonth: 0, properties: 0 };
  },
  subscribeALPRViolations(propertyIds, callback) {
    if (!supabase || !propertyIds?.length) return null;
    const channel = supabase.channel('alpr-violations-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'alpr_violations' }, payload => {
        if (propertyIds.includes(payload.new?.property_id) || propertyIds.includes(payload.old?.property_id)) {
          callback(payload);
        }
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'plate_events' }, payload => {
        if (propertyIds.includes(payload.new?.property_id)) callback(payload);
      })
      .subscribe();
    return channel;
  },
};
