// Ingestion, quarantine, and integrity — the custodian's console (§8, §10).
import { Router } from 'express';
import { z } from 'zod';
import { getPool } from '../../db.ts';
import { runIngestion, resolveQuarantine } from '../../services/ingest/runner.ts';
import { verifyAdditionsSlice, verifySlice } from '../../services/ingest/integrity.ts';
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
    `SELECT q.*, u.full_name AS resolved_by_name,
            -- Pages added to the record this file would supersede: the
            -- custodian must say whether they carry over.
            (SELECT count(*)::int FROM record_additions a
              WHERE a.service_record_id = (q.detail->>'existingRecordId')::uuid
                AND a.status = 'ACTIVE') AS prior_additions
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
  carryAdditions: z.boolean().optional(),
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
  if (body.data.resolution === 'SUPERSEDED' && body.data.carryAdditions === undefined) {
    const { rows } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM quarantine_items q
         JOIN record_additions a ON a.service_record_id = (q.detail->>'existingRecordId')::uuid
        WHERE q.id = $1 AND a.status = 'ACTIVE'`, [param(req, 'id')],
    );
    if ((rows[0]?.n ?? 0) > 0) {
      res.status(400).json({
        error: 'CHOOSE_ADDITIONS',
        message: 'The earlier version has added pages. Say whether they carry over to the new scan.',
      });
      return;
    }
  }
  const ok = await resolveQuarantine(getPool(), {
    id: param(req, 'id'),
    custodianId: req.principal!.id,
    resolution: body.data.resolution,
    ...(body.data.ppo === undefined ? {} : { ppo: body.data.ppo }),
    ...(body.data.name === undefined ? {} : { name: body.data.name }),
    ...(body.data.carryAdditions === undefined ? {} : { carryAdditions: body.data.carryAdditions }),
  });
  if (!ok) {
    res.status(400).json({ error: 'NOT_RESOLVABLE', message: 'That item is already resolved.' });
    return;
  }
  res.json({ ok: true });
}));

custodyRoutes.post('/integrity/verify', wrap(async (_req, res) => {
  const originals = await verifySlice(getPool());
  const additions = await verifyAdditionsSlice(getPool());
  res.json({
    checked: originals.checked + additions.checked,
    findings: [...originals.findings, ...additions.findings],
  });
}));
