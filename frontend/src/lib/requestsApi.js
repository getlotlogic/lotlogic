// ── Typed wrappers over the portal's HTTP API ────────────────
//
// One function per route, nothing else. Each returns the parsed JSON body and
// rethrows `apiFetch`'s error **untouched** — `.status`, `.message`, `.body`
// and `.code` all come from `errorFromResponse` in api.js, so a caller can
// branch on `err.code === 'active_hold_exists'` and read
// `err.body.request_id`. This module adds nothing to an error and swallows
// none: every call site decides what a failure means.
//
// Routes: `/apartment/requests*` (spec §8.3 `routers/tow_requests.py`),
// `/partner/lookup`, `/auth/signup*`, `/auth/verify-email`,
// `/auth/resend-verification`, `/auth/change-email`, `/properties/*/members*`,
// `/apartment/properties*`, `/partner/properties*`, `/partner/slack/*` and the
// two public `/requests/action` entries.

import { API, apiFetch, errorFromResponse, getSessionToken } from './api.js';

const JSON_HEADERS = { 'content-type': 'application/json' };

/** `?a=1&b=2` from an object, skipping null / undefined / '' values. */
function query(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === null || v === undefined || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

const seg = (id) => encodeURIComponent(String(id));

function get(path) {
  return apiFetch(path);
}
function send(method, path, body) {
  return apiFetch(path, {
    method,
    headers: JSON_HEADERS,
    body: JSON.stringify(body ?? {}),
  });
}
const post = (path, body) => send('POST', path, body);
const patch = (path, body) => send('PATCH', path, body);
const del = (path) => apiFetch(path, { method: 'DELETE' });

/** multipart — never set content-type by hand, the boundary comes from FormData. */
function upload(path, form) {
  return apiFetch(path, { method: 'POST', body: form });
}

// ── /apartment/requests ──────────────────────────────────────

/** POST /apartment/requests → `201 {request}` */
export const createRequest = (body) => post('/apartment/requests', body);

/** GET /apartment/requests → `{items, next_cursor}` */
export const listRequests = (params) => get(`/apartment/requests${query(params)}`);

/** GET /apartment/requests/{id} → `{request, events, deliveries, property}` */
export const getRequest = (id) => get(`/apartment/requests/${seg(id)}`);

/** POST /apartment/requests/{id}/extend `{duration_hours|expires_at}` */
export const extendRequest = (id, body) => post(`/apartment/requests/${seg(id)}/extend`, body);

/** POST /apartment/requests/{id}/remove `{note?}` */
export const removeRequest = (id, body) => post(`/apartment/requests/${seg(id)}/remove`, body);

/** POST /apartment/requests/{id}/reinstate `{duration_hours?, undo?}` */
export const reinstateRequest = (id, body) => post(`/apartment/requests/${seg(id)}/reinstate`, body);

/** POST /apartment/requests/{id}/ack — idempotent */
export const ackRequest = (id) => post(`/apartment/requests/${seg(id)}/ack`, {});

/** POST /apartment/requests/{id}/fulfill `{resolution, note?, photo_key?}` */
export const fulfillRequest = (id, body) => post(`/apartment/requests/${seg(id)}/fulfill`, body);

/** POST /apartment/requests/{id}/decline `{reason}` */
export const declineRequest = (id, body) => post(`/apartment/requests/${seg(id)}/decline`, body);

/** POST /apartment/requests/uploads — multipart `file`, `property_id` → `{photo_key}` */
export function uploadPhoto(file, propertyId) {
  const form = new FormData();
  form.append('file', file);
  form.append('property_id', propertyId);
  return upload('/apartment/requests/uploads', form);
}

/**
 * GET /apartment/requests/{id}/photo → a Blob.
 * Not `apiFetch`: the route streams an image, and an `<img src>` cannot carry
 * a Bearer header, so the caller turns this into an object URL (and revokes
 * it). Errors are built by the same `errorFromResponse` so a caller branches
 * on `.status` exactly as everywhere else.
 */
export async function fetchRequestPhoto(id) {
  const token = getSessionToken();
  const r = await fetch(`${API}/apartment/requests/${seg(id)}/photo`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!r.ok) {
    let body = null;
    try { body = await r.json(); } catch { /* an image route may answer non-JSON */ }
    throw errorFromResponse(r.status, body);
  }
  return r.blob();
}

/** POST /apartment/requests/read-plate — multipart `file`, `property_id` (phase 1b) */
export function readPlate(file, propertyId) {
  const form = new FormData();
  form.append('file', file);
  form.append('property_id', propertyId);
  return upload('/apartment/requests/read-plate', form);
}

// ── /partner/lookup ──────────────────────────────────────────

/** GET /partner/lookup?plate=&property_id= */
export const lookupPlate = (params) => get(`/partner/lookup${query(params)}`);

// ── /auth/signup* and email verification ─────────────────────

/** GET /auth/signup/context?slug= → `{partner, partners}` */
export const signupContext = (slug) => get(`/auth/signup/context${query({ slug })}`);

/** GET /auth/signup/match?slug&place_id&name&address_line1&postal_code */
export const signupMatch = (params) => get(`/auth/signup/match${query(params)}`);

/** POST /auth/signup → one of the three §3.6 bodies */
export const signup = (body) => post('/auth/signup', body);

/** POST /auth/verify-email `{code}` */
export const verifyEmail = (body) => post('/auth/verify-email', body);

/** POST /auth/resend-verification — 429 `resend_cooldown {retry_after}` */
export const resendVerification = (body) => post('/auth/resend-verification', body);

/** POST /auth/change-email `{email}` */
export const changeEmail = (body) => post('/auth/change-email', body);

// ── /properties/{id}/members* ────────────────────────────────

/** GET /properties/{id}/members */
export const listMembers = (propertyId) => get(`/properties/${seg(propertyId)}/members`);

/** POST /properties/{id}/members/invite `{email, name, role, admin?}` */
export const inviteMember = (propertyId, body) => post(`/properties/${seg(propertyId)}/members/invite`, body);

/** PATCH /properties/{id}/members/{account_id} `{role?, admin?}` */
export const updateMember = (propertyId, accountId, body) =>
  patch(`/properties/${seg(propertyId)}/members/${seg(accountId)}`, body);

/** DELETE /properties/{id}/members/{account_id} — `status='removed'`, 409 `last_admin` */
export const removeMember = (propertyId, accountId) =>
  del(`/properties/${seg(propertyId)}/members/${seg(accountId)}`);

/** POST /properties/{id}/members/{account_id}/approve */
export const approveMember = (propertyId, accountId) =>
  post(`/properties/${seg(propertyId)}/members/${seg(accountId)}/approve`, {});

/** POST /properties/{id}/members/{account_id}/decline */
export const declineMember = (propertyId, accountId) =>
  post(`/properties/${seg(propertyId)}/members/${seg(accountId)}/decline`, {});

/** POST /properties/{id}/members/join — the in-app "That's mine — ask to join" */
export const joinProperty = (propertyId) => post(`/properties/${seg(propertyId)}/members/join`, {});

/** POST /properties/{id}/members/join/resend — re-notifies the approvers (once per 24 h) */
export const resendJoinRequest = (propertyId) => post(`/properties/${seg(propertyId)}/members/join/resend`, {});

// ── /apartment/properties* ───────────────────────────────────

/** POST /apartment/properties → `201 {property}` / 409 `duplicate {candidates}` */
export const createApartmentProperty = (body) => post('/apartment/properties', body);

/** PATCH /apartment/properties/{id} — name / address / notes only */
export const updateApartmentProperty = (id, body) => patch(`/apartment/properties/${seg(id)}`, body);

/** POST /apartment/properties/{id}/archive — soft delete */
export const archiveApartmentProperty = (id) => post(`/apartment/properties/${seg(id)}/archive`, {});

// ── /partner/properties* ─────────────────────────────────────

/** GET /partner/properties?verification_status=pending */
export const listPartnerProperties = (params) => get(`/partner/properties${query(params)}`);

/** POST /partner/properties/{id}/verify */
export const verifyPartnerProperty = (id) => post(`/partner/properties/${seg(id)}/verify`, {});

/** POST /partner/properties/{id}/reject `{reason}` */
export const rejectPartnerProperty = (id, body) => post(`/partner/properties/${seg(id)}/reject`, body);

// ── /partner/slack/* ─────────────────────────────────────────

/** GET /partner/slack/status → `{connected, team_name, feed_channel_set, revoked}` */
export const getSlackStatus = () => get('/partner/slack/status');

/** POST /partner/slack/install-link */
export const slackInstallLink = () => post('/partner/slack/install-link', {});

/** GET /partner/slack/identities */
export const listSlackIdentities = () => get('/partner/slack/identities');

/** PATCH /partner/slack/identities/{slack_user_id} `{role}` */
export const updateSlackIdentity = (slackUserId, body) =>
  patch(`/partner/slack/identities/${seg(slackUserId)}`, body);

/** DELETE /partner/slack/identities/{slack_user_id} */
export const deleteSlackIdentity = (slackUserId) => del(`/partner/slack/identities/${seg(slackUserId)}`);

/** POST /partner/slack/feed-channel `{channel_id}` */
export const setSlackFeedChannel = (body) => post('/partner/slack/feed-channel', body);

// ── /requests/action (public, exact paths) ───────────────────

/** GET /requests/action?token= → `{action, request}` preview */
export const getRequestAction = (token) => get(`/requests/action${query({ token })}`);

/** POST /requests/action `{token, action?}` → `{result, request}` */
export const postRequestAction = (body) => post('/requests/action', body);

export const requestsApi = {
  createRequest, listRequests, getRequest, extendRequest, removeRequest,
  reinstateRequest, ackRequest, fulfillRequest, declineRequest, uploadPhoto,
  fetchRequestPhoto, readPlate, lookupPlate, signupContext, signupMatch,
  signup, verifyEmail, resendVerification, changeEmail, listMembers,
  inviteMember, updateMember, removeMember, approveMember, declineMember,
  joinProperty, resendJoinRequest, createApartmentProperty, updateApartmentProperty,
  archiveApartmentProperty, listPartnerProperties, verifyPartnerProperty,
  rejectPartnerProperty, getSlackStatus, slackInstallLink, listSlackIdentities, updateSlackIdentity,
  deleteSlackIdentity, setSlackFeedChannel, getRequestAction, postRequestAction,
};
