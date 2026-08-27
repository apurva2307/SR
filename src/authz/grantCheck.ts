// §6.1 — may this person READ this record?
//
// This runs on every page fetch and every thumbnail. It is never memoized,
// never batched, and its result never travels in a token: the token says who
// you are, the database says what that currently means.

import type { Queryable, Uuid } from '../domain/types.ts';

/**
 * Exported as a constant so it is greppable, reviewable, and identical
 * everywhere it is used — including the list endpoint, which is this query
 * with the record filter dropped (§6.3).
 */
export const GRANT_CHECK_SQL = `
WITH custodial AS (
  SELECT 1
  FROM user_roles ur
  JOIN users u ON u.id = ur.user_id
  WHERE ur.user_id = $1
    AND u.status = 'ACTIVE'
    AND ur.role_id IN ('APPROVER', 'CUSTODIAN', 'CONTROLLING_OFFICER')
  LIMIT 1
),
live_grant AS (
  SELECT g.id, g.valid_until, g.max_views, g.view_count
  FROM access_grants g
  JOIN users u ON u.id = g.user_id
  WHERE g.user_id           = $1
    AND g.service_record_id = $2
    AND g.revoked_at IS NULL
    AND now() >= g.valid_from
    AND now() <  g.valid_until
    AND (g.max_views IS NULL OR g.view_count < g.max_views)
    AND u.status = 'ACTIVE'
  ORDER BY g.valid_until DESC
  LIMIT 1
)
SELECT
  EXISTS (SELECT 1 FROM custodial)                 AS is_custodial,
  (SELECT id          FROM live_grant)             AS grant_id,
  (SELECT valid_until FROM live_grant)             AS valid_until,
  (SELECT max_views   FROM live_grant)             AS max_views,
  (SELECT view_count  FROM live_grant)             AS view_count
`;

export type GrantDecision =
  | { allowed: true; via: 'GRANT'; grantId: Uuid; validUntil: Date; viewsLeft: number | null }
  | { allowed: true; via: 'CUSTODIAL_ROLE' }
  | { allowed: false; reason: 'NO_GRANT' };

interface Row {
  is_custodial: boolean;
  grant_id: Uuid | null;
  valid_until: Date | null;
  max_views: number | null;
  view_count: number | null;
}

/**
 * The whole access control of the system. Empty result means: no.
 *
 * A live grant is reported in preference to the custodial role even when the
 * caller holds both, so the audit trail says a record was read under a grant
 * when one existed. Reads that could only have happened by virtue of being
 * Accounts staff are the ones worth being able to filter for.
 */
export async function checkGrant(
  db: Queryable,
  userId: Uuid,
  recordId: Uuid,
): Promise<GrantDecision> {
  const { rows } = await db.query<Row>(GRANT_CHECK_SQL, [userId, recordId]);
  const row = rows[0];
  if (!row) return { allowed: false, reason: 'NO_GRANT' };

  if (row.grant_id && row.valid_until) {
    return {
      allowed: true,
      via: 'GRANT',
      grantId: row.grant_id,
      validUntil: row.valid_until,
      viewsLeft: row.max_views === null ? null : row.max_views - (row.view_count ?? 0),
    };
  }

  if (row.is_custodial) return { allowed: true, via: 'CUSTODIAL_ROLE' };

  return { allowed: false, reason: 'NO_GRANT' };
}

/**
 * Consume one view against a capped grant.
 *
 * The design sketch used SELECT ... FOR UPDATE; a conditional UPDATE gives the
 * same race-freedom in one statement and holds no row lock across the render.
 * Returns false when the cap was reached between the check and here, which is
 * a legitimate outcome under concurrency and must be treated as a denial.
 */
export async function consumeView(db: Queryable, grantId: Uuid): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE access_grants
        SET view_count = view_count + 1
      WHERE id = $1
        AND revoked_at IS NULL
        AND now() >= valid_from
        AND now() <  valid_until
        AND (max_views IS NULL OR view_count < max_views)`,
    [grantId],
  );
  return (rowCount ?? 0) === 1;
}

/**
 * "Which records can I open?" — GRANT_CHECK_SQL with the record filter
 * dropped. One definition, so the badge in search results and the door on the
 * viewer can never disagree (§6.3).
 */
export const READABLE_RECORD_IDS_SQL = `
SELECT g.service_record_id
FROM access_grants g
JOIN users u ON u.id = g.user_id
WHERE g.user_id = $1
  AND g.revoked_at IS NULL
  AND now() >= g.valid_from
  AND now() <  g.valid_until
  AND (g.max_views IS NULL OR g.view_count < g.max_views)
  AND u.status = 'ACTIVE'
`;
