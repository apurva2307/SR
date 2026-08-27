// Ingestion, quarantine, and integrity — the custodian's console (§8, §10).
import { Router } from 'express';
import { z } from 'zod';
import { getPool } from '../../db.ts';
import { runIngestion, resolveQuarantine } from '../../services/ingest/runner.ts';
import { verifySlice } from '../../services/ingest/integrity.ts';
import { requireAuth, requireRole } from '../middleware/auth.ts';
import { wrap } from '../middleware/errors.ts';
import { param, uuidParam } from '../middleware/context.ts';

export const custodyRoutes = Router();
custodyRoutes.param('id', uuidParam());
custodyRoutes.use(requireAuth, requireRole('CUSTODIAN'));

custodyRoutes.post('/ingestion/scan', wrap(async (req, res) => {
  const summary = await runIngestion(getPool(), { triggeredBy: req.principal!.id });
  res.json(summary);
}));

custodyRoutes.get('/ingestion/runs', wrap(async (_req, res) => {
  const { rows } = await getPool().query(
    `SELECT r.*, u.full_name AS triggered_by_name
     FROM ingestion_runs r LEFT JOIN users u ON u.id = r.triggered_by
     ORDER BY r.started_at DESC LIMIT 50`,
  );
  res.json({ runs: rows });
}));

custodyRoutes.get('/quarantine', wrap(async (req, res) => {
  const open = req.query['resolved'] !== 'true';
  const { rows } = await getPool().query(
    `SELECT q.*, u.full_name AS resolved_by_name
     FROM quarantine_items q LEFT JOIN users u ON u.id = q.resolved_by
     WHERE ($1::boolean IS FALSE OR q.resolved_at IS NULL)
     ORDER BY q.created_at DESC LIMIT 200`,
    [open],
  );
  res.json({ items: rows });
}));

const resolveBody = z.object({
  resolution: z.enum(['INDEXED', 'SUPERSEDED', 'LINKED', 'IGNORED']),
  ppo: z.string().trim().optional(),
  name: z.string().trim().optional(),
});

custodyRoutes.post('/quarantine/:id/resolve', wrap(async (req, res) => {
  const body = resolveBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'BAD_REQUEST', message: 'Choose how to resolve this file.' });
    return;
  }
  if ((body.data.resolution === 'INDEXED' || body.data.resolution === 'SUPERSEDED')
      && (!body.data.ppo || !body.data.name)) {
    res.status(400).json({
      error: 'BAD_REQUEST',
      message: 'Indexing needs both a PPO number and an employee name — neither is guessed.',
    });
    return;
  }
  const ok = await resolveQuarantine(getPool(), {
    id: param(req, 'id'),
    custodianId: req.principal!.id,
    resolution: body.data.resolution,
    ...(body.data.ppo === undefined ? {} : { ppo: body.data.ppo }),
    ...(body.data.name === undefined ? {} : { name: body.data.name }),
  });
  if (!ok) {
    res.status(400).json({ error: 'NOT_RESOLVABLE', message: 'That item is already resolved.' });
    return;
  }
  res.json({ ok: true });
}));

custodyRoutes.post('/integrity/verify', wrap(async (_req, res) => {
  res.json(await verifySlice(getPool()));
}));
