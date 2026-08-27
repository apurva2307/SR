import { Router } from 'express';
import { z } from 'zod';
import { randomBytes, createHash } from 'node:crypto';
import { getPool } from '../../db.ts';
import { hashPassword } from '../../services/auth.ts';
import { SETTING_SPECS, setSetting, validateSetting } from '../../services/settings.ts';
import { appendEvent } from '../../audit/events.ts';
import { requireAuth, requireRole } from '../middleware/auth.ts';
import { wrap } from '../middleware/errors.ts';
import { param, uuidParam } from '../middleware/context.ts';

export const adminRoutes = Router();
adminRoutes.param('id', uuidParam());
adminRoutes.use(requireAuth);

// Anyone signed in needs the department list to build a request or an
// authority scope; it carries no record data. `references` lets Administration
// show what a department is holding before anyone tries to remove it.
adminRoutes.get('/departments', wrap(async (_req, res) => {
  const { rows } = await getPool().query(
    `SELECT d.id, d.code, d.name, d.kind, d.is_active, d.created_at,
            (SELECT count(*) FROM users u WHERE u.department_id = d.id
               AND u.status <> 'CLOSED')                              AS user_count,
            (SELECT count(*) FROM access_requests q
               WHERE q.requester_dept_id = d.id)                      AS request_count,
            (SELECT count(*) FROM approval_authorities a
               WHERE d.id = ANY(a.scope_dept_ids))                    AS scoped_authority_count
     FROM departments d
     ORDER BY d.kind, d.name`,
  );
  res.json({ departments: rows });
}));

const departmentBody = z.object({
  code: z.string().trim().min(2, 'A code needs at least two characters.').max(12),
  name: z.string().trim().min(3, 'Give the department its full name.').max(120),
  kind: z.enum(['ACCOUNTS', 'USER_DEPT']),
});

adminRoutes.post('/departments', requireRole('ADMIN'), wrap(async (req, res) => {
  const body = departmentBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({
      error: 'BAD_REQUEST',
      message: body.error.issues[0]?.message ?? 'Check the fields and try again.',
    });
    return;
  }
  try {
    const { rows } = await getPool().query<{ id: string }>(
      'INSERT INTO departments (code, name, kind) VALUES ($1,$2,$3) RETURNING id',
      [body.data.code.toUpperCase(), body.data.name, body.data.kind],
    );
    await appendEvent(getPool(), {
      eventType: 'DEPARTMENT_CREATED', actorId: req.principal!.id,
      detail: { departmentId: rows[0]!.id, ...body.data },
    });
    res.status(201).json({ id: rows[0]!.id });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      res.status(409).json({
        error: 'DUPLICATE_CODE',
        message: `A department with code ${body.data.code.toUpperCase()} already exists.`,
      });
      return;
    }
    throw err;
  }
}));

adminRoutes.put('/departments/:id', requireRole('ADMIN'), wrap(async (req, res) => {
  const body = departmentBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({
      error: 'BAD_REQUEST',
      message: body.error.issues[0]?.message ?? 'Check the fields and try again.',
    });
    return;
  }
  const id = param(req, 'id');

  // `kind` decides whether a department can hold approvers at all (§5.1).
  // Flipping it under people's feet would silently change who may release
  // records, so it is only editable while the department is empty.
  const { rows: current } = await getPool().query<{ kind: string; n: string }>(
    `SELECT d.kind, (SELECT count(*) FROM users u WHERE u.department_id = d.id) AS n
     FROM departments d WHERE d.id = $1`, [id],
  );
  if (!current[0]) { res.status(404).json({ error: 'NOT_FOUND', message: 'No such department.' }); return; }
  if (current[0].kind !== body.data.kind && Number(current[0].n) > 0) {
    res.status(409).json({
      error: 'KIND_LOCKED',
      message: `Move its ${current[0].n} staff out first. Changing Accounts to a user department, or back, would change who can release records.`,
    });
    return;
  }

  try {
    await getPool().query(
      'UPDATE departments SET code = $2, name = $3, kind = $4 WHERE id = $1',
      [id, body.data.code.toUpperCase(), body.data.name, body.data.kind],
    );
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      res.status(409).json({
        error: 'DUPLICATE_CODE',
        message: `A department with code ${body.data.code.toUpperCase()} already exists.`,
      });
      return;
    }
    throw err;
  }
  await appendEvent(getPool(), {
    eventType: 'DEPARTMENT_UPDATED', actorId: req.principal!.id,
    detail: { departmentId: id, ...body.data, previousKind: current[0].kind },
  });
  res.json({ ok: true });
}));

for (const [path, active, event] of [
  ['deactivate', false, 'DEPARTMENT_DEACTIVATED'],
  ['activate', true, 'DEPARTMENT_ACTIVATED'],
] as const) {
  adminRoutes.post(`/departments/:id/${path}`, requireRole('ADMIN'), wrap(async (req, res) => {
    const id = param(req, 'id');
    const { rowCount } = await getPool().query(
      'UPDATE departments SET is_active = $2 WHERE id = $1 AND is_active <> $2', [id, active],
    );
    if ((rowCount ?? 0) === 0) {
      res.status(400).json({ error: 'NO_CHANGE', message: `That department is already ${active ? 'active' : 'inactive'}.` });
      return;
    }
    await appendEvent(getPool(), { eventType: event, actorId: req.principal!.id, detail: { departmentId: id } });
    res.json({ ok: true });
  }));
}

/**
 * Deletes a department outright, but only when nothing points at it.
 *
 * Unlike a user — who is suspended, never deleted, because audit rows name them
 * forever — a department that has never held staff or requests is genuinely
 * just a typo, and refusing to remove typos is its own kind of mess. Once it
 * has history, deactivation is the honest answer and the refusal says so.
 */
adminRoutes.delete('/departments/:id', requireRole('ADMIN'), wrap(async (req, res) => {
  const id = param(req, 'id');
  const { rows } = await getPool().query<{
    name: string; users: string; requests: string; authorities: string;
  }>(
    `SELECT d.name,
            (SELECT count(*) FROM users u WHERE u.department_id = d.id)        AS users,
            (SELECT count(*) FROM access_requests q WHERE q.requester_dept_id = d.id) AS requests,
            (SELECT count(*) FROM approval_authorities a WHERE d.id = ANY(a.scope_dept_ids)) AS authorities
     FROM departments d WHERE d.id = $1`, [id],
  );
  const d = rows[0];
  if (!d) { res.status(404).json({ error: 'NOT_FOUND', message: 'No such department.' }); return; }

  const blockers = [
    Number(d.users) > 0 ? `${d.users} staff account(s)` : null,
    Number(d.requests) > 0 ? `${d.requests} access request(s)` : null,
    Number(d.authorities) > 0 ? `${d.authorities} scoped approval authority(ies)` : null,
  ].filter(Boolean);

  if (blockers.length > 0) {
    res.status(409).json({
      error: 'DEPARTMENT_IN_USE',
      message: `${d.name} still holds ${blockers.join(', ')}. Deactivate it instead — deleting it would orphan records the audit log refers to.`,
      blockers: { users: Number(d.users), requests: Number(d.requests), authorities: Number(d.authorities) },
    });
    return;
  }

  await getPool().query('DELETE FROM departments WHERE id = $1', [id]);
  await appendEvent(getPool(), {
    eventType: 'DEPARTMENT_DELETED', actorId: req.principal!.id,
    detail: { departmentId: id, name: d.name },
  });
  res.json({ ok: true });
}));

adminRoutes.get('/users', requireRole('ADMIN', 'CONTROLLING_OFFICER', 'CUSTODIAN', 'APPROVER'),
  wrap(async (_req, res) => {
    const { rows } = await getPool().query(
      `SELECT u.id, u.staff_code, u.full_name, u.email, u.status, u.totp_enabled, u.totp_required,
              u.last_login_at, u.must_change_password, d.name AS department_name, d.kind,
              coalesce(array_agg(ur.role_id) FILTER (WHERE ur.role_id IS NOT NULL), '{}') AS roles
       FROM users u
       JOIN departments d ON d.id = u.department_id
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       GROUP BY u.id, d.name, d.kind
       ORDER BY d.name, u.full_name`,
    );
    res.json({ users: rows });
  }));

const userBody = z.object({
  staffCode: z.string().trim().min(2),
  fullName: z.string().trim().min(2),
  email: z.string().email().optional().nullable(),
  departmentId: z.string().uuid(),
  roles: z.array(z.enum(['REQUESTER', 'APPROVER', 'CUSTODIAN', 'CONTROLLING_OFFICER', 'AUDITOR', 'ADMIN'])),
});

adminRoutes.post('/users', requireRole('ADMIN'), wrap(async (req, res) => {
  const body = userBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({
      error: 'BAD_REQUEST',
      message: body.error.issues[0]?.message ?? 'Check the fields and try again.',
    });
    return;
  }
  // A one-time password shown once. Reset is an offline procedure by design (§11).
  const initial = randomBytes(9).toString('base64url');
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO users (staff_code, full_name, email, department_id, password_hash, must_change_password)
     VALUES ($1,$2,$3,$4,$5,true) RETURNING id`,
    [body.data.staffCode, body.data.fullName, body.data.email ?? null,
     body.data.departmentId, await hashPassword(initial)],
  );
  const id = rows[0]!.id;
  for (const role of body.data.roles) {
    await getPool().query(
      'INSERT INTO user_roles (user_id, role_id, granted_by) VALUES ($1,$2,$3)',
      [id, role, req.principal!.id],
    );
  }
  await appendEvent(getPool(), {
    eventType: 'USER_CREATED', actorId: req.principal!.id,
    detail: { userId: id, staffCode: body.data.staffCode, roles: body.data.roles },
  });
  res.status(201).json({ id, initialPassword: initial });
}));

const rolesBody = z.object({
  roles: z.array(z.enum(['REQUESTER', 'APPROVER', 'CUSTODIAN', 'CONTROLLING_OFFICER', 'AUDITOR', 'ADMIN'])),
});

/**
 * An administrator can assign themselves the approver role. No permission
 * model prevents that. What the design does instead is make the move loud:
 * every role change is its own audit event (§2.1).
 */
adminRoutes.put('/users/:id/roles', requireRole('ADMIN'), wrap(async (req, res) => {
  const body = rolesBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: 'BAD_REQUEST', message: 'Invalid role list.' }); return; }

  const { rows: before } = await getPool().query<{ role_id: string }>(
    'SELECT role_id FROM user_roles WHERE user_id = $1', [param(req, 'id')],
  );
  const had = new Set(before.map((r) => r.role_id));
  const want = new Set(body.data.roles);

  for (const role of want) if (!had.has(role as string)) {
    await getPool().query(
      'INSERT INTO user_roles (user_id, role_id, granted_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [param(req, 'id'), role, req.principal!.id],
    );
    await appendEvent(getPool(), {
      eventType: 'ROLE_GRANTED', actorId: req.principal!.id,
      detail: { userId: param(req, 'id'), role, selfGranted: param(req, 'id') === req.principal!.id },
    });
  }
  for (const role of had) if (!want.has(role as (typeof body.data.roles)[number])) {
    await getPool().query('DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2',
      [param(req, 'id'), role]);
    await appendEvent(getPool(), {
      eventType: 'ROLE_REVOKED', actorId: req.principal!.id,
      detail: { userId: param(req, 'id'), role },
    });
  }
  res.json({ ok: true });
}));

adminRoutes.post('/users/:id/suspend', requireRole('ADMIN'), wrap(async (req, res) => {
  // Never a delete: audit rows point at this user forever (§5.1).
  await getPool().query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [param(req, 'id')]);
  await getPool().query(
    `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [param(req, 'id')],
  );
  await appendEvent(getPool(), {
    eventType: 'USER_SUSPENDED', actorId: req.principal!.id, detail: { userId: param(req, 'id') },
  });
  res.json({ ok: true });
}));

/**
 * Brings a suspended account back. Their old sessions stay revoked and the
 * password is untouched — if the suspension was because the credential was
 * suspect, issue a reset code as well.
 */
adminRoutes.post('/users/:id/reactivate', requireRole('ADMIN'), wrap(async (req, res) => {
  const id = param(req, 'id');
  const { rows } = await getPool().query<{ full_name: string }>(
    `UPDATE users SET status = 'ACTIVE', failed_attempts = 0, locked_until = NULL
      WHERE id = $1 AND status = 'SUSPENDED' RETURNING full_name`, [id],
  );
  if (!rows[0]) {
    res.status(400).json({
      error: 'NOT_SUSPENDED',
      message: 'That account is not suspended, so there is nothing to restore.',
    });
    return;
  }
  await appendEvent(getPool(), {
    eventType: 'USER_REACTIVATED', actorId: req.principal!.id, detail: { userId: id },
  });
  res.json({
    ok: true,
    message: `${rows[0].full_name} can sign in again. Their old sessions stay ended and their password is unchanged.`,
  });
}));

adminRoutes.post('/users/:id/reset-code', requireRole('ADMIN'), wrap(async (req, res) => {
  const id = param(req, 'id');
  const code = randomBytes(9).toString('base64url');

  // One outstanding code per user: whoever holds an unused one can take over
  // the account. Issuing a new code retires the previous one.
  await getPool().query(
    `UPDATE password_reset_codes SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [id],
  );
  await getPool().query(
    `INSERT INTO password_reset_codes (user_id, code_hash, issued_by, expires_at)
     VALUES ($1,$2,$3, now() + interval '24 hours')`,
    [id, createHash('sha256').update(code).digest('hex'), req.principal!.id],
  );
  await appendEvent(getPool(), {
    eventType: 'PASSWORD_RESET_ISSUED', actorId: req.principal!.id, detail: { userId: id },
  });
  res.json({
    code,
    expiresInHours: 24,
    note: 'Verify identity in person, then hand this over. The user redeems it from the sign-in screen under "Forgotten your password?". It expires in 24 hours and can be used once.',
  });
}));

/**
 * Requires 2FA. Does NOT enable it.
 *
 * Enrolment belongs to the person holding the phone: the earlier version wrote
 * a secret and flipped the flag in one step, showing the secret to the
 * administrator, which locked the user out at their next sign-in. Now the user
 * is prompted to enrol and cannot use the system until they have.
 */
adminRoutes.post('/users/:id/totp/require', requireRole('ADMIN'), wrap(async (req, res) => {
  const id = param(req, 'id');
  const { rows } = await getPool().query<{ totp_enabled: boolean; full_name: string }>(
    'UPDATE users SET totp_required = true WHERE id = $1 RETURNING totp_enabled, full_name', [id],
  );
  if (!rows[0]) { res.status(404).json({ error: 'NOT_FOUND', message: 'No such user.' }); return; }
  await appendEvent(getPool(), {
    eventType: 'TOTP_REQUIRED', actorId: req.principal!.id, detail: { userId: id },
  });
  res.json({
    ok: true,
    alreadyEnrolled: rows[0].totp_enabled,
    message: rows[0].totp_enabled
      ? `${rows[0].full_name} already has two-factor set up. It can no longer be switched off by them.`
      : `${rows[0].full_name} will be asked to set up two-factor the next time they sign in. Nothing to hand over — they scan a code on their own screen.`,
  });
}));

/** Lifts the requirement. Leaves an existing enrolment in place. */
adminRoutes.post('/users/:id/totp/optional', requireRole('ADMIN'), wrap(async (req, res) => {
  const id = param(req, 'id');
  await getPool().query('UPDATE users SET totp_required = false WHERE id = $1', [id]);
  await appendEvent(getPool(), {
    eventType: 'TOTP_REQUIREMENT_LIFTED', actorId: req.principal!.id, detail: { userId: id },
  });
  res.json({ ok: true });
}));

/**
 * Clears 2FA entirely — the lost-phone path. Deliberately also clears the
 * requirement, so the user can sign in with their password alone and re-enrol;
 * leaving the requirement set would lock them out of their own recovery.
 */
adminRoutes.delete('/users/:id/totp', requireRole('ADMIN'), wrap(async (req, res) => {
  const id = param(req, 'id');
  const { rows } = await getPool().query<{ full_name: string }>(
    `UPDATE users SET totp_secret = NULL, totp_pending_secret = NULL,
            totp_enabled = false, totp_required = false
     WHERE id = $1 RETURNING full_name`, [id],
  );
  if (!rows[0]) { res.status(404).json({ error: 'NOT_FOUND', message: 'No such user.' }); return; }
  await appendEvent(getPool(), {
    eventType: 'TOTP_RESET', actorId: req.principal!.id, detail: { userId: id },
  });
  res.json({
    ok: true,
    message: `Two-factor cleared for ${rows[0].full_name}. They can sign in with their password and set it up again.`,
  });
}));

/** Values joined to what each one means, so the screen can explain itself. */
adminRoutes.get('/settings', requireRole('ADMIN', 'CONTROLLING_OFFICER'), wrap(async (_req, res) => {
  const { rows } = await getPool().query<{ key: string; value: unknown; updated_at: Date }>(
    `SELECT s.key, s.value, s.updated_at, u.full_name AS updated_by_name
     FROM settings s LEFT JOIN users u ON u.id = s.updated_by ORDER BY s.key`,
  );
  const byKey = new Map(rows.map((r) => [r.key, r]));
  res.json({
    settings: SETTING_SPECS.map((spec) => ({
      ...spec,
      value: byKey.get(spec.key)?.value ?? null,
      updatedAt: byKey.get(spec.key)?.updated_at ?? null,
      updatedByName: (byKey.get(spec.key) as { updated_by_name?: string } | undefined)?.updated_by_name ?? null,
    })),
  });
}));

adminRoutes.put('/settings/:key', requireRole('ADMIN'), wrap(async (req, res) => {
  const key = param(req, 'key');
  const checked = validateSetting(key, req.body?.value);
  if (!checked.ok) {
    res.status(400).json({ error: 'BAD_VALUE', message: checked.message });
    return;
  }
  const { rows: before } = await getPool().query<{ value: unknown }>(
    'SELECT value FROM settings WHERE key = $1', [key],
  );
  await setSetting(getPool(), key, checked.value, req.principal!.id);
  await appendEvent(getPool(), {
    eventType: 'SETTING_CHANGED', actorId: req.principal!.id,
    detail: { key, from: before[0]?.value ?? null, to: checked.value },
  });
  res.json({ ok: true, value: checked.value });
}));
