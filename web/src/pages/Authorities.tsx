import { useState } from 'react';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { useLoad, fmtDate, daysLeft } from '../hooks';
import { Banner, Empty, Spinner } from '../components/bits';

interface Authority {
  id: string; order_reference: string; effective_from: string; effective_to: string;
  status: string; scope_dept_ids: string[] | null; remarks: string | null;
  holder_name: string; holder_code: string; issued_by_name: string;
  is_live: boolean; live_grants: string;
}

interface User { id: string; full_name: string; staff_code: string; roles: string[]; kind: string }
interface Dept { id: string; name: string; kind: string; is_active: boolean }

export function AuthoritiesPage() {
  const { can, principal } = useAuth();
  const list = useLoad<{ authorities: Authority[] }>('/authorities');
  const users = useLoad<{ users: User[] }>('/admin/users');
  const depts = useLoad<{ departments: Dept[] }>('/admin/departments');
  const [problem, setProblem] = useState<string | null>(null);
  const [showIssue, setShowIssue] = useState(false);

  if (list.loading) return <Spinner />;

  const authorities = list.data?.authorities ?? [];
  const canIssue = can('CONTROLLING_OFFICER');

  async function act(id: string, action: 'suspend' | 'resume' | 'revoke') {
    const reason = action === 'revoke' ? window.prompt('Why is this authority being withdrawn?') : undefined;
    if (action === 'revoke' && !reason) return;
    setProblem(null);
    try {
      await api.post(`/authorities/${id}/${action}`, reason ? { reason } : {});
      await list.reload();
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : 'That did not work.');
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Authority register</h1>
        {canIssue && (
          <button className="primary" onClick={() => setShowIssue((v) => !v)}>
            {showIssue ? 'Cancel' : 'Issue authority'}
          </button>
        )}
      </div>
      <p className="dek">
        Who may release records to other departments right now, under which office order, and until when.
        Holding the approver role is not enough on its own.
      </p>

      {problem && <Banner>{problem}</Banner>}

      {showIssue && canIssue && (
        <IssueForm
          users={(users.data?.users ?? []).filter(
            (u) => u.roles.includes('APPROVER') && u.id !== principal?.id)}
          departments={(depts.data?.departments ?? [])
            .filter((d) => d.kind === 'USER_DEPT' && d.is_active)}
          onDone={() => { setShowIssue(false); void list.reload(); }}
        />
      )}

      {authorities.length === 0
        ? <div className="tw"><Empty title="No authorities issued">
            Until one is issued, nothing can be released to a user department.
          </Empty></div>
        : <div className="tw" style={{ marginTop: 14 }}>
          <table>
            <thead>
              <tr>
                <th>Officer</th><th>Order</th><th>In force</th><th>Scope</th>
                <th>State</th><th>Open grants</th><th>Issued by</th>
                {canIssue && <th></th>}
              </tr>
            </thead>
            <tbody>
              {authorities.map((a) => {
                const left = daysLeft(a.effective_to);
                return (
                  <tr key={a.id}>
                    <td>
                      {a.holder_name}
                      <div style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>{a.holder_code}</div>
                    </td>
                    <td className="mono nowrap">{a.order_reference}</td>
                    <td className="nowrap">
                      {fmtDate(a.effective_from)} – {fmtDate(a.effective_to)}
                      {a.is_live && left != null && left <= 14 && (
                        <div><span className="pill warn">{left}D LEFT</span></div>
                      )}
                    </td>
                    <td>{a.scope_dept_ids ? `${a.scope_dept_ids.length} dept(s)` : 'All departments'}</td>
                    <td>
                      <span className={`pill ${a.is_live ? 'ok' : a.status === 'SUSPENDED' ? 'warn' : 'stop'}`}>
                        {a.is_live ? 'LIVE' : a.status === 'ACTIVE' ? 'NOT IN FORCE' : a.status}
                      </span>
                    </td>
                    <td className="mono">{a.live_grants}</td>
                    <td>{a.issued_by_name}</td>
                    {canIssue && (
                      <td className="nowrap">
                        {a.status === 'ACTIVE' && (
                          <button className="small" onClick={() => void act(a.id, 'suspend')}>Suspend</button>
                        )}
                        {a.status === 'SUSPENDED' && (
                          <button className="small" onClick={() => void act(a.id, 'resume')}>Resume</button>
                        )}
                        {a.status !== 'REVOKED' && (
                          <button className="small danger" style={{ marginLeft: 6 }}
                            onClick={() => void act(a.id, 'revoke')}>Withdraw</button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>}

      <p className="hint" style={{ marginTop: 14 }}>
        Withdrawing an authority does not close the grants it already opened — those releases were
        validly made. The open-grants count above links them; revoke from the access register if
        the circumstances call for it.
      </p>
    </>
  );
}

function IssueForm({ users, departments, onDone }: {
  users: User[]; departments: Dept[]; onDone: () => void;
}) {
  const [toUserId, setToUserId] = useState('');
  const [orderReference, setOrderReference] = useState('');
  const [months, setMonths] = useState(12);
  const [scoped, setScoped] = useState(false);
  const [scope, setScope] = useState<Set<string>>(new Set());
  const [remarks, setRemarks] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const from = new Date();
  const to = new Date(from); to.setMonth(to.getMonth() + months);

  async function submit() {
    setBusy(true); setError(null);
    try {
      await api.post('/authorities', {
        toUserId, orderReference: orderReference.trim(),
        effectiveFrom: from.toISOString(), effectiveTo: to.toISOString(),
        scopeDeptIds: scoped ? [...scope] : null,
        remarks: remarks.trim() || null,
      });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not issue the authority.');
    } finally { setBusy(false); }
  }

  return (
    <div className="card">
      <h2 style={{ marginBottom: 14 }}>Issue an approval authority</h2>
      {error && <Banner>{error}</Banner>}

      <div className="row">
        <div className="field">
          <label htmlFor="officer">Officer</label>
          <select id="officer" value={toUserId} onChange={(e) => setToUserId(e.target.value)}>
            <option value="">Choose an approver…</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.full_name} ({u.staff_code})</option>)}
          </select>
          <p className="hint">Only officers holding the approver role are listed. You cannot pick yourself.</p>
        </div>
        <div className="field">
          <label htmlFor="order">Office order reference</label>
          <input id="order" value={orderReference} placeholder="AC/ORD/2026/17"
            onChange={(e) => setOrderReference(e.target.value)} />
        </div>
      </div>

      <div className="field">
        <label>In force for</label>
        <div className="duration-row">
          {[3, 6, 12, 24].map((m) => (
            <button key={m} className={months === m ? 'on' : ''} onClick={() => setMonths(m)}>
              {m} months
            </button>
          ))}
        </div>
        <p className="hint">
          Ends <strong>{to.toLocaleDateString(undefined,
            { day: 'numeric', month: 'long', year: 'numeric' })}</strong>.
          It stops working by itself on that date, so a transfer needs no cleanup.
        </p>
      </div>

      <div className="field">
        <label>
          <input type="checkbox" checked={scoped} style={{ width: 'auto', marginRight: 8 }}
            onChange={(e) => setScoped(e.target.checked)} />
          Restrict which departments this officer may release to
        </label>
        {scoped && (
          <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            {departments.map((d) => (
              <label key={d.id} style={{ fontWeight: 400 }}>
                <input type="checkbox" style={{ width: 'auto', marginRight: 6 }}
                  checked={scope.has(d.id)}
                  onChange={() => setScope((prev) => {
                    const next = new Set(prev);
                    next.has(d.id) ? next.delete(d.id) : next.add(d.id);
                    return next;
                  })} />
                {d.name}
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="field">
        <label htmlFor="remarks">Remarks (optional)</label>
        <input id="remarks" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
      </div>

      <button className="primary" disabled={busy || !toUserId || orderReference.trim().length < 3}
        onClick={() => void submit()}>
        {busy ? 'Issuing…' : 'Issue authority'}
      </button>
    </div>
  );
}
