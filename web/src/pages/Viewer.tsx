import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import type { PageLayout } from '../api';
import { Banner, Spinner } from '../components/bits';
import { daysLeft, fmtDate } from '../hooks';

interface Detail {
  record: { id: string; ppo_number: string; employee_name: string; page_count: number | null };
  access: { allowed: boolean; via?: string; validUntil?: string; reason?: string };
  pages: PageLayout | null;
}

type CaptureKind = 'PRINT_SCREEN' | 'PRINT' | 'SAVE' | 'COPY' | 'DEVTOOLS';

interface Slot { status: 'idle' | 'loading' | 'ready' | 'error'; src?: string; error?: string }

/** A4 portrait until the first real page tells us otherwise. */
const DEFAULT_RATIO = 297 / 210;
/**
 * A page must sit in (or just below) the viewport this long before it is
 * fetched. Without it, dragging the scrollbar from page 1 to page 140 would
 * request every page in between — each one a PAGE_SERVED event, a view off a
 * capped grant, and a hit against the per-minute page limit.
 */
const DWELL_MS = 250;
/** Fetch ahead of the reader by about one screen. */
const PREFETCH_MARGIN = '100% 0px';
const MAX_CONCURRENT = 2;

/**
 * Screen-only, and structurally so: this component asks for page images. There
 * is no endpoint that would give it the PDF, so there is nothing to add a
 * download button to (§4.1).
 *
 * Pages are laid out one under another and fetched as they scroll into view,
 * so reading a long record is a scroll rather than a click per page.
 */
export function ViewerPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [ratio, setRatio] = useState(DEFAULT_RATIO);
  const [slots, setSlots] = useState<Record<number, Slot>>({});
  const [current, setCurrent] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [shielded, setShielded] = useState(false);

  const scroller = useRef<HTMLDivElement | null>(null);
  const slotEls = useRef(new Map<number, HTMLDivElement>());
  const objectUrls = useRef(new Set<string>());
  const requested = useRef(new Set<number>());
  const queue = useRef<number[]>([]);
  const inFlight = useRef(0);
  const currentRef = useRef(1);
  currentRef.current = current;

  useEffect(() => {
    api.get<Detail>(`/records/${id}`).then((d) => {
      setDetail(d);
      // Fall back to one page; the first page served carries the real count.
      setPageCount(d.pages?.total ?? d.record.page_count ?? 1);
    }).catch((e) => setError(e instanceof ApiError ? e.message : 'Could not open this record.'));
  }, [id]);

  const setSlot = (n: number, s: Slot) => setSlots((prev) => ({ ...prev, [n]: s }));

  const fetchPage = useCallback(async (n: number) => {
    setSlot(n, { status: 'loading' });
    try {
      const res = await fetch(`/api/records/${id}/page/${n}`, { credentials: 'same-origin' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new ApiError(body.error ?? 'ERROR', body.message ?? 'That page could not be opened.', res.status);
      }
      const count = res.headers.get('X-Page-Count');
      if (count) setPageCount(Number(count));
      const w = Number(res.headers.get('X-Page-Width'));
      const h = Number(res.headers.get('X-Page-Height'));
      if (n === 1 && w > 0 && h > 0) setRatio(h / w);
      const url = URL.createObjectURL(await res.blob());
      objectUrls.current.add(url);
      setSlot(n, { status: 'ready', src: url });
    } catch (e) {
      // Allow a retry on the next scroll past it.
      requested.current.delete(n);
      setSlot(n, { status: 'error', error: e instanceof ApiError ? e.message : 'That page could not be opened.' });
    }
  }, [id]);

  const pump = useCallback(() => {
    while (inFlight.current < MAX_CONCURRENT && queue.current.length) {
      // Nearest the reader first, so a jump shows its page before its neighbours.
      queue.current.sort((a, b) => Math.abs(a - currentRef.current) - Math.abs(b - currentRef.current));
      const n = queue.current.shift()!;
      inFlight.current++;
      void fetchPage(n).finally(() => { inFlight.current--; pump(); });
    }
  }, [fetchPage]);

  const want = useCallback((n: number) => {
    if (requested.current.has(n)) return;
    requested.current.add(n);
    queue.current.push(n);
    pump();
  }, [pump]);

  // Lazy loading: queue a page once it has dwelt near the viewport.
  useEffect(() => {
    const root = scroller.current;
    if (!root || !pageCount) return;
    const timers = new Map<number, number>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const n = Number((e.target as HTMLElement).dataset['page']);
        if (e.isIntersecting) {
          if (!timers.has(n)) timers.set(n, window.setTimeout(() => { timers.delete(n); want(n); }, DWELL_MS));
        } else {
          const t = timers.get(n);
          if (t !== undefined) { window.clearTimeout(t); timers.delete(n); }
          // Scrolled past before it started: drop it from the queue.
          const i = queue.current.indexOf(n);
          if (i >= 0) { queue.current.splice(i, 1); requested.current.delete(n); }
        }
      }
    }, { root, rootMargin: PREFETCH_MARGIN });
    slotEls.current.forEach((el) => io.observe(el));
    return () => { io.disconnect(); timers.forEach((t) => window.clearTimeout(t)); };
  }, [pageCount, want]);

  // Which page is "current": the one crossing the middle of the viewport.
  useEffect(() => {
    const root = scroller.current;
    if (!root || !pageCount) return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) setCurrent(Number((e.target as HTMLElement).dataset['page']));
      }
    }, { root, rootMargin: '-50% 0px -50% 0px' });
    slotEls.current.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [pageCount]);

  // Close the sitting so the audit log records a range rather than an open session.
  useEffect(() => () => {
    objectUrls.current.forEach((u) => URL.revokeObjectURL(u));
    objectUrls.current.clear();
    void api.post(`/records/${id}/close-view`).catch(() => {});
  }, [id]);

  const goTo = useCallback((n: number, smooth = true) => {
    const target = Math.max(1, Math.min(pageCount ?? n, n));
    slotEls.current.get(target)?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
  }, [pageCount]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Not while the page box has focus: there, Left and Right move the caret
      // through the number being typed.
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); goTo(currentRef.current + 1); }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); goTo(currentRef.current - 1); }
      if (e.key === 'Home') { e.preventDefault(); goTo(1, false); }
      if (e.key === 'End' && pageCount) { e.preventDefault(); goTo(pageCount, false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pageCount, goTo]);

  useCaptureDeterrents(id, currentRef, setShielded);

  const left = daysLeft(detail?.access.validUntil);
  // Which part of the record this page belongs to: the original file, or a
  // page added later — with what the custodian said it was.
  const segment = detail?.pages?.segments.find((s) => current >= s.firstPage && current <= s.lastPage);
  const hasAdditions = (detail?.pages?.segments.length ?? 0) > 1;
  const pageNumbers = pageCount ? Array.from({ length: pageCount }, (_, i) => i + 1) : [];

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
        <button className="small" disabled={current <= 1} onClick={() => goTo(current - 1)}>← Previous</button>
        <JumpToPage page={current} pageCount={pageCount} onJump={(n) => goTo(n, false)} />
        <button className="small" disabled={!!pageCount && current >= pageCount}
          onClick={() => goTo(current + 1)}>Next →</button>
        {hasAdditions && segment && (
          segment.kind === 'ORIGINAL' ? (
            <span className="hint" style={{ margin: 0 }}>
              <span className="pill neutral">ORIGINAL</span> pages 1–{segment.lastPage}
            </span>
          ) : (
            <span className="hint" style={{ margin: 0 }}>
              <span className="pill warn">ADDED {fmtDate(segment.uploadedAt)}</span>{' '}
              <strong>{segment.description}</strong>
              {segment.documentDate && ` · dated ${fmtDate(segment.documentDate)}`}
              {' · '}pages {segment.firstPage}–{segment.lastPage}
            </span>
          )
        )}
        <span className="spacer" />
        {left != null && (
          <span className="countdown">
            {left <= 0 ? 'Access ends today' : `Access ends in ${left} day${left === 1 ? '' : 's'}`}
          </span>
        )}
        <span className="pill neutral">SCREEN ONLY</span>
      </div>

      <div className="page-stage">
        <div className={`page-scroll${shielded ? ' shielded' : ''}`} ref={scroller}
          onContextMenu={(e) => e.preventDefault()} onDragStart={(e) => e.preventDefault()}>
          {!pageCount && !error && <Spinner label="Opening record…" />}
          {pageNumbers.map((n) => {
            const slot = slots[n];
            return (
              <div key={n} className="page-slot" data-page={n}
                ref={(el) => { if (el) slotEls.current.set(n, el); else slotEls.current.delete(n); }}>
                {slot?.status === 'ready' && slot.src
                  ? <img src={slot.src} alt={`Page ${n}`} draggable={false} />
                  : (
                    <div className="page-placeholder" style={{ aspectRatio: `1 / ${ratio}` }}>
                      {slot?.status === 'error'
                        ? <span className="hint">{slot.error}</span>
                        : <Spinner label={slot?.status === 'loading' ? 'Rendering page…' : `Page ${n}`} />}
                    </div>
                  )}
                <div className="page-label mono">{n}{pageCount ? ` / ${pageCount}` : ''}</div>
              </div>
            );
          })}
        </div>
        {shielded && (
          <div className="capture-shield" onClick={() => setShielded(false)}>
            <strong>Content hidden</strong>
            <span>The record is hidden while this window is not in use. Click here to continue reading.</span>
          </div>
        )}
      </div>

      <p className="hint">
        These pages are rendered images, watermarked with your name and staff code. The document
        itself never leaves the server, every page you open is recorded, and attempts to capture
        the screen are logged.
        {pageCount && pageCount > 1 ? ' Scroll to read on, type a page number above, or use ← and → to move a page at a time.' : ''}
      </p>
    </div>
  );
}

/**
 * Deterrence, not a control. A web page cannot stop a screenshot: the OS
 * captures the screen without asking the browser, and nothing stops a phone
 * camera. What a page can do is make casual capture awkward, blank the record
 * whenever the window is not the one in use (which is what a snipping tool
 * does to it), and record every attempt it can see. The watermark on each page
 * is what makes a capture traceable to the person who took it.
 */
function useCaptureDeterrents(
  id: string | undefined,
  currentRef: { current: number },
  setShielded: (v: boolean) => void,
) {
  useEffect(() => {
    let lastReport = 0;
    let holdUntil = 0;
    const report = (kind: CaptureKind) => {
      // One event per burst: holding a key down should not flood the audit log.
      if (Date.now() - lastReport < 2000) return;
      lastReport = Date.now();
      void api.post(`/records/${id}/capture-attempt`, { kind, page: currentRef.current }).catch(() => {});
    };
    const shieldFor = (ms: number) => { holdUntil = Date.now() + ms; setShielded(true); };

    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'PrintScreen') {
        e.preventDefault();
        shieldFor(1500);
        // Overwrite whatever the key just put on the clipboard, where the
        // browser allows it.
        void navigator.clipboard?.writeText('').catch(() => {});
        if (e.type === 'keyup') report('PRINT_SCREEN');
        return;
      }
      if (e.type !== 'keydown') return;
      if (mod && key === 'p') { e.preventDefault(); report('PRINT'); return; }
      if (mod && key === 's') { e.preventDefault(); report('SAVE'); return; }
      if (mod && (key === 'c' || key === 'x')) { e.preventDefault(); report('COPY'); return; }
      // macOS screenshot shortcuts, where the browser sees them at all.
      if (e.metaKey && e.shiftKey && ['3', '4', '5', 's'].includes(key)) {
        shieldFor(1500); report('PRINT_SCREEN'); return;
      }
      if (e.key === 'F12' || (mod && e.shiftKey && ['i', 'j', 'c'].includes(key))) {
        e.preventDefault(); report('DEVTOOLS');
      }
    };
    const onBlur = () => setShielded(true);
    const onFocus = () => {
      const wait = holdUntil - Date.now();
      if (wait > 0) window.setTimeout(() => setShielded(false), wait);
      else setShielded(false);
    };
    const onVisibility = () => { if (document.hidden) setShielded(true); };
    const onBeforePrint = () => report('PRINT');
    const onCopy = (e: ClipboardEvent) => { e.preventDefault(); };

    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('beforeprint', onBeforePrint);
    document.addEventListener('copy', onCopy);
    document.body.classList.add('no-select');
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('beforeprint', onBeforePrint);
      document.removeEventListener('copy', onCopy);
      document.body.classList.remove('no-select');
    };
  }, [id, currentRef, setShielded]);
}

/**
 * Jumping straight to page 147 of a long service record.
 *
 * The box holds what is being typed rather than the current page, so a partial
 * number ("1" on the way to "147") does not scroll to page 1 and fetch pages
 * nobody meant to open. Nothing moves until the entry is committed with Enter
 * or by leaving the field.
 */
function JumpToPage({ page, pageCount, onJump }: {
  page: number; pageCount: number | null; onJump: (n: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const showing = draft ?? String(page);

  const commit = () => {
    if (draft === null) return;
    const n = Number(draft);
    setDraft(null);
    // Out of range, or not a number at all: fall back to where we already are
    // rather than guessing at what was meant.
    if (!Number.isInteger(n) || n < 1) return;
    if (pageCount && n > pageCount) { onJump(pageCount); return; }
    if (n !== page) onJump(n);
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <label htmlFor="jump" className="mono" style={{ marginBottom: 0 }}>Page</label>
      <input id="jump" className="mono" inputMode="numeric" aria-label="Jump to page"
        // Content-box, so the width is room for the digits alone: under the
        // global border-box rule the padding and border ate into it and a
        // three-digit page number was clipped.
        style={{
          boxSizing: 'content-box', width: `${Math.max(3, String(pageCount ?? 999).length) + 1}ch`,
          flexShrink: 0, textAlign: 'center', padding: '4px 6px', fontSize: '0.95rem',
        }}
        value={showing}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value.replace(/\D/gu, '').slice(0, 5))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { commit(); e.currentTarget.blur(); }
          if (e.key === 'Escape') { setDraft(null); e.currentTarget.blur(); }
        }} />
      <span className="mono">{pageCount ? `of ${pageCount}` : ''}</span>
    </span>
  );
}
