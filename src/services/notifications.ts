// Written in the same transaction as the event that caused them; a separate
// worker does the sending (§5.3).
import type { Queryable, Uuid } from '../domain/types.ts';

export type NotificationKind =
  | 'REQUEST_AWAITING_DECISION' | 'REQUEST_DECIDED'
  | 'GRANT_EXPIRING' | 'GRANT_REVOKED'
  | 'AUTHORITY_EXPIRING' | 'AUTHORITY_ISSUED' | 'AUTHORITY_EXTENDED' | 'AUTHORITY_WITHDRAWN'
  | 'QUARANTINE_WAITING' | 'INTEGRITY_ALERT';

export async function notify(
  db: Queryable, userId: Uuid, kind: NotificationKind, payload: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    'INSERT INTO notifications (user_id, kind, payload) VALUES ($1,$2,$3)',
    [userId, kind, JSON.stringify(payload)],
  );
}

export async function listFor(db: Queryable, userId: Uuid, unreadOnly = false) {
  const { rows } = await db.query(
    `SELECT id, kind, payload, created_at, read_at FROM notifications
      WHERE user_id = $1 ${unreadOnly ? 'AND read_at IS NULL' : ''}
      ORDER BY created_at DESC LIMIT 100`,
    [userId],
  );
  return rows;
}

export async function markRead(db: Queryable, userId: Uuid, ids: Uuid[]): Promise<void> {
  await db.query(
    'UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2) AND read_at IS NULL',
    [userId, ids],
  );
}
