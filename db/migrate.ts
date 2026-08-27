// Plain numbered .sql files and a runner small enough to read in one sitting.
// A government deployment gets audited; an ORM's migration format does not
// help that conversation.
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, 'migrations');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const client = new pg.Client({ connectionString: url });
  await client.connect();

  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

  const applied = new Set<string>(
    (await client.query<{ filename: string }>('SELECT filename FROM schema_migrations')).rows.map(
      (r) => r.filename,
    ),
  );

  const files = (await readdir(DIR)).filter((f) => f.endsWith('.sql')).sort();
  let ran = 0;

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(DIR, file), 'utf8');
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`  applied ${file}`);
      ran++;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`  FAILED  ${file}`);
      throw err;
    }
  }

  console.log(ran === 0 ? 'up to date' : `${ran} migration(s) applied`);
  await client.end();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
