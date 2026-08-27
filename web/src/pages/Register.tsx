import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { useLoad, fmtDate, daysLeft } from '../hooks';
import { Banner, Empty, Spinner } from '../components/bits';

interface RegisterRow {
  id: string; valid_from: string; valid_until: string; origin: string;
  holder_name: string; holder_code: string; holder_dept: string;
  ppo_number: string; employee_name: string; granted_by_name: string;
  order_reference: string; authority_status: string; request_no: string | null;
}

interface MyGrant {
  id: string; record_id: string; valid_until: string;
  ppo_number: string; employee_name: string; page_count: number | null;
}

export function RegisterPage() {
  const { isAccounts, can } = useAuth();
  return isAccounts || can('AUDITOR') ? <AllGrants /> : <MyAccess />;
}

function MyAccess() {
  const navigate = useNavigate();
  const { data, error, loading } = useLoad<{ grants: MyGrant[] }>('/grants');
  if (loading) return <Spinner />;
  if (error) return <Banner>{error}</Banner>;
  const grants = data?.grants ?? [];

  return (
    <>
      <div className="page-head"><h1>My access</h1></div>
      <p className="dek">Records you can open right now, and when each one closes by itself.</p>

      {grants.length === 0
        ? <div className="tw"><Empty title="No records open to you">
            Search the catalogue and raise a request.
          </Empty></div>
        : <div className="tw">
          <table>
            <thead><tr><th>PPO number</th><th>Employee</th><th>Pages</th><th>Closes</th><th></th></tr></thead>
            <tbody>
              {grants.map((g) => {
                const left = daysLeft(g.valid_until);
                return (
                  <tr key={g.id}>
                    <td className="mono nowrap">{g.ppo_number}</td>
                    <td>{g.employee_name}</td>
                    <td className="mono">{g.page_count ?? '—'}</td>
                    <td className="nowrap">
                      {fmtDate(g.valid_until)}{' '}
                      <span className={`pill ${left != null && left <= 3 ? 'warn' : 'neutral'}`}>
                        {left != null && left <= 0 ? 'TODAY' : `${left}D`}
                      </span>
                    </td>
                    <td><button className="small primary"
                      onClick={() => navigate(`/records/${g.record_id}/view`)}>Read</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>}
    </>
  );
}

function AllGrants() {
  const { can } = useAuth();
  const { data, error, loading, reload } = useLoad<{ grants: RegisterRow[] }>('/grants?scope=all');
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  if (loading) return <Spinner />;
  if (error) return <Banner>{error}</Banner>;
  const grants = data?.grants ?? [];

  async function revoke(id: string) {
    const reason = window.prompt('Why is this access being withdrawn?');
    if (!reason || reason.trim().length < 5) return;
    setBusy(id); setProblem(null);
    try {
      await api.post(`/grants/${id}/revoke`, { reason: reason.trim() });
      await reload();
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : 'Could not revoke.');
    } finally { setBusy(null); }
  }

  return (
    <>
      <div className="page-head"><h1>Live access register</h1></div>
      <p className="dek">
        Every open door in the system, soonest to close first. Each row names the officer who
        released it and the office order they acted under.
      </p>

      {problem && <Banner>{problem}</Banner>}

      {grants.length === 0
        ? <div className="tw"><Empty title="No records are currently released">
            Nothing outside Accounts can be opened right now.
          </Empty></div>
        : <div className="tw">
          <table>
            <thead>
              <tr>
                <th>Closes</th><th>Record</th><th>Released to</th>
                <th>Released by</th><th>Under order</th><th>Origin</th>
                {can('APPROVER', 'CUSTODIAN') && <th></th>}
              </tr>
            </thead>
            <tbody>
              {grants.map((g) => {
                const left = daysLeft(g.valid_until);
                return (
                  <tr key={g.id}>
                    <td className="nowrap">
                      {fmtDate(g.valid_until)}{' '}
                      <span className={`pill ${left != null && left <= 3 ? 'warn' : 'neutral'}`}>
                        {left != null && left <= 0 ? 'TODAY' : `${left}D`}
                      </span>
                    </td>
                    <td>
                      <div className="mono">{g.ppo_number}</div>
                      <div style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>{g.employee_name}</div>
                    </td>
                    <td>
                      {g.holder_name}
                      <div style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>
                        {g.holder_code} · {g.holder_dept}
                      </div>
                    </td>
                    <td>{g.granted_by_name}</td>
                    <td>
                      <span className="mono">{g.order_reference}</span>
                      {g.authority_status !== 'ACTIVE' && (
                        <div><span className="pill stop">{g.authority_status}</span></div>
                      )}
                    </td>
                    <td>
                      <span className={`pill ${g.origin === 'EMERGENCY' ? 'warn' : 'neutral'}`}>
                        {g.origin}
                      </span>
                      {g.request_no && <div className="mono" style={{ fontSize: '0.75rem' }}>{g.request_no}</div>}
                    </td>
                    {can('APPROVER', 'CUSTODIAN') && (
                      <td><button className="small danger" disabled={busy === g.id}
                        onClick={() => void revoke(g.id)}>Revoke</button></td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>}
    </>
  );
}
