// Correcting a record's employee name or PPO number (migration 016).
//   /api/records/:id/corrections  — the record's history; a custodian corrects
//                                   the name or proposes a PPO number
//   /api/corrections              — the controlling officer's queue and decisions
import { Router, type Response } from 'express';
import { z } from 'zod';
import { getPool, withTransaction } from '../../db.ts';
import {
  correctName, decidePpo, historyFor, listPending, listRecentlyDecided, proposePpo, withdrawPpo,
  type DecideRefusal, type NameRefusal, type ProposeRefusal,
} from '../../services/corrections.ts';
import * as cache from '../../services/render/cache.ts';
import { requireAuth, requireRole } from '../middleware/auth.ts';
import { wrap } from '../middleware/errors.ts';
import { param, uuidParam } from '../middleware/context.ts';

const reasonField = z.string().trim()
  .min(10, 'Give the reason for the correction — at least 10 characters, e.g. the order or document it rests on.')
  .max(500, 'Keep the reason under 500 characters.');

function badRequest(res: Response, err: z.ZodError): void {
  res.status(400).json({
    error: 'BAD_REQUEST', message: err.issues[0]?.message ?? 'Check the fields and try again.',
  });
}

/** Watermarks carry the PPO; nothing rendered under the old value may be served again. */
async function dropRendered(recordId: string): Promise<void> {
  const { rows } = await getPool().query<{ id: string }>(
    `WITH RECURSIVE chain AS (
       SELECT id FROM service_records WHERE id = $1
       UNION ALL
       SELECT r.id FROM service_records r JOIN chain c ON r.superseded_by = c.id
     ) SELECT id FROM chain`, [recordId],
  );
  for (const r of rows) cache.dropRecord(r.id);
}

// ---------------------------------------------------------------------------
// Per record
// ---------------------------------------------------------------------------

export const recordCorrectionRoutes = Router({ mergeParams: true });
recordCorrectionRoutes.use((req, res, next) => uuidParam()(req, res, next, param(req, 'id')));
recordCorrectionRoutes.use(requireAuth);

recordCorrectionRoutes.get('/', requireRole('CUSTODIAN', 'CONTROLLING_OFFICER', 'AUDITOR'),
  wrap(async (req, res) => {
    res.json({ corrections: await historyFor(getPool(), param(req, 'id')) });
  }));

const NAME_MESSAGES: Record<NameRefusal, string> = {
  RECORD_NOT_FOUND: 'No such record.',
  RECORD_NOT_ACTIVE: 'This version has been superseded. Correct the current version instead.',
  EMPTY_NAME: 'Enter the employee name.',
  NO_CHANGE: 'That is already the name on the record.',
};

const nameBody = z.object({
  name: z.string().trim().min(1, 'Enter the employee name.').max(200, 'Keep the name under 200 characters.'),
  reason: reasonField,
});

recordCorrectionRoutes.post('/name', requireRole('CUSTODIAN'), wrap(async (req, res) => {
  const body = nameBody.safeParse(req.body);
  if (!body.success) { badRequest(res, body.error); return; }
  const recordId = param(req, 'id');
  const out = await withTransaction((tx) => correctName(tx, {
    recordId, userId: req.principal!.id, ip: req.clientIp, ...body.data,
  }));
  if (!out.ok) {
    res.status(out.reason === 'RECORD_NOT_FOUND' ? 404 : 400)
      .json({ error: out.reason, message: NAME_MESSAGES[out.reason] });
    return;
  }
  await dropRendered(recordId);
  res.json(out);
}));

const PROPOSE_MESSAGES: Record<ProposeRefusal, string> = {
  RECORD_NOT_FOUND: 'No such record.',
  RECORD_NOT_ACTIVE: 'This version has been superseded. Correct the current version instead.',
  BAD_PPO: 'A PPO number has 6 to 14 digits. Check the number and try again.',
  NO_CHANGE: 'That is already the PPO number on the record.',
  PPO_IN_USE: 'Another record already has this PPO number',
  ALREADY_PENDING: 'A PPO correction for this record is already waiting for a controlling officer. Withdraw it first to propose a different one.',
};

const ppoBody = z.object({
  ppo: z.string().trim().min(1, 'Enter the PPO number.').max(40, 'That is too long for a PPO number.'),
  reason: reasonField,
});

recordCorrectionRoutes.post('/ppo', requireRole('CUSTODIAN'), wrap(async (req, res) => {
  const body = ppoBody.safeParse(req.body);
  if (!body.success) { badRequest(res, body.error); return; }
  const out = await withTransaction((tx) => proposePpo(tx, {
    recordId: param(req, 'id'), userId: req.principal!.id, ip: req.clientIp, ...body.data,
  }));
  if (!out.ok) {
    const message = out.reason === 'PPO_IN_USE'
      ? `${PROPOSE_MESSAGES.PPO_IN_USE} (${out.detail}). If both are the same person, raise it with the controlling officer.`
      : PROPOSE_MESSAGES[out.reason];
    res.status(out.reason === 'RECORD_NOT_FOUND' ? 404 : 400).json({ error: out.reason, message });
    return;
  }
  res.status(201).json(out);
}));

// ---------------------------------------------------------------------------
// The controlling officer's queue
// ---------------------------------------------------------------------------

export const correctionRoutes = Router();
correctionRoutes.param('cid', uuidParam());
correctionRoutes.use(requireAuth);

correctionRoutes.get('/pending', requireRole('CONTROLLING_OFFICER', 'CUSTODIAN', 'AUDITOR'),
  wrap(async (_req, res) => {
    res.json({ corrections: await listPending(getPool()) });
  }));

correctionRoutes.get('/decided', requireRole('CONTROLLING_OFFICER', 'AUDITOR'),
  wrap(async (_req, res) => {
    res.json({ corrections: await listRecentlyDecided(getPool()) });
  }));

const DECIDE_MESSAGES: Record<DecideRefusal, string> = {
  NOT_FOUND: 'No such correction.',
  NOT_PENDING: 'This correction has already been decided or withdrawn.',
  SELF_DECISION: 'You proposed this correction, so another controlling officer must decide it.',
  REMARKS_REQUIRED: 'Say why the correction is rejected.',
  RECORD_NOT_ACTIVE: 'The record has been superseded since this was proposed. Reject it; the custodian can propose it again on the current version.',
  RECORD_CHANGED: 'The PPO number on the record has changed since this was proposed. Reject it and ask for a fresh proposal.',
  PPO_IN_USE: 'Another record now has this PPO number',
};

const decideBody = z.object({
  remarks: z.string().trim().max(500, 'Keep the remarks under 500 characters.').nullable().optional(),
});

function decide(approve: boolean) {
  return wrap(async (req, res) => {
    const body = decideBody.safeParse(req.body ?? {});
    if (!body.success) { badRequest(res, body.error); return; }
    const out = await withTransaction((tx) => decidePpo(tx, {
      correctionId: param(req, 'cid'), userId: req.principal!.id, ip: req.clientIp,
      approve, remarks: body.data.remarks ?? null,
    }));
    if (!out.ok) {
      const message = out.reason === 'PPO_IN_USE'
        ? `${DECIDE_MESSAGES.PPO_IN_USE} (${out.detail}).`
        : DECIDE_MESSAGES[out.reason];
      res.status(out.reason === 'NOT_FOUND' ? 404 : out.reason === 'SELF_DECISION' ? 403 : 400)
        .json({ error: out.reason, message });
      return;
    }
    if (out.status === 'APPLIED') await dropRendered(out.recordId);
    res.json(out);
  });
}

correctionRoutes.post('/:cid/approve', requireRole('CONTROLLING_OFFICER'), decide(true));
correctionRoutes.post('/:cid/reject', requireRole('CONTROLLING_OFFICER'), decide(false));

correctionRoutes.post('/:cid/withdraw', requireRole('CUSTODIAN'), wrap(async (req, res) => {
  const out = await withTransaction((tx) => withdrawPpo(tx, {
    correctionId: param(req, 'cid'), userId: req.principal!.id, ip: req.clientIp,
  }));
  if (!out.ok) {
    const message = out.reason === 'NOT_FOUND' ? 'No such correction.'
      : out.reason === 'NOT_PENDING' ? 'This correction has already been decided.'
      : 'Only the custodian who proposed this correction can withdraw it.';
    res.status(out.reason === 'NOT_FOUND' ? 404 : 400).json({ error: out.reason, message });
    return;
  }
  res.json({ ok: true });
}));
