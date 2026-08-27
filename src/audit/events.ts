// §12 — the audit log. Deny is recorded as loudly as allow: a user probing
// record ids they were never granted produces a run of DENY rows, which is
// exactly the pattern worth alerting on and is invisible if only successes
// are written.

import type { Queryable, Uuid } from '../domain/types.ts';

export type EventType =
  | 'LOGIN_OK' | 'LOGIN_FAIL' | 'LOCKOUT' | 'LOGOUT' | 'SESSION_REVOKED' | 'PASSWORD_CHANGED'
  | 'SEARCH' | 'RECORD_METADATA_VIEWED'
  | 'REQUEST_SUBMITTED' | 'REQUEST_WITHDRAWN' | 'ITEM_APPROVED' | 'ITEM_REJECTED'
  | 'GRANT_CREATED' | 'GRANT_REVOKED' | 'GRANT_EXPIRED' | 'EMERGENCY_GRANT_ISSUED'
  | 'AUTHORITY_ISSUED' | 'AUTHORITY_SUSPENDED' | 'AUTHORITY_RESUMED' | 'AUTHORITY_REVOKED'
  | 'AUTHORITY_EXPIRED' | 'DECISION_REFUSED_NO_AUTHORITY'
  | 'VIEW_SESSION_OPENED' | 'PAGE_SERVED' | 'PAGE_DENIED' | 'VIEW_SESSION_CLOSED'
  | 'THUMBNAIL_SERVED'
  | 'INGEST_RUN' | 'RECORD_INDEXED' | 'RECORD_SUPERSEDED' | 'QUARANTINE_RESOLVED'
  | 'METADATA_CORRECTED' | 'INTEGRITY_ALERT'
  | 'USER_CREATED' | 'USER_SUSPENDED' | 'USER_REACTIVATED' | 'ROLE_GRANTED' | 'ROLE_REVOKED' | 'SETTING_CHANGED'
  | 'DEPARTMENT_CREATED' | 'DEPARTMENT_UPDATED' | 'DEPARTMENT_DEACTIVATED'
  | 'DEPARTMENT_ACTIVATED' | 'DEPARTMENT_DELETED'
  | 'TOTP_REQUIRED' | 'TOTP_REQUIREMENT_LIFTED' | 'TOTP_ENROLLED' | 'TOTP_DISABLED' | 'TOTP_RESET'
  | 'PASSWORD_RESET_ISSUED' | 'PASSWORD_RESET_REDEEMED' | 'PASSWORD_RESET_FAILED';

export interface AuditEvent {
  eventType: EventType;
  outcome?: 'ALLOW' | 'DENY';
  actorId?: Uuid | null;
  actorIp?: string | null;
  userAgent?: string | null;
  serviceRecordId?: Uuid | null;
  requestId?: Uuid | null;
  grantId?: Uuid | null;
  authorityId?: Uuid | null;
  /** Groups the PAGE_SERVED rows of one sitting so the log stays readable (§12.1). */
  viewSessionId?: Uuid | null;
  detail?: Record<string, unknown>;
}

const INSERT_SQL = `
INSERT INTO access_events (
  event_type, outcome, actor_id, actor_ip, user_agent,
  service_record_id, request_id, grant_id, authority_id, view_session_id, detail
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
RETURNING seq`;

/**
 * Append one event. prev_hash and row_hash are set by a BEFORE INSERT trigger,
 * not here — a hash chain computed in application code is a hash chain that
 * stops being computed the first time someone writes a script.
 *
 * Pass the same transaction the caller is using where one exists: an event
 * that survives a rolled-back grant is a lie in the opposite direction.
 */
export async function appendEvent(db: Queryable, e: AuditEvent): Promise<number> {
  const { rows } = await db.query<{ seq: string }>(INSERT_SQL, [
    e.eventType,
    e.outcome ?? 'ALLOW',
    e.actorId ?? null,
    e.actorIp ?? null,
    e.userAgent ?? null,
    e.serviceRecordId ?? null,
    e.requestId ?? null,
    e.grantId ?? null,
    e.authorityId ?? null,
    e.viewSessionId ?? null,
    JSON.stringify(e.detail ?? {}),
  ]);
  return Number(rows[0]!.seq);
}

/** Returns the first seq where the chain breaks, or null when intact (§12). */
export async function verifyChain(db: Queryable, fromSeq = 0): Promise<number | null> {
  const { rows } = await db.query<{ verify_audit_chain: string | null }>(
    'SELECT verify_audit_chain($1)',
    [fromSeq],
  );
  const v = rows[0]?.verify_audit_chain ?? null;
  return v === null ? null : Number(v);
}
