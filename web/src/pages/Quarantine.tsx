import { useState } from 'react';
import { api, ApiError } from '../api';
import { useLoad, fmtDateTime } from '../hooks';
import { Banner, Empty, Spinner } from '../components/bits';
import { RecordStats } from '../components/RecordStats';

interface Item {
  id: string; raw_path: string; raw_filename: string; reason: string;
  detail: Record<string, unknown>; suggested_ppo: string | null;
  suggested_name: string | null; created_at: string;
  /** Live pages added to the record this file would supersede. */
  prior_additions: number;
}

interface Run {
  id: string; started_at: string; finished_at: string | null;
  files_seen: number; added: number; quarantined: number;
  errors: unknown[]; triggered_by_name: string | null;
}

const WHY: Record<string, string> = {
  UNPARSEABLE: 'No known pattern matched this filename. Nothing was guessed.',
  PPO_CONFLICT: 'This PPO is already on file under a different name. A person has to look.',
  NEW_VERSION: 'Same PPO and name, new contents. Accepting supersedes the earlier version and keeps it.',
  UNREADABLE: 'The file could not be opened — usually a failed scan upstream.',
  DUPLICATE: 'These exact bytes are already indexed at another path.',
};

export function QuarantinePage() {
  const items = useLoad<{ items: Item[] }>('/custody/quarantine');
  const runs = useLoad<{ runs: Run[] }>('/custody/ingestion/runs');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [scans, setScans] = useState(0);

  async function scan() {
    setBusy(true); setProblem(null); setNote(null);
    try {
      const s = await api.post<{ filesSeen: number; added: number; quarantined: number }>(
        '/custody/ingestion/scan');
      setNote(`Scanned ${s.filesSeen} file(s): ${s.added} indexed, ${s.quarantined} quarantined.`);
      await Promise.all([items.reload(), runs.reload()]);
      setScans((v) => v + 1);
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : 'The scan failed.');
    } finally { setBusy(false); }
  }

  if (items.loading) return <Spinner />;
  const open = items.data?.items ?? [];

  return (
    <>
      <div className="page-head">
        <h1>Quarantine</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => void api.post('/custody/integrity/verify').then(() => setNote('Integrity slice verified.'))}>
            Verify integrity
          </button>
          <button className="primary" disabled={busy} onClick={() => void scan()}>
            {busy ? 'Scanning…' : 'Scan folder now'}
          </button>
        </div>
      </div>
      <p className="dek">
        Files the parser could not place with confidence. They stay invisible to search until you
        resolve them — a record findable under the wrong name is worse than one not findable at all.
      </p>

      {note && <Banner kind="ok">{note}</Banner>}
      {problem && <Banner>{problem}</Banner>}

      <RecordStats version={scans} />

      {open.length === 0
        ? <div className="tw"><Empty title="Nothing waiting">
            Every file in the folder is either indexed or already resolved.
          </Empty></div>
        : open.map((i) => <ResolveCard key={i.id} item={i} onDone={() => void items.reload()} />)}

      <h2 style={{ margin: '28px 0 12px' }}>Recent scans</h2>
      <div className="tw">
        <table>
          <thead>
            <tr><th>Started</th><th>By</th><th>Seen</th><th>Indexed</th><th>Quarantined</th><th>Errors</th></tr>
          </thead>
          <tbody>
            {(runs.data?.runs ?? []).map((r) => (
              <tr key={r.id}>
                <td className="nowrap">{fmtDateTime(r.started_at)}</td>
                <td>{r.triggered_by_name ?? 'Scheduled'}</td>
                <td className="mono">{r.files_seen}</td>
                <td className="mono">{r.added}</td>
                <td className="mono">{r.quarantined}</td>
                <td className="mono">{(r.errors ?? []).length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ResolveCard({ item, onDone }: { item: Item; onDone: () => void }) {
  const [ppo, setPpo] = useState(item.suggested_ppo ?? '');
  const [name, setName] = useState(item.suggested_name ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function resolve(resolution: string, carryAdditions?: boolean) {
    setBusy(true); setError(null);
    try {
      await api.post(`/custody/quarantine/${item.id}/resolve`,
        { resolution, ppo, name, ...(carryAdditions === undefined ? {} : { carryAdditions }) });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not resolve this item.');
    } finally { setBusy(false); }
  }

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3 className="mono">{item.raw_filename}</h3>
          <p className="hint" style={{ marginTop: 4 }}>
            <span className="pill warn">{item.reason}</span>{' '}
            {WHY[item.reason] ?? ''} · found {fmtDateTime(item.created_at)}
          </p>
        </div>
      </div>

      {error && <Banner>{error}</Banner>}

      {typeof item.detail['detail'] === 'string' && (
        <p className="hint" style={{ marginBottom: 12 }}>{item.detail['detail']}</p>
      )}
      {item.reason === 'PPO_CONFLICT' && (
        <Banner kind="warn">
          Already on file as <strong>{String(item.detail['existingName'])}</strong>;
          this file says <strong>{String(item.detail['incomingName'])}</strong>.
          A correction, a namesake, or a filing error — only you can tell.
        </Banner>
      )}

      {item.reason === 'NEW_VERSION' && item.prior_additions > 0 && (
        <Banner kind="warn">
          The earlier version has <strong>{item.prior_additions} addition{item.prior_additions === 1 ? '' : 's'}</strong>{' '}
          of pages uploaded since it was indexed. If this new scan already includes those papers, leave them
          with the old version; if not, carry them over so they follow the new scan.
        </Banner>
      )}

      <div className="row">
        <div className="field">
          <label htmlFor={`ppo-${item.id}`}>PPO number</label>
          <input id={`ppo-${item.id}`} className="mono" value={ppo} onChange={(e) => setPpo(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`nm-${item.id}`}>Employee name</label>
          <input id={`nm-${item.id}`} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="primary" disabled={busy || !ppo.trim() || !name.trim()}
          onClick={() => void resolve('INDEXED')}>Index as a new record</button>
        {item.reason === 'NEW_VERSION' && item.prior_additions === 0 && (
          <button disabled={busy || !ppo.trim() || !name.trim()}
            onClick={() => void resolve('SUPERSEDED')}>Supersede the earlier version</button>
        )}
        {item.reason === 'NEW_VERSION' && item.prior_additions > 0 && (
          <>
            <button disabled={busy || !ppo.trim() || !name.trim()}
              onClick={() => void resolve('SUPERSEDED', true)}>Supersede, and keep the added pages</button>
            <button disabled={busy || !ppo.trim() || !name.trim()}
              onClick={() => void resolve('SUPERSEDED', false)}>Supersede — the new scan already has them</button>
          </>
        )}
        <button disabled={busy} onClick={() => void resolve('IGNORED')}>Leave out of the catalogue</button>
      </div>
      <p className="hint" style={{ marginTop: 10 }}>
        Whatever you choose is recorded against your name.
      </p>
    </div>
  );
}
