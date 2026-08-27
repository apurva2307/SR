import { useState } from 'react';
import { useLoad, fmtDateTime } from '../hooks';
import { Banner, Empty, Spinner } from '../components/bits';

interface Event {
  seq: string; occurred_at: string; event_type: string; outcome: string;
  detail: Record<string, unknown>; actor_ip: string | null;
  actor_name: string | null; actor_code: string | null; actor_designation: string | null;
  ppo_number: string | null; employee_name: string | null;
}

interface Session {
  id: string; opened_at: string; closed_at: string | null; pages_served: number;
  first_page: number | null; last_page: number | null; via?: string;
  actor_name: string; actor_code: string; actor_designation: string | null;
  ppo_number: string; employee_name: string;
}

/**
 * Who did it: name, the post they hold, and the staff code that identifies them
 * in an office order.
 *
 * These are the account's values now, not as they read on the day. A rename is
 * itself a USER_PROFILE_UPDATED event carrying both sides, so the log can still
 * answer what someone was called at any point — but this column shows who to go
 * and find today, which is what an auditor is usually after.
 */
function Actor({ name, designation, code, ip }: {
  name: string | null; designation: string | null; code: string | null; ip?: string | null;
}) {
  const muted = { color: 'var(--muted)', fontSize: '0.75rem' } as const;
  // No account: a scheduled job, or the bootstrap that ran before any user existed.
  if (!name) return <span style={muted}>System</span>;
  return (
    <>
      {name}
      {designation && <div style={muted}>{designation}</div>}
      <div className="mono" style={muted}>
        {code}{ip ? ` · ${ip}` : ''}
      </div>
    </>
  );
}

type View = 'all' | 'denials' | 'custodial' | 'sessions';

const VIEWS: { key: View; label: string; path: string; hint: string }[] = [
  { key: 'all', label: 'Everything', path: '/audit?limit=200',
    hint: 'Every recorded action, newest first.' },
  { key: 'denials', label: 'Denials, 24h', path: '/audit/denials',
    hint: 'Refused reads and refused decisions. A run of these against one person is the pattern worth chasing.' },
  { key: 'custodial', label: 'Custodial reads', path: '/audit/custodial-reads',
    hint: 'Records opened by Accounts staff by virtue of the role, not under a grant.' },
  { key: 'sessions', label: 'Reading sessions', path: '/audit/view-sessions',
    hint: 'One row per sitting. Page-level rows sit underneath and are not aggregated away.' },
];

export function AuditPage() {
  const [view, setView] = useState<View>('all');
  const spec = VIEWS.find((v) => v.key === view)!;
  const { data, error, loading } = useLoad<{ events?: Event[]; sessions?: Session[] }>(spec.path, [view]);
  const chain = useLoad<{ intact: boolean; brokenAt: number | null }>('/audit/verify-chain');

  return (
    <>
      <div className="page-head">
        <h1>Audit log</h1>
        <a className="btn" href="/api/audit?format=csv&limit=500">Export CSV</a>
      </div>
      <p className="dek">{spec.hint}</p>

      {chain.data && (
        <Banner kind={chain.data.intact ? 'ok' : 'error'}>
          {chain.data.intact
            ? <>Hash chain verified — no event has been altered or removed.</>
            : <><strong>Chain broken at #{chain.data.brokenAt}.</strong> An event was altered or
                removed directly in the database. Escalate this.</>}
        </Banner>
      )}

      <div className="duration-row" style={{ marginBottom: 16 }}>
        {VIEWS.map((v) => (
          <button key={v.key} className={view === v.key ? 'on' : ''} onClick={() => setView(v.key)}>
            {v.label}
          </button>
        ))}
      </div>

      {loading ? <Spinner /> : error ? <Banner>{error}</Banner> : (
        view === 'custodial' || view === 'sessions'
          ? <SessionTable rows={data?.sessions ?? []} />
          : <EventTable rows={data?.events ?? []} />
      )}
    </>
  );
}

function EventTable({ rows }: { rows: Event[] }) {
  if (rows.length === 0) return <div className="tw"><Empty title="Nothing recorded in this view" /></div>;
  return (
    <div className="tw">
      <table>
        <thead>
          <tr><th>#</th><th>When</th><th>Event</th><th>Who</th><th>Record</th><th>Detail</th></tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.seq}>
              <td className="mono">{e.seq}</td>
              <td className="nowrap">{fmtDateTime(e.occurred_at)}</td>
              <td>
                <span className={`pill ${e.outcome === 'DENY' ? 'stop' : 'neutral'}`}>{e.event_type}</span>
              </td>
              <td>
                <Actor name={e.actor_name} designation={e.actor_designation}
                  code={e.actor_code} ip={e.actor_ip} />
              </td>
              <td>
                {e.ppo_number
                  ? <><span className="mono">{e.ppo_number}</span>
                      <div style={{ color: 'var(--muted)', fontSize: '0.78rem' }}>{e.employee_name}</div></>
                  : '—'}
              </td>
              <td style={{ fontSize: '0.78rem', color: 'var(--muted)', maxWidth: 280 }} className="mono">
                {Object.keys(e.detail ?? {}).length ? JSON.stringify(e.detail) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SessionTable({ rows }: { rows: Session[] }) {
  if (rows.length === 0) return <div className="tw"><Empty title="No reading sessions in this view" /></div>;
  return (
    <div className="tw">
      <table>
        <thead>
          <tr><th>Opened</th><th>Who</th><th>Record</th><th>Pages</th><th>Range</th><th>Closed</th></tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id}>
              <td className="nowrap">{fmtDateTime(s.opened_at)}</td>
              <td>
                <Actor name={s.actor_name} designation={s.actor_designation} code={s.actor_code} />
              </td>
              <td><span className="mono">{s.ppo_number}</span>
                <div style={{ color: 'var(--muted)', fontSize: '0.78rem' }}>{s.employee_name}</div></td>
              <td className="mono">{s.pages_served}</td>
              <td className="mono">
                {s.first_page != null ? `${s.first_page}–${s.last_page}` : '—'}
              </td>
              <td className="nowrap">{s.closed_at ? fmtDateTime(s.closed_at) : <span className="pill warn">OPEN</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
