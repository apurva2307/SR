import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { Banner, Spinner } from '../components/bits';
import { daysLeft } from '../hooks';

interface Detail {
  record: { id: string; ppo_number: string; employee_name: string; page_count: number | null };
  access: { allowed: boolean; via?: string; validUntil?: string; reason?: string };
}

/**
 * Screen-only, and structurally so: this component asks for page images. There
 * is no endpoint that would give it the PDF, so there is nothing to add a
 * download button to (§4.1).
 */
export function ViewerPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [page, setPage] = useState(1);
  const [src, setSrc] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const objectUrl = useRef<string | null>(null);

  useEffect(() => {
    api.get<Detail>(`/records/${id}`).then((d) => {
      setDetail(d);
      setPageCount(d.record.page_count);
    }).catch((e) => setError(e instanceof ApiError ? e.message : 'Could not open this record.'));
  }, [id]);

  const loadPage = useCallback(async (n: number) => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/records/${id}/page/${n}`, { credentials: 'same-origin' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new ApiError(body.error ?? 'ERROR', body.message ?? 'That page could not be opened.', res.status);
      }
      const count = res.headers.get('X-Page-Count');
      if (count) setPageCount(Number(count));
      const blob = await res.blob();
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = URL.createObjectURL(blob);
      setSrc(objectUrl.current);
    } catch (e) {
      setSrc(null);
      setError(e instanceof ApiError ? e.message : 'That page could not be opened.');
    } finally { setLoading(false); }
  }, [id]);

  useEffect(() => { void loadPage(page); }, [page, loadPage]);

  // Close the sitting so the audit log records a range rather than an open session.
  useEffect(() => () => {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    void api.post(`/records/${id}/close-view`).catch(() => {});
  }, [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') setPage((p) => Math.min(pageCount ?? p, p + 1));
      if (e.key === 'ArrowLeft') setPage((p) => Math.max(1, p - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pageCount]);

  const left = daysLeft(detail?.access.validUntil);

  return (
    <div className="viewer">
      <div className="page-head">
        <div>
          <h1>{detail?.record.employee_name ?? 'Service record'}</h1>
          <p className="dek" style={{ marginBottom: 0 }}>
            <span className="mono">{detail?.record.ppo_number}</span>
            {detail?.access.via === 'CUSTODIAL_ROLE' && ' · opened as Accounts staff'}
          </p>
        </div>
        <button onClick={() => navigate(-1)}>← Back</button>
      </div>

      {error && <Banner>{error}</Banner>}

      <div className="viewer-bar">
        <button className="small" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>← Previous</button>
        <span className="mono">
          Page {page}{pageCount ? ` of ${pageCount}` : ''}
        </span>
        <button className="small" disabled={!!pageCount && page >= pageCount}
          onClick={() => setPage((p) => p + 1)}>Next →</button>
        <span className="spacer" />
        {left != null && (
          <span className="countdown">
            {left <= 0 ? 'Access ends today' : `Access ends in ${left} day${left === 1 ? '' : 's'}`}
          </span>
        )}
        <span className="pill neutral">SCREEN ONLY</span>
      </div>

      <div className="page-frame">
        {loading && !src ? <Spinner label="Rendering page…" />
          : src ? <img src={src} alt={`Page ${page}`} draggable={false} />
          : <Spinner label="Nothing to show." />}
      </div>

      <p className="hint">
        This page is a rendered image, watermarked with your name and staff code. The document
        itself never leaves the server, and every page you open is recorded.
      </p>
    </div>
  );
}
