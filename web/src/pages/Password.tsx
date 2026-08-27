import { useState } from 'react';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { Banner } from '../components/bits';
import { Link } from 'react-router-dom';
import { TotpDisable } from './Totp';

export function PasswordPage({ forced = false }: { forced?: boolean }) {
  const { refresh, signOut, principal } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const mismatch = confirm.length > 0 && next !== confirm;
  const tooShort = next.length > 0 && next.length < 12;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post('/auth/password', { current, next });
      setDone(true);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change the password.');
    } finally { setBusy(false); }
  }

  const form = (
    <form className="card login" onSubmit={submit}>
      <h2 style={{ marginBottom: 6 }}>{forced ? 'Set a new password' : 'Change your password'}</h2>
      <p className="hint" style={{ marginBottom: 16 }}>
        {forced
          ? 'Your account was issued with a one-time password. Choose your own before continuing.'
          : 'At least 12 characters. Your current password is required either way.'}
      </p>

      {error && <Banner>{error}</Banner>}
      {done && <Banner kind="ok">Password changed.</Banner>}

      <div className="field">
        <label htmlFor="cur">Current password</label>
        <input id="cur" type="password" autoComplete="current-password"
          value={current} onChange={(e) => setCurrent(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="nw">New password</label>
        <input id="nw" type="password" autoComplete="new-password"
          value={next} onChange={(e) => setNext(e.target.value)} />
        {tooShort && <p className="hint">{12 - next.length} more characters needed.</p>}
      </div>
      <div className="field">
        <label htmlFor="cf">Confirm new password</label>
        <input id="cf" type="password" autoComplete="new-password"
          value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        {mismatch && <p className="hint">These do not match.</p>}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button className="primary" type="submit"
          disabled={busy || !current || next.length < 12 || next !== confirm}>
          {busy ? 'Saving…' : 'Change password'}
        </button>
        {forced && <button type="button" className="ghost" onClick={() => void signOut()}>Sign out</button>}
      </div>
    </form>
  );

  if (forced) return <div className="login-wrap">{form}</div>;

  return (
    <div style={{ maxWidth: 560 }}>
      {form}
      <div className="card" style={{ maxWidth: 420, marginTop: 14 }}>
        <h3 style={{ marginBottom: 6 }}>Two-factor authentication</h3>
        {principal?.totpEnabled ? (
          <p className="hint" style={{ marginBottom: 0 }}>
            On. You are asked for a six-digit code at each sign-in.
          </p>
        ) : (
          <>
            <p className="hint">
              Off. A six-digit code from your phone, on top of your password.
            </p>
            <Link className="btn" to="/two-factor">Set up two-factor</Link>
          </>
        )}
      </div>
      {principal?.totpEnabled && <TotpDisable onChanged={() => void refresh()} />}
    </div>
  );
}
