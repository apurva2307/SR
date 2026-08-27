import pg from 'pg';
import { ensureDefaultSettings } from '../../src/services/settings.ts';

export interface World {
  db: pg.Client;
  accountsDept: string;
  userDept: string;
  otherDept: string;
  record: string;
  users: Record<
    | 'requester' | 'requester2' | 'approver' | 'approverNoAuthority'
    | 'controller' | 'controller2' | 'custodian' | 'suspended',
    string
  >;
}

const days = (n: number) => `${n} days`;

/** Wipes and reseeds. Every test file gets a world it fully owns. */
export async function seed(db: pg.Client): Promise<World> {
  await db.query(`
    TRUNCATE access_events, notifications, access_grants, access_request_items,
             access_requests, approval_authorities, record_aliases,
             quarantine_items, ingestion_runs, service_records,
             sessions, user_roles, users, departments RESTART IDENTITY CASCADE`);

  // TRUNCATE ... CASCADE reaches settings through settings.updated_by.
  await ensureDefaultSettings(db as unknown as Parameters<typeof ensureDefaultSettings>[0]);

  const dept = async (code: string, name: string, kind: string) =>
    (await db.query<{ id: string }>(
      'INSERT INTO departments (code, name, kind) VALUES ($1,$2,$3) RETURNING id',
      [code, name, kind],
    )).rows[0]!.id;

  const accountsDept = await dept('AC', 'Accounts', 'ACCOUNTS');
  const userDept = await dept('PW', 'Public Works', 'USER_DEPT');
  const otherDept = await dept('ED', 'Education', 'USER_DEPT');

  const user = async (code: string, name: string, deptId: string, status = 'ACTIVE') =>
    (await db.query<{ id: string }>(
      `INSERT INTO users (staff_code, full_name, department_id, password_hash, status)
       VALUES ($1,$2,$3,'argon2id$placeholder',$4) RETURNING id`,
      [code, name, deptId, status],
    )).rows[0]!.id;

  const users = {
    requester: await user('PW001', 'A Requester', userDept),
    requester2: await user('ED001', 'Another Requester', otherDept),
    approver: await user('AC001', 'An Approver', accountsDept),
    approverNoAuthority: await user('AC002', 'Eligible But Unauthorised', accountsDept),
    controller: await user('AC000', 'A Controlling Officer', accountsDept),
    // A second one, because an authority can never be self-issued.
    controller2: await user('AC010', 'Another Controlling Officer', accountsDept),
    custodian: await user('AC003', 'A Custodian', accountsDept),
    suspended: await user('PW999', 'A Suspended Clerk', userDept, 'SUSPENDED'),
  };

  const role = (userId: string, roleId: string) =>
    db.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)', [userId, roleId]);

  await role(users.requester, 'REQUESTER');
  await role(users.requester2, 'REQUESTER');
  await role(users.suspended, 'REQUESTER');
  await role(users.approver, 'APPROVER');
  await role(users.approverNoAuthority, 'APPROVER');
  await role(users.controller, 'APPROVER');
  await role(users.controller, 'CONTROLLING_OFFICER');
  await role(users.controller2, 'APPROVER');
  await role(users.controller2, 'CONTROLLING_OFFICER');
  await role(users.custodian, 'CUSTODIAN');

  const record = (await db.query<{ id: string }>(
    `INSERT INTO service_records
       (ppo_number, ppo_normalized, employee_name, name_normalized, name_sorted,
        file_path, file_name, sha256, byte_size, page_count, source_root)
     VALUES ('410221100347','410221100347','Shri Ram Kumar Sharma','RAM KUMAR SHARMA',
             'KUMAR RAM SHARMA','/srv/sr/410221100347_Ram.pdf','410221100347_Ram.pdf',
             repeat('a',64), 182344, 84, '/srv/sr')
     RETURNING id`,
  )).rows[0]!.id;

  return { db, accountsDept, userDept, otherDept, record, users };
}

export async function issueAuthority(
  w: World,
  opts: {
    to: string;
    by?: string;
    from?: string;
    to_?: string;
    scope?: string[] | null;
    status?: 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
  },
): Promise<string> {
  const { rows } = await w.db.query<{ id: string }>(
    `INSERT INTO approval_authorities
       (user_id, issued_by, order_reference, effective_from, effective_to, scope_dept_ids, status)
     VALUES ($1,$2,'AC/ORD/2026/17', now() - $3::interval, now() + $4::interval, $5, $6)
     RETURNING id`,
    [
      opts.to,
      opts.by ?? w.users.controller,
      opts.from ?? days(1),
      opts.to_ ?? days(90),
      opts.scope ?? null,
      opts.status ?? 'ACTIVE',
    ],
  );
  return rows[0]!.id;
}

export async function issueGrant(
  w: World,
  opts: {
    to: string;
    authority: string;
    record?: string;
    fromInterval?: string;
    untilInterval?: string;
    maxViews?: number | null;
    revoked?: boolean;
  },
): Promise<string> {
  const { rows } = await w.db.query<{ id: string }>(
    `INSERT INTO access_grants
       (user_id, service_record_id, valid_from, valid_until, max_views,
        granted_by, granted_under_authority_id, origin,
        revoked_at, revoked_by, revoke_reason)
     VALUES ($1,$2, now() + $3::interval, now() + $4::interval, $5,
             $6, $7, 'EMERGENCY',
             $8, $9, $10)
     RETURNING id`,
    [
      opts.to,
      opts.record ?? w.record,
      opts.fromInterval ?? '-1 day',
      opts.untilInterval ?? days(15),
      opts.maxViews ?? null,
      w.users.approver,
      opts.authority,
      opts.revoked ? new Date() : null,
      opts.revoked ? w.users.approver : null,
      opts.revoked ? 'test revocation' : null,
    ],
  );
  return rows[0]!.id;
}
