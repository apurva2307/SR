import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { Banner, Spinner } from '../components/bits';

interface Setup { secret: string; formattedSecret: string; otpauth: string; qrSvg: string }

/**
 * Enrolment belongs to the person holding the phone. The secret is generated
 * when this screen opens and is only activated once the user has typed a code
 * it produced, so an abandoned setup cannot lock anyone out.
 */
export function TotpPage({ forced = false }: { forced?: boolean }) {
  const { refresh, signOut, principal } = useAuth();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const begin = useCallback(async () => {
    setLoadError(null);
    try {
      setSetup(await api.post<Setup>('/auth/totp/setup'));
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : 'Could not start setup.');
    }
  }, []);

  useEffect(() => { void begin(); }, [begin]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post('/auth/totp/enable', { code: code.trim() });
      setDone(true);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not turn on two-factor.');
      setCode('');
    } finally { setBusy(false); }
  }

  if (done && !forced) return <Banner kind="ok">Two-factor authentication is on.</Banner>;

  const body = (
    <div className="card" style={{ maxWidth: 560 }}>
      <h2 style={{ marginBottom: 6 }}>Set up two-factor authentication</h2>
      <p className="hint" style={{ marginBottom: 18 }}>
        {forced
          ? 'Your account releases or oversees service records, so it needs a second factor before you can continue.'
          : 'A six-digit code from your phone, in addition to your password.'}
      </p>

      {loadError && <Banner>{loadError}</Banner>}
      {error && <Banner>{error}</Banner>}
      {done && <Banner kind="ok">Two-factor is on. You will be asked for a code at each sign-in.</Banner>}

      {!setup ? <Spinner label="Preparing your enrolment…" /> : (
        <>
          <ol style={{ paddingLeft: 20, margin: '0 0 18px', fontSize: '0.9rem', lineHeight: 1.7 }}>
            <li>
              Install an authenticator app if you do not have one — Google Authenticator,
              Microsoft Authenticator and Authy all work.
            </li>
            <li>Scan this code with it:</li>
          </ol>

          <div style={{
            display: 'flex', justifyContent: 'center', padding: 14, marginBottom: 16,
            background: '#fff', borderRadius: 8, border: '1px solid var(--line)',
          }}>
            {/* Rendered on the server, so the client needs no QR library. */}
            <div style={{ width: 220, height: 220 }} dangerouslySetInnerHTML={{ __html: setup.qrSvg }} />
          </div>

          <details style={{ marginBottom: 18 }}>
            <summary style={{ cursor: 'pointer', fontSize: '0.85rem' }}>
              Cannot scan it? Type this in instead
            </summary>
            <p className="mono" style={{
              marginTop: 10, padding: '10px 12px', background: 'var(--sunk)',
              borderRadius: 6, wordBreak: 'break-all', fontSize: '0.9rem', letterSpacing: '0.06em',
            }}>
              {setup.formattedSecret}
            </p>
            <p className="hint">
              Account name <strong>{principal?.staffCode}</strong>, type “time-based”, 6 digits, 30 seconds.
            </p>
          </details>

          <form onSubmit={submit}>
            <div className="field">
              <label htmlFor="totpcode">3. Enter the six-digit code your app now shows</label>
              <input id="totpcode" value={code} inputMode="numeric" autoComplete="one-time-code"
                maxLength={6} className="mono" style={{ maxWidth: 160, letterSpacing: '0.3em' }}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
              <p className="hint">
                Codes change every 30 seconds. If it keeps failing, check your phone's clock is set automatically.
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="primary" type="submit" disabled={busy || code.length !== 6 || done}>
                {busy ? 'Checking…' : 'Turn on two-factor'}
              </button>
              <button type="button" onClick={() => void begin()} disabled={busy}>Start again</button>
              {forced && (
                <button type="button" className="ghost" onClick={() => void signOut()}>Sign out</button>
              )}
            </div>
          </form>
        </>
      )}
    </div>
  );

  return forced ? <div className="login-wrap">{body}</div> : body;
}

/** Turning it off, for users an administrator has not made it mandatory for. */
export function TotpDisable({ onChanged }: { onChanged: () => void }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="card" style={{ maxWidth: 420, marginTop: 14 }}>
      <h3 style={{ marginBottom: 6 }}>Turn off two-factor</h3>
      <p className="hint" style={{ marginBottom: 14 }}>
        Both your password and a current code are needed — knowing only one of them is
        the situation two-factor exists for.
      </p>
      {error && <Banner>{error}</Banner>}
      <div className="field">
        <label htmlFor="dpw">Password</label>
        <input id="dpw" type="password" value={password} autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="dcode">Authenticator code</label>
        <input id="dcode" value={code} inputMode="numeric" maxLength={6} className="mono"
          style={{ maxWidth: 160, letterSpacing: '0.3em' }}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
      </div>
      <button className="danger" disabled={busy || !password || code.length !== 6}
        onClick={async () => {
          setBusy(true); setError(null);
          try {
            await api.post('/auth/totp/disable', { password, code });
            onChanged();
          } catch (e) {
            setError(e instanceof ApiError ? e.message : 'Could not turn it off.');
          } finally { setBusy(false); }
        }}>
        {busy ? 'Turning off…' : 'Turn off two-factor'}
      </button>
    </div>
  );
}
