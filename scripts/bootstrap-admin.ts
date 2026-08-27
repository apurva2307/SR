// The first account on a real deployment.
//
// scripts/seed.ts is demo data: it TRUNCATEs every table and creates nine
// fictional users. That is the wrong tool for a folder of real service
// records. This creates one department and one user, inserts nothing else,
// and refuses rather than overwrite anything that already exists.
//
//   BOOTSTRAP_STAFF_CODE=IT001 BOOTSTRAP_NAME='...' BOOTSTRAP_DEPT_CODE=IT \
//   BOOTSTRAP_DEPT_NAME='IT Department' BOOTSTRAP_ROLES=ADMIN \
//     node --experimental-strip-types scripts/bootstrap-admin.ts
//
// The password is generated here and printed once. It is never stored in
// plaintext and must_change_password is set, so the holder replaces it at
// first sign-in — the same path the admin console uses for every other user.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { hashPassword } from '../src/services/auth.ts';
import { appendEvent } from '../src/audit/events.ts';

const VALID_ROLES = new Set([
  'REQUESTER', 'APPROVER', 'CUSTODIAN', 'CONTROLLING_OFFICER', 'AUDITOR', 'ADMIN',
]);

function env(name: string, fallback?: string): string {
  const v = process.env[name]?.trim();
  if (v) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`${name} is not set`);
}

async function main() {
  const staffCode = env('BOOTSTRAP_STAFF_CODE', 'IT001').toUpperCase();
  const fullName = env('BOOTSTRAP_NAME', 'System Administrator');
  const email = process.env['BOOTSTRAP_EMAIL']?.trim() || null;
  const deptCode = env('BOOTSTRAP_DEPT_CODE', 'IT').toUpperCase();
  const deptName = env('BOOTSTRAP_DEPT_NAME', 'IT Department');
  // ACCOUNTS lets the department hold approvers; an admin needs neither, so
  // USER_DEPT is the honest default. `kind` is locked once staff are posted.
  const deptKind = env('BOOTSTRAP_DEPT_KIND', 'USER_DEPT').toUpperCase();
  const roles = env('BOOTSTRAP_ROLES', 'ADMIN').split(',').map((r) => r.trim().toUpperCase()).filter(Boolean);

  if (deptKind !== 'ACCOUNTS' && deptKind !== 'USER_DEPT') {
    throw new Error(`BOOTSTRAP_DEPT_KIND must be ACCOUNTS or USER_DEPT, not ${deptKind}`);
  }
  for (const r of roles) if (!VALID_ROLES.has(r)) throw new Error(`Unknown role: ${r}`);

  const db = new pg.Client({ connectionString: env('DATABASE_URL') });
  await db.connect();

  try {
    await db.query('BEGIN');

    const { rows: clash } = await db.query<{ id: string }>(
      'SELECT id FROM users WHERE staff_code = $1', [staffCode],
    );
    if (clash[0]) {
      throw new Error(
        `A user with staff code ${staffCode} already exists. ` +
        `Issue a reset code from Administration instead of bootstrapping a second one.`,
      );
    }

    // Reuse the department if it is already there — bootstrapping an admin and
    // a custodian into the same department is the normal case.
    let deptId = (await db.query<{ id: string }>(
      'SELECT id FROM departments WHERE code = $1', [deptCode],
    )).rows[0]?.id;

    if (!deptId) {
      deptId = (await db.query<{ id: string }>(
        'INSERT INTO departments (code, name, kind) VALUES ($1,$2,$3) RETURNING id',
        [deptCode, deptName, deptKind],
      )).rows[0]!.id;
      await appendEvent(db, {
        eventType: 'DEPARTMENT_CREATED', actorId: null,
        detail: { departmentId: deptId, code: deptCode, name: deptName, kind: deptKind, bootstrap: true },
      });
    }

    const password = randomBytes(12).toString('base64url');
    const userId = (await db.query<{ id: string }>(
      `INSERT INTO users (staff_code, full_name, email, department_id, password_hash, must_change_password)
       VALUES ($1,$2,$3,$4,$5,true) RETURNING id`,
      [staffCode, fullName, email, deptId, await hashPassword(password)],
    )).rows[0]!.id;

    for (const role of roles) {
      // granted_by is null: there is no prior administrator to name, and
      // saying so is better than attributing it to the account itself.
      await db.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)', [userId, role]);
    }

    await appendEvent(db, {
      eventType: 'USER_CREATED', actorId: null,
      detail: { userId, staffCode, roles, bootstrap: true },
    });
    for (const role of roles) {
      await appendEvent(db, {
        eventType: 'ROLE_GRANTED', actorId: null,
        detail: { userId, role, bootstrap: true },
      });
    }

    await db.query('COMMIT');

    console.log('\nCreated. This password is shown once and is not recoverable:\n');
    console.log(`  staff code: ${staffCode}`);
    console.log(`  password:   ${password}`);
    console.log(`  roles:      ${roles.join(', ')}`);
    console.log(`  department: ${deptCode} — ${deptName}\n`);
    console.log('You will be asked to change it at first sign-in.\n');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally {
    await db.end();
  }
}

main().catch((e: unknown) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
