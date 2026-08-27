import type { NextFunction, Request, Response } from 'express';
import { getPool } from '../../db.ts';
import { loadPrincipal, resolveSession } from '../../services/auth.ts';
import { CUSTODIAL_ROLES } from '../../domain/types.ts';

export const SESSION_COOKIE = 'sr_session';

/** Resolves the session if there is one. Never rejects — that is requireAuth's job. */
export async function attachPrincipal(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token === 'string' && token.length > 0) {
    const session = await resolveSession(getPool(), token);
    if (session) {
      const principal = await loadPrincipal(getPool(), session.userId);
      if (principal) {
        req.principal = principal;
        req.sessionToken = token;
      }
    }
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.principal) {
    res.status(401).json({ error: 'NOT_AUTHENTICATED', message: 'Sign in to continue.' });
    return;
  }
  // A forced password change blocks everything except changing the password.
  //
  // originalUrl, not path: inside a router mounted at /api/auth, req.path is
  // '/password' — so matching on '/auth/password' silently blocked the one
  // endpoint that clears the flag, and every admin-created account was locked
  // out on first login with no way forward.
  const requestPath = req.originalUrl.split('?')[0] ?? '';
  if (req.principal.mustChangePassword && !requestPath.endsWith('/auth/password')) {
    res.status(403).json({
      error: 'PASSWORD_CHANGE_REQUIRED',
      message: 'Set a new password before using the system.',
    });
    return;
  }

  // Enforced here, not only by the client router: an obligation that lives in
  // the React routes is an obligation anyone can skip with curl.
  if (req.principal.mustEnrolTotp && !requestPath.includes('/auth/totp/')) {
    res.status(403).json({
      error: 'TOTP_ENROLMENT_REQUIRED',
      message: 'Set up two-factor authentication before using the system.',
    });
    return;
  }
  next();
}

export const hasRole = (req: Request, ...roles: string[]): boolean =>
  !!req.principal && roles.some((r) => req.principal!.roles.includes(r));

/** Reads any record by virtue of being Accounts staff (§6.1). */
export const isCustodial = (req: Request): boolean => hasRole(req, ...CUSTODIAL_ROLES);

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!hasRole(req, ...roles)) {
      res.status(403).json({
        error: 'FORBIDDEN',
        message: `This needs one of: ${roles.join(', ')}.`,
      });
      return;
    }
    next();
  };
}
