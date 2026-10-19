// The tow company's Team section (spec 2026-10-18-tow-company-team §1.3,
// §1.4, §4): the pure half in src/lib/partnerTeam.js, and the five
// `/partner/team…` wrappers in src/lib/requestsApi.js.
//
// The role column keeps its DB values (`admin` | `dispatcher` | `driver`);
// what a person reads is "Admin" / "Dispatch" / "Truck", never the third
// value's own name.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TEAM_ROLES, teamRoleLabel, canManageTeam, teamMembers,
  INVITE_ERRORS, buildInvite,
  lastSignedInLabel, memberStatusLine, memberPhone,
  lastAdminBlocked, LAST_ADMIN_REASON,
  teamErrorMessage, removeConfirmText,
  sessionNames, partnerFieldsFromMe, headerName,
  isTruck, canAssignProperties, ALL_PROPERTIES, NO_PROPERTIES_YET, UNKNOWN_PROPERTY_SENTENCE,
  memberPropertyIds, propertiesRow, assignableProperties, sameIdSet, idsToSave,
  firstAdminName, askAdminSentence,
} from '../src/lib/partnerTeam.js';
import {
  listTeam, inviteTeammate, patchTeammate, removeTeammate, resendTeammate, requestsApi, teamPath,
  assignProperties,
} from '../src/lib/requestsApi.js';

// ── role labels ──────────────────────────────────────────────

test('the three roles read Admin, Dispatch and Truck', () => {
  assert.deepEqual(TEAM_ROLES, ['admin', 'dispatcher', 'driver']);
  assert.equal(teamRoleLabel('admin'), 'Admin');
  assert.equal(teamRoleLabel('dispatcher'), 'Dispatch');
  assert.equal(teamRoleLabel('driver'), 'Truck');
});

test('an unknown role never echoes its own value', () => {
  for (const bad of [undefined, null, '', 'Driver', 'DRIVER', 'manager', 'owner']) {
    assert.equal(teamRoleLabel(bad), '', String(bad));
  }
});

// ── who may change the team ──────────────────────────────────

test('canManageTeam: an Admin member may', () => {
  assert.equal(canManageTeam({ _role: 'partner', member_role: 'admin' }), true);
});

test('canManageTeam: Dispatch and Truck may not', () => {
  assert.equal(canManageTeam({ _role: 'partner', member_role: 'dispatcher' }), false);
  assert.equal(canManageTeam({ _role: 'partner', member_role: 'driver' }), false);
});

test('canManageTeam: a partner session from before team logins is the company Admin', () => {
  assert.equal(canManageTeam({ _role: 'partner' }), true);
  assert.equal(canManageTeam({ _role: 'partner', member_role: null }), true);
});

test('canManageTeam: never an owner, never no session', () => {
  assert.equal(canManageTeam({ _role: 'owner' }), false);
  assert.equal(canManageTeam({ _role: 'owner', member_role: 'admin' }), false);
  assert.equal(canManageTeam(null), false);
  assert.equal(canManageTeam(undefined), false);
});

// ── the roster payload ───────────────────────────────────────

test('teamMembers reads {members: [...]} and tolerates nothing', () => {
  const a = { id: 'm1' };
  assert.deepEqual(teamMembers({ members: [a] }), [a]);
  assert.deepEqual(teamMembers([a]), [a]);
  assert.deepEqual(teamMembers({}), []);
  assert.deepEqual(teamMembers(null), []);
});

// ── the invite body ──────────────────────────────────────────

test('buildInvite: name, email and role, trimmed; the email lowercased; no phone when blank', () => {
  const r = buildInvite({ name: '  Sam Ortiz ', email: ' Sam@QueenCityTow.test ', phone: '', role: 'driver' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.body, { name: 'Sam Ortiz', email: 'sam@queencitytow.test', role: 'driver' });
  assert.ok(!('phone' in r.body));
});

test('buildInvite: a phone goes out as +1 and ten digits', () => {
  const r = buildInvite({ name: 'Sam', email: 'sam@x.test', phone: '(704) 555-0142', role: 'dispatcher' });
  assert.equal(r.ok, true);
  assert.equal(r.body.phone, '+17045550142');
});

test('buildInvite: a name is required', () => {
  const r = buildInvite({ name: '   ', email: 'sam@x.test', role: 'admin' });
  assert.equal(r.ok, false);
  assert.equal(r.body, null);
  assert.equal(r.errors.name, INVITE_ERRORS.name);
});

test('buildInvite: an email that is not one', () => {
  for (const email of ['', 'sam', 'sam@', '@x.test', 'sam@x', 'sam x@y.test']) {
    const r = buildInvite({ name: 'Sam', email, role: 'admin' });
    assert.equal(r.ok, false, email);
    assert.equal(r.errors.email, INVITE_ERRORS.email, email);
  }
});

test('buildInvite: a phone that cannot be a US number', () => {
  const r = buildInvite({ name: 'Sam', email: 'sam@x.test', phone: '555', role: 'admin' });
  assert.equal(r.ok, false);
  assert.equal(r.errors.phone, INVITE_ERRORS.phone);
});

test('buildInvite: the role must be one of the three', () => {
  for (const role of [undefined, '', 'manager', 'owner', 'Driver']) {
    const r = buildInvite({ name: 'Sam', email: 'sam@x.test', role });
    assert.equal(r.ok, false, String(role));
    assert.equal(r.errors.role, INVITE_ERRORS.role, String(role));
  }
  for (const role of TEAM_ROLES) {
    assert.equal(buildInvite({ name: 'Sam', email: 'sam@x.test', role }).ok, true, role);
  }
});

test('buildInvite: every problem is reported, not just the first', () => {
  const r = buildInvite({});
  assert.deepEqual(Object.keys(r.errors).sort(), ['email', 'name', 'role']);
});

// ── "last signed in …" / "Set-up link not used yet" ──────────

// Sun Oct 18 2026, 3:00 PM EDT.
const NOW = Date.parse('2026-10-18T19:00:00Z');

test('lastSignedInLabel: inside the week, the weekday and the ET clock', () => {
  assert.equal(lastSignedInLabel('2026-10-16T13:05:00Z', { now: NOW }), 'last signed in Fri 9:05 AM');
  assert.equal(lastSignedInLabel('2026-10-18T18:30:00Z', { now: NOW }), 'last signed in Sun 2:30 PM');
});

test('lastSignedInLabel: older than six days, the date instead', () => {
  assert.equal(lastSignedInLabel('2026-10-02T13:05:00Z', { now: NOW }), 'last signed in Oct 2');
  assert.equal(lastSignedInLabel('2025-12-30T13:05:00Z', { now: NOW }), 'last signed in Dec 30, 2025');
});

test('lastSignedInLabel: nothing for no time or a bad one', () => {
  assert.equal(lastSignedInLabel(null, { now: NOW }), null);
  assert.equal(lastSignedInLabel('', { now: NOW }), null);
  assert.equal(lastSignedInLabel('not a date', { now: NOW }), null);
});

test('memberStatusLine: no password yet says the set-up link is unused', () => {
  assert.equal(memberStatusLine({ has_password: false, last_login_at: null }, { now: NOW }), 'Set-up link not used yet');
  // a set-up link wins over a stale login time
  assert.equal(memberStatusLine({ has_password: false, last_login_at: '2026-10-16T13:05:00Z' }, { now: NOW }), 'Set-up link not used yet');
});

test('memberStatusLine: a password and a login reads the last sign-in', () => {
  assert.equal(memberStatusLine({ has_password: true, last_login_at: '2026-10-16T13:05:00Z' }, { now: NOW }), 'last signed in Fri 9:05 AM');
});

test('memberStatusLine: a password and no login yet has no line', () => {
  assert.equal(memberStatusLine({ has_password: true, last_login_at: null }, { now: NOW }), null);
});

test('memberPhone: a US number is shown the way it is dialed', () => {
  assert.equal(memberPhone('+17045550142'), '(704) 555-0142');
  assert.equal(memberPhone('7045550142'), '(704) 555-0142');
  assert.equal(memberPhone('+44 20 7946 0958'), '+44 20 7946 0958');
  assert.equal(memberPhone(null), '');
  assert.equal(memberPhone(''), '');
});

// ── the last Admin ───────────────────────────────────────────

const DANA = { id: 'm1', name: 'Dana Reyes', role: 'admin' };
const SAM = { id: 'm2', name: 'Sam Ortiz', role: 'driver' };
const LEE = { id: 'm3', name: 'Lee Park', role: 'admin' };

test('lastAdminBlocked: the only Admin cannot be changed or removed', () => {
  assert.equal(lastAdminBlocked([DANA, SAM], DANA), true);
});

test('lastAdminBlocked: with a second Admin, either may be', () => {
  assert.equal(lastAdminBlocked([DANA, SAM, LEE], DANA), false);
  assert.equal(lastAdminBlocked([DANA, SAM, LEE], LEE), false);
});

test('lastAdminBlocked: a non-Admin is never blocked', () => {
  assert.equal(lastAdminBlocked([DANA, SAM], SAM), false);
});

test('lastAdminBlocked: found by id, not by object identity', () => {
  assert.equal(lastAdminBlocked([DANA, SAM], { ...DANA }), true);
  assert.equal(lastAdminBlocked(null, DANA), true);
  assert.equal(lastAdminBlocked([DANA], null), false);
});

test('the last-Admin reason is the spec sentence', () => {
  assert.equal(LAST_ADMIN_REASON, 'Add another Admin before changing this one.');
});

// ── error codes → sentences ──────────────────────────────────

function apiError(status, detail) {
  const e = new Error(typeof detail === 'string' ? detail : `Server error (${status})`);
  e.status = status;
  e.body = { detail };
  e.code = typeof detail === 'string' ? detail : undefined;
  return e;
}

test('teamErrorMessage: email_in_use and last_admin have their sentences', () => {
  assert.equal(teamErrorMessage(apiError(409, 'email_in_use')), 'That email already has a LotLogic login.');
  assert.equal(teamErrorMessage(apiError(409, 'last_admin')), 'Add another Admin before changing this one.');
});

test('teamErrorMessage: anything else is the call site sentence, never the code', () => {
  assert.equal(teamErrorMessage(apiError(404, 'not_found'), 'Could not remove access. Try again.'), 'Could not remove access. Try again.');
  assert.equal(teamErrorMessage(apiError(422, [{ msg: 'bad' }]), 'Could not send the invite. Try again.'), 'Could not send the invite. Try again.');
  assert.equal(teamErrorMessage(new TypeError('Failed to fetch')), 'Something went wrong. Try again.');
  assert.equal(teamErrorMessage(null), 'Something went wrong. Try again.');
});

// ── the Remove access confirm (spec §1.3, verbatim) ──────────

test('removeConfirmText is the spec sentence with the name and the company', () => {
  assert.equal(
    removeConfirmText({ name: 'Sam Ortiz' }, 'Queen City Towing'),
    'Sam Ortiz will lose access to Queen City Towing on LotLogic. Their past requests stay on the record.',
  );
});

test('removeConfirmText still reads when a name or the company is missing', () => {
  assert.equal(
    removeConfirmText({}, ''),
    'This person will lose access to your company on LotLogic. Their past requests stay on the record.',
  );
});

// ── who the session is (spec §1.2, §1.4) ─────────────────────

test('sessionNames: an owner login is unchanged', () => {
  assert.deepEqual(
    sessionNames({ type: 'owner', id: 'o1', display_name: 'Spring Lake Apartments' }),
    { business_name: 'Spring Lake Apartments', company_name: undefined },
  );
});

test('sessionNames: a partner login from before team logins is unchanged', () => {
  assert.deepEqual(
    sessionNames({ type: 'partner', id: 'p1', display_name: 'Queen City Towing' }),
    { business_name: 'Queen City Towing', company_name: 'Queen City Towing' },
  );
});

test("sessionNames: a member's display_name is the person, so it never becomes the company", () => {
  const out = sessionNames({
    type: 'partner', id: 'p1', display_name: 'Dana Reyes', member_id: 'm1', member_role: 'dispatcher',
  });
  assert.deepEqual(out, { member_id: 'm1', member_role: 'dispatcher', member_name: 'Dana Reyes' });
});

test('partnerFieldsFromMe: the company and the member from /auth/me', () => {
  assert.deepEqual(
    partnerFieldsFromMe({
      type: 'partner', company_name: 'Queen City Towing', display_name: 'Queen City Towing',
      member: { id: 'm1', name: 'Dana Reyes', role: 'admin' },
    }),
    {
      company_name: 'Queen City Towing', business_name: 'Queen City Towing',
      member_id: 'm1', member_role: 'admin', member_name: 'Dana Reyes',
    },
  );
});

test('partnerFieldsFromMe: no member block leaves the member fields alone', () => {
  assert.deepEqual(
    partnerFieldsFromMe({ type: 'partner', company_name: 'Queen City Towing' }),
    { company_name: 'Queen City Towing', business_name: 'Queen City Towing' },
  );
});

test('partnerFieldsFromMe: nothing for an owner, nothing for no company name', () => {
  assert.deepEqual(partnerFieldsFromMe({ type: 'owner', business_name: 'Spring Lake' }), {});
  assert.deepEqual(partnerFieldsFromMe({ type: 'partner', company_name: null }), {});
  assert.deepEqual(partnerFieldsFromMe(null), {});
});

test("headerName: a member's own name, the company's only for a company login", () => {
  assert.equal(headerName({ member_name: 'Dana Reyes', business_name: 'Queen City Towing' }), 'Dana Reyes');
  assert.equal(headerName({ business_name: 'Queen City Towing', contact_name: 'Dana' }), 'Queen City Towing');
  assert.equal(headerName({ contact_name: 'Dana' }), 'Dana');
  assert.equal(headerName(null), '');
});

// ── the five calls (spec §1.3) ───────────────────────────────

async function seen(call) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body === undefined ? undefined : JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try { await call(); } finally { globalThis.fetch = realFetch; }
  assert.equal(calls.length, 1);
  return calls[0];
}

test('listTeam: GET /partner/team', async () => {
  const c = await seen(() => listTeam());
  assert.ok(c.url.endsWith('/partner/team'), c.url);
  assert.equal(c.method, 'GET');
  assert.equal(requestsApi.listTeam, listTeam);
});

test('inviteTeammate: POST /partner/team/invite with the body as given', async () => {
  const body = { name: 'Sam Ortiz', email: 'sam@x.test', phone: '+17045550142', role: 'driver' };
  const c = await seen(() => inviteTeammate(body));
  assert.ok(c.url.endsWith('/partner/team/invite'), c.url);
  assert.equal(c.method, 'POST');
  assert.deepEqual(c.body, body);
  assert.equal(requestsApi.inviteTeammate, inviteTeammate);
});

test('patchTeammate: PATCH /partner/team/{id}, the id encoded', async () => {
  const c = await seen(() => patchTeammate('m 1/2', { role: 'dispatcher' }));
  assert.ok(c.url.endsWith('/partner/team/m%201%2F2'), c.url);
  assert.equal(c.method, 'PATCH');
  assert.deepEqual(c.body, { role: 'dispatcher' });
  assert.equal(requestsApi.patchTeammate, patchTeammate);
});

test('removeTeammate: DELETE /partner/team/{id}', async () => {
  const c = await seen(() => removeTeammate('m2'));
  assert.ok(c.url.endsWith('/partner/team/m2'), c.url);
  assert.equal(c.method, 'DELETE');
  assert.equal(requestsApi.removeTeammate, removeTeammate);
});

test('resendTeammate: POST /partner/team/{id}/resend', async () => {
  const c = await seen(() => resendTeammate('m2'));
  assert.ok(c.url.endsWith('/partner/team/m2/resend'), c.url);
  assert.equal(c.method, 'POST');
  assert.deepEqual(c.body, {});
  assert.equal(requestsApi.resendTeammate, resendTeammate);
});


// ── View as Partner (2026-10-19): a platform admin names the company it acts for ──
test('teamPath leaves a plain call alone and adds ?partner_id= for an impersonated company', () => {
  assert.equal(teamPath('/partner/team'), '/partner/team');
  assert.equal(teamPath('/partner/team', undefined), '/partner/team');
  assert.equal(teamPath('/partner/team', ''), '/partner/team');
  assert.equal(teamPath('/partner/team', 'a320a1c8-90b5-43a9-85a7-4ca31ed0de35'),
    '/partner/team?partner_id=a320a1c8-90b5-43a9-85a7-4ca31ed0de35');
  assert.equal(teamPath('/partner/team/abc/resend', 'x y&z'), '/partner/team/abc/resend?partner_id=x%20y%26z');
});

// ── P2: assignments and scope (spec §2.2, §2.3, §4) ──────────

test('isTruck: a partner member whose role is the third one', () => {
  assert.equal(isTruck({ _role: 'partner', member_role: 'driver' }), true);
  assert.equal(isTruck({ _role: 'partner', member_role: 'admin' }), false);
  assert.equal(isTruck({ _role: 'partner', member_role: 'dispatcher' }), false);
  // a company login from before team logins is the company's Admin
  assert.equal(isTruck({ _role: 'partner' }), false);
  assert.equal(isTruck({ _role: 'partner', member_role: null }), false);
  // never an owner, never no session
  assert.equal(isTruck({ _role: 'owner', member_role: 'driver' }), false);
  assert.equal(isTruck(null), false);
  assert.equal(isTruck(undefined), false);
});

test('canAssignProperties: an Admin and Dispatch may, a Truck may not', () => {
  assert.equal(canAssignProperties({ _role: 'partner', member_role: 'admin' }), true);
  assert.equal(canAssignProperties({ _role: 'partner', member_role: 'dispatcher' }), true);
  assert.equal(canAssignProperties({ _role: 'partner', member_role: 'driver' }), false);
});

test('canAssignProperties: a partner session from before team logins may (it is the company Admin)', () => {
  assert.equal(canAssignProperties({ _role: 'partner' }), true);
  assert.equal(canAssignProperties({ _role: 'partner', member_role: null }), true);
});

test('canAssignProperties: never an owner, never no session, never an unknown role', () => {
  assert.equal(canAssignProperties({ _role: 'owner' }), false);
  assert.equal(canAssignProperties({ _role: 'owner', member_role: 'admin' }), false);
  assert.equal(canAssignProperties({ _role: 'partner', member_role: 'manager' }), false);
  assert.equal(canAssignProperties(null), false);
  assert.equal(canAssignProperties(undefined), false);
});

test('the Properties row strings are the spec copy', () => {
  assert.equal(ALL_PROPERTIES, 'All properties');
  assert.equal(NO_PROPERTIES_YET, 'No properties yet');
});

test('memberPropertyIds reads [{id, name}], tolerates bare ids, and nothing', () => {
  assert.deepEqual(memberPropertyIds({ properties: [{ id: 'p1', name: 'Oak Hill' }, { id: 'p2', name: 'Spring Lake' }] }), ['p1', 'p2']);
  assert.deepEqual(memberPropertyIds({ properties: ['p1', 'p2'] }), ['p1', 'p2']);
  assert.deepEqual(memberPropertyIds({ properties: [{ name: 'no id' }, null, '', 'p3'] }), ['p3']);
  assert.deepEqual(memberPropertyIds({ properties: [] }), []);
  assert.deepEqual(memberPropertyIds({}), []);
  assert.deepEqual(memberPropertyIds(null), []);
});

const ADMIN_VIEWER = { _role: 'partner', member_role: 'admin' };
const DISPATCH_VIEWER = { _role: 'partner', member_role: 'dispatcher' };
const TRUCK_VIEWER = { _role: 'partner', member_role: 'driver' };
const TERRY = { id: 'm4', name: 'Terry Banks', role: 'driver', properties: [{ id: 'p1', name: 'Oak Hill' }, { id: 'p2', name: 'Spring Lake' }] };
const NEW_TRUCK = { id: 'm5', name: 'Sam Ortiz', role: 'driver', properties: [] };

test('propertiesRow: an Admin or Dispatch member reads "All properties", with no control, for every viewer', () => {
  for (const viewer of [ADMIN_VIEWER, DISPATCH_VIEWER, TRUCK_VIEWER]) {
    assert.deepEqual(propertiesRow({ ...DANA, properties: [] }, viewer), { kind: 'all', text: 'All properties' });
    assert.deepEqual(propertiesRow({ id: 'm6', name: 'Lee', role: 'dispatcher', properties: [] }, viewer), { kind: 'all', text: 'All properties' });
  }
  // an assignment on an Admin restricts nothing, so it is not shown
  assert.deepEqual(propertiesRow({ ...DANA, properties: [{ id: 'p1', name: 'Oak Hill' }] }, ADMIN_VIEWER), { kind: 'all', text: 'All properties' });
});

test('propertiesRow: a Truck, to an Admin or Dispatch, is a checklist', () => {
  for (const viewer of [ADMIN_VIEWER, DISPATCH_VIEWER, { _role: 'partner' }]) {
    assert.deepEqual(propertiesRow(TERRY, viewer), { kind: 'checklist', empty: false, note: null });
    assert.deepEqual(propertiesRow(NEW_TRUCK, viewer), { kind: 'checklist', empty: true, note: 'No properties yet' });
  }
});

test('propertiesRow: a Truck, to another Truck, is read-only text', () => {
  assert.deepEqual(propertiesRow(TERRY, TRUCK_VIEWER), { kind: 'list', empty: false, text: 'Oak Hill, Spring Lake' });
  assert.deepEqual(propertiesRow(NEW_TRUCK, TRUCK_VIEWER), { kind: 'list', empty: true, text: 'No properties yet' });
});

test('propertiesRow: bare ids are named from the list given, and never shown raw', () => {
  const names = { p1: 'Oak Hill' };
  assert.deepEqual(
    propertiesRow({ ...TERRY, properties: ['p1', 'p9'] }, TRUCK_VIEWER, names),
    { kind: 'list', empty: false, text: 'Oak Hill, 1 more' },
  );
});

test('propertiesRow: nothing for no member', () => {
  assert.equal(propertiesRow(null, ADMIN_VIEWER), null);
});

test('assignableProperties: {id, name}, sorted by name, each id once', () => {
  assert.deepEqual(
    assignableProperties([
      { id: 'p2', name: 'Spring Lake', property_type: 'apartment' },
      { id: 'p1', name: 'Oak Hill' },
      { id: 'p2', name: 'Spring Lake' },
      { name: 'no id' },
      null,
      { id: 'p3', address: '9 Elm St' },
    ]),
    [{ id: 'p3', name: '9 Elm St' }, { id: 'p1', name: 'Oak Hill' }, { id: 'p2', name: 'Spring Lake' }],
  );
  assert.deepEqual(assignableProperties(null), []);
});

test('sameIdSet: order does not matter, membership does', () => {
  assert.equal(sameIdSet(['a', 'b'], ['b', 'a']), true);
  assert.equal(sameIdSet([], []), true);
  assert.equal(sameIdSet(['a'], ['a', 'b']), false);
  assert.equal(sameIdSet(['a', 'b'], ['a']), false);
  assert.equal(sameIdSet(['a', 'c'], ['a', 'b']), false);
});

test('teamErrorMessage: a 422 unknown_property is the reload sentence', () => {
  assert.equal(UNKNOWN_PROPERTY_SENTENCE, "One of those properties isn't yours any more. Reload and try again.");
  assert.equal(
    teamErrorMessage(apiError(422, 'unknown_property'), 'Could not save those properties. Try again.'),
    "One of those properties isn't yours any more. Reload and try again.",
  );
});

test('firstAdminName: the first name the backend lists, skipping blanks', () => {
  assert.equal(firstAdminName(['Austin Ward', 'Lee Park']), 'Austin Ward');
  assert.equal(firstAdminName(['  ', ' Lee Park ']), 'Lee Park');
  assert.equal(firstAdminName([]), null);
  assert.equal(firstAdminName(null), null);
  assert.equal(firstAdminName('Austin Ward'), null);
});

test('askAdminSentence: the spec empty state, with the Admin or "your Admin"', () => {
  assert.equal(askAdminSentence('Austin Ward'), 'Ask Austin Ward to assign you a property.');
  assert.equal(askAdminSentence(null), 'Ask your Admin to assign you a property.');
  assert.equal(askAdminSentence(''), 'Ask your Admin to assign you a property.');
});

test("partnerFieldsFromMe: a Truck's /auth/me carries the first Admin's name", () => {
  assert.deepEqual(
    partnerFieldsFromMe({
      type: 'partner', company_name: 'Queen City Towing',
      member: { id: 'm4', name: 'Terry Banks', role: 'driver', properties: [], admin_names: ['Austin Ward', 'Dana Reyes'] },
    }),
    {
      company_name: 'Queen City Towing', business_name: 'Queen City Towing',
      member_id: 'm4', member_role: 'driver', member_name: 'Terry Banks', member_admin_name: 'Austin Ward',
    },
  );
  // an empty list still says so: the fallback sentence names "your Admin"
  assert.equal(
    partnerFieldsFromMe({ type: 'partner', member: { id: 'm4', name: 'Terry', role: 'driver', admin_names: [] } }).member_admin_name,
    null,
  );
});

test('assignProperties: PUT /partner/team/{id}/properties with {property_ids}', async () => {
  const c = await seen(() => assignProperties('m 4', ['p1', 'p2']));
  assert.ok(c.url.endsWith('/partner/team/m%204/properties'), c.url);
  assert.equal(c.method, 'PUT');
  assert.deepEqual(c.body, { property_ids: ['p1', 'p2'] });
  assert.equal(requestsApi.assignProperties, assignProperties);
});

test('assignProperties: an empty set is sent as an empty list, not skipped', async () => {
  const c = await seen(() => assignProperties('m4', []));
  assert.deepEqual(c.body, { property_ids: [] });
});

test("assignProperties: View as Partner names the company, like the other Team calls", async () => {
  const c = await seen(() => assignProperties('m4', ['p1'], { partnerId: 'a320a1c8-90b5-43a9-85a7-4ca31ed0de35' }));
  assert.ok(c.url.endsWith('/partner/team/m4/properties?partner_id=a320a1c8-90b5-43a9-85a7-4ca31ed0de35'), c.url);
  assert.equal(c.method, 'PUT');
});

test('idsToSave: only the ids the checklist shows, in the order picked', () => {
  const list = [{ id: 'p1', name: 'Oak Hill' }, { id: 'p2', name: 'Spring Lake' }];
  // p9 is an assignment the company no longer has live (archived since): it
  // is not on the checklist, so it is not sent back to be refused with a 422.
  assert.deepEqual(idsToSave(['p2', 'p9', 'p1'], list), ['p2', 'p1']);
  assert.deepEqual(idsToSave([], list), []);
  assert.deepEqual(idsToSave(['p1'], []), []);
  assert.deepEqual(idsToSave(null, list), []);
});
