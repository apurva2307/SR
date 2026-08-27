// §3.1 — one request, several records, decided item by item.
import type { Queryable, Uuid } from '../domain/types.ts';
import { appendEvent } from '../audit/events.ts';
import { assertMayRelease } from '../authz/authorityCheck.ts';
import { requestNotFound, requestNotOpen } from '../domain/errors.ts';
import { getSetting } from './settings.ts';
import { notify } from './notifications.ts';

export interface DraftInput {
  requesterId: Uuid;
  requesterDeptId: Uuid;
  recordIds: Uuid[];
}

async function nextRequestNo(db: Queryable): Promise<string> {
  const year = new Date().getUTCFullYear();
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*) + 1 AS n FROM access_requests WHERE request_no LIKE $1`, [`REQ-${year}-%`],
  );
  return `REQ-${year}-${String(rows[0]!.n).padStart(4, '0')}`;
}

export async function createDraft(db: Queryable, input: DraftInput): Promise<Uuid> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO access_requests (request_no, requester_id, requester_dept_id, status)
     VALUES ($1,$2,$3,'DRAFT') RETURNING id`,
    [await nextRequestNo(db), input.requesterId, input.requesterDeptId],
  );
  const id = rows[0]!.id;
  for (const recordId of new Set(input.recordIds)) {
    await db.query(
      `INSERT INTO access_request_items (request_id, service_record_id) VALUES ($1,$2)
       ON CONFLICT DO NOTHING`, [id, recordId],
    );
  }
  return id;
}

export interface SubmitInput {
  requestId: Uuid;
  requesterId: Uuid;
  purpose: string;
  fileReference?: string | null;
  requestedFrom: Date;
  requestedTo: Date;
}

export type SubmitResult =
  | { ok: true }
  | { ok: false; reason: 'NOT_FOUND' | 'NOT_DRAFT' | 'NO_ITEMS' | 'PERIOD_TOO_LONG'; maxDays?: number };

export async function submit(db: Queryable, input: SubmitInput): Promise<SubmitResult> {
  const maxDays = await getSetting(db, 'grant.max_days', 180);
  const days = (input.requestedTo.getTime() - input.requestedFrom.getTime()) / 86_400_000;
  if (days > maxDays) return { ok: false, reason: 'PERIOD_TOO_LONG', maxDays };

  const { rows } = await db.query<{ status: string; items: string }>(
    `SELECT q.status, (SELECT count(*) FROM access_request_items i WHERE i.request_id = q.id) AS items
     FROM access_requests q WHERE q.id = $1 AND q.requester_id = $2`,
    [input.requestId, input.requesterId],
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: 'NOT_FOUND' };
  if (row.status !== 'DRAFT') return { ok: false, reason: 'NOT_DRAFT' };
  if (Number(row.items) === 0) return { ok: false, reason: 'NO_ITEMS' };

  await db.query(
    `UPDATE access_requests
        SET purpose = $2, file_reference = $3, requested_from = $4, requested_to = $5,
            status = 'SUBMITTED', submitted_at = now()
      WHERE id = $1`,
    [input.requestId, input.purpose, input.fileReference ?? null, input.requestedFrom, input.requestedTo],
  );
  await appendEvent(db, {
    eventType: 'REQUEST_SUBMITTED', actorId: input.requesterId, requestId: input.requestId,
    detail: { purpose: input.purpose, items: Number(row.items) },
  });

  // Everyone who could actually act on it: the approver role alone is not enough.
  const { rows: approvers } = await db.query<{ user_id: string }>(
    `SELECT DISTINCT a.user_id FROM approval_authorities a
     JOIN user_roles ur ON ur.user_id = a.user_id AND ur.role_id = 'APPROVER'
     WHERE a.status = 'ACTIVE' AND now() >= a.effective_from AND now() < a.effective_to`,
  );
  for (const a of approvers) {
    await notify(db, a.user_id, 'REQUEST_AWAITING_DECISION', { requestId: input.requestId });
  }
  return { ok: true };
}

export async function withdraw(db: Queryable, requestId: Uuid, requesterId: Uuid): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE access_requests SET status = 'WITHDRAWN'
      WHERE id = $1 AND requester_id = $2 AND status = 'SUBMITTED'`,
    [requestId, requesterId],
  );
  if ((rowCount ?? 0) === 0) return false;
  await appendEvent(db, { eventType: 'REQUEST_WITHDRAWN', actorId: requesterId, requestId });
  return true;
}

export interface ItemDecision {
  itemId: Uuid;
  action: 'APPROVE' | 'REJECT';
  grantedFrom?: Date | undefined;
  grantedTo?: Date | undefined;
  remarks?: string | null | undefined;
}

export interface DecisionOutcome {
  itemId: Uuid;
  action: 'APPROVE' | 'REJECT';
  grantId?: Uuid;
}

/**
 * Decide a request. §6.2 runs first and throws before the body is read: an
 * officer holding the approver role but no live authority gets a hard stop.
 */
export async function decide(
  db: Queryable,
  args: { requestId: Uuid; officerId: Uuid; decisions: ItemDecision[] },
): Promise<DecisionOutcome[]> {
  const { rows } = await db.query<{ requester_id: string; requester_dept_id: string; status: string }>(
    'SELECT requester_id, requester_dept_id, status FROM access_requests WHERE id = $1',
    [args.requestId],
  );
  const req = rows[0];
  // Typed so the HTTP layer answers 404/409 rather than a blanket 500.
  if (!req) throw requestNotFound();
  if (req.status !== 'SUBMITTED') throw requestNotOpen();

  const authority = await assertMayRelease(db, {
    officerId: args.officerId,
    requesterId: req.requester_id,
    requesterDeptId: req.requester_dept_id,
  });

  const out: DecisionOutcome[] = [];
  for (const d of args.decisions) {
    const { rows: items } = await db.query<{ service_record_id: string }>(
      `UPDATE access_request_items
          SET item_status = $3, decided_by = $4, decided_at = now(), decision_remarks = $5
        WHERE id = $1 AND request_id = $2 AND item_status = 'PENDING'
        RETURNING service_record_id`,
      [d.itemId, args.requestId, d.action === 'APPROVE' ? 'APPROVED' : 'REJECTED',
       args.officerId, d.remarks ?? null],
    );
    const item = items[0];
    if (!item) continue;

    if (d.action === 'REJECT') {
      await appendEvent(db, {
        eventType: 'ITEM_REJECTED', actorId: args.officerId, requestId: args.requestId,
        serviceRecordId: item.service_record_id, authorityId: authority.id,
        detail: { remarks: d.remarks ?? null },
      });
      out.push({ itemId: d.itemId, action: 'REJECT' });
      continue;
    }

    const from = d.grantedFrom ?? new Date();
    const to = d.grantedTo ?? new Date(from.getTime() + (await getSetting(db, 'grant.default_days', 15)) * 86_400_000);

    const { rows: grants } = await db.query<{ id: string }>(
      `INSERT INTO access_grants
         (request_item_id, user_id, service_record_id, valid_from, valid_until,
          granted_by, granted_under_authority_id, origin)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'REQUEST') RETURNING id`,
      [d.itemId, req.requester_id, item.service_record_id, from, to, args.officerId, authority.id],
    );
    const grantId = grants[0]!.id;

    await appendEvent(db, {
      eventType: 'ITEM_APPROVED', actorId: args.officerId, requestId: args.requestId,
      serviceRecordId: item.service_record_id, grantId, authorityId: authority.id,
      detail: { validFrom: from.toISOString(), validUntil: to.toISOString() },
    });
    await appendEvent(db, {
      eventType: 'GRANT_CREATED', actorId: args.officerId, grantId,
      serviceRecordId: item.service_record_id, authorityId: authority.id,
      detail: { orderReference: authority.orderReference, releasedTo: req.requester_id },
    });
    out.push({ itemId: d.itemId, action: 'APPROVE', grantId });
  }

  await db.query(
    `UPDATE access_requests SET status = 'DECIDED'
      WHERE id = $1 AND NOT EXISTS (
        SELECT 1 FROM access_request_items WHERE request_id = $1 AND item_status = 'PENDING')`,
    [args.requestId],
  );
  await notify(db, req.requester_id, 'REQUEST_DECIDED', { requestId: args.requestId });
  return out;
}
