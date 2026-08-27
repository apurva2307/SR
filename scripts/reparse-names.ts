// Re-derive the name columns of already-indexed records from their filenames.
//
// Needed whenever the parser learns something after a scan has run — a new
// noise suffix, a new honorific. Re-ingesting will not do it: the runner keys
// on sha256, so a file already in the catalogue is skipped or quarantined as a
// duplicate, never re-parsed.
//
// This corrects metadata; it never touches the PDF, the path, or the checksum,
// and it will not change a PPO — a record whose identity moved is a different
// record and belongs in quarantine, not in a bulk update.
//
//   node --experimental-strip-types scripts/reparse-names.ts          # dry run
//   node --experimental-strip-types scripts/reparse-names.ts --apply
import pg from 'pg';
import { parseFilename } from '../src/ingest/parseFilename.ts';
import { deriveNameForms } from '../src/ingest/normalize.ts';
import { appendEvent } from '../src/audit/events.ts';

interface Row {
  id: string;
  file_name: string;
  ppo_normalized: string;
  employee_name: string;
  name_normalized: string;
  name_sorted: string;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is not set');

  const db = new pg.Client({ connectionString: url });
  await db.connect();

  try {
    const { rows } = await db.query<Row>(
      `SELECT id, file_name, ppo_normalized, employee_name, name_normalized, name_sorted
         FROM service_records ORDER BY ppo_normalized`,
    );

    let changed = 0;
    let skipped = 0;

    if (apply) await db.query('BEGIN');

    for (const r of rows) {
      const parsed = parseFilename(r.file_name);

      // A row that no longer parses, or that now reads as a different person,
      // is a custodian's decision and not a script's.
      if (!parsed.ok) {
        console.log(`SKIP  ${r.file_name} — no longer parses (${parsed.reason})`);
        skipped++;
        continue;
      }
      if (parsed.ppoNormalized !== r.ppo_normalized) {
        console.log(
          `SKIP  ${r.file_name} — PPO would move ${r.ppo_normalized} -> ${parsed.ppoNormalized}`,
        );
        skipped++;
        continue;
      }
      if (
        parsed.employeeName === r.employee_name &&
        parsed.nameNormalized === r.name_normalized &&
        parsed.nameSorted === r.name_sorted
      ) continue;

      console.log(`${apply ? 'FIX  ' : 'WOULD'} ${r.ppo_normalized}  "${r.employee_name}" -> "${parsed.employeeName}"`);
      changed++;
      if (!apply) continue;

      await db.query(
        // No touched-at column here by design: when a record's metadata last
        // changed is the audit log's business, and the METADATA_CORRECTED
        // event below carries both the timestamp and the before/after.
        `UPDATE service_records
            SET employee_name = $2, name_normalized = $3, name_sorted = $4
          WHERE id = $1`,
        [r.id, parsed.employeeName, parsed.nameNormalized, parsed.nameSorted],
      );
      await appendEvent(db, {
        eventType: 'METADATA_CORRECTED',
        actorId: null, // a maintenance script, not a person — §12 allows NULL
        serviceRecordId: r.id,
        detail: {
          reason: 'REPARSED_FILENAME',
          file: r.file_name,
          before: { employeeName: r.employee_name, nameNormalized: r.name_normalized },
          after: { employeeName: parsed.employeeName, nameNormalized: parsed.nameNormalized },
        },
      });
    }

    // The custodian's console pre-fills from these, so a stale suggestion here
    // is a stale name typed into the catalogue later.
    const { rows: quarantined } = await db.query<{ id: string; raw_filename: string; suggested_name: string | null }>(
      `SELECT id, raw_filename, suggested_name FROM quarantine_items
        WHERE resolved_at IS NULL AND suggested_name IS NOT NULL`,
    );
    let suggestions = 0;
    for (const q of quarantined) {
      const parsed = parseFilename(q.raw_filename);
      const next = parsed.ok ? parsed.employeeName : deriveNameForms(q.suggested_name ?? '').employeeName;
      if (!next || next === q.suggested_name) continue;
      console.log(`${apply ? 'FIX  ' : 'WOULD'} quarantine "${q.suggested_name}" -> "${next}"`);
      suggestions++;
      if (apply) {
        await db.query('UPDATE quarantine_items SET suggested_name = $2 WHERE id = $1', [q.id, next]);
      }
    }

    if (apply) await db.query('COMMIT');

    console.log(
      `\n${rows.length} record(s) examined, ${changed} ${apply ? 'corrected' : 'would change'}, ` +
      `${skipped} left for a custodian, ${suggestions} quarantine suggestion(s) ${apply ? 'updated' : 'would change'}.`,
    );
    if (!apply && (changed > 0 || suggestions > 0)) console.log('Nothing was written. Re-run with --apply.\n');
  } catch (err) {
    if (apply) await db.query('ROLLBACK');
    throw err;
  } finally {
    await db.end();
  }
}

main().catch((e: unknown) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
