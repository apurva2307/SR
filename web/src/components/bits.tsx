import type { ReactNode } from 'react';
import type { AccessState } from '../api';

export function Banner({ kind = 'error', children }: { kind?: 'error' | 'ok' | 'warn'; children: ReactNode }) {
  return <div className={`banner ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><strong>{title}</strong>{children}</div>;
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return <div className="spinner">{label}</div>;
}

const ACCESS: Record<AccessState, { cls: string; label: string }> = {
  CUSTODIAL: { cls: 'acc', label: 'ACCOUNTS' },
  GRANTED: { cls: 'ok', label: 'GRANTED' },
  PENDING: { cls: 'warn', label: 'PENDING' },
  EXPIRED: { cls: 'neutral', label: 'EXPIRED' },
  NO_ACCESS: { cls: 'neutral', label: 'NO ACCESS' },
};

export function AccessPill({ state, daysLeft }: { state: AccessState; daysLeft?: number | null }) {
  const s = ACCESS[state];
  const suffix = state === 'GRANTED' && daysLeft != null
    ? ` · ${daysLeft <= 0 ? 'today' : `${daysLeft}d left`}` : '';
  return <span className={`pill ${s.cls}`}>{s.label}{suffix}</span>;
}

const ITEM: Record<string, string> = { PENDING: 'warn', APPROVED: 'ok', REJECTED: 'stop' };
const REQ: Record<string, string> = {
  DRAFT: 'neutral', SUBMITTED: 'warn', DECIDED: 'ok', WITHDRAWN: 'neutral',
};

export const ItemPill = ({ status }: { status: string }) =>
  <span className={`pill ${ITEM[status] ?? 'neutral'}`}>{status}</span>;

export const RequestPill = ({ status }: { status: string }) =>
  <span className={`pill ${REQ[status] ?? 'neutral'}`}>{status}</span>;
