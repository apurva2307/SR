import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { Banner } from '../components/bits';
import { PasswordCard } from './Password';
import { TotpDisable } from './Totp';

/**
 * Everything a user can change about their own account, in one place: who they
 * are, their password, and their second factor.
 *
 * What is deliberately read-only here is as much the point as what is not.
 * Staff code, department and roles say where a person sits and what they may
 * do; an account that could rewrite them would make every other control in the
 * system decorative. Those stay with an administrator.
 */
export function ProfilePage() {
  const { principal } = useAuth();

  return (
    <div style={{ maxWidth: 620 }}>
      <div className="page-head">
        <h1>Your profile</h1>
      </div>
      <p className="dek">
        Your details, your password and your second factor. Staff code, department and
        roles are set by an administrator.
      </p>

      <Details />
      <div style={{ marginTop: 14 }}><PasswordCard /></div>
      <div style={{ marginTop: 14 }}><TwoFactor /></div>

      <div className="card" style={{ marginTop: 14 }}>
        <h3 style={{ marginBottom: 10 }}>Set by an administrator</h3>
        <dl className="detail-list" style={{ marginBottom: 12 }}>
          <dt>Staff code</dt><dd className="mono">{principal?.staffCode}</dd>
          <dt>Department</dt><dd>{principal?.departmentName}</dd>
          <dt>Roles</dt>
          <dd>
            {principal?.roles.length
              ? principal.roles.join(', ')
              : <span className="hint">None assigned.</span>}
          </dd>
        </dl>
        <p className="hint" style={{ marginBottom: 0 }}>
          Ask an administrator if any of these are wrong. A role change is its own audit event.
        </p>
      </div>
    </div>
  );
}

function Details() {
  const { principal, refresh } = useAuth();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [designation, setDesignation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Seeded from the principal rather than held only in it: the fields are
  // editable, so they need their own state, and it has to catch up whenever a
  // save refreshes the principal underneath.
  useEffect(() => {
    setFullName(principal?.fullName ?? '');
    setEmail(principal?.email ?? '');
    setDesignation(principal?.designation ?? '');
  }, [principal?.fullName, principal?.email, principal?.designation]);

  const dirty =
    fullName !== (principal?.fullName ?? '') ||
    email !== (principal?.email ?? '') ||
    designation !== (principal?.designation ?? '');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setNote(null);
    try {
      await api.put('/auth/profile', {
        fullName: fullName.trim(),
        email: email.trim() || null,
        designation: designation.trim() || null,
      });
      setNote('Saved.');
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save your details.');
    } finally { setBusy(false); }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2 style={{ marginBottom: 6 }}>Your details</h2>
      <p className="hint" style={{ marginBottom: 16 }}>
        Your name appears on the watermark of every page you open, and against every
        entry you leave in the audit log.
      </p>

      {error && <Banner>{error}</Banner>}
      {note && <Banner kind="ok">{note}</Banner>}

      <div className="field">
        <label htmlFor="pfn">Full name</label>
        <input id="pfn" value={fullName} autoComplete="name"
          onChange={(e) => setFullName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="pem">Email</label>
        <input id="pem" type="email" value={email} autoComplete="email"
          placeholder="Not set" onChange={(e) => setEmail(e.target.value)} />
        <p className="hint" style={{ marginTop: 6 }}>
          Used to address you in the system. Password resets are handed over in person,
          never emailed — an email account is not a stronger factor than the password
          it would protect.
        </p>
      </div>
      <div className="field">
        <label htmlFor="pdg">Designation</label>
        <input id="pdg" value={designation} placeholder="Senior Accounts Officer"
          onChange={(e) => setDesignation(e.target.value)} />
        <p className="hint" style={{ marginTop: 6 }}>
          The post you hold. It does not affect what you can do — your roles decide that.
        </p>
      </div>

      <button className="primary" type="submit" disabled={busy || !dirty || fullName.trim().length < 2}>
        {busy ? 'Saving…' : 'Save details'}
      </button>
    </form>
  );
}

function TwoFactor() {
  const { principal, refresh } = useAuth();

  if (principal?.totpEnabled) {
    return (
      <>
        <div className="card">
          <h2 style={{ marginBottom: 6 }}>Two-factor authentication</h2>
          <p className="hint" style={{ marginBottom: principal.totpRequired ? 10 : 0 }}>
            <span className="pill ok">ON</span>{' '}
            You are asked for a six-digit code from your authenticator app at each sign-in.
          </p>
          {/* The API refuses to turn it off when an administrator required it,
              so offering the form here would only ever produce a rejection. */}
          {principal.totpRequired && (
            <p className="hint" style={{ marginBottom: 0 }}>
              An administrator requires two-factor on this account, so it cannot be turned
              off here. If you have lost your phone, ask them to clear it.
            </p>
          )}
        </div>
        {!principal.totpRequired && <TotpDisable onChanged={() => void refresh()} />}
      </>
    );
  }

  return (
    <div className="card">
      <h2 style={{ marginBottom: 6 }}>Two-factor authentication</h2>
      <p className="hint">
        <span className="pill neutral">OFF</span>{' '}
        A six-digit code from your phone, on top of your password. Set up on your own
        device — nothing is generated for you until you prove a code it produced.
      </p>
      <Link className="btn" to="/two-factor">Set up two-factor</Link>
    </div>
  );
}
