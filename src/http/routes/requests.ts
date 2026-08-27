import { Router } from 'express';
import { z } from 'zod';
import { getPool } from '../../db.ts';
import { withTransaction } from '../../db.ts';
import { createDraft, decide, submit, withdraw } from '../../services/requests.ts';
import { findLiveAuthority } from '../../authz/authorityCheck.ts';
import { appendEvent } from '../../audit/events.ts';
import { requireAuth, requireRole } from '../middleware/auth.ts';
import { wrap } from '../middleware/errors.ts';
import { param, uuidParam } from '../middleware/context.ts';

export const requestRoutes = Router();
requestRoutes.param('id', uuidParam());
requestRoutes.use(requireAuth);

const LIST_SQL = `
SELECT q.id, q.request_no, q.status, q.purpose, q.file_reference,
       q.requested_from, q.requested_to, q.submitted_at, q.created_at,
       u.full_name AS requester_name, u.staff_code AS requester_code,
       d.name AS requester_dept,
       json_agg(json_build_object(
         'id', i.id, 'recordId', r.id, 'ppoNumber', r.ppo_number,
         'employeeName', r.employee_name, 'pageCount', r.page_count,
         'status', i.item_status, 'remarks', i.decision_remarks,
         'decidedAt', i.decided_at
       ) ORDER BY r.employee_name) AS items
FROM access_requests q
JOIN users u       ON u.id = q.requester_id
JOIN departments d ON d.id = q.requester_dept_id
LEFT JOIN access_request_items i ON i.request_id = q.id
LEFT JOIN service_records r      ON r.id = i.service_record_id
WHERE ($1::text = 'mine'  AND q.requester_id = $2)
   OR ($1::text = 'inbox' AND q.status = 'SUBMITTED' AND q.requester_id <> $2)
   OR ($1::text = 'all')
GROUP BY q.id, u.full_name, u.staff_code, d.name
ORDER BY q.submitted_at DESC NULLS FIRST, q.created_at DESC
LIMIT 200`;

requestRoutes.get('/', wrap(async (req, res) => {
  const scope = req.query['scope'] === 'inbox' ? 'inbox'
    : req.query['scope'] === 'all' ? 'all' : 'mine';
  // `inbox` excludes requests the caller raised — separation of duties,
  // enforced server-side and not by hiding a button (§9).
  const { rows } = await getPool().query(LIST_SQL, [scope, req.principal!.id]);
  res.json({ requests: rows });
}));

const draftBody = z.object({ recordIds: z.array(z.string().uuid()).min(1).max(50) });

requestRoutes.post('/', wrap(async (req, res) => {
  const body = draftBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'BAD_REQUEST', message: 'Select at least one record.' });
    return;
  }
  const id = await createDraft(getPool(), {
    requesterId: req.principal!.id,
    requesterDeptId: req.principal!.departmentId,
    recordIds: body.data.recordIds,
  });
  res.status(201).json({ id });
}));

const submitBody = z.object({
  purpose: z.string().trim().min(20, 'Say what the record is needed for — at least 20 characters.'),
  fileReference: z.string().trim().max(120).optional().nullable(),
  requestedFrom: z.coerce.date(),
  requestedTo: z.coerce.date(),
});

const SUBMIT_MESSAGES = {
  NOT_FOUND: 'That request no longer exists.',
  NOT_DRAFT: 'This request has already been submitted.',
  NO_ITEMS: 'Add at least one record before submitting.',
} as const;

requestRoutes.post('/:id/submit', wrap(async (req, res) => {
  const body = submitBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({
      error: 'BAD_REQUEST',
      message: body.error.issues[0]?.message ?? 'Check the fields and try again.',
    });
    return;
  }
  const out = await submit(getPool(), {
    requestId: param(req, 'id'),
    requesterId: req.principal!.id,
    purpose: body.data.purpose,
    fileReference: body.data.fileReference ?? null,
    requestedFrom: body.data.requestedFrom,
    requestedTo: body.data.requestedTo,
  });
  if (!out.ok) {
    const message = out.reason === 'PERIOD_TOO_LONG'
      ? `The longest period that can be requested is ${out.maxDays} days.`
      : SUBMIT_MESSAGES[out.reason];
    res.status(400).json({ error: out.reason, message });
    return;
  }
  res.json({ ok: true });
}));

requestRoutes.post('/:id/withdraw', wrap(async (req, res) => {
  const ok = await withdraw(getPool(), param(req, 'id'), req.principal!.id);
  if (!ok) {
    res.status(400).json({ error: 'NOT_WITHDRAWABLE', message: 'Only a submitted request can be withdrawn.' });
    return;
  }
  res.json({ ok: true });
}));

const decisionBody = z.object({
  decisions: z.array(z.object({
    itemId: z.string().uuid(),
    action: z.enum(['APPROVE', 'REJECT']),
    grantedFrom: z.coerce.date().optional(),
    grantedTo: z.coerce.date().optional(),
    remarks: z.string().trim().max(500).optional().nullable(),
  })).min(1),
});

/**
 * §6.2 runs first, inside decide(), and throws before the body is acted on:
 * an officer holding the approver role but no live authority gets a hard stop
 * whether or not the UI rendered the button.
 */
requestRoutes.post('/:id/decision', requireRole('APPROVER'), wrap(async (req, res) => {
  const body = decisionBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'BAD_REQUEST', message: 'Nothing to decide.' });
    return;
  }
  try {
    const outcomes = await withTransaction((tx) =>
      decide(tx, {
        requestId: param(req, 'id'),
        officerId: req.principal!.id,
        decisions: body.data.decisions,
      }));
    res.json({ outcomes });
  } catch (err) {
    if ((err as { code?: string }).code === 'NO_APPROVAL_AUTHORITY') {
      await appendEvent(getPool(), {
        eventType: 'DECISION_REFUSED_NO_AUTHORITY', outcome: 'DENY',
        actorId: req.principal!.id, requestId: param(req, 'id'),
      });
    }
    throw err;
  }
}));

/** The officer's own authority: shown in the corner of the inbox, because
 *  nobody should discover it has lapsed by clicking approve (§10). */
requestRoutes.get('/my-authority', wrap(async (req, res) => {
  const authority = await findLiveAuthority(getPool(), req.principal!.id);
  res.json({ authority });
}));
