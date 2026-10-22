/**
 * The SevaLekh mark (brand/sevalekh-mark.svg), drawn inline so it takes its
 * colours from the theme tokens. Fills live in styles.css (.mark-*) rather than
 * in attributes because the CSP is style-src 'self'.
 *
 * Below 40px the ruling and the seal's inner ring fill in, so `small` swaps to
 * the heavier cut used for the favicon.
 */
export function Mark({ size = 32, small = false }: { size?: number; small?: boolean }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      {small ? (
        <>
          <rect className="mark-ink" x="6" y="7" width="52" height="9" rx="2" />
          <path className="mark-line" strokeWidth="7" strokeLinejoin="round" d="M15 16V53H33M47 16V33" />
          <path className="mark-line" strokeWidth="6" strokeLinecap="round" d="M25 28H39" />
          <circle className="mark-seal" strokeWidth="4" cx="46" cy="46" r="13" />
        </>
      ) : (
        <>
          <rect className="mark-paper" x="15" y="15" width="34" height="40" />
          <rect className="mark-ink" x="8" y="9" width="48" height="6" rx="1.5" />
          <path className="mark-line" strokeWidth="4" strokeLinejoin="round" d="M17 15V53H35M47 15V35" />
          <path className="mark-line" strokeWidth="3" strokeLinecap="round" d="M23 24H41M23 31H41M23 38H32" />
          <circle className="mark-seal" strokeWidth="3" cx="46" cy="47" r="11" />
          <circle className="mark-ring" strokeWidth="1.6" cx="46" cy="47" r="6.4" />
          <circle className="mark-paper" cx="46" cy="47" r="1.9" />
        </>
      )}
    </svg>
  );
}

/** Mark + wordmark. `stacked` is the sign-in lockup; inline is the sidebar. */
export function Brand({ stacked = false, sub }: { stacked?: boolean; sub: string }) {
  return (
    <div className={`brand${stacked ? ' stacked' : ''}`}>
      <Mark size={stacked ? 64 : 34} />
      <div className="brand-text">
        <strong className="wordmark">Seva<span>Lekh</span></strong>
        {stacked && <span className="wordmark-deva" lang="hi">सेवालेख</span>}
        <span className="brand-sub">{sub}</span>
      </div>
    </div>
  );
}
