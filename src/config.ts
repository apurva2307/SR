import { resolve } from 'node:path';

function num(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: num('PORT', 3000),
  databaseUrl: process.env['DATABASE_URL'] ?? '',
  nodeEnv: process.env['NODE_ENV'] ?? 'development',

  /**
   * Where the service records live. Mount these READ-ONLY: the application
   * reads records and never writes, renames, or deletes them. If the mount is
   * writable, a bug in ingestion becomes a records-destruction incident.
   */
  sourceRoots: (process.env['SR_SOURCE_ROOTS'] ?? '/srv/service-records')
    .split(',')
    .map((r) => resolve(r.trim()))
    .filter(Boolean),

  /**
   * Where pages added after indexing are kept — the one folder the application
   * writes to. It holds the only copy of each upload, so it belongs in the
   * backup regime from day one. Never one of the source roots: ingestion must
   * not scan what the application itself wrote.
   */
  additionsRoot: resolve(process.env['SR_ADDITIONS_ROOT'] ?? '/srv/sr-additions'),
  additionMaxBytes: num('SR_ADDITION_MAX_MB', 25) * 1024 * 1024,

  session: {
    accessMinutes: num('SESSION_ACCESS_MINUTES', 15),
    // Fallback only: Administration's 'session.idle_minutes' setting wins.
    idleMinutes: num('SESSION_IDLE_MINUTES', 15),
    absoluteHours: num('SESSION_ABSOLUTE_HOURS', 8),
    cookieSecure: process.env['COOKIE_SECURE'] !== 'false',
  },

  render: {
    dpi: num('RENDER_DPI', 150),
    quality: num('RENDER_QUALITY', 80),
    cacheEntries: num('RENDER_CACHE_ENTRIES', 200),
    cacheTtlSeconds: num('RENDER_CACHE_TTL_SECONDS', 900),
    /**
     * Watermark text needs a real font file. Alpine has none by default, and
     * a missing font fails silently: fillText draws nothing and pages ship
     * unwatermarked. The renderer refuses to start rather than let that happen.
     */
    fontPath: process.env['WATERMARK_FONT'] ?? '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
  },

  limits: {
    loginPer15Min: num('RL_LOGIN', 5),
    searchPerMin: num('RL_SEARCH', 60),
    pagesPerMin: num('RL_PAGES_MIN', 90),
    pagesPerHour: num('RL_PAGES_HOUR', 600),
  },
} as const;

export function assertConfigured(): void {
  if (!config.databaseUrl) throw new Error('DATABASE_URL is not set');
  if (config.sourceRoots.length === 0) throw new Error('SR_SOURCE_ROOTS is empty');
}
