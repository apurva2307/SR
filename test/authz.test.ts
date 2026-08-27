// Integration tests for the two checks (§6.1, §6.2) and the database
// constraints that back them. Skipped when DATABASE_URL is absent.
import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { checkGrant, consumeView } from '../src/authz/grantCheck.ts';
import { assertMayRelease, findLiveAuthority } from '../src/authz/authorityCheck.ts';
import { appendEvent, verifyChain } from '../src/audit/events.ts';
import { revoke as revokeGrant } from '../src/services/grants.ts';
import { seed, issueAuthority, issueGrant, type World } from './helpers/fixtures.ts';

const url = process.env.DATABASE_URL;

describe('authorisation', { skip: url ? false : 'DATABASE_URL not set' }, () => {
  let db: pg.Client;
  let w: World;

  before(async () => {
    db = new pg.Client({ connectionString: url });
    await db.connect();
  });
  after(async () => { await db.end(); });
  beforeEach(async () => { w = await seed(db); });

  // -------------------------------------------------------------------------
  describe('§6.1 the grant check — may this person READ this record?', () => {
    test('no grant means no', async () => {
      const d = await checkGrant(db, w.users.requester, w.record);
      assert.deepEqual(d, { allowed: false, reason: 'NO_GRANT' });
    });

    test('a live grant allows, and reports the window', async () => {
      const a = await issueAuthority(w, { to: w.users.approver });
      const g = await issueGrant(w, { to: w.users.requester, authority: a });

      const d = await checkGrant(db, w.users.requester, w.record);
      assert.equal(d.allowed, true);
      assert.equal(d.allowed && d.via, 'GRANT');
      assert.equal(d.allowed && d.via === 'GRANT' && d.grantId, g);
    });

    test('a grant that has not started yet does not allow', async () => {
      const a = await issueAuthority(w, { to: w.users.approver });
      await issueGrant(w, {
        to: w.users.requester, authority: a,
        fromInterval: '2 days', untilInterval: '20 days',
      });
      assert.equal((await checkGrant(db, w.users.requester, w.record)).allowed, false);
    });

    test('an expired grant does not allow — expiry is computed, not scheduled', async () => {
      const a = await issueAuthority(w, { to: w.users.approver });
      await issueGrant(w, {
        to: w.users.requester, authority: a,
        fromInterval: '-30 days', untilInterval: '-1 day',
      });
      assert.equal((await checkGrant(db, w.users.requester, w.record)).allowed, false);
    });

    test('a revoked grant does not allow, effective immediately', async () => {
      const a = await issueAuthority(w, { to: w.users.approver });
      await issueGrant(w, { to: w.users.requester, authority: a, revoked: true });
      assert.equal((await checkGrant(db, w.users.requester, w.record)).allowed, false);
    });

    test('a suspended user does not allow, even holding a live grant', async () => {
      const a = await issueAuthority(w, { to: w.users.approver });
      await issueGrant(w, { to: w.users.suspended, authority: a });
      assert.equal((await checkGrant(db, w.users.suspended, w.record)).allowed, false);
    });

    test('a grant for a different record does not leak across', async () => {
      const a = await issueAuthority(w, { to: w.users.approver });
      const other = (await db.query<{ id: string }>(
        `INSERT INTO service_records
           (ppo_number, ppo_normalized, employee_name, name_normalized, name_sorted,
            file_path, file_name, sha256, byte_size, source_root)
         VALUES ('410221100348','410221100348','Sunita Devi','SUNITA DEVI','DEVI SUNITA',
                 '/srv/sr/b.pdf','b.pdf', repeat('b',64), 1, '/srv/sr') RETURNING id`,
      )).rows[0]!.id;
      await issueGrant(w, { to: w.users.requester, authority: a, record: other });

      assert.equal((await checkGrant(db, w.users.requester, w.record)).allowed, false);
      assert.equal((await checkGrant(db, w.users.requester, other)).allowed, true);
    });

    test('Accounts staff read any record, reported as custodial access', async () => {
      for (const u of [w.users.approver, w.users.custodian, w.users.controller]) {
        const d = await checkGrant(db, u, w.record);
        assert.equal(d.allowed, true);
        assert.equal(d.allowed && d.via, 'CUSTODIAL_ROLE');
      }
    });

    test('an admin is not custodial — the role opens no records', async () => {
      const admin = (await db.query<{ id: string }>(
        `INSERT INTO users (staff_code, full_name, department_id, password_hash)
         VALUES ('IT001','An Administrator',$1,'x') RETURNING id`, [w.accountsDept],
      )).rows[0]!.id;
      await db.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,'ADMIN')`, [admin]);
      assert.equal((await checkGrant(db, admin, w.record)).allowed, false);
    });

    test('an auditor is not custodial either — sees who looked, never what', async () => {
      const auditor = (await db.query<{ id: string }>(
        `INSERT INTO users (staff_code, full_name, department_id, password_hash)
         VALUES ('AU001','An Auditor',$1,'x') RETURNING id`, [w.userDept],
      )).rows[0]!.id;
      await db.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,'AUDITOR')`, [auditor]);
      assert.equal((await checkGrant(db, auditor, w.record)).allowed, false);
    });

    test('a grant is reported in preference to the custodial role', async () => {
      // So the audit trail says "read under a grant" when one existed, and
      // custodial reads stay filterable.
      const a = await issueAuthority(w, { to: w.users.controller, by: w.users.controller2 });
      await issueGrant(w, { to: w.users.approver, authority: a });
      const d = await checkGrant(db, w.users.approver, w.record);
      assert.equal(d.allowed && d.via, 'GRANT');
    });

    test('view caps are enforced, and consumeView is race-free', async () => {
      const a = await issueAuthority(w, { to: w.users.approver });
      const g = await issueGrant(w, { to: w.users.requester, authority: a, maxViews: 3 });

      assert.equal(await consumeView(db, g), true);
      assert.equal(await consumeView(db, g), true);
      assert.equal(await consumeView(db, g), true);
      // Fourth attempt loses: the cap is reached.
      assert.equal(await consumeView(db, g), false);
      assert.equal((await checkGrant(db, w.users.requester, w.record)).allowed, false);
    });

    test('consumeView refuses against a revoked grant', async () => {
      const a = await issueAuthority(w, { to: w.users.approver });
      const g = await issueGrant(w, { to: w.users.requester, authority: a, revoked: true });
      assert.equal(await consumeView(db, g), false);
    });
  });

  // -------------------------------------------------------------------------
  describe('§6.2 the authority check — may this person RELEASE a record?', () => {
    const release = (officer: string, requester = w.users.requester, dept = w.userDept) =>
      assertMayRelease(db, { officerId: officer, requesterId: requester, requesterDeptId: dept });

    test('the approver role alone releases nothing', async () => {
      assert.equal(await findLiveAuthority(db, w.users.approverNoAuthority), null);
      await assert.rejects(
        () => release(w.users.approverNoAuthority),
        (e: Error & { code?: string }) => e.code === 'NO_APPROVAL_AUTHORITY',
      );
    });

    test('a live authority permits release and returns the office order', async () => {
      const a = await issueAuthority(w, { to: w.users.approver });
      const live = await release(w.users.approver);
      assert.equal(live.id, a);
      assert.equal(live.orderReference, 'AC/ORD/2026/17');
    });

    test('a suspended authority refuses — leave is not a permission', async () => {
      await issueAuthority(w, { to: w.users.approver, status: 'SUSPENDED' });
      await assert.rejects(() => release(w.users.approver),
        (e: Error & { code?: string }) => e.code === 'NO_APPROVAL_AUTHORITY');
    });

    test('a revoked authority refuses', async () => {
      await issueAuthority(w, { to: w.users.approver, status: 'REVOKED' });
      await assert.rejects(() => release(w.users.approver),
        (e: Error & { code?: string }) => e.code === 'NO_APPROVAL_AUTHORITY');
    });

    test('an expired authority refuses — a transfer closes the door by itself', async () => {
      await issueAuthority(w, { to: w.users.approver, from: '90 days', to_: '-1 day' });
      await assert.rejects(() => release(w.users.approver),
        (e: Error & { code?: string }) => e.code === 'NO_APPROVAL_AUTHORITY');
    });

    test('an authority not yet in force refuses', async () => {
      await issueAuthority(w, { to: w.users.approver, from: '-2 days', to_: '90 days' });
      await assert.rejects(() => release(w.users.approver),
        (e: Error & { code?: string }) => e.code === 'NO_APPROVAL_AUTHORITY');
    });

    test('an authority held by someone without the approver role does nothing', async () => {
      await issueAuthority(w, { to: w.users.custodian });
      await assert.rejects(() => release(w.users.custodian),
        (e: Error & { code?: string }) => e.code === 'NO_APPROVAL_AUTHORITY');
    });

    test('null scope means any user department', async () => {
      await issueAuthority(w, { to: w.users.approver, scope: null });
      await release(w.users.approver, w.users.requester, w.userDept);
      await release(w.users.approver, w.users.requester2, w.otherDept);
    });

    test('a scoped authority refuses departments outside its scope', async () => {
      await issueAuthority(w, { to: w.users.approver, scope: [w.userDept] });
      await release(w.users.approver, w.users.requester, w.userDept);
      await assert.rejects(
        () => release(w.users.approver, w.users.requester2, w.otherDept),
        (e: Error & { code?: string }) => e.code === 'OUT_OF_AUTHORITY_SCOPE',
      );
    });

    test('self-approval is refused before the authority is even looked up', async () => {
      await issueAuthority(w, { to: w.users.approver });
      await assert.rejects(
        () => release(w.users.approver, w.users.approver, w.accountsDept),
        (e: Error & { code?: string }) => e.code === 'SELF_APPROVAL',
      );
    });

    test('revocation is NOT gated by the authority — closing a door differs from opening one', async () => {
      // §6.2.1. Gating revocation behind the authority would mean the safety
      // action expires along with the power that created the risk.
      const a = await issueAuthority(w, { to: w.users.approver });
      const g = await issueGrant(w, { to: w.users.requester, authority: a });
      assert.equal((await checkGrant(db, w.users.requester, w.record)).allowed, true);

      // An officer with the role but no authority: refused on release...
      await assert.rejects(() => release(w.users.approverNoAuthority),
        (e: Error & { code?: string }) => e.code === 'NO_APPROVAL_AUTHORITY');
      // ...and permitted on revoke.
      assert.equal(await revokeGrant(db, g, w.users.approverNoAuthority, 'no longer required'), true);
      assert.equal((await checkGrant(db, w.users.requester, w.record)).allowed, false);
    });

    test('reading and releasing are genuinely separate powers', async () => {
      // The whole point of §2.1, in one assertion: an Accounts officer with no
      // authority reads every record and releases none of them.
      const u = w.users.approverNoAuthority;
      assert.equal((await checkGrant(db, u, w.record)).allowed, true);
      await assert.rejects(() => release(u),
        (e: Error & { code?: string }) => e.code === 'NO_APPROVAL_AUTHORITY');
    });
  });

  // -------------------------------------------------------------------------
  describe('constraints that outlive the application code', () => {
    test('a grant cannot be issued without naming the authority behind it', async () => {
      await assert.rejects(
        () => db.query(
          `INSERT INTO access_grants
             (user_id, service_record_id, valid_from, valid_until, granted_by, origin)
           VALUES ($1,$2, now(), now() + interval '15 days', $3, 'EMERGENCY')`,
          [w.users.requester, w.record, w.users.approver],
        ),
        /granted_under_authority_id/,
      );
    });

    test('the 180-day cap is enforced by the database, not the UI', async () => {
      const a = await issueAuthority(w, { to: w.users.approver });
      await issueGrant(w, { to: w.users.requester, authority: a, untilInterval: '179 days' });
      await assert.rejects(
        () => issueGrant(w, { to: w.users.requester2, authority: a, untilInterval: '181 days' }),
        /grant_period_capped/,
      );
    });

    test('an authority cannot be issued to oneself', async () => {
      await assert.rejects(
        () => issueAuthority(w, { to: w.users.controller, by: w.users.controller }),
        /authority_not_self_issued/,
      );
    });

    test('a revocation must say who and why', async () => {
      const a = await issueAuthority(w, { to: w.users.approver });
      const g = await issueGrant(w, { to: w.users.requester, authority: a });
      await assert.rejects(
        () => db.query('UPDATE access_grants SET revoked_at = now() WHERE id = $1', [g]),
        /revocation_is_complete/,
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('§12 the audit log', () => {
    test('events chain, and the chain verifies', async () => {
      const a = await issueAuthority(w, { to: w.users.approver });
      const g = await issueGrant(w, { to: w.users.requester, authority: a });

      await appendEvent(db, {
        eventType: 'GRANT_CREATED', actorId: w.users.approver,
        grantId: g, authorityId: a, serviceRecordId: w.record,
        detail: { orderReference: 'AC/ORD/2026/17' },
      });
      await appendEvent(db, {
        eventType: 'PAGE_SERVED', actorId: w.users.requester,
        grantId: g, serviceRecordId: w.record, detail: { page: 1 },
      });

      assert.equal(await verifyChain(db), null);

      const { rows } = await db.query<{ prev_hash: string; row_hash: string }>(
        'SELECT prev_hash, row_hash FROM access_events ORDER BY seq',
      );
      assert.equal(rows[0]!.prev_hash, '0'.repeat(64));
      assert.equal(rows[1]!.prev_hash, rows[0]!.row_hash);
    });

    test('denials are recorded as loudly as allows', async () => {
      await appendEvent(db, {
        eventType: 'PAGE_DENIED', outcome: 'DENY',
        actorId: w.users.requester, serviceRecordId: w.record,
        detail: { reason: 'NO_GRANT' },
      });
      const { rows } = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM access_events WHERE outcome = 'DENY'`,
      );
      assert.equal(rows[0]!.n, '1');
    });

    test('the log is append-only against the owner, not only against a role', async () => {
      await appendEvent(db, { eventType: 'LOGIN_OK', actorId: w.users.requester });
      await assert.rejects(
        () => db.query(`UPDATE access_events SET event_type = 'LOGOUT'`),
        /append-only/,
      );
      await assert.rejects(() => db.query('DELETE FROM access_events'), /append-only/);
    });

    test('an unknown event type is refused', async () => {
      await assert.rejects(
        () => db.query(
          `INSERT INTO access_events (event_type, prev_hash, row_hash) VALUES ('WHATEVER','','')`,
        ),
        /event_type_known/,
      );
    });
  });
});
