// Double-submit token on every state-changing request, on top of
// SameSite=Strict cookies (§11).
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../../config.ts';

export const CSRF_COOKIE = 'sr_csrf';
const HEADER = 'x-csrf-token';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export function issueCsrf(res: Response): string {
  const token = randomBytes(24).toString('base64url');
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false, // the client must read it to echo it back
    sameSite: 'strict',
    secure: config.session.cookieSecure,
    path: '/',
  });
  return token;
}

export function csrf(req: Request, res: Response, next: NextFunction): void {
  if (SAFE.has(req.method)) { next(); return; }
  const cookie = req.cookies?.[CSRF_COOKIE];
  const header = req.headers[HEADER];
  const a = Buffer.from(String(cookie ?? ''));
  const b = Buffer.from(String(header ?? ''));
  if (a.length === 0 || a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(403).json({
      error: 'CSRF_FAILED',
      message: 'Your session token did not match. Reload the page and try again.',
    });
    return;
  }
  next();
}
