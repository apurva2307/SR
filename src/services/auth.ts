// §11 — passwords, sessions, lockout, TOTP.
import { createHash, randomBytes, randomUUID, timingSafeEqual, createHmac } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import type { Queryable, Uuid } from '../domain/types.ts';
import { config } from '../config.ts';
import { appendEvent } from '../audit/events.ts';
import { idleMinutes } from './settings.ts';

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MINUTES = 15;

export const hashPassword = (plain: string): Promise<string> => argonHash(plain);

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try { return await argonVerify(hash, plain); } catch { return false; }
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export interface Principal {
  id: Uuid;
  staffCode: string;
  fullName: string;
  departmentId: Uuid;
  departmentKind: 'ACCOUNTS' | 'USER_DEPT';
  departmentName: string;
  email: string | null;
  designation: string | null;
  roles: string[];
  mustChangePassword: boolean;
  totpEnabled: boolean;
  /** An administrator made it mandatory, so the holder cannot turn it off. */
  totpRequired: boolean;
  /** Required by an administrator but not yet enrolled — the user must finish it. */
  mustEnrolTotp: boolean;
}

const PRINCIPAL_SQL = `
SELECT u.id, u.staff_code, u.full_name, u.email, u.designation, u.department_id,
       u.must_change_password,
       u.totp_enabled, u.totp_required, d.kind AS department_kind, d.name AS department_name,
       coalesce(array_agg(ur.role_id) FILTER (WHERE ur.role_id IS NOT NULL), '{}') AS roles
FROM users u
JOIN departments d ON d.id = u.department_id
LEFT JOIN user_roles ur ON ur.user_id = u.id
WHERE u.id = $1 AND u.status = 'ACTIVE'
GROUP BY u.id, d.kind, d.name`;

interface PrincipalRow {
  id: string; staff_code: string; full_name: string; department_id: string;
  email: string | null; designation: string | null;
  must_change_password: boolean; totp_enabled: boolean; totp_required: boolean;
  department_kind: 'ACCOUNTS' | 'USER_DEPT'; department_name: string; roles: string[];
}

const toPrincipal = (r: PrincipalRow): Principal => ({
  id: r.id, staffCode: r.staff_code, fullName: r.full_name,
  departmentId: r.department_id, departmentKind: r.department_kind,
  departmentName: r.department_name, roles: r.roles,
  email: r.email, designation: r.designation,
  mustChangePassword: r.must_change_password, totpEnabled: r.totp_enabled,
  totpRequired: r.totp_required,
  mustEnrolTotp: r.totp_required && !r.totp_enabled,
});

export async function loadPrincipal(db: Queryable, userId: Uuid): Promise<Principal | null> {
  const { rows } = await db.query<PrincipalRow>(PRINCIPAL_SQL, [userId]);
  return rows[0] ? toPrincipal(rows[0]) : null;
}

export type LoginResult =
  | { ok: true; principal: Principal; token: string; expiresAt: Date }
  | { ok: false; reason: 'BAD_CREDENTIALS' | 'LOCKED' | 'TOTP_REQUIRED' | 'BAD_TOTP' };

interface LoginRow {
  id: string; password_hash: string; failed_attempts: number;
  locked_until: Date | null; totp_secret: string | null; totp_enabled: boolean;
}

export async function login(
  db: Queryable,
  staffCode: string,
  password: string,
  totp: string | undefined,
  ctx: { ip?: string; userAgent?: string },
): Promise<LoginResult> {
  const { rows } = await db.query<LoginRow>(
    `SELECT id, password_hash, failed_attempts, locked_until, totp_secret, totp_enabled
     FROM users WHERE staff_code = $1 AND status = 'ACTIVE'`,
    [staffCode],
  );
  const row = rows[0];

  // Same work either way, so a missing account is not distinguishable by timing.
  const okPassword = row
    ? await verifyPassword(row.password_hash, password)
    : await verifyPassword('$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$dummy', password);

  if (!row) {
    await appendEvent(db, {
      eventType: 'LOGIN_FAIL', outcome: 'DENY', actorIp: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null, detail: { staffCode, reason: 'NO_SUCH_USER' },
    });
    return { ok: false, reason: 'BAD_CREDENTIALS' };
  }

  if (row.locked_until && row.locked_until > new Date()) {
    await appendEvent(db, {
      eventType: 'LOGIN_FAIL', outcome: 'DENY', actorId: row.id,
      actorIp: ctx.ip ?? null, detail: { reason: 'LOCKED' },
    });
    return { ok: false, reason: 'LOCKED' };
  }

  if (!okPassword) {
    const attempts = row.failed_attempts + 1;
    const lock = attempts >= LOCKOUT_THRESHOLD;
    await db.query(
      `UPDATE users SET failed_attempts = $2,
              locked_until = CASE WHEN $3 THEN now() + ($4 || ' minutes')::interval ELSE locked_until END
       WHERE id = $1`,
      [row.id, lock ? 0 : attempts, lock, String(LOCKOUT_MINUTES)],
    );
    await appendEvent(db, {
      eventType: lock ? 'LOCKOUT' : 'LOGIN_FAIL', outcome: 'DENY',
      actorId: row.id, actorIp: ctx.ip ?? null, detail: { attempts },
    });
    return { ok: false, reason: lock ? 'LOCKED' : 'BAD_CREDENTIALS' };
  }

  if (row.totp_enabled && row.totp_secret) {
    if (!totp) return { ok: false, reason: 'TOTP_REQUIRED' };
    if (!verifyTotp(row.totp_secret, totp)) {
      await appendEvent(db, {
        eventType: 'LOGIN_FAIL', outcome: 'DENY', actorId: row.id,
        actorIp: ctx.ip ?? null, detail: { reason: 'BAD_TOTP' },
      });
      return { ok: false, reason: 'BAD_TOTP' };
    }
  }

  await db.query(
    `UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`,
    [row.id],
  );

  const { token, expiresAt } = await createSession(db, row.id, ctx);
  const principal = await loadPrincipal(db, row.id);
  await appendEvent(db, {
    eventType: 'LOGIN_OK', actorId: row.id, actorIp: ctx.ip ?? null,
    userAgent: ctx.userAgent ?? null,
  });
  return { ok: true, principal: principal!, token, expiresAt };
}

export async function createSession(
  db: Queryable, userId: Uuid, ctx: { ip?: string; userAgent?: string }, familyId = randomUUID(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.session.absoluteHours * 3_600_000);
  await db.query(
    `INSERT INTO sessions (user_id, refresh_token_hash, family_id, expires_at, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [userId, sha256(token), familyId, expiresAt, ctx.ip ?? null, ctx.userAgent ?? null],
  );
  return { token, expiresAt };
}

export interface ResolvedSession { sessionId: Uuid; userId: Uuid; familyId: Uuid }

/**
 * Resolves a session token and slides the idle window. Returns null for
 * anything expired, revoked, or idle past the limit — the caller cannot tell
 * which, and does not need to.
 */
export async function resolveSession(db: Queryable, token: string): Promise<ResolvedSession | null> {
  const { rows } = await db.query<{ id: string; user_id: string; family_id: string }>(
    `UPDATE sessions SET last_seen_at = now()
     WHERE refresh_token_hash = $1
       AND revoked_at IS NULL
       AND expires_at > now()
       AND last_seen_at > now() - ($2 || ' minutes')::interval
     RETURNING id, user_id, family_id`,
    [sha256(token), String(await idleMinutes(db, config.session.idleMinutes))],
  );
  const r = rows[0];
  return r ? { sessionId: r.id, userId: r.user_id, familyId: r.family_id } : null;
}

/** Reuse of a spent token kills the whole family (§11). */
export async function revokeSession(db: Queryable, token: string): Promise<void> {
  await db.query(
    `UPDATE sessions SET revoked_at = now() WHERE refresh_token_hash = $1 AND revoked_at IS NULL`,
    [sha256(token)],
  );
}

export async function revokeFamily(db: Queryable, familyId: Uuid): Promise<void> {
  await db.query(
    `UPDATE sessions SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`,
    [familyId],
  );
}

export async function changePassword(
  db: Queryable, userId: Uuid, current: string, next: string,
): Promise<boolean> {
  const { rows } = await db.query<{ password_hash: string }>(
    'SELECT password_hash FROM users WHERE id = $1', [userId],
  );
  // Required even when must_change_password is set (§9).
  if (!rows[0] || !(await verifyPassword(rows[0].password_hash, current))) return false;
  await db.query(
    `UPDATE users SET password_hash = $2, must_change_password = false, updated_at = now() WHERE id = $1`,
    [userId, await hashPassword(next)],
  );
  await appendEvent(db, { eventType: 'PASSWORD_CHANGED', actorId: userId });
  return true;
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238, SHA-1, 6 digits, 30s). Hand-rolled: it is thirty lines and
// avoids a dependency in the authentication path.
// ---------------------------------------------------------------------------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateTotpSecret(): string {
  const bytes = randomBytes(20);
  let bits = '', out = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function base32Decode(secret: string): Buffer {
  let bits = '';
  for (const ch of secret.toUpperCase().replace(/=+$/, '')) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totpAt(secret: string, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const code = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16)
             | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(code % 1_000_000).padStart(6, '0');
}

/** One step of drift either way, compared in constant time. */
export function verifyTotp(secret: string, code: string, now = Date.now()): boolean {
  const counter = Math.floor(now / 30_000);
  const given = Buffer.from(code.trim());
  for (const c of [counter - 1, counter, counter + 1]) {
    const expected = Buffer.from(totpAt(secret, c));
    if (expected.length === given.length && timingSafeEqual(expected, given)) return true;
  }
  return false;
}


// ---------------------------------------------------------------------------
// Two-factor enrolment (§11).
//
// The administrator REQUIRES 2FA; the user ENROLS. A secret is only promoted
// to `totp_secret` once the user has typed a code it produced, so a
// half-finished enrolment can never lock anyone out.
// ---------------------------------------------------------------------------

export interface TotpSetup {
  secret: string;
  /** Grouped in fours, for anyone typing it by hand. */
  formattedSecret: string;
  otpauth: string;
  qrSvg: string;
}

export async function beginTotpEnrolment(
  db: Queryable, userId: Uuid, issuer = 'Service Records',
): Promise<TotpSetup> {
  const { rows } = await db.query<{ staff_code: string; totp_enabled: boolean }>(
    'SELECT staff_code, totp_enabled FROM users WHERE id = $1', [userId],
  );
  const user = rows[0];
  if (!user) throw new Error('No such user');

  // A fresh secret every time setup is opened: an abandoned enrolment must not
  // leave a usable secret lying in the database.
  const secret = generateTotpSecret();
  await db.query('UPDATE users SET totp_pending_secret = $2 WHERE id = $1', [userId, secret]);

  const label = encodeURIComponent(`${issuer}:${user.staff_code}`);
  const otpauth =
    `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;

  // Rendered server-side so the client needs no QR library and the page stays
  // within `script-src 'self'`.
  const { toString: qrToString } = await import('qrcode');
  const qrSvg = await qrToString(otpauth, { type: 'svg', margin: 1, width: 220 });

  return { secret, formattedSecret: secret.match(/.{1,4}/g)?.join(' ') ?? secret, otpauth, qrSvg };
}

export type EnrolResult = 'OK' | 'NO_PENDING' | 'BAD_CODE';

export async function completeTotpEnrolment(
  db: Queryable, userId: Uuid, code: string,
): Promise<EnrolResult> {
  const { rows } = await db.query<{ totp_pending_secret: string | null }>(
    'SELECT totp_pending_secret FROM users WHERE id = $1', [userId],
  );
  const pending = rows[0]?.totp_pending_secret;
  if (!pending) return 'NO_PENDING';
  if (!verifyTotp(pending, code)) return 'BAD_CODE';

  await db.query(
    `UPDATE users SET totp_secret = totp_pending_secret, totp_pending_secret = NULL,
            totp_enabled = true WHERE id = $1`,
    [userId],
  );
  await appendEvent(db, { eventType: 'TOTP_ENROLLED', actorId: userId });
  return 'OK';
}

export type DisableResult = 'OK' | 'REQUIRED' | 'NOT_ENABLED' | 'BAD_PASSWORD' | 'BAD_CODE';

/**
 * A user turning off their own second factor. Needs both the password and a
 * current code: knowing one of them is exactly the situation 2FA exists for.
 */
export async function disableOwnTotp(
  db: Queryable, userId: Uuid, password: string, code: string,
): Promise<DisableResult> {
  const { rows } = await db.query<{
    password_hash: string; totp_secret: string | null;
    totp_enabled: boolean; totp_required: boolean;
  }>(
    `SELECT password_hash, totp_secret, totp_enabled, totp_required FROM users WHERE id = $1`,
    [userId],
  );
  const u = rows[0];
  if (!u || !u.totp_enabled || !u.totp_secret) return 'NOT_ENABLED';
  // An administrator required it; the holder does not get to opt out.
  if (u.totp_required) return 'REQUIRED';
  if (!(await verifyPassword(u.password_hash, password))) return 'BAD_PASSWORD';
  if (!verifyTotp(u.totp_secret, code)) return 'BAD_CODE';

  await db.query(
    `UPDATE users SET totp_secret = NULL, totp_pending_secret = NULL, totp_enabled = false
     WHERE id = $1`, [userId],
  );
  await appendEvent(db, { eventType: 'TOTP_DISABLED', actorId: userId });
  return 'OK';
}

// ---------------------------------------------------------------------------
// Password reset (§11). Offline by design: a custodian verifies identity, an
// administrator issues a single-use code, and the user redeems it here. No
// email-based self-service, because the email account is not a stronger factor
// than the password it protects.
// ---------------------------------------------------------------------------

export type RedeemResult = 'OK' | 'BAD_CODE' | 'EXPIRED' | 'NO_USER';

export async function redeemResetCode(
  db: Queryable,
  args: { staffCode: string; code: string; newPassword: string },
  ctx: { ip?: string } = {},
): Promise<RedeemResult> {
  const { rows: users } = await db.query<{ id: string }>(
    `SELECT id FROM users WHERE staff_code = $1 AND status = 'ACTIVE'`, [args.staffCode],
  );
  const user = users[0];
  if (!user) {
    await appendEvent(db, {
      eventType: 'PASSWORD_RESET_FAILED', outcome: 'DENY', actorIp: ctx.ip ?? null,
      detail: { staffCode: args.staffCode, reason: 'NO_USER' },
    });
    return 'NO_USER';
  }

  const hash = createHash('sha256').update(args.code.trim()).digest('hex');
  const { rows } = await db.query<{ id: string; expires_at: Date }>(
    `SELECT id, expires_at FROM password_reset_codes
      WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
    [user.id, hash],
  );
  const row = rows[0];
  if (!row) {
    await appendEvent(db, {
      eventType: 'PASSWORD_RESET_FAILED', outcome: 'DENY', actorId: user.id,
      actorIp: ctx.ip ?? null, detail: { reason: 'BAD_CODE' },
    });
    return 'BAD_CODE';
  }
  if (row.expires_at <= new Date()) {
    await appendEvent(db, {
      eventType: 'PASSWORD_RESET_FAILED', outcome: 'DENY', actorId: user.id,
      actorIp: ctx.ip ?? null, detail: { reason: 'EXPIRED' },
    });
    return 'EXPIRED';
  }

  await db.query('UPDATE password_reset_codes SET used_at = now() WHERE id = $1', [row.id]);
  await db.query(
    `UPDATE users SET password_hash = $2, must_change_password = false,
            failed_attempts = 0, locked_until = NULL, updated_at = now()
     WHERE id = $1`,
    [user.id, await hashPassword(args.newPassword)],
  );
  // Anyone already signed in as this account loses that session: a reset is
  // what you do when you suspect the old credential is compromised.
  await db.query(
    `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [user.id],
  );
  await appendEvent(db, {
    eventType: 'PASSWORD_RESET_REDEEMED', actorId: user.id, actorIp: ctx.ip ?? null,
  });
  return 'OK';
}
