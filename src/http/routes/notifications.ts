import { Router } from 'express';
import { z } from 'zod';
import { getPool } from '../../db.ts';
import { listFor, markRead } from '../../services/notifications.ts';
import { requireAuth } from '../middleware/auth.ts';
import { wrap } from '../middleware/errors.ts';

export const notificationRoutes = Router();
notificationRoutes.use(requireAuth);

notificationRoutes.get('/', wrap(async (req, res) => {
  res.json({ notifications: await listFor(getPool(), req.principal!.id, req.query['unread'] === 'true') });
}));

notificationRoutes.post('/read', wrap(async (req, res) => {
  const body = z.object({ ids: z.array(z.string().uuid()) }).safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: 'BAD_REQUEST', message: 'Nothing to mark.' }); return; }
  await markRead(getPool(), req.principal!.id, body.data.ids);
  res.json({ ok: true });
}));
