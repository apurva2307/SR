import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { useLoad, fmtDateTime } from '../hooks';
import { Banner, Empty, Spinner } from '../components/bits';

interface User {
  id: string; staff_code: string; full_name: string; email: string | null;
  designation: string | null; status: string; roles: string[]; department_name: string; kind: string;
  last_login_at: string | null; must_change_password: boolean;
  totp_enabled: boolean; totp_required: boolean;
}
interface Dept {
  id: string; code: string; name: string; kind: string; is_active: boolean;
  user_count: string; request_count: string; scoped_authority_count: string;
}
interface Setting {
  key: string; label: string; description: string;
  kind: 'integer' | 'number' | 'integer-list';
  unit?: string; min?: number; max?: number; ceilingNote?: string;
  value: unknown; updatedAt: string | null; updatedByName: string | null;
}

const ROLES = ['REQUESTER', 'APPROVER', 'CUSTODIAN', 'CONTROLLING_OFFICER', 'AUDITOR', 'ADMIN'] as const;

export function AdminPage() {
  const users = useLoad<{ users: User[] }>('/admin/users');
  const depts = useLoad<{ departments: Dept[] }>('/admin/departments');
  const settings = useLoad<{ settings: Setting[] }>('/admin/settings');
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  if (users.loading) return <Spinner />;

  // Every admin action goes through here: the previous version swallowed failures as
  // unhandled promise rejections, so a button that did nothing looked like a
  // button that was broken.
  async function act(fn: () => Promise<void>) {
    setProblem(null);
    try { await fn(); } catch (e) {
      setProblem(e instanceof ApiError ? e.message : 'That action did not work.');
    }
  }

  async function setRoles(u: User, role: string, on: boolean) {
    setProblem(null);
    const roles = on ? [...new Set([...u.roles, role])] : u.roles.filter((r) => r !== role);
    try {
      await api.put(`/admin/users/${u.id}/roles`, { roles });
      await users.reload();
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : 'Could not change roles.');
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Administration</h1>
        <button className="primary" onClick={() => setCreating((v) => !v)}>
          {creating ? 'Cancel' : 'Add user'}
        </button>
      </div>
      <p className="dek">
        Users, roles, departments, and policy. Nothing here opens a service record — an
        administrator who wants to read one needs the approver role, and to release one they
        would also need an authority from a controlling officer.
      </p>

      {note && <Banner kind="ok">{note}</Banner>}
      {problem && <Banner>{problem}</Banner>}

      {creating && (
        <NewUser departments={depts.data?.departments ?? []}
          onDone={(pw, code) => {
            setCreating(false);
            setNote(`${code} created. One-time password: ${pw} — hand it over in person; it is shown once.`);
            void users.reload();
          }} />
      )}

      <h2 style={{ margin: '22px 0 12px' }}>Users</h2>
      <div className="tw">
        <table>
          <thead>
            <tr><th>Staff</th><th>Department</th><th>Roles</th><th>Last seen</th><th>State</th><th></th></tr>
          </thead>
          <tbody>
            {(users.data?.users ?? []).map((u) => (
              <tr key={u.id}>
                <td>
                  {u.full_name}
                  {u.designation && (
                    <div style={{ color: 'var(--muted)', fontSize: '0.78rem' }}>{u.designation}</div>
                  )}
                  <div className="mono" style={{ color: 'var(--muted)', fontSize: '0.78rem' }}>
                    {u.staff_code}
                  </div>
                </td>
                <td>{u.department_name}
                  <div style={{ color: 'var(--muted)', fontSize: '0.75rem' }}>{u.kind}</div></td>
                <td>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {ROLES.map((r) => (
                      <label key={r} style={{ fontWeight: 400, fontSize: '0.72rem', marginBottom: 0 }}>
                        <input type="checkbox" style={{ width: 'auto', marginRight: 4 }}
                          checked={u.roles.includes(r)}
                          onChange={(e) => void setRoles(u, r, e.target.checked)} />
                        {r === 'CONTROLLING_OFFICER' ? 'CTRL' : r.slice(0, 5)}
                      </label>
                    ))}
                  </div>
                </td>
                <td className="nowrap">{fmtDateTime(u.last_login_at)}</td>
                <td>
                  <span className={`pill ${u.status === 'ACTIVE' ? 'ok' : 'stop'}`}>{u.status}</span>
                  <div style={{ marginTop: 4 }}>
                    {u.totp_enabled
                      ? <span className="pill acc">2FA ON</span>
                      : u.totp_required
                        ? <span className="pill warn">2FA AWAITING SETUP</span>
                        : <span className="pill neutral">2FA OFF</span>}
                  </div>
                  {u.must_change_password && <div><span className="pill warn">NEW PW</span></div>}
                </td>
                <td className="nowrap">
                  <button className="small" onClick={() => void act(async () => {
                    const r = await api.post<{ code: string; note: string }>(
                      `/admin/users/${u.id}/reset-code`);
                    setNote(`Reset code for ${u.full_name} — ${r.code} — ${r.note}`);
                  })}>Reset code</button>

                  <TotpButtons user={u} onNote={setNote} onDone={() => void users.reload()}
                    run={act} />

                  {u.status === 'ACTIVE' ? (
                    <button className="small danger" style={{ marginLeft: 6 }}
                      title="Ends their sessions immediately. Reversible."
                      onClick={() => void act(async () => {
                        if (!window.confirm(`Suspend ${u.full_name}? Their sessions end immediately.`)) return;
                        await api.post(`/admin/users/${u.id}/suspend`);
                        void users.reload();
                      })}>Suspend</button>
                  ) : u.status === 'SUSPENDED' ? (
                    <button className="small" style={{ marginLeft: 6 }}
                      title="Let this account sign in again. Password unchanged; old sessions stay ended."
                      onClick={() => void act(async () => {
                        const r = await api.post<{ message: string }>(`/admin/users/${u.id}/reactivate`);
                        setNote(r.message);
                        void users.reload();
                      })}>Reactivate</button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Departments
        departments={depts.data?.departments ?? []}
        onChange={() => { void depts.reload(); void users.reload(); }}
        onNote={setNote}
      />

      <h2 style={{ margin: '28px 0 12px' }}>Policy</h2>
      <p className="dek" style={{ marginBottom: 14 }}>
        What the department can tune without a deploy. Each value says what it affects; hover a
        row for the same text as a tooltip.
      </p>
      {(settings.data?.settings ?? []).length === 0
        ? <Empty title="No settings loaded" />
        : <div className="tw">
          <table>
            <thead>
              <tr><th>Setting</th><th style={{ width: 210 }}>Value</th><th>Last changed</th></tr>
            </thead>
            <tbody>
              {(settings.data?.settings ?? []).map((s) => (
                <SettingRow key={s.key} setting={s}
                  onSaved={(msg) => { setNote(msg); void settings.reload(); }} />
              ))}
            </tbody>
          </table>
        </div>}
      <p className="hint" style={{ marginTop: 10 }}>
        Two things deliberately absent: there is no download setting, because screen-only is
        structural rather than a toggle; and the 180-day grant ceiling is a database constraint,
        so raising the maximum above it is a migration, not a form field.
      </p>
    </>
  );
}

function NewUser({ departments, onDone }: {
  departments: Dept[]; onDone: (pw: string, staffCode: string) => void;
}) {
  const [staffCode, setStaffCode] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [designation, setDesignation] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [roles, setRoles] = useState<Set<string>>(new Set(['REQUESTER']));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A department numbering its staff some other way is a real situation, not a
  // mistake to be prevented — so the allocated code can be overridden.
  const [manualCode, setManualCode] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Only a preview. The code that counts is allocated by the server when the
  // account is inserted, so two administrators working at once cannot both
  // take the same one however long this form sits open.
  useEffect(() => {
    if (!departmentId) { setPreview(null); setPreviewError(null); return; }
    let current = true;
    setPreview(null); setPreviewError(null);
    api.get<{ code: string }>(`/admin/users/next-code?departmentId=${departmentId}`)
      .then((r) => { if (current) setPreview(r.code); })
      .catch((e) => {
        if (!current) return;
        setPreviewError(e instanceof ApiError ? e.message : 'Could not work out the next staff code.');
        setManualCode(true);
      });
    return () => { current = false; };
  }, [departmentId]);

  return (
    <div className="card">
      <h2 style={{ marginBottom: 14 }}>Add a user</h2>
      {error && <Banner>{error}</Banner>}
      <div className="row">
        <div className="field">
          <label htmlFor="dp">Department</label>
          <select id="dp" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
            <option value="">Choose…</option>
            {departments.filter((d) => d.is_active)
              .map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="sc">Staff code</label>
          <input id="sc"
            value={manualCode ? staffCode : preview ?? ''}
            readOnly={!manualCode}
            placeholder={departmentId ? 'Working it out…' : 'Choose a department first'}
            onChange={(e) => setStaffCode(e.target.value)} />
          <p className="hint" style={{ marginTop: 6 }}>
            {previewError ??
              (manualCode
                ? <>Typed in by hand. <a href="#" onClick={(e) => {
                    e.preventDefault(); setManualCode(false); setStaffCode('');
                  }}>Use {preview ?? 'the department’s next code'} instead</a></>
                : <>Allocated from the department. <a href="#" onClick={(e) => {
                    e.preventDefault(); setManualCode(true); setStaffCode(preview ?? '');
                  }}>Set it manually</a></>)}
          </p>
        </div>
      </div>
      <div className="row">
        <div className="field">
          <label htmlFor="fn">Full name</label>
          <input id="fn" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="em">Email (optional)</label>
          <input id="em" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="dg">Designation (optional)</label>
        <input id="dg" value={designation} placeholder="Senior Accounts Officer"
          onChange={(e) => setDesignation(e.target.value)} />
        <p className="hint" style={{ marginTop: 6 }}>
          The post they hold, as an office order would name it. Roles below decide what
          they can do; this does not.
        </p>
      </div>
      <div className="field">
        <label>Roles</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
          {ROLES.map((r) => (
            <label key={r} style={{ fontWeight: 400, marginBottom: 0 }}>
              <input type="checkbox" style={{ width: 'auto', marginRight: 6 }}
                checked={roles.has(r)}
                onChange={() => setRoles((prev) => {
                  const next = new Set(prev);
                  next.has(r) ? next.delete(r) : next.add(r);
                  return next;
                })} />
              {r}
            </label>
          ))}
        </div>
      </div>
      <button className="primary"
        disabled={busy || !fullName || !departmentId || (manualCode && !staffCode.trim())}
        onClick={async () => {
          setBusy(true); setError(null);
          try {
            const out = await api.post<{ staffCode: string; initialPassword: string }>('/admin/users', {
              // null, not the preview: sending it back would let a code the
              // server has since issued to someone else be claimed twice.
              staffCode: manualCode ? staffCode.trim() : null,
              fullName: fullName.trim(),
              email: email.trim() || null, designation: designation.trim() || null,
              departmentId, roles: [...roles],
            });
            onDone(out.initialPassword, out.staffCode);
          } catch (e) {
            setError(e instanceof ApiError ? e.message : 'Could not create the user.');
          } finally { setBusy(false); }
        }}>
        {busy ? 'Creating…' : 'Create user'}
      </button>
    </div>
  );
}

function Departments({ departments, onChange, onNote }: {
  departments: Dept[]; onChange: () => void; onNote: (s: string) => void;
}) {
  const [editing, setEditing] = useState<Dept | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove(d: Dept) {
    setError(null);
    if (!window.confirm(`Delete ${d.name} permanently? This cannot be undone.`)) return;
    try {
      await api.del(`/admin/departments/${d.id}`);
      onNote(`${d.name} deleted.`);
      onChange();
    } catch (e) {
      // A refusal here is the useful case: it names what the department still
      // holds and points at deactivation instead.
      setError(e instanceof ApiError ? e.message : 'Could not delete that department.');
    }
  }

  async function toggle(d: Dept) {
    setError(null);
    try {
      await api.post(`/admin/departments/${d.id}/${d.is_active ? 'deactivate' : 'activate'}`);
      onChange();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not change that department.');
    }
  }

  return (
    <>
      <div className="card-head" style={{ margin: '28px 0 12px' }}>
        <h2>Departments</h2>
        <button className="primary" onClick={() => { setAdding((v) => !v); setEditing(null); }}>
          {adding ? 'Cancel' : 'Add department'}
        </button>
      </div>

      {error && <Banner>{error}</Banner>}

      {(adding || editing) && (
        <DepartmentForm
          key={editing?.id ?? 'new'}
          existing={editing}
          onCancel={() => { setAdding(false); setEditing(null); }}
          onDone={(verb) => {
            setAdding(false); setEditing(null);
            onNote(`Department ${verb}.`);
            onChange();
          }}
        />
      )}

      <div className="tw">
        <table>
          <thead>
            <tr>
              <th>Code</th><th>Name</th><th>Kind</th><th>Holds</th><th>State</th><th></th>
            </tr>
          </thead>
          <tbody>
            {departments.map((d) => {
              const holds = Number(d.user_count) + Number(d.request_count) + Number(d.scoped_authority_count);
              return (
                <tr key={d.id}>
                  <td className="mono">{d.code}</td>
                  <td>{d.name}</td>
                  <td><span className={`pill ${d.kind === 'ACCOUNTS' ? 'acc' : 'neutral'}`}>{d.kind}</span></td>
                  <td style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>
                    {holds === 0 ? 'nothing yet' : [
                      Number(d.user_count) ? `${d.user_count} staff` : null,
                      Number(d.request_count) ? `${d.request_count} requests` : null,
                      Number(d.scoped_authority_count) ? `${d.scoped_authority_count} scoped authorities` : null,
                    ].filter(Boolean).join(' · ')}
                  </td>
                  <td>
                    <span className={`pill ${d.is_active ? 'ok' : 'neutral'}`}>
                      {d.is_active ? 'ACTIVE' : 'INACTIVE'}
                    </span>
                  </td>
                  <td className="nowrap">
                    <button className="small" onClick={() => { setEditing(d); setAdding(false); }}>Edit</button>
                    <button className="small" style={{ marginLeft: 6 }} onClick={() => void toggle(d)}>
                      {d.is_active ? 'Deactivate' : 'Reactivate'}
                    </button>
                    <button className="small danger" style={{ marginLeft: 6 }}
                      disabled={holds > 0}
                      title={holds > 0
                        ? 'Still holds staff, requests or scoped authorities — deactivate instead'
                        : 'Delete permanently'}
                      onClick={() => void remove(d)}>Delete</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="hint" style={{ marginTop: 10 }}>
        A department that has never held staff, requests or a scoped authority is just a typo, and
        deletes outright. Once it has history, deactivating is the honest option — deleting would
        orphan records the audit log still refers to.
      </p>
    </>
  );
}

function DepartmentForm({ existing, onCancel, onDone }: {
  existing: Dept | null; onCancel: () => void; onDone: (verb: string) => void;
}) {
  const [code, setCode] = useState(existing?.code ?? '');
  const [name, setName] = useState(existing?.name ?? '');
  const [kind, setKind] = useState(existing?.kind ?? 'USER_DEPT');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = !!existing && Number(existing.user_count) > 0;

  async function submit() {
    setBusy(true); setError(null);
    try {
      const body = { code: code.trim().toUpperCase(), name: name.trim(), kind };
      if (existing) await api.put(`/admin/departments/${existing.id}`, body);
      else await api.post('/admin/departments', body);
      onDone(existing ? 'updated' : 'created');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save that department.');
    } finally { setBusy(false); }
  }

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-head">
        <h3>{existing ? `Edit ${existing.name}` : 'Add a department'}</h3>
        <button className="ghost small" onClick={onCancel}>Cancel</button>
      </div>
      {error && <Banner>{error}</Banner>}
      <div className="row">
        <div className="field shrink" style={{ flexBasis: 140 }}>
          <label htmlFor="dcode">Code</label>
          <input id="dcode" className="mono" value={code} maxLength={12} placeholder="PW"
            onChange={(e) => setCode(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="dname">Full name</label>
          <input id="dname" value={name} placeholder="Public Works Department"
            onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field shrink" style={{ flexBasis: 220 }}>
          <label htmlFor="dkind">Kind</label>
          <select id="dkind" value={kind} disabled={locked} onChange={(e) => setKind(e.target.value)}>
            <option value="USER_DEPT">User department</option>
            <option value="ACCOUNTS">Accounts (custodian)</option>
          </select>
        </div>
      </div>
      <p className="hint" style={{ marginTop: -4, marginBottom: 14 }}>
        {locked
          ? `Kind is locked while ${existing!.user_count} staff are posted here — changing it would change who can release records.`
          : 'Accounts departments hold the records and can be given approvers. User departments request access.'}
      </p>
      <button className="primary" disabled={busy || code.trim().length < 2 || name.trim().length < 3}
        onClick={() => void submit()}>
        {busy ? 'Saving…' : existing ? 'Save changes' : 'Create department'}
      </button>
    </div>
  );
}

function TotpButtons({ user, onNote, onDone, run }: {
  user: User; onNote: (s: string) => void; onDone: () => void;
  run: (fn: () => Promise<void>) => Promise<void>;
}) {
  return (
    <>
      {!user.totp_required && (
        <button className="small" style={{ marginLeft: 6 }}
          title="Ask this user to set up two-factor the next time they sign in"
          onClick={() => void run(async () => {
            const r = await api.post<{ message: string }>(`/admin/users/${user.id}/totp/require`);
            onNote(r.message);
            onDone();
          })}>Require 2FA</button>
      )}
      {user.totp_required && (
        <button className="small" style={{ marginLeft: 6 }}
          title="Stop requiring it. Any existing enrolment stays."
          onClick={() => void run(async () => {
            await api.post(`/admin/users/${user.id}/totp/optional`);
            onNote(`Two-factor is no longer required for ${user.full_name}.`);
            onDone();
          })}>Make 2FA optional</button>
      )}
      {(user.totp_enabled || user.totp_required) && (
        <button className="small danger" style={{ marginLeft: 6 }}
          title="Lost phone: clears the enrolment so they can sign in and set it up again"
          onClick={() => void run(async () => {
            if (!window.confirm(
              `Clear two-factor for ${user.full_name}? They will sign in with their password alone until they set it up again.`)) return;
            const r = await api.del<{ message: string }>(`/admin/users/${user.id}/totp`);
            onNote(r.message);
            onDone();
          })}>Clear 2FA</button>
      )}
    </>
  );
}

/** One policy row: explains itself, and edits in place with server validation. */
function SettingRow({ setting, onSaved }: { setting: Setting; onSaved: (msg: string) => void }) {
  const asText = (v: unknown) => Array.isArray(v) ? v.join(', ') : String(v ?? '');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(asText(setting.value));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true); setError(null);
    try {
      const value = setting.kind === 'integer-list'
        ? draft.split(/[,\s]+/).filter(Boolean).map(Number)
        : Number(draft);
      await api.put(`/admin/settings/${setting.key}`, { value });
      setEditing(false);
      onSaved(`${setting.label} updated.`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save that value.');
    } finally { setBusy(false); }
  }

  const range = setting.min !== undefined && setting.max !== undefined
    ? `${setting.min}–${setting.max}${setting.unit ? ' ' + setting.unit : ''}`
    : null;

  return (
    <tr title={setting.description}>
      <td style={{ maxWidth: 520 }}>
        <strong style={{ fontWeight: 600 }}>{setting.label}</strong>
        <div className="mono" style={{ fontSize: '0.72rem', color: 'var(--muted)' }}>{setting.key}</div>
        <p className="hint" style={{ marginTop: 6 }}>{setting.description}</p>
        {setting.ceilingNote && (
          <p className="hint" style={{ marginTop: 4, color: 'var(--warn)' }}>{setting.ceilingNote}</p>
        )}
        {error && <p className="hint" style={{ color: 'var(--stop)', marginTop: 6 }}>{error}</p>}
      </td>
      <td>
        {editing ? (
          <>
            <input className="mono" value={draft} autoFocus
              inputMode={setting.kind === 'number' ? 'decimal' : 'numeric'}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void save(); if (e.key === 'Escape') setEditing(false); }} />
            {range && <p className="hint">Allowed: {range}</p>}
            {setting.kind === 'integer-list' && <p className="hint">Comma-separated, e.g. 7, 2</p>}
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <button className="small primary" disabled={busy} onClick={() => void save()}>
                {busy ? 'Saving…' : 'Save'}
              </button>
              <button className="small ghost" disabled={busy}
                onClick={() => { setEditing(false); setDraft(asText(setting.value)); setError(null); }}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="mono">{asText(setting.value)}</span>
            {setting.unit && <span className="hint">{setting.unit}</span>}
            <button className="small ghost" onClick={() => setEditing(true)}>Edit</button>
          </div>
        )}
      </td>
      <td className="nowrap" style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>
        {setting.updatedAt ? fmtDateTime(setting.updatedAt) : '—'}
        {setting.updatedByName && <div>{setting.updatedByName}</div>}
      </td>
    </tr>
  );
}
