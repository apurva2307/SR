import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import type { PageLayout } from '../api';
import { useLoad, fmtDate, fmtDateTime } from '../hooks';
import { Banner, Spinner } from './bits';

const ACCEPT = 'application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png';
const MAX_MB = 25;

interface Staged { id: string; pageCount: number; sourceKind: 'PDF' | 'IMAGE' }

/**
 * Adding pages to a service record, in two steps. The file is uploaded and
 * held; the custodian pages through it — watermarked, as any reader would see
 * it — and only then describes it and adds it. Attaching a page to the wrong
 * employee is the mistake this exists to catch.
 */
export function AddPages({ recordId, employeeName, ppo, onAdded }: {
  recordId: string; employeeName: string; ppo: string; onAdded: (msg: string) => void;
}) {
  const [staged, setStaged] = useState<Staged | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [documentDate, setDocumentDate] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setError(null);
    if (file.size > MAX_MB * 1024 * 1024) { setError(`That file is larger than ${MAX_MB} MB.`); return; }
    setBusy(true);
    try {
      setStaged(await api.upload<Staged>(`/records/${recordId}/additions/stage`, file));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The upload failed.');
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function discard() {
    if (!staged) return;
    await api.del(`/records/${recordId}/additions/staged/${staged.id}`).catch(() => {});
    setStaged(null); setDescription(''); setDocumentDate(''); setError(null);
  }

  async function confirm() {
    if (!staged) return;
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ seq: number; firstPage: number; lastPage: number }>(
        `/records/${recordId}/additions`,
        { uploadId: staged.id, description: description.trim(), documentDate: documentDate || null });
      setStaged(null); setDescription(''); setDocumentDate('');
      onAdded(r.firstPage === r.lastPage
        ? `Added as page ${r.firstPage} (addition ${r.seq}).`
        : `Added as pages ${r.firstPage}–${r.lastPage} (addition ${r.seq}).`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not add the pages.');
    } finally { setBusy(false); }
  }

  return (
    <div className="card" style={{ marginTop: 14 }}>
      <h3 style={{ marginBottom: 6 }}>Add pages</h3>
      <p className="hint" style={{ marginBottom: 12 }}>
        New papers for this employee — a PDF, or a JPG/PNG scan or photo, up to {MAX_MB} MB.
        They are added after the last page. The original file is never changed.
      </p>
      {error && <Banner>{error}</Banner>}

      {!staged ? (
        <div className="field">
          <input ref={fileInput} type="file" accept={ACCEPT} disabled={busy}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
          {busy && <p className="hint">Checking the file…</p>}
        </div>
      ) : (
        <>
          <Banner kind="warn">
            Check these {staged.pageCount === 1 ? 'page' : `${staged.pageCount} pages`} belong to{' '}
            <strong>{employeeName}</strong> (<span className="mono">{ppo}</span>) before adding them.
          </Banner>
          <StagedPreview recordId={recordId} uploadId={staged.id} pageCount={staged.pageCount} />

          <div className="field" style={{ marginTop: 12 }}>
            <label htmlFor="add-desc">What are these pages?</label>
            <input id="add-desc" value={description} maxLength={300}
              placeholder="e.g. Increment order 2026-27"
              onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="add-date">Date on the document (optional)</label>
            <input id="add-date" type="date" value={documentDate} style={{ maxWidth: 200 }}
              onChange={(e) => setDocumentDate(e.target.value)} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="primary" disabled={busy || description.trim().length < 5}
              onClick={() => void confirm()}>
              {busy ? 'Adding…' : `Add ${staged.pageCount === 1 ? 'page' : `${staged.pageCount} pages`} to the record`}
            </button>
            <button disabled={busy} onClick={() => void discard()}>Discard</button>
          </div>
        </>
      )}
    </div>
  );
}

function StagedPreview({ recordId, uploadId, pageCount }: {
  recordId: string; uploadId: string; pageCount: number;
}) {
  const [page, setPage] = useState(1);
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const url = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    fetch(`/api/records/${recordId}/additions/staged/${uploadId}/page/${page}`, { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) throw new Error('That page could not be shown.');
        const blob = await res.blob();
        if (!live) return;
        if (url.current) URL.revokeObjectURL(url.current);
        url.current = URL.createObjectURL(blob);
        setSrc(url.current);
      })
      .catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [recordId, uploadId, page]);

  useEffect(() => () => { if (url.current) URL.revokeObjectURL(url.current); }, []);

  return (
    <div style={{ marginTop: 12 }}>
      {pageCount > 1 && (
        <div className="viewer-bar" style={{ marginBottom: 8 }}>
          <button className="small" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>← Previous</button>
          <span className="mono">Page {page} of {pageCount}</span>
          <button className="small" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}>Next →</button>
        </div>
      )}
      {error && <Banner>{error}</Banner>}
      <div className="page-frame" style={{ minHeight: 260 }}>
        {src ? <img src={src} alt={`Uploaded page ${page}`} draggable={false} style={{ maxHeight: 520 }} />
          : <Spinner label="Rendering page…" />}
      </div>
    </div>
  );
}

interface AdditionRow {
  id: string; seq: number; description: string; document_date: string | null;
  page_count: number; source_kind: string; status: 'ACTIVE' | 'WITHDRAWN';
  uploaded_at: string; uploaded_by_name: string;
  withdrawn_at: string | null; withdrawn_by_name: string | null; withdrawal_reason: string | null;
}

/** Every addition, withdrawn ones included, with where each sits in the record. */
export function AdditionsHistory({ recordId, layout, refreshKey, onChanged }: {
  recordId: string; layout: PageLayout | null; refreshKey: number; onChanged: () => void;
}) {
  const list = useLoad<{ additions: AdditionRow[] }>(`/records/${recordId}/additions`, [refreshKey]);
  const [problem, setProblem] = useState<string | null>(null);

  async function withdraw(a: AdditionRow) {
    const reason = window.prompt(
      `Withdraw addition ${a.seq} ("${a.description}")?\n\nPages after it will move up. Give the reason:`);
    if (!reason) return;
    setProblem(null);
    try {
      await api.post(`/records/${recordId}/additions/${a.id}/withdraw`, { reason });
      onChanged();
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : 'Could not withdraw those pages.');
    }
  }

  const rows = list.data?.additions ?? [];
  if (list.loading || rows.length === 0) return null;
  const where = (id: string) => layout?.segments.find((s) => s.additionId === id);

  return (
    <div className="card" style={{ marginTop: 14 }}>
      <h3 style={{ marginBottom: 12 }}>Added pages — history</h3>
      {problem && <Banner>{problem}</Banner>}
      <div className="tw">
        <table>
          <thead>
            <tr><th>#</th><th>Description</th><th>Document date</th><th>Pages</th><th>Added</th><th>State</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((a) => {
              const seg = where(a.id);
              return (
                <tr key={a.id}>
                  <td className="mono">{a.seq}</td>
                  <td>{a.description}</td>
                  <td className="nowrap">{fmtDate(a.document_date)}</td>
                  <td className="mono nowrap">
                    {seg ? (seg.firstPage === seg.lastPage ? seg.firstPage : `${seg.firstPage}–${seg.lastPage}`)
                      : `${a.page_count} p.`}
                  </td>
                  <td>
                    {fmtDateTime(a.uploaded_at)}
                    <div style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>{a.uploaded_by_name}</div>
                  </td>
                  <td>
                    {a.status === 'ACTIVE' ? <span className="pill ok">IN RECORD</span> : (
                      <>
                        <span className="pill stop">WITHDRAWN</span>
                        <div style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>
                          {a.withdrawn_by_name}, {fmtDate(a.withdrawn_at)}: {a.withdrawal_reason}
                        </div>
                      </>
                    )}
                  </td>
                  <td>
                    {a.status === 'ACTIVE' && (
                      <button className="small danger" onClick={() => void withdraw(a)}>Withdraw</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
