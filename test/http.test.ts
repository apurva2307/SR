// End-to-end over the real HTTP surface. Two of these exist because the
// bugs they describe shipped and were caught by driving the app, not by
// reading it: a cold visitor could never obtain a CSRF token and so could
// never sign in, and a malformed :id reached Postgres and answered 500.
import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import pg from 'pg';
import { createApp } from '../src/http/app.ts';
import { hashPassword } from '../src/services/auth.ts';
import { closePool, getPool } from '../src/db.ts';
import { reset as resetLimits } from '../src/http/middleware/rateLimit.ts';
import { ensureDefaultSettings } from '../src/services/settings.ts';
import { totpAt } from '../src/services/auth.ts';

const url = process.env['DATABASE_URL'];
const PW = 'TestPassword!2026';

describe('http surface', { skip: url ? false : 'DATABASE_URL not set' }, () => {
  let server: Server;
  let base: string;
  let db: pg.Client;
  let recordId: string;

  before(async () => {
    db = new pg.Client({ connectionString: url });
    await db.connect();
    await db.query(`TRUNCATE access_events, notifications, view_sessions, access_grants,
      access_request_items, access_requests, approval_authorities, record_aliases,
      quarantine_items, ingestion_runs, service_records, sessions, password_reset_codes,
      user_roles, users, departments RESTART IDENTITY CASCADE`);

    // That CASCADE reaches settings through settings.updated_by.
    await ensureDefaultSettings(getPool());

    const dept = async (c: string, n: string, k: string) => (await db.query<{ id: string }>(
      'INSERT INTO departments (code,name,kind) VALUES ($1,$2,$3) RETURNING id', [c, n, k])).rows[0]!.id;
    const accounts = await dept('AC', 'Accounts', 'ACCOUNTS');
    const works = await dept('PW', 'Works', 'USER_DEPT');

    const hash = await hashPassword(PW);
    const user = async (code: string, deptId: string, roles: string[]) => {
      const id = (await db.query<{ id: string }>(
        `INSERT INTO users (staff_code, full_name, department_id, password_hash, must_change_password)
         VALUES ($1,$1,$2,$3,false) RETURNING id`, [code, deptId, hash])).rows[0]!.id;
      for (const r of roles) await db.query('INSERT INTO user_roles VALUES ($1,$2)', [id, r]);
      return id;
    };
    await user('PW001', works, ['REQUESTER']);
    await user('AC002', accounts, ['APPROVER']);   // role, deliberately no authority
    await user('IT001', accounts, ['ADMIN']);
    // Its own department, so the accounts staff-code sequence other tests
    // count on is left alone.
    await user('RC001', await dept('RC', 'Records Cell', 'ACCOUNTS'), ['CUSTODIAN']);

    recordId = (await db.query<{ id: string }>(
      `INSERT INTO service_records
        (ppo_number, ppo_normalized, employee_name, name_normalized, name_sorted,
         file_path, file_name, sha256, byte_size, page_count, source_root)
       VALUES ('410221100347','410221100347','Shri Ram Kumar Sharma','RAM KUMAR SHARMA',
               'KUMAR RAM SHARMA','/nonexistent/a.pdf','a.pdf', repeat('c',64), 10, 4, '/nonexistent')
       RETURNING id`)).rows[0]!.id;

    server = createServer(createApp());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    resetLimits();
  });

  // Each test signs in cold, and the per-account bucket is 5 per 15 minutes.
  // That limit is correct; a suite that trips it is just measuring itself.
  beforeEach(() => { resetLimits(); });

  after(async () => {
    // fetch() keeps sockets alive, and server.close() waits for every one of
    // them — without this the suite hangs instead of finishing.
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await db.end();
    await closePool();
  });

  /** A cookie jar with a CSRF token, for calls made while signed out. */
  async function freshJar(): Promise<Map<string, string>> {
    const jar = new Map<string, string>();
    const res = await fetch(`${base}/api/auth/me`);
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const i = pair!.indexOf('=');
      jar.set(pair!.slice(0, i), pair!.slice(i + 1));
    }
    return jar;
  }

  const csrfFor = (jar: Map<string, string>) => ({
    cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
    'x-csrf-token': jar.get('sr_csrf') ?? '',
  });

  /** A browser starting from nothing: no cookies, no tokens. */
  async function coldSignIn(staffCode: string, password: string = PW, totp?: string) {
    const jar = new Map<string, string>();
    const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const absorb = (res: Response) => {
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [pair] = c.split(';');
        const idx = pair!.indexOf('=');
        jar.set(pair!.slice(0, idx), pair!.slice(idx + 1));
      }
    };

    absorb(await fetch(`${base}/api/auth/me`, { headers: { cookie: cookieHeader() } }));

    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookieHeader(),
        'x-csrf-token': jar.get('sr_csrf') ?? '',
      },
      body: JSON.stringify({ staffCode, password, ...(totp ? { totp } : {}) }),
    });
    absorb(res);
    return {
      status: res.status,
      body: await res.json() as Record<string, unknown>,
      cookieHeader,
      csrf: () => jar.get('sr_csrf') ?? '',
      get: (p: string) => fetch(`${base}/api${p}`, { headers: { cookie: cookieHeader() } }),
      post: (p: string, body: unknown) => fetch(`${base}/api${p}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: cookieHeader(),
          'x-csrf-token': jar.get('sr_csrf') ?? '',
        },
        body: JSON.stringify(body),
      }),
      put: (p: string, body: unknown) => fetch(`${base}/api${p}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          cookie: cookieHeader(),
          'x-csrf-token': jar.get('sr_csrf') ?? '',
        },
        body: JSON.stringify(body),
      }),
    };
  }

  test('a cold visitor can sign in — CSRF must not lock out the login itself', async () => {
    const s = await coldSignIn('PW001');
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal((s.body['principal'] as { staffCode: string }).staffCode, 'PW001');
  });

  test('/auth/me hands an anonymous caller a CSRF cookie with its 401', async () => {
    const res = await fetch(`${base}/api/auth/me`);
    assert.equal(res.status, 401);
    assert.ok((res.headers.getSetCookie?.() ?? []).some((c) => c.startsWith('sr_csrf=')));
  });

  test('a state-changing request without the CSRF header is refused', async () => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ staffCode: 'PW001', password: PW }),
    });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error: string }).error, 'CSRF_FAILED');
  });

  test('no route anywhere returns the PDF — screen-only is structural', async () => {
    const s = await coldSignIn('PW001');
    for (const p of [
      `/records/${recordId}/content`,
      `/records/${recordId}/download`,
      `/records/${recordId}/file`,
      `/records/${recordId}/pdf`,
      `/records/${recordId}.pdf`,
    ]) {
      const res = await s.get(p);
      assert.equal(res.status, 404, `${p} answered ${res.status}`);
      assert.notEqual(res.headers.get('content-type'), 'application/pdf');
    }
  });

  test('a custodian adds pages over HTTP: upload, check, describe, and they join the record', async () => {
    const { mkdir } = await import('node:fs/promises');
    const mupdf = await import('mupdf');
    const { config } = await import('../src/config.ts');
    await mkdir(config.additionsRoot, { recursive: true });

    const doc = new mupdf.PDFDocument();
    for (let i = 0; i < 2; i++) doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, {}, `% http ${i}
`));
    const pdf = Buffer.from(doc.saveToBuffer().asUint8Array());

    const s = await coldSignIn('RC001');
    const raw = (p: string, body: Buffer) => fetch(`${base}/api${p}`, {
      method: 'POST', body,
      headers: {
        'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('Increment order.pdf'),
        cookie: s.cookieHeader(), 'x-csrf-token': s.csrf(),
      },
    });

    const staged = await raw(`/records/${recordId}/additions/stage`, pdf);
    assert.equal(staged.status, 201);
    const up = await staged.json() as { id: string; pageCount: number };
    assert.equal(up.pageCount, 2);

    // The custodian's check: an image, never the PDF.
    const preview = await s.get(`/records/${recordId}/additions/staged/${up.id}/page/2`);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('content-type'), 'image/webp');

    const done = await s.post(`/records/${recordId}/additions`,
      { uploadId: up.id, description: 'Increment order 2026-27', documentDate: '2026-10-01' });
    assert.equal(done.status, 201);
    const added = await done.json() as { seq: number; firstPage: number; lastPage: number };
    assert.deepEqual([added.seq, added.firstPage, added.lastPage], [1, 5, 6]);

    const detail = await (await s.get(`/records/${recordId}`)).json() as { pages: { total: number } };
    assert.equal(detail.pages.total, 6); // 4 original + 2 added

    // A requester cannot upload, even with a valid session and token.
    const r = await coldSignIn('PW001');
    const denied = await fetch(`${base}/api/records/${recordId}/additions/stage`, {
      method: 'POST', body: pdf,
      headers: { 'content-type': 'application/pdf', cookie: r.cookieHeader(), 'x-csrf-token': r.csrf() },
    });
    assert.equal(denied.status, 403);
  });

  test('a malformed record id answers 404, not a 500 from the database', async () => {
    const s = await coldSignIn('PW001');
    for (const bad of ['not-a-uuid', `${recordId}.pdf`, '../../etc/passwd', '1 OR 1=1']) {
      const res = await s.get(`/records/${encodeURIComponent(bad)}`);
      assert.equal(res.status, 404, `${bad} answered ${res.status}`);
    }
  });

  test('reading a page without a grant is refused and audited as a denial', async () => {
    const s = await coldSignIn('PW001');
    const res = await s.get(`/records/${recordId}/page/1`);
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error: string }).error, 'NO_GRANT');

    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*) AS n FROM access_events WHERE event_type = 'PAGE_DENIED' AND outcome = 'DENY'`);
    assert.ok(Number(rows[0]!.n) >= 1, 'the denial was not recorded');
  });

  test('the approver role alone cannot release — the endpoint checks, not the button', async () => {
    const requester = await coldSignIn('PW001');
    const created = await requester.post('/requests', { recordIds: [recordId] });
    const { id } = await created.json() as { id: string };
    const submitted = await requester.post(`/requests/${id}/submit`, {
      purpose: 'Verifying qualifying service for a pension revision case.',
      requestedFrom: new Date().toISOString(),
      requestedTo: new Date(Date.now() + 15 * 86_400_000).toISOString(),
    });
    assert.equal(submitted.status, 200);

    const officer = await coldSignIn('AC002');
    const inbox = await (await officer.get('/requests?scope=inbox')).json() as
      { requests: { id: string; items: { id: string }[] }[] };
    const target = inbox.requests.find((r) => r.id === id);
    assert.ok(target, 'the request should appear in another officer\'s inbox');

    const res = await officer.post(`/requests/${id}/decision`, {
      decisions: [{ itemId: target.items[0]!.id, action: 'APPROVE' }],
    });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error: string }).error, 'NO_APPROVAL_AUTHORITY');

    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*) AS n FROM access_events WHERE event_type = 'DECISION_REFUSED_NO_AUTHORITY'`);
    assert.ok(Number(rows[0]!.n) >= 1, 'the refusal was not audited');
  });

  test('a decision on a request that does not exist answers 404, not 500', async () => {
    const officer = await coldSignIn('AC002');
    const res = await officer.post(
      '/requests/11111111-1111-4111-8111-111111111111/decision',
      { decisions: [{ itemId: '22222222-2222-4222-8222-222222222222', action: 'APPROVE' }] });
    assert.equal(res.status, 404);
  });

  test('a requester never sees their own request in the approver inbox', async () => {
    const requester = await coldSignIn('PW001');
    const own = await (await requester.get('/requests?scope=mine')).json() as { requests: unknown[] };
    const inbox = await (await requester.get('/requests?scope=inbox')).json() as
      { requests: { requester_code: string }[] };
    assert.ok(own.requests.length > 0);
    assert.ok(inbox.requests.every((r) => r.requester_code !== 'PW001'));
  });

  test('search refuses a query too short to be useful, distinctly from finding nothing', async () => {
    const s = await coldSignIn('PW001');
    const short = await s.get('/records?q=ra');
    assert.equal(short.status, 400);
    assert.equal(((await short.json()) as { error: string }).error, 'QUERY_TOO_SHORT');

    const found = await s.get('/records?q=sharma%20ram');
    const body = await found.json() as { hits: unknown[]; branch: string };
    assert.equal(found.status, 200);
    assert.equal(body.branch, 'NAME');
    assert.equal(body.hits.length, 1, 'reversed word order should still match');
  });

  describe('departments', () => {
    async function admin() {
      const s = await coldSignIn('IT001');
      assert.equal(s.status, 200, JSON.stringify(s.body));
      return {
        ...s,
        del: (path: string) => s.post(path, undefined),
        list: async () => (await (await s.get('/admin/departments')).json()) as {
          departments: { id: string; code: string; user_count: string }[];
        },
      };
    }

    test('an administrator can create, rename and delete a department', async () => {
      const a = await admin();
      const created = await a.post('/admin/departments',
        { code: 'hl', name: 'Health Department', kind: 'USER_DEPT' });
      assert.equal(created.status, 201);
      const { id } = await created.json() as { id: string };

      // Codes are stored uppercase so people can type them either way.
      const listed = (await a.list()).departments.find((d) => d.id === id);
      assert.equal(listed?.code, 'HL');

      const renamed = await fetch(`${base}/api/admin/departments/${id}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          cookie: a.cookieHeader(),
          'x-csrf-token': a.csrf(),
        },
        body: JSON.stringify({ code: 'HL', name: 'Health and Family Welfare', kind: 'USER_DEPT' }),
      });
      assert.equal(renamed.status, 200);
      assert.equal(
        (await a.list()).departments.find((d) => d.id === id)?.code, 'HL');

      const del = await fetch(`${base}/api/admin/departments/${id}`, {
        method: 'DELETE',
        headers: { cookie: a.cookieHeader(), 'x-csrf-token': a.csrf() },
      });
      assert.equal(del.status, 200, 'an unused department should delete outright');
    });

    test('department codes are unique regardless of case', async () => {
      const a = await admin();
      const first = await a.post('/admin/departments',
        { code: 'ZZ', name: 'Test Department', kind: 'USER_DEPT' });
      assert.equal(first.status, 201);
      const dupe = await a.post('/admin/departments',
        { code: 'zz', name: 'Another One', kind: 'USER_DEPT' });
      assert.equal(dupe.status, 409);
      assert.equal(((await dupe.json()) as { error: string }).error, 'DUPLICATE_CODE');
    });

    test('a department holding staff cannot be deleted, and the refusal says why', async () => {
      const a = await admin();
      const works = (await a.list()).departments.find((d) => d.code === 'PW');
      assert.ok(works);
      const res = await fetch(`${base}/api/admin/departments/${works.id}`, {
        method: 'DELETE',
        headers: { cookie: a.cookieHeader(), 'x-csrf-token': a.csrf() },
      });
      assert.equal(res.status, 409);
      const body = await res.json() as { error: string; message: string; blockers: { users: number } };
      assert.equal(body.error, 'DEPARTMENT_IN_USE');
      assert.ok(body.blockers.users > 0);
      assert.match(body.message, /Deactivate it instead/);
    });

    test('a staffed department cannot change kind — that would move who can release', async () => {
      const a = await admin();
      const accounts = (await a.list()).departments.find((d) => d.code === 'AC');
      assert.ok(accounts);
      const res = await fetch(`${base}/api/admin/departments/${accounts.id}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          cookie: a.cookieHeader(),
          'x-csrf-token': a.csrf(),
        },
        body: JSON.stringify({ code: 'AC', name: 'Accounts', kind: 'USER_DEPT' }),
      });
      assert.equal(res.status, 409);
      assert.equal(((await res.json()) as { error: string }).error, 'KIND_LOCKED');
    });

    test('policy settings survive a reseed — TRUNCATE cascades into them', async () => {
      // settings.updated_by references users, so `TRUNCATE users ... CASCADE`
      // empties the settings table. Nothing visibly breaks, because the code
      // fallbacks match, which is exactly why this needs a test.
      const a = await admin();
      const body = await (await a.get('/admin/settings')).json() as
        { settings: { key: string }[] };
      const keys = body.settings.map((x) => x.key);
      for (const k of ['grant.default_days', 'grant.max_days', 'audit.retention_years']) {
        assert.ok(keys.includes(k), `${k} missing from settings`);
      }
    });

    test('a non-administrator cannot touch departments', async () => {
      const s = await coldSignIn('PW001');
      const res = await s.post('/admin/departments',
        { code: 'XX', name: 'Should Not Exist', kind: 'USER_DEPT' });
      assert.equal(res.status, 403);
    });
  });

  test('a newly created user can complete first login and set a password', async () => {
    // The forced-password-change guard must not block the password-change
    // endpoint. When it did, every admin-created account was locked out with
    // no route forward — invisible in the demo, because seeded users have the
    // flag off.
    const a = await coldSignIn('IT001');
    const depts = await (await a.get('/admin/departments')).json() as
      { departments: { id: string; code: string }[] };
    const accounts = depts.departments.find((d) => d.code === 'AC');
    assert.ok(accounts);

    const created = await a.post('/admin/users', {
      staffCode: 'NEW01', fullName: 'Newly Created', departmentId: accounts.id,
      roles: ['CONTROLLING_OFFICER'],
    });
    assert.equal(created.status, 201);
    const { initialPassword } = await created.json() as { initialPassword: string };

    // Sign in with the one-time password.
    const jar = new Map<string, string>();
    const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const absorb = (r: Response) => {
      for (const c of r.headers.getSetCookie?.() ?? []) {
        const [pair] = c.split(';');
        const i = pair!.indexOf('=');
        jar.set(pair!.slice(0, i), pair!.slice(i + 1));
      }
    };
    absorb(await fetch(`${base}/api/auth/me`, { headers: { cookie: cookieHeader() } }));
    const signIn = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookieHeader(),
        'x-csrf-token': jar.get('sr_csrf') ?? '',
      },
      body: JSON.stringify({ staffCode: 'NEW01', password: initialPassword }),
    });
    absorb(signIn);
    assert.equal(signIn.status, 200);
    const principal = (await signIn.json() as { principal: { mustChangePassword: boolean } }).principal;
    assert.equal(principal.mustChangePassword, true);

    // Everything else is blocked...
    const blocked = await fetch(`${base}/api/authorities`, { headers: { cookie: cookieHeader() } });
    assert.equal(blocked.status, 403);
    assert.equal(((await blocked.json()) as { error: string }).error, 'PASSWORD_CHANGE_REQUIRED');

    // ...except setting the password, which must go through.
    const changed = await fetch(`${base}/api/auth/password`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookieHeader(),
        'x-csrf-token': jar.get('sr_csrf') ?? '',
      },
      body: JSON.stringify({ current: initialPassword, next: 'NewPassword!2026x' }),
    });
    assert.equal(changed.status, 200, 'the password-change endpoint must not be blocked by its own guard');

    // And now the account works.
    const ok = await fetch(`${base}/api/authorities`, { headers: { cookie: cookieHeader() } });
    assert.equal(ok.status, 200, 'a controlling officer should reach the authority register');
  });

  test('a user edits their own name, email and designation — but nothing that grants power', async () => {
    const a = await coldSignIn('PW001');

    const saved = await a.put('/auth/profile', {
      fullName: 'Arun Deshpande', email: 'arun@example.gov', designation: 'Head Clerk',
    });
    assert.equal(saved.status, 200);

    const me = await (await a.get('/auth/me')).json() as
      { principal: { fullName: string; email: string; designation: string; staffCode: string; roles: string[] } };
    assert.equal(me.principal.fullName, 'Arun Deshpande');
    assert.equal(me.principal.designation, 'Head Clerk');

    // Staff code and roles are an administrator's to set. Sending them must
    // not take, or the whole permission model is advisory.
    await a.put('/auth/profile', {
      fullName: 'Arun Deshpande', staffCode: 'AC000', roles: ['ADMIN'], departmentId: null,
    });
    const after = await (await a.get('/auth/me')).json() as
      { principal: { staffCode: string; roles: string[] } };
    assert.equal(after.principal.staffCode, 'PW001');
    assert.deepEqual(after.principal.roles, ['REQUESTER']);

    // An empty email clears it rather than storing '', which would collide the
    // moment a second person did the same.
    assert.equal((await a.put('/auth/profile', { fullName: 'Arun Deshpande', email: '' })).status, 200);
    const cleared = await (await a.get('/auth/me')).json() as { principal: { email: string | null } };
    assert.equal(cleared.principal.email, null);

    // The change is on the record, with both sides of it.
    const { rows } = await db.query<{ detail: { before: { fullName: string } } }>(
      `SELECT detail FROM access_events WHERE event_type = 'USER_PROFILE_UPDATED'
        ORDER BY seq LIMIT 1`,
    );
    assert.equal(rows[0]?.detail.before.fullName, 'PW001');
  });

  test('the staff list is not readable by every role in Accounts', async () => {
    // Codes deliberately outside the <DEPT><3 digits> pattern, so these two do
    // not move the numbers the allocation test asserts on.
    const acc = (await db.query<{ id: string }>(
      `SELECT id FROM departments WHERE code = 'AC'`)).rows[0]!.id;
    const hash = await hashPassword(PW);
    const extra = async (code: string, role: string) => {
      const id = (await db.query<{ id: string }>(
        `INSERT INTO users (staff_code, full_name, department_id, password_hash, must_change_password)
         VALUES ($1,$1,$2,$3,false) RETURNING id`, [code, acc, hash])).rows[0]!.id;
      await db.query('INSERT INTO user_roles VALUES ($1,$2)', [id, role]);
    };
    await extra('CUST-A', 'CUSTODIAN');
    await extra('CTRL-A', 'CONTROLLING_OFFICER');

    // A custodian runs ingestion and resolves quarantine. Nothing in that job
    // needs the personnel record of everyone in the building — names, emails,
    // last sign-in, and which accounts have a second factor on them.
    const custodian = await coldSignIn('CUST-A');
    assert.equal(custodian.status, 200, JSON.stringify(custodian.body));
    assert.equal((await custodian.get('/admin/users')).status, 403);

    // Nor does an approver, who works the request queue.
    const approver = await coldSignIn('AC002');
    assert.equal((await approver.get('/admin/users')).status, 403);

    // An administrator manages accounts, and a controlling officer needs the
    // list to issue an authority to a named person. Those two, and no others.
    const admin = await coldSignIn('IT001');
    assert.equal((await admin.get('/admin/users')).status, 200);
    const officer = await coldSignIn('CTRL-A');
    assert.equal((await officer.get('/admin/users')).status, 200);
  });

  test('the audit log names the actor by name, designation and staff code', async () => {
    // Give PW001 a designation, which is itself an auditable act.
    const them = await coldSignIn('PW001');
    await them.put('/auth/profile', { fullName: 'Arun Deshpande', designation: 'Head Clerk' });
    await them.get(`/records/${recordId}`);

    const auditor = await coldSignIn('IT001');
    const log = await (await auditor.get('/audit?limit=200')).json() as {
      events: {
        event_type: string;
        actor_name: string | null; actor_code: string | null; actor_designation: string | null;
      }[];
    };

    const mine = log.events.find((e) => e.actor_code === 'PW001');
    assert.ok(mine, 'the actor should be identified by staff code');
    assert.equal(mine.actor_name, 'Arun Deshpande');
    assert.equal(mine.actor_designation, 'Head Clerk');

    // The columns must survive the CSV export too — an auditor who exports and
    // loses the identifying columns has an export of nothing much.
    const csv = await (await auditor.get('/audit?format=csv&limit=10')).text();
    const header = csv.split('\n')[0] ?? '';
    for (const col of ['actor_name', 'actor_code', 'actor_designation']) {
      assert.ok(header.includes(col), `CSV header should carry ${col}, got: ${header}`);
    }
  });

  test('staff codes are allocated from the department, and can still be overridden', async () => {
    const a = await coldSignIn('IT001');
    const depts = await (await a.get('/admin/departments')).json() as
      { departments: { id: string; code: string }[] };
    const accounts = depts.departments.find((d) => d.code === 'AC')!;
    const works = depts.departments.find((d) => d.code === 'PW')!;

    // The fixture holds AC002 and PW001. IT001 sits in Accounts too, and is
    // deliberately not counted: it does not carry the department's prefix.
    const preview = await (await a.get(`/admin/users/next-code?departmentId=${accounts.id}`)).json() as
      { code: string };
    assert.equal(preview.code, 'AC003');

    const first = await a.post('/admin/users', {
      fullName: 'Allocated One', departmentId: accounts.id, roles: ['APPROVER'],
    });
    assert.equal(first.status, 201);
    assert.equal((await first.json() as { staffCode: string }).staffCode, 'AC003');

    // The next one must move on rather than collide.
    const second = await a.post('/admin/users', {
      fullName: 'Allocated Two', departmentId: accounts.id, roles: ['APPROVER'],
    });
    assert.equal((await second.json() as { staffCode: string }).staffCode, 'AC004');

    // Numbering is per department, not global.
    const other = await a.post('/admin/users', {
      fullName: 'Allocated Three', departmentId: works.id, roles: ['REQUESTER'],
    });
    assert.equal((await other.json() as { staffCode: string }).staffCode, 'PW002');

    // A code typed in by hand is taken as given, and a clash says so plainly
    // rather than silently handing back a different account.
    const manual = await a.post('/admin/users', {
      staffCode: 'LEGACY-7', fullName: 'Hand Numbered', departmentId: works.id, roles: ['REQUESTER'],
    });
    assert.equal((await manual.json() as { staffCode: string }).staffCode, 'LEGACY-7');

    const clash = await a.post('/admin/users', {
      staffCode: 'LEGACY-7', fullName: 'Second Claimant', departmentId: works.id, roles: ['REQUESTER'],
    });
    assert.equal(clash.status, 409);
    assert.equal((await clash.json() as { error: string }).error, 'DUPLICATE_STAFF_CODE');

    // A hand-numbered code outside the pattern must not disturb allocation.
    const after = await (await a.get(`/admin/users/next-code?departmentId=${works.id}`)).json() as
      { code: string };
    assert.equal(after.code, 'PW003');
  });

  describe('two-factor enrolment', () => {
    // Carried between tests: once PW001 is genuinely enrolled, signing in as
    // them needs a live code, which is itself worth asserting.
    let enrolledSecret = '';

    test('requiring 2FA does not enable it — the user enrols, and is blocked until they do', async () => {
      const admin = await coldSignIn('IT001');
      const users = await (await admin.get('/admin/users')).json() as
        { users: { id: string; staff_code: string }[] };
      const target = users.users.find((u) => u.staff_code === 'PW001');
      assert.ok(target);

      const req = await admin.post(`/admin/users/${target.id}/totp/require`, {});
      assert.equal(req.status, 200);
      assert.equal(((await req.json()) as { alreadyEnrolled: boolean }).alreadyEnrolled, false);

      // The user can still sign in — an unenrolled requirement must not lock
      // them out of the enrolment itself.
      const user = await coldSignIn('PW001');
      assert.equal(user.status, 200);
      assert.equal((user.body['principal'] as { mustEnrolTotp: boolean }).mustEnrolTotp, true);

      // ...but nothing else works yet.
      const blocked = await user.get('/records?q=sharma');
      assert.equal(blocked.status, 403);

      // Enrol: fetch the secret, prove a code from it.
      const setup = await (await user.post('/auth/totp/setup', {})).json() as
        { secret: string; qrSvg: string; otpauth: string };
      assert.match(setup.qrSvg, /^<svg/);
      assert.match(setup.otpauth, /^otpauth:\/\/totp\//);

      const wrong = await user.post('/auth/totp/enable', { code: '000000' });
      assert.equal(wrong.status, 400);
      // A rejected code must not have enabled anything.
      assert.equal((await (await user.get('/auth/me')).json() as
        { principal: { totpEnabled: boolean } }).principal.totpEnabled, false);

      const code = totpAt(setup.secret, Math.floor(Date.now() / 30_000));
      const good = await user.post('/auth/totp/enable', { code });
      assert.equal(good.status, 200);

      const me = await (await user.get('/auth/me')).json() as
        { principal: { totpEnabled: boolean; mustEnrolTotp: boolean } };
      assert.equal(me.principal.totpEnabled, true);
      assert.equal(me.principal.mustEnrolTotp, false);

      // And the rest of the system opens up.
      assert.equal((await user.get('/records?q=sharma')).status, 200);
      enrolledSecret = setup.secret;
    });

    test('once enrolled, signing in without a code is refused', async () => {
      assert.ok(enrolledSecret, 'the enrolment test must run first');
      const noCode = await coldSignIn('PW001');
      assert.equal((noCode.body as { error?: string }).error, 'TOTP_REQUIRED');

      const badCode = await coldSignIn('PW001', PW, '000000');
      assert.equal((badCode.body as { error?: string }).error, 'BAD_TOTP');

      const good = await coldSignIn('PW001', PW,
        totpAt(enrolledSecret, Math.floor(Date.now() / 30_000)));
      assert.equal(good.status, 200);
      assert.equal((good.body['principal'] as { totpEnabled: boolean }).totpEnabled, true);
    });

    test('a required second factor cannot be switched off by its holder', async () => {
      const code = totpAt(enrolledSecret, Math.floor(Date.now() / 30_000));
      const user = await coldSignIn('PW001', PW, code);
      assert.equal(user.status, 200);
      // A correct password and a correct code, and it still refuses: an
      // administrator required it, so the holder does not get to opt out.
      const res = await user.post('/auth/totp/disable', { password: PW, code });
      assert.equal(res.status, 403);
      assert.equal(((await res.json()) as { error: string }).error, 'REQUIRED');
    });

    test('an administrator can clear 2FA — the lost-phone path', async () => {
      const admin = await coldSignIn('IT001');
      const users = await (await admin.get('/admin/users')).json() as
        { users: { id: string; staff_code: string }[] };
      const target = users.users.find((u) => u.staff_code === 'PW001')!;

      const res = await fetch(`${base}/api/admin/users/${target.id}/totp`, {
        method: 'DELETE',
        headers: { cookie: admin.cookieHeader(), 'x-csrf-token': admin.csrf() },
      });
      assert.equal(res.status, 200);

      // Clearing also lifts the requirement — otherwise the user is locked out
      // of their own recovery.
      const back = await coldSignIn('PW001');
      const p = back.body['principal'] as { totpEnabled: boolean; mustEnrolTotp: boolean };
      assert.equal(p.totpEnabled, false);
      assert.equal(p.mustEnrolTotp, false);
      assert.equal((await back.get('/records?q=sharma')).status, 200);
    });
  });

  describe('password reset codes', () => {
    test('an issued code can actually be redeemed, once', async () => {
      const admin = await coldSignIn('IT001');
      const users = await (await admin.get('/admin/users')).json() as
        { users: { id: string; staff_code: string }[] };
      const target = users.users.find((u) => u.staff_code === 'AC002')!;

      const issued = await admin.post(`/admin/users/${target.id}/reset-code`, {});
      assert.equal(issued.status, 200);
      const { code } = await issued.json() as { code: string };

      const bad = await fetch(`${base}/api/auth/password/reset`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...csrfFor(await freshJar()) },
        body: JSON.stringify({ staffCode: 'AC002', code: 'not-the-code', newPassword: 'Whatever!2026x' }),
      });
      assert.equal(bad.status, 400);

      const jar = await freshJar();
      const good = await fetch(`${base}/api/auth/password/reset`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...csrfFor(jar) },
        body: JSON.stringify({ staffCode: 'AC002', code, newPassword: 'ResetPassword!2026' }),
      });
      assert.equal(good.status, 200, 'a reset code must be redeemable');

      // Reusing it fails: single use.
      const again = await fetch(`${base}/api/auth/password/reset`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...csrfFor(await freshJar()) },
        body: JSON.stringify({ staffCode: 'AC002', code, newPassword: 'Another!2026xx' }),
      });
      assert.equal(again.status, 400);

      // The new password works and the old one does not.
      const withNew = await coldSignIn('AC002', 'ResetPassword!2026');
      assert.equal(withNew.status, 200);
      const withOld = await coldSignIn('AC002', PW);
      assert.equal(withOld.status, 401);
    });
  });

  describe('administration', () => {
    test('a suspended account can be brought back', async () => {
      const admin = await coldSignIn('IT001');
      const list = await (await admin.get('/admin/users')).json() as
        { users: { id: string; staff_code: string; status: string }[] };
      const target = list.users.find((u) => u.staff_code === 'AC002')!;

      assert.equal((await admin.post(`/admin/users/${target.id}/suspend`, {})).status, 200);
      // Suspension is real: the grant check refuses even a live grant (§6.1).
      const blocked = await coldSignIn('AC002', 'ResetPassword!2026');
      assert.equal(blocked.status, 401);

      const back = await admin.post(`/admin/users/${target.id}/reactivate`, {});
      assert.equal(back.status, 200, 'a suspended account must be recoverable');

      const restored = await coldSignIn('AC002', 'ResetPassword!2026');
      assert.equal(restored.status, 200);

      // Reactivating something that is not suspended says so rather than lying.
      assert.equal((await admin.post(`/admin/users/${target.id}/reactivate`, {})).status, 400);
    });

    test('policy settings carry their explanation and validate on save', async () => {
      const admin = await coldSignIn('IT001');
      const body = await (await admin.get('/admin/settings')).json() as
        { settings: { key: string; label: string; description: string; value: unknown }[] };

      const max = body.settings.find((x) => x.key === 'grant.max_days')!;
      assert.ok(max.description.length > 40, 'every setting should explain itself');
      assert.ok(max.label);

      // The 180-day ceiling is a database CHECK, so the API must not accept more.
      const tooBig = await fetch(`${base}/api/admin/settings/grant.max_days`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          cookie: admin.cookieHeader(), 'x-csrf-token': admin.csrf(),
        },
        body: JSON.stringify({ value: 365 }),
      });
      assert.equal(tooBig.status, 400);
      assert.match(((await tooBig.json()) as { message: string }).message, /database CHECK/);

      const ok = await fetch(`${base}/api/admin/settings/grant.default_days`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          cookie: admin.cookieHeader(), 'x-csrf-token': admin.csrf(),
        },
        body: JSON.stringify({ value: 21 }),
      });
      assert.equal(ok.status, 200);

      const after = await (await admin.get('/admin/settings')).json() as
        { settings: { key: string; value: unknown }[] };
      assert.equal(after.settings.find((x) => x.key === 'grant.default_days')?.value, 21);

      const unknown = await fetch(`${base}/api/admin/settings/not.a.setting`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          cookie: admin.cookieHeader(), 'x-csrf-token': admin.csrf(),
        },
        body: JSON.stringify({ value: 1 }),
      });
      assert.equal(unknown.status, 400);
    });

    test('the inactivity limit is an administrator setting, and the server enforces it', async () => {
      const admin = await coldSignIn('IT001');
      assert.equal((await admin.put('/admin/settings/session.idle_minutes', { value: 0 })).status, 400);
      assert.equal((await admin.put('/admin/settings/session.idle_minutes', { value: 5 })).status, 200);

      // The browser runs its timer from what /auth/me reports.
      const me = await (await admin.get('/auth/me')).json() as { idleMinutes: number };
      assert.equal(me.idleMinutes, 5);

      // Administration sees who is on now and when each person last signed in.
      const user = await coldSignIn('PW001');
      const list = await (await admin.get('/admin/users')).json() as
        { users: { staff_code: string; online: boolean; last_login_at: string | null; last_seen_at: string | null }[] };
      const pw = list.users.find((u) => u.staff_code === 'PW001')!;
      assert.equal(pw.online, true);
      assert.ok(pw.last_login_at && pw.last_seen_at);

      // Left alone past the limit, the session is refused and shows as offline.
      await db.query(
        `UPDATE sessions SET last_seen_at = now() - interval '6 minutes'
          WHERE user_id = (SELECT id FROM users WHERE staff_code = 'PW001')`,
      );
      assert.equal((await user.get('/auth/me')).status, 401);
      const later = await (await admin.get('/admin/users')).json() as
        { users: { staff_code: string; online: boolean }[] };
      assert.equal(later.users.find((u) => u.staff_code === 'PW001')!.online, false);

      assert.equal((await admin.put('/admin/settings/session.idle_minutes', { value: 15 })).status, 200);
    });
  });

  test('the viewer records attempts to capture a page, and refuses kinds it does not know', async () => {
    const s = await coldSignIn('IT001');
    const { rows } = await db.query<{ id: string }>(`SELECT id FROM service_records LIMIT 1`);
    const recordId = rows[0]!.id;
    assert.equal((await s.post(`/records/${recordId}/capture-attempt`, { kind: 'NOPE' })).status, 400);
    assert.equal((await s.post(`/records/${recordId}/capture-attempt`, { kind: 'PRINT_SCREEN', page: 3 })).status, 200);
    const { rows: ev } = await db.query<{ detail: { kind: string; page: number } }>(
      `SELECT detail FROM access_events WHERE event_type = 'SCREEN_CAPTURE_ATTEMPT' ORDER BY seq DESC LIMIT 1`,
    );
    assert.deepEqual(ev[0]?.detail, { kind: 'PRINT_SCREEN', page: 3 });
  });

  test('security headers are set on every response', async () => {
    const res = await fetch(`${base}/api/health`);
    assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
  });
});
