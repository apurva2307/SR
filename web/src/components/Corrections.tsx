import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { useLoad, fmtDateTime } from '../hooks';
import { Banner, Spinner } from './bits';

export interface Correction {
  id: string; service_record_id: string; field: 'EMPLOYEE_NAME' | 'PPO_NUMBER';
  old_value: string; new_value: string; reason: string;
  status: 'PENDING' | 'APPLIED' | 'REJECTED' | 'WITHDRAWN';
  proposed_at: string; decided_at: string | null; decision_remarks: string | null;
  proposed_by: string; proposed_by_name: string; proposed_by_code: string;
  decided_by_name: string | null; decided_by_code: string | null;
  employee_name: string; ppo_number: string;
}

export const FIELD_LABEL = { EMPLOYEE_NAME: 'Employee name', PPO_NUMBER: 'PPO number' } as const;

const STATUS_PILL: Record<Correction['status'], string> = {
  PENDING: 'warn', APPLIED: 'ok', REJECTED: 'stop', WITHDRAWN: 'neutral',
};

export const CorrectionPill = ({ status }: { status: Correction['status'] }) =>
  <span className={`pill ${STATUS_PILL[status]}`}>{status === 'PENDING' ? 'AWAITING OFFICER' : status}</span>;

/** Who did what, in the order it happened. */
function Trail({ c }: { c: Correction }) {
  const muted = { color: 'var(--muted)', fontSize: '0.78rem' } as const;
  const by = (name: string | null, code: string | null) => <>{name} <span className="mono">({code})</span></>;
  return (
    <>
      <div>{by(c.proposed_by_name, c.proposed_by_code)}</div>
      <div style={muted}>{c.field === 'PPO_NUMBER' ? 'Proposed' : 'Corrected'} {fmtDateTime(c.proposed_at)}</div>
      {c.field === 'PPO_NUMBER' && c.decided_at && (
        <div style={{ marginTop: 4 }}>
          {c.status === 'WITHDRAWN' ? <div style={muted}>Withdrawn {fmtDateTime(c.decided_at)}</div> : (
            <>
              <div>{by(c.decided_by_name, c.decided_by_code)}</div>
              <div style={muted}>{c.status === 'APPLIED' ? 'Approved' : 'Rejected'} {fmtDateTime(c.decided_at)}</div>
            </>
          )}
        </div>
      )}
    </>
  );
}

export function CorrectionsTable({ rows, showRecord = false }: { rows: Correction[]; showRecord?: boolean }) {
  return (
    <div className="tw">
      <table>
        <thead>
          <tr>
            {showRecord && <th>Record</th>}
            <th>Field</th><th>From</th><th>To</th><th>Reason</th><th>By</th><th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id}>
              {showRecord && (
                <td><Link to={`/records/${c.service_record_id}`}>{c.employee_name}</Link>
                  <div className="mono" style={{ color: 'var(--muted)', fontSize: '0.78rem' }}>{c.ppo_number}</div></td>
              )}
              <td className="nowrap">{FIELD_LABEL[c.field]}</td>
              <td className={c.field === 'PPO_NUMBER' ? 'mono' : undefined}>{c.old_value}</td>
              <td className={c.field === 'PPO_NUMBER' ? 'mono' : undefined}>{c.new_value}</td>
              <td>
                {c.reason}
                {c.decision_remarks && (
                  <div style={{ color: 'var(--muted)', fontSize: '0.8rem', marginTop: 4 }}>
                    Officer: {c.decision_remarks}
                  </div>
                )}
              </td>
              <td><Trail c={c} /></td>
              <td><CorrectionPill status={c.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The record page's corrections panel. Custodians correct the name directly
 * and propose a PPO number; controlling officers and auditors see the history.
 * Every row here is also in the audit log.
 */
export function RecordCorrections({ recordId, employeeName, ppo, active, onChanged }: {
  recordId: string; employeeName: string; ppo: string; active: boolean;
  onChanged: (msg: string) => void;
}) {
  const { can, principal } = useAuth();
  const isCustodian = can('CUSTODIAN');
  const { data, error, loading, reload } = useLoad<{ corrections: Correction[] }>(
    `/records/${recordId}/corrections`);
  const [editing, setEditing] = useState<null | 'name' | 'ppo'>(null);

  if (loading && !data) return <div className="card" style={{ marginTop: 14 }}><Spinner /></div>;
  const rows = data?.corrections ?? [];
  const pending = rows.find((c) => c.status === 'PENDING' && c.service_record_id === recordId);

  const done = (msg: string) => { setEditing(null); void reload(); onChanged(msg); };

  async function withdraw(id: string) {
    try {
      await api.post(`/corrections/${id}/withdraw`);
      done('The PPO correction was withdrawn.');
    } catch (e) {
      onChanged(e instanceof ApiError ? e.message : 'Could not withdraw the correction.');
    }
  }

  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="card-head">
        <h3>Corrections</h3>
        {isCustodian && active && !editing && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="small" onClick={() => setEditing('name')}>Correct name</button>
            <button className="small" disabled={!!pending} onClick={() => setEditing('ppo')}>Correct PPO number</button>
          </div>
        )}
      </div>
      <p className="hint" style={{ marginTop: -6, marginBottom: 12 }}>
        A name correction takes effect at once. A PPO correction waits for a controlling officer
        other than you. Every correction, its reason and who made it are kept permanently and
        written to the audit log. The old value stays searchable.
      </p>
      {error && <Banner>{error}</Banner>}

      {pending && (
        <Banner kind="warn">
          <strong>PPO correction awaiting a controlling officer:</strong>{' '}
          <span className="mono">{pending.old_value}</span> → <span className="mono">{pending.new_value}</span>,
          proposed by {pending.proposed_by_name} on {fmtDateTime(pending.proposed_at)}.
          {pending.proposed_by === principal?.id && (
            <> <button className="small ghost" onClick={() => void withdraw(pending.id)}>Withdraw</button></>
          )}
        </Banner>
      )}

      {editing && (
        <CorrectionForm recordId={recordId} kind={editing}
          current={editing === 'name' ? employeeName : ppo}
          onCancel={() => setEditing(null)} onDone={done} />
      )}

      {rows.length === 0
        ? <p className="hint">No corrections. The name and PPO number are as parsed from the filename.</p>
        : <CorrectionsTable rows={rows} />}
    </div>
  );
}

function CorrectionForm({ recordId, kind, current, onCancel, onDone }: {
  recordId: string; kind: 'name' | 'ppo'; current: string;
  onCancel: () => void; onDone: (msg: string) => void;
}) {
  const [value, setValue] = useState(current);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isPpo = kind === 'ppo';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      if (isPpo) {
        await api.post(`/records/${recordId}/corrections/ppo`, { ppo: value.trim(), reason: reason.trim() });
        onDone('PPO correction sent to the controlling officers. The record keeps its current PPO number until one approves it.');
      } else {
        await api.post(`/records/${recordId}/corrections/name`, { name: value.trim(), reason: reason.trim() });
        onDone('Name corrected. The previous name is still searchable.');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the correction.');
    } finally { setBusy(false); }
  }

  const unchanged = value.trim() === current;
  return (
    <form className="correction-form" onSubmit={submit}>
      {error && <Banner>{error}</Banner>}
      <div className="row">
        <div className="field">
          <label htmlFor="corr-current">Current {isPpo ? 'PPO number' : 'name'}</label>
          <input id="corr-current" className={isPpo ? 'mono' : undefined} value={current} readOnly disabled />
        </div>
        <div className="field">
          <label htmlFor="corr-value">Corrected {isPpo ? 'PPO number' : 'name'}</label>
          <input id="corr-value" className={isPpo ? 'mono' : undefined} value={value} autoFocus
            onChange={(e) => setValue(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="corr-reason">Reason</label>
        <textarea id="corr-reason" value={reason} onChange={(e) => setReason(e.target.value)}
          placeholder={isPpo
            ? 'e.g. PPO revised under Pension Sanction Order no. … dated …'
            : 'e.g. Spelling as in the service book, page 1'} />
        <p className="hint">Name the order or document the correction rests on. Kept permanently.</p>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="submit" className="primary"
          disabled={busy || unchanged || !value.trim() || reason.trim().length < 10}>
          {isPpo ? 'Send for approval' : 'Correct name'}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}
