// §6.2 — the authority register. Who may release records right now, and until
// when.
import type { Queryable, Uuid } from '../domain/types.ts';
import { appendEvent } from '../audit/events.ts';
import { notify } from './notifications.ts';

export const REGISTER_SQL = `
SELECT a.id, a.user_id, a.effective_from, a.effective_to, a.status,
       a.scope_dept_ids, a.remarks, a.created_at,
       u.full_name AS holder_name, u.staff_code AS holder_code,
       ib.full_name AS issued_by_name,
       (a.status = 'ACTIVE' AND now() >= a.effective_from AND now() < a.effective_to) AS is_live,
       (SELECT count(*) FROM access_grants g
         WHERE g.granted_under_authority_id = a.id
           AND g.revoked_at IS NULL AND now() < g.valid_until) AS live_grants
FROM approval_authorities a
JOIN users u  ON u.id = a.user_id
JOIN users ib ON ib.id = a.issued_by
WHERE ($1::boolean IS NOT TRUE OR a.status <> 'REVOKED')
ORDER BY (a.status = 'ACTIVE' AND now() < a.effective_to) DESC, a.effective_to`;

export async function list(db: Queryable, hideRevoked = false) {
  const { rows } = await db.query(REGISTER_SQL, [hideRevoked]);
  return rows;
}

export interface IssueInput {
  issuerId: Uuid;
  toUserId: Uuid;
  effectiveFrom: Date;
  effectiveTo: Date;
  scopeDeptIds?: Uuid[] | null;
  remarks?: string | null;
}

export type IssueResult =
  | { ok: true; id: Uuid }
  | { ok: false; reason: 'SELF_ISSUE' | 'NOT_AN_APPROVER' | 'BAD_PERIOD' };

export async function issue(db: Queryable, input: IssueInput): Promise<IssueResult> {
  if (input.issuerId === input.toUserId) return { ok: false, reason: 'SELF_ISSUE' };
  if (input.effectiveTo <= input.effectiveFrom) return { ok: false, reason: 'BAD_PERIOD' };

  // An authority handed to someone without the approver role does nothing;
  // refusing here makes that obvious at the point of issue rather than at the
  // point of use.
  const { rows: ok } = await db.query(
    `SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = 'APPROVER'`, [input.toUserId],
  );
  if (!ok[0]) return { ok: false, reason: 'NOT_AN_APPROVER' };

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO approval_authorities
       (user_id, issued_by, effective_from, effective_to, scope_dept_ids, remarks)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [input.toUserId, input.issuerId, input.effectiveFrom, input.effectiveTo, input.scopeDeptIds ?? null, input.remarks ?? null],
  );
  const id = rows[0]!.id;
  await appendEvent(db, {
    eventType: 'AUTHORITY_ISSUED', actorId: input.issuerId, authorityId: id,
    detail: {
      holder: input.toUserId,
      effectiveTo: input.effectiveTo.toISOString(), scoped: input.scopeDeptIds !== null,
    },
  });
  await notify(db, input.toUserId, 'AUTHORITY_ISSUED', { authorityId: id });
  return { ok: true, id };
}

type Transition = 'SUSPEND' | 'RESUME' | 'REVOKE';

const NEXT: Record<Transition, { from: string; to: string; event: 'AUTHORITY_SUSPENDED' | 'AUTHORITY_RESUMED' | 'AUTHORITY_REVOKED' }> = {
  SUSPEND: { from: 'ACTIVE',    to: 'SUSPENDED', event: 'AUTHORITY_SUSPENDED' },
  RESUME:  { from: 'SUSPENDED', to: 'ACTIVE',    event: 'AUTHORITY_RESUMED' },
  REVOKE:  { from: 'ACTIVE',    to: 'REVOKED',   event: 'AUTHORITY_REVOKED' },
};

export async function transition(
  db: Queryable, id: Uuid, officerId: Uuid, kind: Transition, reason?: string,
): Promise<boolean> {
  const t = NEXT[kind];
  const sql = kind === 'REVOKE'
    ? `UPDATE approval_authorities SET status = $3, revoked_at = now(), revoked_by = $4, remarks = coalesce($5, remarks)
        WHERE id = $1 AND status IN ('ACTIVE','SUSPENDED') RETURNING user_id`
    : `UPDATE approval_authorities SET status = $3,
              suspended_at = CASE WHEN $3 = 'SUSPENDED' THEN now() ELSE NULL END
        WHERE id = $1 AND status = $2 RETURNING user_id`;
  const params = kind === 'REVOKE'
    ? [id, t.from, t.to, officerId, reason ?? null]
    : [id, t.from, t.to];

  const { rows } = await db.query<{ user_id: string }>(sql, params);
  if (!rows[0]) return false;

  await appendEvent(db, {
    eventType: t.event, actorId: officerId, authorityId: id, detail: { reason: reason ?? null },
  });
  if (kind === 'REVOKE') await notify(db, rows[0].user_id, 'AUTHORITY_WITHDRAWN', { authorityId: id });
  return true;
}

export type ExtendResult =
  | { ok: true }
  | { ok: false; reason: 'NOT_FOUND' | 'REVOKED' | 'SELF_EXTEND' | 'NOT_LATER' };

/**
 * Moves an authority's end date later. Only ever later: shortening one is what
 * suspend and withdraw are for, and both leave a clearer trail. A suspended
 * authority may be extended and stays suspended; a withdrawn one may not —
 * that needs a fresh issue.
 */
export async function extend(
  db: Queryable, id: Uuid, officerId: Uuid, newEffectiveTo: Date, reason?: string,
): Promise<ExtendResult> {
  const { rows: cur } = await db.query<{ user_id: string; status: string; effective_to: Date }>(
    'SELECT user_id, status, effective_to FROM approval_authorities WHERE id = $1 FOR UPDATE', [id],
  );
  const a = cur[0];
  if (!a) return { ok: false, reason: 'NOT_FOUND' };
  if (a.status === 'REVOKED') return { ok: false, reason: 'REVOKED' };
  // Same separation as issuing: nobody lengthens their own power to release.
  if (a.user_id === officerId) return { ok: false, reason: 'SELF_EXTEND' };
  if (newEffectiveTo <= a.effective_to || newEffectiveTo.getTime() <= Date.now()) {
    return { ok: false, reason: 'NOT_LATER' };
  }

  await db.query('UPDATE approval_authorities SET effective_to = $2 WHERE id = $1', [id, newEffectiveTo]);
  await appendEvent(db, {
    eventType: 'AUTHORITY_EXTENDED', actorId: officerId, authorityId: id,
    detail: {
      from: a.effective_to.toISOString(), to: newEffectiveTo.toISOString(), reason: reason ?? null,
    },
  });
  await notify(db, a.user_id, 'AUTHORITY_EXTENDED',
    { authorityId: id, effectiveTo: newEffectiveTo.toISOString() });
  return { ok: true };
}

/**
 * Grants opened under an authority stay live after it is withdrawn — the
 * releases were validly made. The register surfaces them so a controlling
 * officer can review and revoke in the same sitting if circumstances call
 * for it (§6.2).
 */
export async function liveGrantsUnder(db: Queryable, authorityId: Uuid) {
  const { rows } = await db.query(
    `SELECT g.id, g.valid_until, u.full_name AS holder_name, r.ppo_number, r.employee_name
     FROM access_grants g
     JOIN users u ON u.id = g.user_id
     JOIN service_records r ON r.id = g.service_record_id
     WHERE g.granted_under_authority_id = $1 AND g.revoked_at IS NULL AND now() < g.valid_until
     ORDER BY g.valid_until`,
    [authorityId],
  );
  return rows;
}

/** An authority that lapses silently on a Friday means the queue stops on
 *  Monday and nobody guesses why (§6.2). */
export async function warnExpiring(db: Queryable, warnDays: number[]): Promise<number> {
  let sent = 0;
  for (const d of warnDays) {
    // Keyed on the end date as well, so an authority that was extended is
    // warned again before its new end rather than considered already warned.
    const { rows } = await db.query<{ id: string; user_id: string; issued_by: string; until: string }>(
      `SELECT a.id, a.user_id, a.issued_by, a.effective_to::text AS until
         FROM approval_authorities a
        WHERE a.status = 'ACTIVE'
          AND a.effective_to BETWEEN now() AND now() + ($1 || ' days')::interval
          AND NOT EXISTS (
            SELECT 1 FROM notifications n
            WHERE n.kind = 'AUTHORITY_EXPIRING'
              AND n.payload->>'authorityId' = a.id::text
              AND n.payload->>'window' = $1
              AND coalesce(n.payload->>'until', a.effective_to::text) = a.effective_to::text)`,
      [String(d)],
    );
    for (const a of rows) {
      const payload = { authorityId: a.id, window: String(d), until: a.until };
      await notify(db, a.user_id, 'AUTHORITY_EXPIRING', payload);
      await notify(db, a.issued_by, 'AUTHORITY_EXPIRING', payload);
      sent += 2;
    }
  }
  return sent;
}
