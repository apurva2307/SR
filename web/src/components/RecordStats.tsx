import { useLoad, fmtDateTime } from '../hooks';

interface Stats {
  active: number; superseded: number; archived: number;
  pages: number; quarantined: number; last_scan: string | null;
}

const n = (v: number) => v.toLocaleString();

/**
 * How many service records are on file. Counts only, for the administrator
 * and the custodian; `version` lets a page refresh it after a scan.
 */
export function RecordStats({ version = 0 }: { version?: number }) {
  const { data, error } = useLoad<Stats>('/admin/record-stats', [version]);
  if (error) return null;

  return (
    <div className="stats" aria-busy={!data}>
      <div className="stat">
        <span className="stat-label">Records on file</span>
        <span className="stat-value">{data ? n(data.active) : '—'}</span>
        <span className="stat-note">searchable now</span>
      </div>
      <div className="stat">
        <span className="stat-label">Pages</span>
        <span className="stat-value">{data ? n(data.pages) : '—'}</span>
        <span className="stat-note">including added pages</span>
      </div>
      <div className="stat">
        <span className="stat-label">Earlier versions</span>
        <span className="stat-value">{data ? n(data.superseded + data.archived) : '—'}</span>
        <span className="stat-note">
          {data ? `${n(data.superseded)} superseded · ${n(data.archived)} archived` : ' '}
        </span>
      </div>
      <div className="stat">
        <span className="stat-label">In quarantine</span>
        <span className={`stat-value${data && data.quarantined > 0 ? ' warn' : ''}`}>
          {data ? n(data.quarantined) : '—'}
        </span>
        <span className="stat-note">last scan {fmtDateTime(data?.last_scan)}</span>
      </div>
    </div>
  );
}
