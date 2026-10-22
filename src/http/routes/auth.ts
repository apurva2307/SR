import { Router } from 'express';
import { z } from 'zod';
import { getPool } from '../../db.ts';
import { config } from '../../config.ts';
import {
  beginTotpEnrolment, changePassword, completeTotpEnrolment, disableOwnTotp,
  login, redeemResetCode, revokeSession,
} from '../../services/auth.ts';
import { appendEvent } from '../../audit/events.ts';
import { idleMinutes } from '../../services/settings.ts';
import { SESSION_COOKIE, requireAuth } from '../middleware/auth.ts';
import { issueCsrf } from '../middleware/csrf.ts';
import { hit } from '../middleware/rateLimit.ts';
import { audit } from '../middleware/context.ts';
import { wrap } from '../middleware/errors.ts';

export const authRoutes = Router();

const loginBody = z.object({
  staffCode: z.string().min(1),
  password: z.string().min(1),
  totp: z.string().optional(),
});

const MESSAGES = {
  BAD_CREDENTIALS: 'Staff code or password is incorrect.',
  LOCKED: 'This account is locked after repeated failed attempts. Try again in 15 minutes.',
  TOTP_REQUIRED: 'Enter the six-digit code from your authenticator app.',
  BAD_TOTP: 'That authenticator code is not valid. Codes change every 30 seconds.',
} as const;

/**
 * Two buckets, not one. Keying the login limiter purely by IP looks right
 * until you remember an intranet department egresses through a single NAT
 * gateway — five attempts per fifteen minutes would then be five attempts for
 * the whole office. So: a tight per-account bucket, which is what actually
 * stops password guessing, and a loose per-IP bucket sized for a large office
 * that still catches a machine spraying credentials across many accounts.
 */
const IP_MULTIPLIER = 20;

authRoutes.post('/login', wrap(async (req, res) => {
    const body = loginBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'Staff code and password are required.' });
      return;
    }

    const perAccount = hit(`login:acct:${body.data.staffCode}`, config.limits.loginPer15Min, 15 * 60_000);
    const perIp = hit(`login:ip:${req.clientIp}`, config.limits.loginPer15Min * IP_MULTIPLIER, 15 * 60_000);
    if (!perAccount.ok || !perIp.ok) {
      const retryAfter = Math.max(perAccount.retryAfter, perIp.retryAfter);
      res.status(429).set('Retry-After', String(retryAfter)).json({
        error: 'RATE_LIMITED',
        message: `Too many sign-in attempts. Try again in ${retryAfter} seconds.`,
      });
      return;
    }
    const result = await login(getPool(), body.data.staffCode, body.data.password,
      body.data.totp, audit(req));

    if (!result.ok) {
      const status = result.reason === 'TOTP_REQUIRED' ? 200 : 401;
      res.status(status).json({ error: result.reason, message: MESSAGES[result.reason] });
      return;
    }

    res.cookie(SESSION_COOKIE, result.token, {
      httpOnly: true, sameSite: 'strict', secure: config.session.cookieSecure,
      path: '/', expires: result.expiresAt,
    });
    issueCsrf(res);
    res.json({ principal: result.principal });
  }));

authRoutes.post('/logout', wrap(async (req, res) => {
  if (req.sessionToken) {
    await revokeSession(getPool(), req.sessionToken);
    await appendEvent(getPool(), { eventType: 'LOGOUT', actorId: req.principal?.id ?? null });
  }
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
}));

authRoutes.get('/me', wrap(async (req, res) => {
  // Issued before the auth check, and to anonymous callers too: the login POST
  // is itself state-changing, so without a token here nobody could ever sign
  // in. Handing the token to an anonymous visitor is safe — double-submit
  // works because a cross-site attacker cannot READ the cookie to echo it.
  issueCsrf(res);
  if (!req.principal) {
    res.status(401).json({ error: 'NOT_AUTHENTICATED', message: 'Sign in to continue.' });
    return;
  }
  // The browser runs its own inactivity timer from this, so a user who walks
  // away is signed out on screen even if no request is ever made again.
  res.json({
    principal: req.principal,
    idleMinutes: await idleMinutes(getPool(), config.session.idleMinutes),
  });
}));

const passwordBody = z.object({
  current: z.string().min(1),
  next: z.string().min(12, 'Use at least 12 characters.'),
});

authRoutes.post('/password', requireAuth, wrap(async (req, res) => {
  const body = passwordBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({
      error: 'BAD_REQUEST',
      message: body.error.issues[0]?.message ?? 'Check the fields and try again.',
    });
    return;
  }
  const ok = await changePassword(getPool(), req.principal!.id, body.data.current, body.data.next);
  if (!ok) {
    res.status(400).json({ error: 'BAD_CURRENT', message: 'Your current password is incorrect.' });
    return;
  }
  res.json({ ok: true });
}));

/**
 * A user's own name, email and designation.
 *
 * Deliberately not here: staff code, department and roles. Those say where a
 * person sits and what they may do, and letting an account rewrite them would
 * make every other control decorative. They stay with an administrator.
 *
 * The audit log is unaffected by a rename — events name a user id, and the
 * before/after is recorded below so an old row stays explainable.
 */
const profileBody = z.object({
  fullName: z.string().trim().min(2, 'Give your full name.').max(120),
  // Explicit null clears it; an empty string is the same intent typed into a
  // form, and reading it as the literal '' would break the UNIQUE index the
  // moment a second person did it.
  email: z.string().trim().email('That is not a valid email address.').max(160)
    .nullable().optional()
    .or(z.literal('').transform(() => null)),
  designation: z.string().trim().max(120).nullable().optional()
    .or(z.literal('').transform(() => null)),
});

authRoutes.put('/profile', requireAuth, wrap(async (req, res) => {
  const body = profileBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({
      error: 'BAD_REQUEST',
      message: body.error.issues[0]?.message ?? 'Check the fields and try again.',
    });
    return;
  }

  const me = req.principal!;
  const email = body.data.email ?? null;
  const designation = body.data.designation ?? null;

  if (me.fullName === body.data.fullName && me.email === email && me.designation === designation) {
    res.json({ ok: true, changed: false });
    return;
  }

  try {
    await getPool().query(
      `UPDATE users SET full_name = $2, email = $3, designation = $4, updated_at = now()
        WHERE id = $1`,
      [me.id, body.data.fullName, email, designation],
    );
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      res.status(409).json({
        error: 'DUPLICATE_EMAIL',
        message: `${email} is already on another account.`,
      });
      return;
    }
    throw err;
  }

  await appendEvent(getPool(), {
    eventType: 'USER_PROFILE_UPDATED',
    actorId: me.id,
    // Named, not spread: audit() returns `ip`, and an AuditEvent wants
    // `actorIp`. Spreading type-checks and silently logs no address.
    actorIp: audit(req).ip ?? null,
    userAgent: audit(req).userAgent,
    detail: {
      before: { fullName: me.fullName, email: me.email, designation: me.designation },
      after: { fullName: body.data.fullName, email, designation },
    },
  });

  res.json({ ok: true, changed: true });
}));


// ---------------------------------------------------------------------------
// Two-factor enrolment, done by the person holding the phone.
// ---------------------------------------------------------------------------

/** Returns the QR and the typed-out secret. Never returns an existing secret. */
authRoutes.post('/totp/setup', requireAuth, wrap(async (req, res) => {
  if (req.principal!.totpEnabled) {
    res.status(409).json({
      error: 'ALREADY_ENABLED',
      message: 'Two-factor is already set up. Turn it off first if you want to re-enrol.',
    });
    return;
  }
  res.json(await beginTotpEnrolment(getPool(), req.principal!.id));
}));

const totpCode = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the six digits shown in your app.') });

authRoutes.post('/totp/enable', requireAuth, wrap(async (req, res) => {
  const body = totpCode.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'BAD_CODE', message: body.error.issues[0]!.message });
    return;
  }
  const out = await completeTotpEnrolment(getPool(), req.principal!.id, body.data.code);
  if (out === 'NO_PENDING') {
    res.status(409).json({ error: out, message: 'Start the setup again — no enrolment is in progress.' });
    return;
  }
  if (out === 'BAD_CODE') {
    res.status(400).json({
      error: out,
      message: 'That code did not match. Codes change every 30 seconds — check your device clock is correct and try the current one.',
    });
    return;
  }
  res.json({ ok: true });
}));

const disableBody = z.object({
  password: z.string().min(1),
  code: z.string().trim().regex(/^\d{6}$/),
});

const DISABLE_MESSAGES = {
  REQUIRED: 'Two-factor is required on your account by an administrator, so it cannot be switched off here.',
  NOT_ENABLED: 'Two-factor is not currently set up on your account.',
  BAD_PASSWORD: 'That password is not correct.',
  BAD_CODE: 'That authenticator code is not valid.',
} as const;

authRoutes.post('/totp/disable', requireAuth, wrap(async (req, res) => {
  const body = disableBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'BAD_REQUEST', message: 'Enter your password and a current code.' });
    return;
  }
  const out = await disableOwnTotp(getPool(), req.principal!.id, body.data.password, body.data.code);
  if (out !== 'OK') {
    res.status(out === 'REQUIRED' ? 403 : 400).json({ error: out, message: DISABLE_MESSAGES[out] });
    return;
  }
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Redeeming an administrator-issued reset code. Unauthenticated by necessity:
// the whole point is that the user cannot sign in.
// ---------------------------------------------------------------------------

const resetBody = z.object({
  staffCode: z.string().trim().min(1),
  code: z.string().trim().min(6),
  newPassword: z.string().min(12, 'Use at least 12 characters.'),
});

const RESET_MESSAGES = {
  NO_USER: 'That staff code and reset code do not match.',
  BAD_CODE: 'That staff code and reset code do not match.',
  EXPIRED: 'That reset code has expired. Ask an administrator for a new one.',
} as const;

authRoutes.post('/password/reset',
  wrap(async (req, res) => {
    const body = resetBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: body.error.issues[0]?.message ?? 'Check the fields and try again.',
      });
      return;
    }
    // Same bucket as login: a reset code is a credential, and guessing one
    // should be as slow as guessing a password.
    const limited = hit(`reset:${body.data.staffCode}`, config.limits.loginPer15Min, 15 * 60_000);
    if (!limited.ok) {
      res.status(429).set('Retry-After', String(limited.retryAfter)).json({
        error: 'RATE_LIMITED',
        message: `Too many attempts. Try again in ${limited.retryAfter} seconds.`,
      });
      return;
    }

    const out = await redeemResetCode(getPool(), body.data, { ip: req.clientIp });
    if (out !== 'OK') {
      res.status(400).json({ error: out, message: RESET_MESSAGES[out] });
      return;
    }
    res.json({ ok: true });
  }));
