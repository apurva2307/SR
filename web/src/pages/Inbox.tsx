import { useState } from 'react';
import { api, ApiError } from '../api';
import type { AccessRequest, LiveAuthority } from '../api';
import { useLoad, fmtDate, fmtDateTime, daysLeft } from '../hooks';
import { Banner, Empty, ItemPill, Spinner } from '../components/bits';

const DURATIONS = [15, 30, 90];

export function InboxPage() {
  const inbox = useLoad<{ requests: AccessRequest[] }>('/requests?scope=inbox');
  const mine = useLoad<{ authority: LiveAuthority | null }>('/requests/my-authority');

  if (inbox.loading || mine.loading) return <Spinner />;

  const authority = mine.data?.authority ?? null;
  const requests = (inbox.data?.requests ?? []).filter((r) => r.status === 'SUBMITTED');
  const left = daysLeft(authority?.effectiveTo);

  return (
    <>
      <div className="page-head"><h1>Approver inbox</h1></div>
      <p className="dek">
        Requests raised by other people. Your own never appear here — deciding a request
        you raised is refused by the server, not just hidden.
      </p>

      {authority ? (
        <Banner kind={left != null && left <= 14 ? 'warn' : 'ok'}>
          <strong>Live authority</strong> — you may release records
          {authority.scopeDeptIds ? ' to your scoped departments' : ' to any user department'}
          {' '}until {fmtDate(authority.effectiveTo)}
          {left != null && left <= 14 && ` · ${left} day${left === 1 ? '' : 's'} left`}.
        </Banner>
      ) : (
        <Banner kind="warn">
          <strong>You hold no live approval authority.</strong> You can read any record, but you
          cannot release one to another department until a controlling officer issues you an
          authority.
        </Banner>
      )}

      {inbox.error && <Banner>{inbox.error}</Banner>}

      {requests.length === 0
        ? <div className="tw"><Empty title="Nothing waiting">The queue is clear.</Empty></div>
        : requests.map((r) => (
          <DecisionCard key={r.id} request={r} canDecide={!!authority} onDone={() => void inbox.reload()} />
        ))}
    </>
  );
}

function DecisionCard({ request, canDecide, onDone }: {
  request: AccessRequest; canDecide: boolean; onDone: () => void;
}) {
  const pending = (request.items ?? []).filter((i) => i.id && i.status === 'PENDING');
  // What the requester asked for, so the officer starts from it rather than a
  // default they have to remember to change.
  const askedDays = request.requested_from && request.requested_to
    ? Math.max(1, Math.round(
      (Date.parse(request.requested_to) - Date.parse(request.requested_from)) / 86_400_000))
    : null;
  const [days, setDays] = useState(askedDays ? Math.min(180, askedDays) : 15);
  const [custom, setCustom] = useState(askedDays != null && !DURATIONS.includes(askedDays));
  const [remarks, setRemarks] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(new Set(pending.map((i) => i.id)));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const until = new Date(Date.now() + days * 86_400_000);

  async function decide(action: 'APPROVE' | 'REJECT') {
    setBusy(true); setError(null);
    try {
      await api.post(`/requests/${request.id}/decision`, {
        decisions: [...chosen].map((itemId) => ({
          itemId, action, remarks: remarks.trim() || null,
          ...(action === 'APPROVE'
            ? { grantedFrom: new Date().toISOString(), grantedTo: until.toISOString() }
            : {}),
        })),
      });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The decision could not be recorded.');
    } finally { setBusy(false); }
  }

  const toggle = (id: string) => setChosen((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2><span className="mono">{request.request_no}</span></h2>
          <p className="hint" style={{ marginTop: 4 }}>
            {request.requester_name} ({request.requester_code}) · {request.requester_dept}
            {' · '}submitted {fmtDateTime(request.submitted_at)}
          </p>
        </div>
      </div>

      {error && <Banner>{error}</Banner>}

      {askedDays != null && (
        <p style={{ fontSize: '0.88rem' }}>
          Asked for <strong>{askedDays} {askedDays === 1 ? 'day' : 'days'}</strong>
          {' '}({fmtDate(request.requested_from)} – {fmtDate(request.requested_to)})
        </p>
      )}

      <p style={{ fontSize: '0.88rem', color: 'var(--ink-2)' }}>{request.purpose}</p>

      <div className="tw" style={{ margin: '12px 0 16px' }}>
        <table>
          <thead>
            <tr><th style={{ width: 34 }}></th><th>PPO number</th><th>Employee</th><th>Pages</th><th>Status</th></tr>
          </thead>
          <tbody>
            {(request.items ?? []).filter((i) => i.id).map((i) => (
              <tr key={i.id}>
                <td>
                  <input type="checkbox" style={{ width: 'auto' }}
                    disabled={i.status !== 'PENDING' || !canDecide}
                    checked={chosen.has(i.id)} onChange={() => toggle(i.id)}
                    aria-label={`Select ${i.employeeName}`} />
                </td>
                <td className="mono nowrap">{i.ppoNumber}</td>
                <td>{i.employeeName}</td>
                <td className="mono">{i.pageCount ?? '—'}</td>
                <td><ItemPill status={i.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="field">
        <label>Release for how long?</label>
        <div className="duration-row">
          {DURATIONS.map((d) => (
            <button key={d} className={!custom && days === d ? 'on' : ''} disabled={!canDecide}
              onClick={() => { setCustom(false); setDays(d); }}>{d} days</button>
          ))}
          <button className={custom ? 'on' : ''} disabled={!canDecide}
            onClick={() => setCustom(true)}>Custom</button>
          {custom && (
            <input type="number" min={1} max={180} value={days} style={{ width: 100 }}
              onChange={(e) => setDays(Math.min(180, Math.max(1, Number(e.target.value))))} />
          )}
        </div>
        <p className="hint">
          Access ends <strong>{until.toLocaleDateString(undefined,
            { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</strong>.
          You may release for less than was asked.
        </p>
      </div>

      <div className="field">
        <label htmlFor={`rm-${request.id}`}>Remarks (optional)</label>
        <input id={`rm-${request.id}`} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button className="primary" disabled={!canDecide || busy || chosen.size === 0}
          onClick={() => void decide('APPROVE')}>
          Approve {chosen.size} {chosen.size === 1 ? 'record' : 'records'}
        </button>
        <button className="danger" disabled={!canDecide || busy || chosen.size === 0}
          onClick={() => void decide('REJECT')}>Reject</button>
      </div>
    </div>
  );
}
