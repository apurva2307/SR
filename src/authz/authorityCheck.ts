// §6.2 — may this person RELEASE a record to somebody else?
//
// Reading is not releasing. This runs before any decision endpoint does
// anything, and failing it is a hard stop regardless of role, seniority, or
// how obviously reasonable the request looks.

import type { Queryable, Uuid } from '../domain/types.ts';
import { noApprovalAuthority, outOfAuthorityScope, selfApproval } from '../domain/errors.ts';

/**
 * Runs on POST /requests/:id/decision and POST /grants — everything that OPENS
 * a door. Revocation deliberately does not run it (§6.2.1): authorisation
 * gates additions of privilege, never removals. An authority expires, and that
 * is exactly when its holder most wants to pull back what they released.
 */
export const AUTHORITY_CHECK_SQL = `
SELECT a.id, a.scope_dept_ids, a.effective_to
FROM   approval_authorities a
JOIN   user_roles ur ON ur.user_id = a.user_id
                    AND ur.role_id = 'APPROVER'
JOIN   users u       ON u.id = a.user_id
WHERE  a.user_id = $1
  AND  a.status  = 'ACTIVE'
  AND  u.status  = 'ACTIVE'
  AND  now() >= a.effective_from
  AND  now() <  a.effective_to
ORDER BY a.effective_to DESC
LIMIT 1
`;

export interface LiveAuthority {
  id: Uuid;
  /** null = may release to any user department. */
  scopeDeptIds: Uuid[] | null;
  effectiveTo: Date;
}

interface Row {
  id: Uuid;
  scope_dept_ids: Uuid[] | null;
  effective_to: Date;
}

/** Returns the officer's live authority, or null. No exception, no opinion. */
export async function findLiveAuthority(
  db: Queryable,
  officerId: Uuid,
): Promise<LiveAuthority | null> {
  const { rows } = await db.query<Row>(AUTHORITY_CHECK_SQL, [officerId]);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    scopeDeptIds: row.scope_dept_ids,
    effectiveTo: row.effective_to,
  };
}

export interface ReleaseContext {
  officerId: Uuid;
  /** Who the record is being released TO. */
  requesterId: Uuid;
  requesterDeptId: Uuid;
}

/**
 * The gate every decision endpoint calls first. Throws AuthzError, so a
 * caller that forgets to check the return value still fails closed.
 *
 * The returned authority id belongs in access_grants.granted_under_authority_id,
 * which is NOT NULL: every open door traces to a named officer and a date
 * range during which they held the power to open it.
 */
export async function assertMayRelease(
  db: Queryable,
  ctx: ReleaseContext,
): Promise<LiveAuthority> {
  // Separation of duties comes first: it is the cheapest check and the one
  // whose failure is least ambiguous.
  if (ctx.officerId === ctx.requesterId) throw selfApproval();

  const authority = await findLiveAuthority(db, ctx.officerId);
  if (!authority) throw noApprovalAuthority();

  // Scope is by requesting department, never by record — records carry no
  // departmental label, so scoping the other way round is unmaintainable.
  if (authority.scopeDeptIds !== null && !authority.scopeDeptIds.includes(ctx.requesterDeptId)) {
    throw outOfAuthorityScope();
  }

  return authority;
}

/**
 * Grants opened under an authority stay live after it is withdrawn — the
 * releases were validly made. This is what the register uses to let a
 * controlling officer review, and revoke, them in the same sitting (§6.2).
 */
export const GRANTS_UNDER_AUTHORITY_SQL = `
SELECT g.id, g.user_id, g.service_record_id, g.valid_from, g.valid_until, g.revoked_at
FROM   access_grants g
WHERE  g.granted_under_authority_id = $1
  AND  g.revoked_at IS NULL
  AND  now() < g.valid_until
ORDER BY g.valid_until
`;
