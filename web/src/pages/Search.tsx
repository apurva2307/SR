import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, type SearchHit } from '../api';
import { useAuth } from '../auth';
import { AccessPill, Banner, Empty, Spinner } from '../components/bits';
import { daysLeft, fmtDate } from '../hooks';

const DURATIONS = [15, 30, 90];

export function SearchPage() {
  const { isAccounts, principal } = useAuth();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [basketOpen, setBasketOpen] = useState(false);

  const run = useCallback(async (query: string) => {
    if (!query.trim()) { setHits(null); setError(null); return; }
    setBusy(true); setError(null);
    try {
      const out = await api.get<{ hits: SearchHit[]; total: number }>(
        `/records?q=${encodeURIComponent(query)}`);
      setHits(out.hits);
      setTotal(out.total);
    } catch (e) {
      setHits(null);
      setError(e instanceof ApiError ? e.message : 'Search failed.');
    } finally { setBusy(false); }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void run(q), 280);
    return () => clearTimeout(t);
  }, [q, run]);

  const toggle = (id: string) => setPicked((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  return (
    <>
      <div className="page-head"><h1>Search the catalogue</h1></div>
      <p className="dek">
        By PPO number or by name. Everyone can find a record; opening one needs a grant.
        {!isAccounts && ' Select the records you need and raise a request for them together.'}
      </p>

      <div className="card">
        <label htmlFor="q">PPO number or employee name</label>
        <input id="q" value={q} autoFocus placeholder="410221100347  ·  Ram Kumar Sharma  ·  sharma ram"
          onChange={(e) => setQ(e.target.value)} />
        <p className="hint">
          Word order does not matter, and honorifics are ignored — “sharma ram” finds “Shri Ram Kumar Sharma”.
        </p>
      </div>

      {error && <div style={{ marginTop: 16 }}><Banner>{error}</Banner></div>}
      {busy && <Spinner label="Searching…" />}

      {hits && !busy && (
        <div style={{ marginTop: 18 }}>
          {hits.length === 0 ? (
            <div className="tw"><Empty title="No records matched">
              Try the PPO number, or a surname on its own.
            </Empty></div>
          ) : (
            <>
              <p className="dek" style={{ marginBottom: 10 }}>
                {total} {total === 1 ? 'record' : 'records'} matched.
              </p>
              <div className="tw">
                <table>
                  <thead>
                    <tr>
                      {!isAccounts && <th style={{ width: 34 }}></th>}
                      <th>PPO number</th><th>Employee</th><th>Pages</th>
                      <th>Indexed</th><th>Access</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {hits.map((h) => (
                      <tr key={h.id} className="selectable">
                        {!isAccounts && (
                          <td>
                            <input type="checkbox" style={{ width: 'auto' }}
                              checked={picked.has(h.id)}
                              disabled={h.accessState === 'GRANTED' || h.accessState === 'PENDING'}
                              aria-label={`Select ${h.employeeName}`}
                              onChange={() => toggle(h.id)} />
                          </td>
                        )}
                        <td className="mono nowrap">{h.ppoNumber}</td>
                        <td>{h.employeeName}</td>
                        <td className="mono">{h.pageCount ?? '—'}</td>
                        <td className="nowrap">{fmtDate(h.indexedAt)}</td>
                        <td><AccessPill state={h.accessState} daysLeft={daysLeft(h.grantValidUntil)} /></td>
                        <td className="nowrap">
                          <button className="small" onClick={() => navigate(`/records/${h.id}`)}>Details</button>
                          {(h.accessState === 'GRANTED' || h.accessState === 'CUSTODIAL') && (
                            <button className="small primary" style={{ marginLeft: 6 }}
                              onClick={() => navigate(`/records/${h.id}/view`)}>Read</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {picked.size > 0 && !basketOpen && (
        <div className="basket-bar">
          <strong>{picked.size} selected</strong>
          <span className="spacer" />
          <button onClick={() => setPicked(new Set())}>Clear</button>
          <button onClick={() => setBasketOpen(true)}>Request access →</button>
        </div>
      )}

      {basketOpen && (
        <Basket
          records={(hits ?? []).filter((h) => picked.has(h.id))}
          deptKind={principal?.departmentKind ?? 'USER_DEPT'}
          onCancel={() => setBasketOpen(false)}
          onDone={() => { setBasketOpen(false); setPicked(new Set()); navigate('/requests'); }}
        />
      )}
    </>
  );
}

function Basket({ records, onCancel, onDone }: {
  records: SearchHit[]; deptKind: string; onCancel: () => void; onDone: () => void;
}) {
  const [purpose, setPurpose] = useState('');
  const [reference, setReference] = useState('');
  const [days, setDays] = useState(15);
  const [custom, setCustom] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const from = new Date();
  const to = new Date(from.getTime() + days * 86_400_000);

  async function submit() {
    setBusy(true); setError(null);
    try {
      const { id } = await api.post<{ id: string }>('/requests', {
        recordIds: records.map((r) => r.id),
      });
      await api.post(`/requests/${id}/submit`, {
        purpose: purpose.trim(),
        fileReference: reference.trim() || null,
        requestedFrom: from.toISOString(),
        requestedTo: to.toISOString(),
      });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not submit the request.');
    } finally { setBusy(false); }
  }

  return (
    <div className="card" style={{ marginTop: 18 }}>
      <div className="card-head">
        <h2>Request access to {records.length} {records.length === 1 ? 'record' : 'records'}</h2>
        <button className="ghost small" onClick={onCancel}>Cancel</button>
      </div>

      {error && <Banner>{error}</Banner>}

      <div className="tw" style={{ marginBottom: 16 }}>
        <table>
          <thead><tr><th>PPO number</th><th>Employee</th><th>Pages</th></tr></thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.id}>
                <td className="mono nowrap">{r.ppoNumber}</td>
                <td>{r.employeeName}</td>
                <td className="mono">{r.pageCount ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="field">
        <label htmlFor="purpose">What do you need these records for?</label>
        <textarea id="purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)}
          placeholder="e.g. Verifying qualifying service for revision of pension in case no. PW/PEN/2026/118." />
        <p className="hint">
          At least 20 characters. This is what an auditor reads six years from now, so write it for them.
          {purpose.trim().length > 0 && purpose.trim().length < 20 &&
            ` ${20 - purpose.trim().length} more to go.`}
        </p>
      </div>

      <div className="field">
        <label htmlFor="ref">File reference (optional)</label>
        <input id="ref" value={reference} onChange={(e) => setReference(e.target.value)}
          placeholder="PW/PEN/2026/118" />
      </div>

      <div className="field">
        <label>How long do you need them?</label>
        <div className="duration-row">
          {DURATIONS.map((d) => (
            <button key={d} className={!custom && days === d ? 'on' : ''}
              onClick={() => { setCustom(false); setDays(d); }}>{d} days</button>
          ))}
          <button className={custom ? 'on' : ''} onClick={() => setCustom(true)}>Custom</button>
          {custom && (
            <input type="number" min={1} max={180} value={days} style={{ width: 100 }}
              onChange={(e) => setDays(Math.min(180, Math.max(1, Number(e.target.value))))} />
          )}
        </div>
        <p className="hint">
          Asking until <strong>{to.toLocaleDateString(undefined,
            { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</strong>.
          The approver may grant a shorter period.
        </p>
      </div>

      <button className="primary" disabled={busy || purpose.trim().length < 20} onClick={() => void submit()}>
        {busy ? 'Submitting…' : 'Submit request'}
      </button>
    </div>
  );
}
