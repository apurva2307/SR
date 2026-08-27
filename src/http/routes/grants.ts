import { Router } from 'express';
import { z } from 'zod';
import { getPool } from '../../db.ts';
import { issueEmergency, myGrants, register, revoke } from '../../services/grants.ts';
import * as cache from '../../services/render/cache.ts';
import { requireAuth, requireRole } from '../middleware/auth.ts';
import { wrap } from '../middleware/errors.ts';
import { param, uuidParam } from '../middleware/context.ts';

export const grantRoutes = Router();
grantRoutes.param('id', uuidParam());
grantRoutes.use(requireAuth);

grantRoutes.get('/', wrap(async (req, res) => {
  if (req.query['scope'] === 'all') {
    if (!req.principal!.roles.some((r) => ['APPROVER', 'CUSTODIAN', 'CONTROLLING_OFFICER', 'AUDITOR'].includes(r))) {
      res.status(403).json({ error: 'FORBIDDEN', message: 'The access register is for Accounts and auditors.' });
      return;
    }
    res.json({ grants: await register(getPool(), {
      ...(typeof req.query['authorityId'] === 'string' ? { authorityId: req.query['authorityId'] } : {}),
    }) });
    return;
  }
  res.json({ grants: await myGrants(getPool(), req.principal!.id) });
}));

const emergencyBody = z.object({
  toUserId: z.string().uuid(),
  recordId: z.string().uuid(),
  justification: z.string().trim().min(20, 'An emergency grant needs a written justification.'),
  days: z.number().int().min(1).max(7).optional(),
});

grantRoutes.post('/', requireRole('CUSTODIAN', 'APPROVER'), wrap(async (req, res) => {
  const body = emergencyBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({
      error: 'BAD_REQUEST',
      message: body.error.issues[0]?.message ?? 'Check the fields and try again.',
    });
    return;
  }
  const id = await issueEmergency(getPool(), {
    officerId: req.principal!.id,
    toUserId: body.data.toUserId,
    recordId: body.data.recordId,
    justification: body.data.justification,
    ...(body.data.days === undefined ? {} : { days: body.data.days }),
  });
  res.status(201).json({ id });
}));

const revokeBody = z.object({ reason: z.string().trim().min(5, 'Say why this is being revoked.') });

grantRoutes.post('/:id/revoke', requireRole('APPROVER', 'CUSTODIAN'), wrap(async (req, res) => {
  const body = revokeBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'BAD_REQUEST', message: body.error.issues[0]!.message });
    return;
  }
  const ok = await revoke(getPool(), param(req, 'id'), req.principal!.id, body.data.reason);
  if (!ok) {
    res.status(404).json({ error: 'NOT_FOUND', message: 'That grant is already revoked or does not exist.' });
    return;
  }
  // A revoked grant must not keep serving from the render cache.
  cache.dropGrant(param(req, 'id'));
  res.json({ ok: true });
}));
