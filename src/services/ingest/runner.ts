// §8 — the scan. Walks the configured roots and, for each PDF: hash it, check
// whether that hash is known, parse the filename, then index it or quarantine
// it. Writes nothing to the folder and reads nothing outside it.
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Queryable, Uuid } from '../../domain/types.ts';
import { parseFilename, toQuarantineReason } from '../../ingest/parseFilename.ts';
import { appendEvent } from '../../audit/events.ts';
import { countPages } from '../render/pageRenderer.ts';
import { config } from '../../config.ts';
import { notify } from '../notifications.ts';
import { carryForward } from '../additions.ts';

export interface IngestSummary {
  runId: Uuid;
  filesSeen: number;
  added: number;
  updated: number;
  quarantined: number;
  errors: { path: string; message: string }[];
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile() && /\.pdf$/i.test(e.name)) yield full;
  }
}

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

async function quarantine(
  db: Queryable, runId: Uuid, path: string, filename: string, sha: string | null,
  reason: string, detail: Record<string, unknown>, ppo?: string, name?: string,
): Promise<void> {
  await db.query(
    `INSERT INTO quarantine_items
       (ingestion_run_id, raw_path, raw_filename, sha256, reason, detail, suggested_ppo, suggested_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [runId, path, filename, sha, reason, JSON.stringify(detail), ppo ?? null, name ?? null],
  );
}

export async function runIngestion(
  db: Queryable, opts: { triggeredBy?: Uuid | null; roots?: string[] } = {},
): Promise<IngestSummary> {
  const roots = opts.roots ?? config.sourceRoots;
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO ingestion_runs (triggered_by) VALUES ($1) RETURNING id', [opts.triggeredBy ?? null],
  );
  const runId = rows[0]!.id;
  const s: IngestSummary = { runId, filesSeen: 0, added: 0, updated: 0, quarantined: 0, errors: [] };

  for (const root of roots) {
    for await (const path of walk(root)) {
      s.filesSeen++;
      const filename = path.slice(path.lastIndexOf('/') + 1);
      try {
        const info = await stat(path);
        if (info.size === 0) {
          await quarantine(db, runId, path, filename, null, 'UNREADABLE', { reason: 'ZERO_BYTE' });
          s.quarantined++; continue;
        }

        const bytes = await readFile(path);
        const sha = sha256(bytes);

        // Same checksum somewhere else: link it, do not re-index it.
        const { rows: existing } = await db.query<{ id: string; file_path: string }>(
          'SELECT id, file_path FROM service_records WHERE sha256 = $1', [sha],
        );
        if (existing[0]) {
          if (existing[0].file_path !== path) {
            await quarantine(db, runId, path, filename, sha, 'DUPLICATE',
              { alreadyIndexedAs: existing[0].file_path, recordId: existing[0].id });
            s.quarantined++;
          }
          continue;
        }

        const parsed = parseFilename(filename);
        if (!parsed.ok) {
          await quarantine(db, runId, path, filename, sha, toQuarantineReason(parsed.reason),
            { parseReason: parsed.reason, detail: parsed.detail },
            parsed.suggestedPpo, parsed.suggestedName);
          s.quarantined++; continue;
        }

        let pageCount: number | null = null;
        try { pageCount = await countPages(path); } catch (err) {
          await quarantine(db, runId, path, filename, sha, 'UNREADABLE',
            { message: (err as Error).message });
          s.quarantined++; continue;
        }

        // Same PPO already on file. Same name means a new version; a different
        // name is a conflict a human has to look at. Neither is guessed.
        const { rows: samePpo } = await db.query<{ id: string; name_normalized: string; version_no: number }>(
          `SELECT id, name_normalized, version_no FROM service_records
            WHERE ppo_normalized = $1 AND status = 'ACTIVE'`,
          [parsed.ppoNormalized],
        );
        const prior = samePpo[0];
        if (prior) {
          const same = prior.name_normalized === parsed.nameNormalized;
          await quarantine(db, runId, path, filename, sha, same ? 'NEW_VERSION' : 'PPO_CONFLICT',
            {
              existingRecordId: prior.id, existingName: prior.name_normalized,
              incomingName: parsed.nameNormalized, pageCount,
            },
            parsed.ppoNormalized, parsed.employeeName);
          s.quarantined++; continue;
        }

        const { rows: inserted } = await db.query<{ id: string }>(
          `INSERT INTO service_records
             (ppo_number, ppo_normalized, employee_name, name_normalized, name_sorted,
              file_path, file_name, sha256, byte_size, page_count, source_root, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
          [parsed.ppoRaw, parsed.ppoNormalized, parsed.employeeName, parsed.nameNormalized,
           parsed.nameSorted, path, filename, sha, info.size, pageCount, root,
           JSON.stringify({ pattern: parsed.pattern, ppoVerdict: parsed.ppoVerdict })],
        );
        await appendEvent(db, {
          eventType: 'RECORD_INDEXED', actorId: opts.triggeredBy ?? null,
          serviceRecordId: inserted[0]!.id,
          detail: { file: filename, pattern: parsed.pattern, ppoVerdict: parsed.ppoVerdict },
        });
        s.added++;
      } catch (err) {
        s.errors.push({ path, message: (err as Error).message });
      }
    }
  }

  await db.query(
    `UPDATE ingestion_runs
        SET finished_at = now(), files_seen = $2, added = $3, updated = $4,
            quarantined = $5, errors = $6
      WHERE id = $1`,
    [runId, s.filesSeen, s.added, s.updated, s.quarantined, JSON.stringify(s.errors)],
  );
  await appendEvent(db, {
    eventType: 'INGEST_RUN', actorId: opts.triggeredBy ?? null,
    detail: { ...s, errors: s.errors.length },
  });

  if (s.quarantined > 0) {
    const { rows: custodians } = await db.query<{ user_id: string }>(
      `SELECT user_id FROM user_roles WHERE role_id = 'CUSTODIAN'`,
    );
    for (const c of custodians) {
      await notify(db, c.user_id, 'QUARANTINE_WAITING', { runId, count: s.quarantined });
    }
  }
  return s;
}

export type Resolution = 'INDEXED' | 'SUPERSEDED' | 'LINKED' | 'IGNORED';

/** Every resolution is an audit event naming who decided (§8.1). */
export async function resolveQuarantine(
  db: Queryable,
  args: {
    id: Uuid; custodianId: Uuid; resolution: Resolution; ppo?: string; name?: string;
    /** Superseding only: move the old record's added pages onto the new one. */
    carryAdditions?: boolean;
  },
): Promise<boolean> {
  const { rows } = await db.query<{
    raw_path: string; raw_filename: string; sha256: string | null;
    reason: string; detail: Record<string, unknown>;
  }>(
    `SELECT raw_path, raw_filename, sha256, reason, detail FROM quarantine_items
      WHERE id = $1 AND resolved_at IS NULL`, [args.id],
  );
  const item = rows[0];
  if (!item) return false;

  if (args.resolution === 'INDEXED' || args.resolution === 'SUPERSEDED') {
    const { normalizePpo, deriveNameForms } = await import('../../ingest/normalize.ts');
    const ppo = normalizePpo(args.ppo ?? '');
    const forms = deriveNameForms(args.name ?? '');
    if (!ppo || !forms.nameNormalized) return false;

    const info = await stat(item.raw_path);
    let pageCount: number | null = null;
    try { pageCount = await countPages(item.raw_path); } catch { /* left null */ }

    if (args.resolution === 'SUPERSEDED') {
      const priorId = item.detail['existingRecordId'] as string | undefined;
      if (priorId) {
        await db.query(`UPDATE service_records SET status = 'SUPERSEDED' WHERE id = $1`, [priorId]);
      }
    }

    const { rows: ins } = await db.query<{ id: string }>(
      `INSERT INTO service_records
         (ppo_number, ppo_normalized, employee_name, name_normalized, name_sorted,
          file_path, file_name, sha256, byte_size, page_count, source_root, version_no, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
               (SELECT coalesce(max(version_no),0)+1 FROM service_records WHERE ppo_normalized = $2),
               $12)
       RETURNING id`,
      [args.ppo!, ppo, forms.employeeName, forms.nameNormalized, forms.nameSorted,
       item.raw_path, item.raw_filename, item.sha256 ?? '', info.size, pageCount,
       config.sourceRoots[0] ?? '', JSON.stringify({ resolvedFromQuarantine: true })],
    );
    if (args.resolution === 'SUPERSEDED') {
      const priorId = item.detail['existingRecordId'] as string | undefined;
      if (priorId) {
        await db.query('UPDATE service_records SET superseded_by = $2 WHERE id = $1', [priorId, ins[0]!.id]);
        await appendEvent(db, {
          eventType: 'RECORD_SUPERSEDED', actorId: args.custodianId,
          serviceRecordId: priorId, detail: { replacedBy: ins[0]!.id },
        });
        if (args.carryAdditions) {
          await carryForward(db, { fromRecordId: priorId, toRecordId: ins[0]!.id, custodianId: args.custodianId });
        }
      }
    }
    await appendEvent(db, {
      eventType: 'RECORD_INDEXED', actorId: args.custodianId, serviceRecordId: ins[0]!.id,
      detail: { viaQuarantine: args.id, file: item.raw_filename },
    });
  }

  await db.query(
    `UPDATE quarantine_items SET resolved_by = $2, resolved_at = now(), resolution = $3 WHERE id = $1`,
    [args.id, args.custodianId, args.resolution],
  );
  await appendEvent(db, {
    eventType: 'QUARANTINE_RESOLVED', actorId: args.custodianId,
    detail: { quarantineId: args.id, resolution: args.resolution, reason: item.reason },
  });
  return true;
}
