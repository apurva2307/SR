import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { PageLayout } from '../api';
import { useAuth } from '../auth';
import { useLoad, fmtDateTime, fmtDate } from '../hooks';
import { Banner, ItemPill, Spinner } from '../components/bits';
import { AddPages, AdditionsHistory } from '../components/Additions';
import { RecordCorrections } from '../components/Corrections';

interface Detail {
  record: {
    id: string; ppo_number: string; employee_name: string; page_count: number | null;
    added_page_count: number; byte_size: string; indexed_at: string; last_verified_at: string | null;
    status: string; version_no: number; metadata: Record<string, unknown>;
  };
  access: { allowed: boolean; via?: string; validUntil?: string; reason?: string };
  myRequests: {
    request_no: string; request_status: string; purpose: string; submitted_at: string;
    item_status: string; decided_at: string | null; decision_remarks: string | null;
  }[];
  /** Only present when the reader may open the record. */
  pages: PageLayout | null;
}

export function RecordPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const { data, error, loading, reload } = useLoad<Detail>(`/records/${id}`);
  const [note, setNote] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  if (loading && !data) return <Spinner />;
  if (error || !data) return <Banner>{error ?? 'Not found.'}</Banner>;

  const { record, access, myRequests, pages } = data;
  const isCustodian = can('CUSTODIAN');
  const added = (pages?.segments ?? []).filter((s) => s.kind === 'ADDITION');
  const changed = (msg?: string) => {
    setNote(msg ?? null);
    setRefreshKey((k) => k + 1);
    void reload();
  };

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
            <dt>Pages</dt>
            <dd className="mono">
              {record.page_count == null ? '—' : record.page_count + record.added_page_count}
              {record.added_page_count > 0 && (
                <span style={{ color: 'var(--muted)' }}>
                  {' '}({record.page_count} original + {record.added_page_count} added)
                </span>
              )}
            </dd>
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

      {note && <div style={{ marginTop: 14 }}><Banner kind="ok">{note}</Banner></div>}

      {added.length > 0 && !isCustodian && (
        <div className="card" style={{ marginTop: 14 }}>
          <h3 style={{ marginBottom: 12 }}>Pages added after the original</h3>
          <div className="tw">
            <table>
              <thead><tr><th>Pages</th><th>Description</th><th>Document date</th><th>Added</th></tr></thead>
              <tbody>
                {added.map((s) => (
                  <tr key={s.additionId}>
                    <td className="mono nowrap">{s.firstPage === s.lastPage ? s.firstPage : `${s.firstPage}–${s.lastPage}`}</td>
                    <td>{s.description}</td>
                    <td className="nowrap">{fmtDate(s.documentDate)}</td>
                    <td className="nowrap">{fmtDate(s.uploadedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {isCustodian && (
        <>
          <AdditionsHistory recordId={record.id} layout={pages} refreshKey={refreshKey}
            onChanged={() => changed('Those pages were withdrawn. Later pages have moved up.')} />
          {record.status === 'ACTIVE' ? (
            <AddPages recordId={record.id} employeeName={record.employee_name}
              ppo={record.ppo_number} onAdded={(msg) => changed(msg)} />
          ) : (
            <div style={{ marginTop: 14 }}>
              <Banner kind="warn">This version has been superseded. Add pages to the current version.</Banner>
            </div>
          )}
        </>
      )}

      {can('CUSTODIAN', 'CONTROLLING_OFFICER', 'AUDITOR') && (
        <RecordCorrections key={refreshKey} recordId={record.id} employeeName={record.employee_name}
          ppo={record.ppo_number} active={record.status === 'ACTIVE'} onChanged={(msg) => changed(msg)} />
      )}

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
