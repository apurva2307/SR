// §8.2 — integrity, continuously.
//
// The system has no opinions about the department's backup regime, but it can
// tell them on a Tuesday morning that four records went missing on Sunday night.
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { Queryable } from '../../domain/types.ts';
import { appendEvent } from '../../audit/events.ts';
import { notify } from '../notifications.ts';
import { resolveInsideRoots } from './paths.ts';
import { config } from '../../config.ts';

export type IntegrityFinding =
  | { recordId: string; kind: 'MISSING'; detail: string }
  | { recordId: string; kind: 'CHECKSUM_CHANGED'; detail: string }
  | { recordId: string; kind: 'MTIME_MOVED'; detail: string };

/**
 * Verifies a rotating slice, sized so the whole catalogue is checked within
 * `cycleDays`. Least-recently-verified first, so nothing is ever skipped twice.
 */
export async function verifySlice(
  db: Queryable, opts: { cycleDays?: number } = {},
): Promise<{ checked: number; findings: IntegrityFinding[] }> {
  const cycleDays = opts.cycleDays ?? 30;
  const { rows: counts } = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM service_records WHERE status = 'ACTIVE'`,
  );
  const total = Number(counts[0]!.n);
  const slice = Math.max(1, Math.ceil(total / cycleDays));

  const { rows } = await db.query<{
    id: string; file_path: string; sha256: string; byte_size: string; last_verified_at: Date | null;
  }>(
    `SELECT id, file_path, sha256, byte_size, last_verified_at
     FROM service_records WHERE status = 'ACTIVE'
     ORDER BY last_verified_at NULLS FIRST LIMIT $1`, [slice],
  );

  const findings: IntegrityFinding[] = [];
  for (const r of rows) {
    try {
      const real = await resolveInsideRoots(r.file_path);
      const info = await stat(real);
      const sha = createHash('sha256').update(await readFile(real)).digest('hex');
      if (sha !== r.sha256) {
        findings.push({ recordId: r.id, kind: 'CHECKSUM_CHANGED', detail: `${r.sha256} -> ${sha}` });
      } else if (String(info.size) !== String(r.byte_size)) {
        findings.push({ recordId: r.id, kind: 'MTIME_MOVED', detail: `size ${r.byte_size} -> ${info.size}` });
      }
    } catch (err) {
      findings.push({ recordId: r.id, kind: 'MISSING', detail: (err as Error).message });
    }
    await db.query('UPDATE service_records SET last_verified_at = now() WHERE id = $1', [r.id]);
  }

  if (findings.length > 0) {
    for (const f of findings) {
      await appendEvent(db, {
        eventType: 'INTEGRITY_ALERT', outcome: 'DENY', serviceRecordId: f.recordId,
        detail: { kind: f.kind, detail: f.detail },
      });
    }
    const { rows: custodians } = await db.query<{ user_id: string }>(
      `SELECT user_id FROM user_roles WHERE role_id = 'CUSTODIAN'`,
    );
    for (const c of custodians) {
      await notify(db, c.user_id, 'INTEGRITY_ALERT', { count: findings.length });
    }
  }
  return { checked: rows.length, findings };
}

/**
 * The same check over added pages. These matter more, not less: the additions
 * folder holds the only copy of each upload.
 */
export async function verifyAdditionsSlice(
  db: Queryable, opts: { cycleDays?: number } = {},
): Promise<{ checked: number; findings: IntegrityFinding[] }> {
  const cycleDays = opts.cycleDays ?? 30;
  const { rows: counts } = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM record_additions WHERE status = 'ACTIVE'`,
  );
  const slice = Math.max(1, Math.ceil(Number(counts[0]!.n) / cycleDays));

  const { rows } = await db.query<{ id: string; service_record_id: string; file_path: string; sha256: string; seq: number }>(
    `SELECT id, service_record_id, file_path, sha256, seq FROM record_additions
      WHERE status = 'ACTIVE' ORDER BY last_verified_at NULLS FIRST LIMIT $1`, [slice],
  );

  const findings: IntegrityFinding[] = [];
  for (const a of rows) {
    try {
      const real = await resolveInsideRoots(a.file_path, [config.additionsRoot]);
      const sha = createHash('sha256').update(await readFile(real)).digest('hex');
      if (sha !== a.sha256) {
        findings.push({ recordId: a.service_record_id, kind: 'CHECKSUM_CHANGED',
          detail: `addition ${a.seq}: ${a.sha256} -> ${sha}` });
      }
    } catch (err) {
      findings.push({ recordId: a.service_record_id, kind: 'MISSING',
        detail: `addition ${a.seq}: ${(err as Error).message}` });
    }
    await db.query('UPDATE record_additions SET last_verified_at = now() WHERE id = $1', [a.id]);
  }

  for (const f of findings) {
    await appendEvent(db, {
      eventType: 'INTEGRITY_ALERT', outcome: 'DENY', serviceRecordId: f.recordId,
      detail: { kind: f.kind, detail: f.detail, addition: true },
    });
  }
  if (findings.length > 0) {
    const { rows: custodians } = await db.query<{ user_id: string }>(
      `SELECT user_id FROM user_roles WHERE role_id = 'CUSTODIAN'`,
    );
    for (const c of custodians) {
      await notify(db, c.user_id, 'INTEGRITY_ALERT', { count: findings.length });
    }
  }
  return { checked: rows.length, findings };
}
