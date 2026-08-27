import { useNavigate, useParams } from 'react-router-dom';
import { useLoad, fmtDateTime, fmtDate } from '../hooks';
import { Banner, ItemPill, Spinner } from '../components/bits';

interface Detail {
  record: {
    id: string; ppo_number: string; employee_name: string; page_count: number | null;
    byte_size: string; indexed_at: string; last_verified_at: string | null;
    status: string; version_no: number; metadata: Record<string, unknown>;
  };
  access: { allowed: boolean; via?: string; validUntil?: string; reason?: string };
  myRequests: {
    request_no: string; request_status: string; purpose: string; submitted_at: string;
    item_status: string; decided_at: string | null; decision_remarks: string | null;
  }[];
}

export function RecordPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, error, loading } = useLoad<Detail>(`/records/${id}`);

  if (loading) return <Spinner />;
  if (error || !data) return <Banner>{error ?? 'Not found.'}</Banner>;

  const { record, access, myRequests } = data;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{record.employee_name}</h1>
          <p className="dek" style={{ marginBottom: 0 }}>
            <span className="mono">{record.ppo_number}</span>
          </p>
        </div>
        {access.allowed && (
          <button className="primary" onClick={() => navigate(`/records/${id}/view`)}>Read on screen</button>
        )}
      </div>

      <div className="grid" style={{ marginTop: 18 }}>
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>Record</h3>
          <dl className="detail-list">
            <dt>Pages</dt><dd className="mono">{record.page_count ?? '—'}</dd>
            <dt>Size</dt><dd className="mono">{(Number(record.byte_size) / 1024).toFixed(0)} KB</dd>
            <dt>Version</dt><dd className="mono">{record.version_no}</dd>
            <dt>Status</dt><dd>{record.status}</dd>
            <dt>Indexed</dt><dd>{fmtDateTime(record.indexed_at)}</dd>
            <dt>Verified</dt><dd>{fmtDateTime(record.last_verified_at)}</dd>
          </dl>
        </div>

        <div className="card">
          <h3 style={{ marginBottom: 12 }}>Your access</h3>
          {access.allowed ? (
            access.via === 'CUSTODIAL_ROLE' ? (
              <Banner kind="ok">
                <strong>Open as Accounts staff.</strong> You can read any record. This read is logged
                as custodial access and is filterable as such in the audit log.
              </Banner>
            ) : (
              <Banner kind="ok">
                <strong>Granted until {fmtDate(access.validUntil)}.</strong> Access closes by itself
                on that date — no action needed.
              </Banner>
            )
          ) : (
            <Banner kind="warn">
              <strong>No access.</strong> Search for this record and select it to raise a request.
            </Banner>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h3 style={{ marginBottom: 12 }}>Your requests for this record</h3>
        {myRequests.length === 0 ? (
          <p className="hint">You have not requested this record.</p>
        ) : (
          <div className="tw">
            <table>
              <thead>
                <tr><th>Request</th><th>Submitted</th><th>Item</th><th>Decided</th><th>Remarks</th></tr>
              </thead>
              <tbody>
                {myRequests.map((r) => (
                  <tr key={r.request_no}>
                    <td className="mono nowrap">{r.request_no}</td>
                    <td className="nowrap">{fmtDate(r.submitted_at)}</td>
                    <td><ItemPill status={r.item_status} /></td>
                    <td className="nowrap">{fmtDate(r.decided_at)}</td>
                    <td>{r.decision_remarks ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
