// §12 — the auditor's view. Sessions first, pages on drill-in, so an 84-page
// read does not bury the log.
import type { Queryable, Uuid } from '../domain/types.ts';

export interface AuditFilter {
  recordId?: Uuid; actorId?: Uuid; eventType?: string;
  outcome?: 'ALLOW' | 'DENY'; from?: Date; to?: Date;
  limit?: number; offset?: number;
}

export async function query(db: Queryable, f: AuditFilter) {
  const { rows } = await db.query(
    `SELECT e.seq, e.occurred_at, e.event_type, e.outcome, e.detail, e.actor_ip,
            e.view_session_id, e.grant_id, e.authority_id, e.request_id,
            u.full_name AS actor_name, u.staff_code AS actor_code,
            u.designation AS actor_designation,
            r.ppo_number, r.employee_name
     FROM access_events e
     LEFT JOIN users u ON u.id = e.actor_id
     LEFT JOIN service_records r ON r.id = e.service_record_id
     WHERE ($1::uuid IS NULL OR e.service_record_id = $1)
       AND ($2::uuid IS NULL OR e.actor_id = $2)
       AND ($3::text IS NULL OR e.event_type = $3)
       AND ($4::text IS NULL OR e.outcome = $4)
       AND ($5::timestamptz IS NULL OR e.occurred_at >= $5)
       AND ($6::timestamptz IS NULL OR e.occurred_at <= $6)
     ORDER BY e.seq DESC
     LIMIT $7 OFFSET $8`,
    [f.recordId ?? null, f.actorId ?? null, f.eventType ?? null, f.outcome ?? null,
     f.from ?? null, f.to ?? null, f.limit ?? 100, f.offset ?? 0],
  );
  return rows;
}

/** Saved view: denials in the last 24 hours (§10). */
export async function recentDenials(db: Queryable) {
  return query(db, { outcome: 'DENY', from: new Date(Date.now() - 86_400_000), limit: 200 });
}

/** Saved view: reads that happened only by virtue of being Accounts staff. */
export async function custodialReads(db: Queryable, days = 7) {
  const { rows } = await db.query(
    `SELECT v.id, v.opened_at, v.closed_at, v.pages_served, v.first_page, v.last_page,
            u.full_name AS actor_name, u.staff_code AS actor_code,
            u.designation AS actor_designation,
            r.ppo_number, r.employee_name
     FROM view_sessions v
     JOIN users u ON u.id = v.user_id
     JOIN service_records r ON r.id = v.service_record_id
     WHERE v.via = 'CUSTODIAL_ROLE' AND v.opened_at > now() - ($1 || ' days')::interval
     ORDER BY v.opened_at DESC LIMIT 200`,
    [String(days)],
  );
  return rows;
}

export async function viewSessions(db: Queryable, f: { recordId?: Uuid; actorId?: Uuid; limit?: number }) {
  const { rows } = await db.query(
    `SELECT v.id, v.opened_at, v.closed_at, v.pages_served, v.first_page, v.last_page, v.via, v.ip,
            u.full_name AS actor_name, u.staff_code AS actor_code,
            u.designation AS actor_designation,
            r.ppo_number, r.employee_name
     FROM view_sessions v
     JOIN users u ON u.id = v.user_id
     JOIN service_records r ON r.id = v.service_record_id
     WHERE ($1::uuid IS NULL OR v.service_record_id = $1)
       AND ($2::uuid IS NULL OR v.user_id = $2)
     ORDER BY v.opened_at DESC LIMIT $3`,
    [f.recordId ?? null, f.actorId ?? null, f.limit ?? 100],
  );
  return rows;
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const cols = Object.keys(rows[0]!);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? ''
      : v instanceof Date ? v.toISOString()
      : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}
