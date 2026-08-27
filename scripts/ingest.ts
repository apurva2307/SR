import { getPool, closePool } from '../src/db.ts';
import { runIngestion } from '../src/services/ingest/runner.ts';
import { assertConfigured } from '../src/config.ts';

assertConfigured();
const summary = await runIngestion(getPool());
console.log(summary);
await closePool();
