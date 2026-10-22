// The live access register, emergency grants, and revocation.
import type { Queryable, Uuid } from '../domain/types.ts';
import { appendEvent } from '../audit/events.ts';
import { assertMayRelease } from '../authz/authorityCheck.ts';
import { getSetting } from './settings.ts';
import { notify } from './notifications.ts';

/** Every open door, sorted by expiry — the screen an officer opens when
 *  someone asks "who can see what right now?" (§10). */
export const REGISTER_SQL = `
SELECT g.id, g.valid_from, g.valid_until, g.origin, g.max_views, g.view_count,
       u.full_name AS holder_name, u.staff_code AS holder_code,
       d.name AS holder_dept,
       r.ppo_number, r.employee_name,
       gb.full_name AS granted_by_name,
       a.id AS authority_id, a.status AS authority_status,
       q.request_no
FROM access_grants g
JOIN users u        ON u.id = g.user_id
JOIN departments d  ON d.id = u.department_id
JOIN service_records r ON r.id = g.service_record_id
JOIN users gb       ON gb.id = g.granted_by
JOIN approval_authorities a ON a.id = g.granted_under_authority_id
LEFT JOIN access_request_items i ON i.id = g.request_item_id
LEFT JOIN access_requests q ON q.id = i.request_id
WHERE g.revoked_at IS NULL
  AND now() < g.valid_until
  AND ($1::uuid IS NULL OR g.granted_under_authority_id = $1)
  AND ($2::uuid IS NULL OR g.user_id = $2)
ORDER BY g.valid_until`;

export async function register(db: Queryable, filter: { authorityId?: Uuid; userId?: Uuid } = {}) {
  const { rows } = await db.query(REGISTER_SQL, [filter.authorityId ?? null, filter.userId ?? null]);
  return rows;
}

export async function myGrants(db: Queryable, userId: Uuid) {
  const { rows } = await db.query(
    `SELECT g.id, g.valid_from, g.valid_until, g.max_views, g.view_count,
            r.id AS record_id, r.ppo_number, r.employee_name,
            r.page_count + r.added_page_count AS page_count
     FROM access_grants g
     JOIN service_records r ON r.id = g.service_record_id
     WHERE g.user_id = $1 AND g.revoked_at IS NULL AND now() < g.valid_until
     ORDER BY g.valid_until`,
    [userId],
  );
  return rows;
}

export interface EmergencyInput {
  officerId: Uuid;
  toUserId: Uuid;
  recordId: Uuid;
  justification: string;
  days?: number;
}

/**
 * An emergency is not a bypass: §6.2 applies here too, and the window is
 * capped shorter than a normal grant.
 */
export async function issueEmergency(db: Queryable, input: EmergencyInput): Promise<Uuid> {
  const { rows: users } = await db.query<{ department_id: string }>(
    `SELECT department_id FROM users WHERE id = $1 AND status = 'ACTIVE'`, [input.toUserId],
  );
  if (!users[0]) throw new Error('Recipient not found');

  const authority = await assertMayRelease(db, {
    officerId: input.officerId,
    requesterId: input.toUserId,
    requesterDeptId: users[0].department_id,
  });

  const cap = Math.min(input.days ?? 3, await getSetting(db, 'grant.emergency_max_days', 7));
  const from = new Date();
  const to = new Date(from.getTime() + cap * 86_400_000);

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO access_grants
       (user_id, service_record_id, valid_from, valid_until, granted_by,
        granted_under_authority_id, origin)
     VALUES ($1,$2,$3,$4,$5,$6,'EMERGENCY') RETURNING id`,
    [input.toUserId, input.recordId, from, to, input.officerId, authority.id],
  );
  const id = rows[0]!.id;
  await appendEvent(db, {
    eventType: 'EMERGENCY_GRANT_ISSUED', actorId: input.officerId, grantId: id,
    serviceRecordId: input.recordId, authorityId: authority.id,
    detail: { justification: input.justification, days: cap, releasedTo: input.toUserId },
  });
  return id;
}

export async function revoke(
  db: Queryable, grantId: Uuid, officerId: Uuid, reason: string,
): Promise<boolean> {
  const { rows } = await db.query<{ user_id: string; service_record_id: string }>(
    `UPDATE access_grants SET revoked_at = now(), revoked_by = $2, revoke_reason = $3
      WHERE id = $1 AND revoked_at IS NULL
      RETURNING user_id, service_record_id`,
    [grantId, officerId, reason],
  );
  const g = rows[0];
  if (!g) return false;
  await appendEvent(db, {
    eventType: 'GRANT_REVOKED', actorId: officerId, grantId,
    serviceRecordId: g.service_record_id, detail: { reason },
  });
  await notify(db, g.user_id, 'GRANT_REVOKED', { grantId, reason });
  return true;
}

/** Marks lapsed grants for the dashboard. Security does not depend on it
 *  running: expiry is computed at request time (§3.2). */
export async function sweepExpired(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ id: string; user_id: string; service_record_id: string }>(
    `SELECT id, user_id, service_record_id FROM access_grants
      WHERE revoked_at IS NULL AND valid_until <= now()
        AND NOT EXISTS (
          SELECT 1 FROM access_events e
          WHERE e.grant_id = access_grants.id AND e.event_type = 'GRANT_EXPIRED')`,
  );
  for (const g of rows) {
    await appendEvent(db, {
      eventType: 'GRANT_EXPIRED', grantId: g.id, serviceRecordId: g.service_record_id,
    });
  }
  return rows.length;
}
