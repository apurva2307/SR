import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { useLoad, fmtDateTime } from '../hooks';
import { Banner, Empty, Spinner } from '../components/bits';
import { CorrectionsTable, type Correction } from '../components/Corrections';

/**
 * PPO corrections waiting for a controlling officer. A PPO number is a
 * record's identity, so a custodian's proposal changes nothing until an
 * officer — never the proposer — approves it here.
 */
export function CorrectionsPage() {
  const { can } = useAuth();
  const isOfficer = can('CONTROLLING_OFFICER');
  const pending = useLoad<{ corrections: Correction[] }>('/corrections/pending');
  const decided = useLoad<{ corrections: Correction[] }>(
    isOfficer || can('AUDITOR') ? '/corrections/decided' : null);
  const [note, setNote] = useState<string | null>(null);

  if (pending.loading && !pending.data) return <Spinner />;
  const queue = pending.data?.corrections ?? [];

  const done = (msg: string) => {
    setNote(msg);
    void pending.reload();
    void decided.reload();
  };

  return (
    <>
      <div className="page-head"><h1>PPO corrections</h1></div>
      <p className="dek">
        Changes to a record's PPO number proposed by a custodian. Nothing changes on the record
        until a controlling officer approves. You cannot decide a correction you proposed yourself.
        Every decision is written to the audit log.
      </p>

      {note && <Banner kind="ok">{note}</Banner>}
      {pending.error && <Banner>{pending.error}</Banner>}

      {queue.length === 0
        ? <div className="tw"><Empty title="Nothing waiting">No PPO corrections are awaiting a decision.</Empty></div>
        : queue.map((c) => <DecisionCard key={c.id} c={c} canDecide={isOfficer} onDone={done} />)}

      {decided.data && decided.data.corrections.length > 0 && (
        <div style={{ marginTop: 26 }}>
          <h2 style={{ marginBottom: 12 }}>Recently decided</h2>
          <CorrectionsTable rows={decided.data.corrections} showRecord />
        </div>
      )}
    </>
  );
}

function DecisionCard({ c, canDecide, onDone }: {
  c: Correction; canDecide: boolean; onDone: (msg: string) => void;
}) {
  const { principal } = useAuth();
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const own = c.proposed_by === principal?.id;

  async function decide(approve: boolean) {
    setBusy(true); setError(null);
    try {
      await api.post(`/corrections/${c.id}/${approve ? 'approve' : 'reject'}`, { remarks: remarks.trim() || null });
      onDone(approve
        ? `Approved. ${c.employee_name}'s record now carries PPO ${c.new_value}; ${c.old_value} stays searchable.`
        : `Rejected. ${c.employee_name}'s record keeps PPO ${c.old_value}.`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not record the decision.');
    } finally { setBusy(false); }
  }

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3><Link to={`/records/${c.service_record_id}`}>{c.employee_name}</Link></h3>
          <div className="hint" style={{ marginTop: 2 }}>
            Proposed by {c.proposed_by_name} <span className="mono">({c.proposed_by_code})</span> · {fmtDateTime(c.proposed_at)}
          </div>
        </div>
        <span className="pill warn">AWAITING OFFICER</span>
      </div>

      <dl className="detail-list">
        <dt>Current PPO</dt><dd className="mono">{c.old_value}</dd>
        <dt>Proposed PPO</dt><dd className="mono"><strong>{c.new_value}</strong></dd>
        <dt>Reason</dt><dd>{c.reason}</dd>
      </dl>

      {error && <div style={{ marginTop: 12 }}><Banner>{error}</Banner></div>}

      {own ? (
        <div style={{ marginTop: 12 }}>
          <Banner kind="warn">You proposed this correction, so another controlling officer must decide it.</Banner>
        </div>
      ) : canDecide && (
        <div style={{ marginTop: 14 }}>
          <div className="field">
            <label htmlFor={`rm-${c.id}`}>Remarks <span style={{ fontWeight: 400 }}>(needed to reject)</span></label>
            <textarea id={`rm-${c.id}`} value={remarks} onChange={(e) => setRemarks(e.target.value)}
              placeholder="e.g. Checked against PSO register" />
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="primary" disabled={busy} onClick={() => void decide(true)}>Approve and apply</button>
            <button className="danger" disabled={busy || !remarks.trim()} onClick={() => void decide(false)}>Reject</button>
          </div>
        </div>
      )}
    </div>
  );
}
