// The background work. None of it is load-bearing for security: expiry is
// computed at request time (§3.2), so if the scheduler never ran, the access
// rules would be unchanged. It exists for notifications and hygiene.
import type { Queryable } from './domain/types.ts';
import { sweepExpired } from './services/grants.ts';
import { warnExpiring } from './services/authorities.ts';
import { verifyAdditionsSlice, verifySlice } from './services/ingest/integrity.ts';
import { sweepStaged } from './services/additions.ts';
import { runIngestion } from './services/ingest/runner.ts';
import { getSetting } from './services/settings.ts';

const HOUR = 3_600_000;

async function safely(name: string, fn: () => Promise<unknown>): Promise<void> {
  try { await fn(); } catch (err) { console.error(`[scheduler:${name}]`, err); }
}

export function startScheduler(db: Queryable): () => void {
  const timers = [
    setInterval(() => void safely('ingest', () => runIngestion(db)), HOUR),
    setInterval(() => void safely('expiry', () => sweepExpired(db)), HOUR),
    setInterval(() => void safely('authority-warnings', async () => {
      await warnExpiring(db, await getSetting(db, 'authority.expiry_warn_days', [14, 3]));
    }), 12 * HOUR),
    setInterval(() => void safely('integrity', () => verifySlice(db)), 24 * HOUR),
    setInterval(() => void safely('integrity-additions', () => verifyAdditionsSlice(db)), 24 * HOUR),
    setInterval(() => void safely('staged-uploads', () => sweepStaged(db)), HOUR),
  ];
  for (const t of timers) t.unref();
  return () => { for (const t of timers) clearInterval(t); };
}
