import type { NextFunction, Request, Response } from 'express';
import type { Principal } from '../../services/auth.ts';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      principal?: Principal;
      sessionToken?: string;
      clientIp: string;
    }
  }
}

/**
 * Node reports IPv4 connections on a dual-stack socket as "::ffff:10.0.4.21".
 * That string ends up burned into every watermark and written to every audit
 * row, so normalise it once here rather than leaving operators to decode it.
 */
function normaliseIp(raw: string | undefined): string {
  if (!raw) return 'unknown';
  const v = raw.trim();
  return v.startsWith('::ffff:') ? v.slice(7) : v;
}

export function context(req: Request, _res: Response, next: NextFunction): void {
  const fwd = req.headers['x-forwarded-for'];
  const forwarded = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0];
  req.clientIp = normaliseIp(forwarded ?? req.socket.remoteAddress ?? undefined);
  next();
}

export const audit = (req: Request) => ({
  ip: req.clientIp,
  userAgent: String(req.headers['user-agent'] ?? '').slice(0, 400),
});

/**
 * Express 5 types route params as `string | string[]` because a route may
 * carry a wildcard. Ours never do, so narrow once here rather than asserting
 * at forty call sites.
 */
export function param(req: Request, name: string): string {
  const v = (req.params as Record<string, string | string[] | undefined>)[name];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Rejects a malformed :id before it reaches Postgres. Without this, a probe
 * like `/records/<uuid>.pdf` reaches the query, throws on the invalid uuid
 * cast, and answers 500 — which both leaks that the id shape was interesting
 * and turns a scan into a pile of error logs. 404 is the honest answer.
 */
export function uuidParam(name = 'id') {
  return (req: Request, res: Response, next: NextFunction, value: unknown): void => {
    if (!UUID.test(String(value))) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'No such record.' });
      return;
    }
    next();
  };
}
