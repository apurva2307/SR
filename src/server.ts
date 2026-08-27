import { assertConfigured, config } from './config.ts';
import { createApp } from './http/app.ts';
import { closePool, getPool } from './db.ts';
import { initRenderer } from './services/render/pageRenderer.ts';
import { startScheduler } from './scheduler.ts';

assertConfigured();
// Fails fast rather than shipping unwatermarked pages (§4.1).
initRenderer();

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`service-records listening on :${config.port}`);
  console.log(`  source roots: ${config.sourceRoots.join(', ')}`);
  console.log(`  render: ${config.render.dpi} dpi, watermark font ${config.render.fontPath}`);
});

const stopScheduler = startScheduler(getPool());

async function shutdown(signal: string): Promise<void> {
  console.log(`\n${signal} — shutting down`);
  stopScheduler();
  server.close();
  await closePool();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
