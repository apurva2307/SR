import { api } from '../api';
import type { AccessRequest } from '../api';
import { useLoad, fmtDate, fmtDateTime } from '../hooks';
import { Banner, Empty, ItemPill, RequestPill, Spinner } from '../components/bits';

export function MyRequestsPage() {
  const { data, error, loading, reload } = useLoad<{ requests: AccessRequest[] }>('/requests?scope=mine');

  if (loading) return <Spinner />;
  if (error) return <Banner>{error}</Banner>;
  const requests = data?.requests ?? [];

  return (
    <>
      <div className="page-head"><h1>My requests</h1></div>
      <p className="dek">
        Status is shown per record. A request covering five records can be partly approved,
        and reads that way here.
      </p>

      {requests.length === 0
        ? <div className="tw"><Empty title="No requests yet">
            Find records in Search and select them to raise your first request.
          </Empty></div>
        : requests.map((r) => (
          <div className="card" key={r.id}>
            <div className="card-head">
              <div>
                <h2><span className="mono">{r.request_no}</span> <RequestPill status={r.status} /></h2>
                <p className="hint" style={{ marginTop: 4 }}>
                  {r.submitted_at ? `Submitted ${fmtDateTime(r.submitted_at)}` : 'Draft'}
                  {r.requested_to && ` · asked until ${fmtDate(r.requested_to)}`}
                  {r.file_reference && ` · ref ${r.file_reference}`}
                </p>
              </div>
              {r.status === 'SUBMITTED' && (
                <button className="small" onClick={async () => {
                  await api.post(`/requests/${r.id}/withdraw`);
                  await reload();
                }}>Withdraw</button>
              )}
            </div>

            {r.purpose && <p style={{ fontSize: '0.88rem', color: 'var(--ink-2)' }}>{r.purpose}</p>}

            <div className="tw" style={{ marginTop: 12 }}>
              <table>
                <thead>
                  <tr><th>PPO number</th><th>Employee</th><th>Status</th><th>Decided</th><th>Remarks</th></tr>
                </thead>
                <tbody>
                  {(r.items ?? []).filter((i) => i.id).map((i) => (
                    <tr key={i.id}>
                      <td className="mono nowrap">{i.ppoNumber}</td>
                      <td>{i.employeeName}</td>
                      <td><ItemPill status={i.status} /></td>
                      <td className="nowrap">{fmtDate(i.decidedAt)}</td>
                      <td>{i.remarks ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
    </>
  );
}
