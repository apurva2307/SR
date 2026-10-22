import { useState } from 'react';
import { useAuth } from '../auth';
import { api, ApiError } from '../api';
import { Banner } from '../components/bits';
import { Brand } from '../components/Logo';
import { ThemeSwitch } from '../theme';

export function LoginPage() {
  const { signIn, idleSignedOut } = useAuth();
  const [resetting, setResetting] = useState(false);
  const [staffCode, setStaffCode] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(staffCode.trim(), password, totp.trim() || undefined);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'TOTP_REQUIRED') {
        setNeedsTotp(true);
        setError(null);
      } else {
        setError(err instanceof ApiError ? err.message : 'Sign-in failed.');
      }
    } finally {
      setBusy(false);
    }
  }

  if (resetting) return <ResetForm onBack={() => setResetting(false)} />;

  return (
    <div className="login-wrap">
      <form className="login card" onSubmit={submit}>
        <Brand stacked sub="Accounts Department · Reading room" />

        {!error && idleSignedOut && (
          <Banner kind="warn">You were signed out after a period of inactivity. Sign in again to continue.</Banner>
        )}
        {error && <Banner>{error}</Banner>}

        <div className="field">
          <label htmlFor="staff">Staff code</label>
          <input id="staff" value={staffCode} autoFocus autoComplete="username"
            onChange={(e) => setStaffCode(e.target.value)} />
        </div>

        <div className="field">
          <label htmlFor="pw">Password</label>
          <input id="pw" type="password" value={password} autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)} />
        </div>

        {needsTotp && (
          <div className="field">
            <label htmlFor="totp">Authenticator code</label>
            <input id="totp" value={totp} inputMode="numeric" autoComplete="one-time-code" autoFocus
              onChange={(e) => setTotp(e.target.value)} />
            <p className="hint">Six digits from your authenticator app. Codes change every 30 seconds.</p>
          </div>
        )}

        <button className="primary" type="submit" disabled={busy || !staffCode || !password}
          style={{ width: '100%', justifyContent: 'center' }}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p style={{ marginTop: 14, textAlign: 'center' }}>
          <button type="button" className="ghost small" onClick={() => setResetting(true)}>
            Forgotten your password?
          </button>
        </p>

        <p className="hint" style={{ marginTop: 10 }}>
          Every search and every page you open is recorded against your name.
        </p>
        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'center' }}>
          <ThemeSwitch />
        </div>
      </form>
    </div>
  );
}


/**
 * Redeeming a reset code issued by an administrator. There is no self-service
 * email reset by design: the email account is not a stronger factor than the
 * password it protects, so a person verifies identity and hands over a code.
 */
function ResetForm({ onBack }: { onBack: () => void }) {
  const [staffCode, setStaffCode] = useState('');
  const [code, setCode] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post('/auth/password/reset', {
        staffCode: staffCode.trim(), code: code.trim(), newPassword: next,
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reset the password.');
    } finally { setBusy(false); }
  }

  return (
    <div className="login-wrap">
      <form className="login card" onSubmit={submit}>
        <Brand stacked sub="Reset your password" />

        {error && <Banner>{error}</Banner>}
        {done && (
          <Banner kind="ok">
            Password set. Sign in with it now — any other session on your account has been ended.
          </Banner>
        )}

        {!done && (
          <>
            <p className="hint" style={{ marginBottom: 16 }}>
              Ask an administrator for a reset code. They will verify who you are in person
              first — codes are not sent by email. A code lasts 24 hours and works once.
            </p>

            <div className="field">
              <label htmlFor="rstaff">Staff code</label>
              <input id="rstaff" value={staffCode} autoFocus
                onChange={(e) => setStaffCode(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="rcode">Reset code</label>
              <input id="rcode" className="mono" value={code} onChange={(e) => setCode(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="rnew">New password</label>
              <input id="rnew" type="password" value={next} autoComplete="new-password"
                onChange={(e) => setNext(e.target.value)} />
              {next.length > 0 && next.length < 12 && (
                <p className="hint">{12 - next.length} more characters needed.</p>
              )}
            </div>
            <div className="field">
              <label htmlFor="rconf">Confirm new password</label>
              <input id="rconf" type="password" value={confirm} autoComplete="new-password"
                onChange={(e) => setConfirm(e.target.value)} />
              {confirm.length > 0 && next !== confirm && <p className="hint">These do not match.</p>}
            </div>

            <button className="primary" type="submit"
              disabled={busy || !staffCode || !code || next.length < 12 || next !== confirm}
              style={{ width: '100%', justifyContent: 'center' }}>
              {busy ? 'Setting…' : 'Set new password'}
            </button>
          </>
        )}

        <p style={{ marginTop: 14, textAlign: 'center' }}>
          <button type="button" className="ghost small" onClick={onBack}>← Back to sign in</button>
        </p>
      </form>
    </div>
  );
}
