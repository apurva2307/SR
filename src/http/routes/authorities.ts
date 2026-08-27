import { Router } from 'express';
import { z } from 'zod';
import { getPool } from '../../db.ts';
import { issue, list, liveGrantsUnder, transition } from '../../services/authorities.ts';
import { requireAuth, requireRole } from '../middleware/auth.ts';
import { wrap } from '../middleware/errors.ts';
import { param, uuidParam } from '../middleware/context.ts';

export const authorityRoutes = Router();
authorityRoutes.param('id', uuidParam());
authorityRoutes.use(requireAuth);

authorityRoutes.get('/', requireRole('CONTROLLING_OFFICER', 'AUDITOR', 'APPROVER'),
  wrap(async (req, res) => {
    res.json({ authorities: await list(getPool(), req.query['hideRevoked'] === 'true') });
  }));

authorityRoutes.get('/:id/grants', requireRole('CONTROLLING_OFFICER', 'AUDITOR'),
  wrap(async (req, res) => {
    res.json({ grants: await liveGrantsUnder(getPool(), param(req, 'id')) });
  }));

const issueBody = z.object({
  toUserId: z.string().uuid(),
  orderReference: z.string().trim().min(3, 'Give the office order number this authority rests on.'),
  effectiveFrom: z.coerce.date(),
  effectiveTo: z.coerce.date(),
  scopeDeptIds: z.array(z.string().uuid()).nullable().optional(),
  remarks: z.string().trim().max(500).nullable().optional(),
});

const ISSUE_MESSAGES = {
  SELF_ISSUE: 'You cannot issue an authority to yourself. Another controlling officer must do it.',
  NOT_AN_APPROVER: 'That officer does not hold the approver role, so an authority would do nothing.',
  BAD_PERIOD: 'The end date must fall after the start date.',
} as const;

authorityRoutes.post('/', requireRole('CONTROLLING_OFFICER'), wrap(async (req, res) => {
  const body = issueBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({
      error: 'BAD_REQUEST',
      message: body.error.issues[0]?.message ?? 'Check the fields and try again.',
    });
    return;
  }
  const out = await issue(getPool(), {
    issuerId: req.principal!.id,
    toUserId: body.data.toUserId,
    orderReference: body.data.orderReference,
    effectiveFrom: body.data.effectiveFrom,
    effectiveTo: body.data.effectiveTo,
    scopeDeptIds: body.data.scopeDeptIds ?? null,
    remarks: body.data.remarks ?? null,
  });
  if (!out.ok) {
    res.status(400).json({ error: out.reason, message: ISSUE_MESSAGES[out.reason] });
    return;
  }
  res.status(201).json({ id: out.id });
}));

const transitionBody = z.object({ reason: z.string().trim().max(500).optional() });

for (const [path, kind] of [['suspend', 'SUSPEND'], ['resume', 'RESUME'], ['revoke', 'REVOKE']] as const) {
  authorityRoutes.post(`/:id/${path}`, requireRole('CONTROLLING_OFFICER'), wrap(async (req, res) => {
    const body = transitionBody.safeParse(req.body ?? {});
    const ok = await transition(getPool(), param(req, 'id'), req.principal!.id, kind,
      body.success ? body.data.reason : undefined);
    if (!ok) {
      res.status(400).json({
        error: 'BAD_TRANSITION',
        message: `This authority cannot be ${path}d from its current state.`,
      });
      return;
    }
    res.json({ ok: true });
  }));
}
