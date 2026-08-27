import { Router } from 'express';
import { getPool } from '../../db.ts';
import { custodialReads, query, recentDenials, toCsv, viewSessions } from '../../services/audit.ts';
import { verifyChain } from '../../audit/events.ts';
import { requireAuth, requireRole } from '../middleware/auth.ts';
import { wrap } from '../middleware/errors.ts';

export const auditRoutes = Router();
auditRoutes.use(requireAuth, requireRole('AUDITOR', 'ADMIN'));

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

auditRoutes.get('/', wrap(async (req, res) => {
  const f = {
    ...(str(req.query['recordId']) ? { recordId: str(req.query['recordId'])! } : {}),
    ...(str(req.query['actorId']) ? { actorId: str(req.query['actorId'])! } : {}),
    ...(str(req.query['eventType']) ? { eventType: str(req.query['eventType'])! } : {}),
    ...(req.query['outcome'] === 'DENY' || req.query['outcome'] === 'ALLOW'
      ? { outcome: req.query['outcome'] as 'DENY' | 'ALLOW' } : {}),
    ...(str(req.query['from']) ? { from: new Date(str(req.query['from'])!) } : {}),
    ...(str(req.query['to']) ? { to: new Date(str(req.query['to'])!) } : {}),
    limit: Math.min(500, Number(req.query['limit'] ?? 100)),
    offset: Number(req.query['offset'] ?? 0),
  };
  const rows = await query(getPool(), f);
  if (req.query['format'] === 'csv') {
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="audit.csv"',
    }).send(toCsv(rows as Record<string, unknown>[]));
    return;
  }
  res.json({ events: rows });
}));

auditRoutes.get('/denials', wrap(async (_req, res) => {
  res.json({ events: await recentDenials(getPool()) });
}));

auditRoutes.get('/custodial-reads', wrap(async (_req, res) => {
  res.json({ sessions: await custodialReads(getPool()) });
}));

auditRoutes.get('/view-sessions', wrap(async (req, res) => {
  res.json({ sessions: await viewSessions(getPool(), {
    ...(str(req.query['recordId']) ? { recordId: str(req.query['recordId'])! } : {}),
    ...(str(req.query['actorId']) ? { actorId: str(req.query['actorId'])! } : {}),
  }) });
}));

/** Returns the first seq where the chain breaks, or null when intact (§12). */
auditRoutes.get('/verify-chain', wrap(async (_req, res) => {
  const brokenAt = await verifyChain(getPool());
  res.json({ intact: brokenAt === null, brokenAt });
}));
