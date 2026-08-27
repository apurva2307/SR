import { useState } from 'react';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { Banner } from '../components/bits';

/**
 * Changing a password, in the two places it happens: on the profile page by
 * choice, and full-screen at first sign-in because the account was issued with
 * a one-time password and cannot go anywhere else until it is replaced.
 *
 * One component for both, because they are the same operation — the forced
 * variant only changes the wording and adds a way out.
 */
export function PasswordCard({ forced = false }: { forced?: boolean }) {
  const { refresh, signOut } = useAuth();
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
      setCurrent(''); setNext(''); setConfirm('');
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change the password.');
    } finally { setBusy(false); }
  }

  return (
    <form className={forced ? 'card login' : 'card'} onSubmit={submit}>
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
}

/** The full-screen forced variant, shown by the gate before anything else loads. */
export function PasswordPage() {
  return <div className="login-wrap"><PasswordCard forced /></div>;
}
