// §11 — bulk metadata harvesting is the realistic insider abuse, and the
// search limit is the control that addresses it. Page limits sit above normal
// reading and well below a script walking a 200-page record.
//
// In-memory, so a multi-process deployment needs a shared store. Documented
// rather than hidden: with one process this is exact, with four it is 4x loose.
import type { NextFunction, Request, Response } from 'express';

interface Bucket { count: number; resetAt: number }
const buckets = new Map<string, Bucket>();

export function hit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  b.count++;
  if (b.count > limit) return { ok: false, retryAfter: Math.ceil((b.resetAt - now) / 1000) };
  return { ok: true, retryAfter: 0 };
}

export function rateLimit(name: string, limit: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const who = req.principal?.id ?? req.clientIp;
    const { ok, retryAfter } = hit(`${name}:${who}`, limit, windowMs);
    if (!ok) {
      res.status(429)
        .set('Retry-After', String(retryAfter))
        .json({ error: 'RATE_LIMITED', message: `Too many requests. Try again in ${retryAfter}s.` });
      return;
    }
    next();
  };
}

export function reset(): void { buckets.clear(); }
