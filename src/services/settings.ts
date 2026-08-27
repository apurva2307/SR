import type { Queryable } from '../domain/types.ts';

/** Policy the department can change without a deploy (§5.3). Cached briefly. */
let cache: { at: number; values: Map<string, unknown> } | null = null;
const TTL_MS = 30_000;

export async function loadSettings(db: Queryable): Promise<Map<string, unknown>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.values;
  const { rows } = await db.query<{ key: string; value: unknown }>('SELECT key, value FROM settings');
  const values = new Map(rows.map((r) => [r.key, r.value]));
  cache = { at: Date.now(), values };
  return values;
}

export async function getSetting<T>(db: Queryable, key: string, fallback: T): Promise<T> {
  const v = (await loadSettings(db)).get(key);
  return (v as T | undefined) ?? fallback;
}

export async function setSetting(db: Queryable, key: string, value: unknown, by: string): Promise<void> {
  await db.query(
    `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1,$2,$3, now())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $3, updated_at = now()`,
    [key, JSON.stringify(value), by],
  );
  cache = null;
}

export function invalidateSettings(): void { cache = null; }

/** The policy defaults, kept here so migration 007 and any reseed agree. */
export const DEFAULT_SETTINGS: Record<string, unknown> = {
  'grant.default_days': 15,
  'grant.max_days': 180,
  'grant.emergency_max_days': 7,
  'grant.expiry_warn_days': [7, 2],
  'authority.expiry_warn_days': [14, 3],
  'audit.retention_years': 8,
  'render.dpi': 150,
  'render.cache_ttl_seconds': 900,
  'ppo.standard_length': 12,
  'ppo.min_length': 6,
  'ppo.max_length': 14,
  'search.min_query_length': 3,
  'search.similarity_floor': 0.35,
};

/**
 * Restores any missing policy row without touching one an operator has changed.
 *
 * Needed because `settings.updated_by` references `users`, so a
 * `TRUNCATE users ... CASCADE` — which every reseed and test fixture does —
 * silently empties this table too. Nothing visibly broke, since the code
 * fallbacks happen to match, but the Administration screen went blank and a
 * department could no longer tune anything.
 */
export async function ensureDefaultSettings(db: Queryable): Promise<number> {
  let inserted = 0;
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    const { rowCount } = await db.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO NOTHING`,
      [key, JSON.stringify(value)],
    );
    inserted += rowCount ?? 0;
  }
  invalidateSettings();
  return inserted;
}


// ---------------------------------------------------------------------------
// What each setting means, and what it may be set to.
//
// The descriptions are shown in Administration. Several of these interact with
// something that is NOT a setting — a database constraint, a rendering cost —
// and saying so here is the only way an operator finds out before they are
// surprised by it.
// ---------------------------------------------------------------------------

export type SettingKind = 'integer' | 'number' | 'integer-list';

export interface SettingSpec {
  key: string;
  label: string;
  description: string;
  kind: SettingKind;
  unit?: string;
  min?: number;
  max?: number;
  /** Why the maximum is what it is, when the reason is not obvious. */
  ceilingNote?: string;
}

export const SETTING_SPECS: SettingSpec[] = [
  {
    key: 'grant.default_days', label: 'Default grant period', kind: 'integer', unit: 'days',
    min: 1, max: 180,
    description:
      'What the approver’s duration control offers first when releasing a record. They can still choose less or more, up to the maximum below.',
  },
  {
    key: 'grant.max_days', label: 'Maximum grant period', kind: 'integer', unit: 'days',
    min: 1, max: 180,
    ceilingNote:
      'The 180-day ceiling is a database CHECK on access_grants, not a setting. Raising this above 180 would be silently ignored at the point it matters, so it is refused here instead. Changing the real cap is a migration.',
    description:
      'The longest period a requester may ask for and an approver may grant. Too short and approvers get re-request fatigue; too long and revocation becomes the only control that works.',
  },
  {
    key: 'grant.emergency_max_days', label: 'Maximum emergency grant', kind: 'integer', unit: 'days',
    min: 1, max: 30,
    description:
      'The ceiling on a grant issued outside the request queue. Kept short on purpose: an emergency that needs three weeks was not an emergency.',
  },
  {
    key: 'grant.expiry_warn_days', label: 'Warn before a grant expires', kind: 'integer-list', unit: 'days',
    description:
      'How many days ahead the holder is told their access is about to close. Several values give several warnings, e.g. 7 and 2.',
  },
  {
    key: 'authority.expiry_warn_days', label: 'Warn before an authority expires', kind: 'integer-list', unit: 'days',
    description:
      'How far ahead an approver and the controlling officer who appointed them are warned. An authority that lapses silently on a Friday means the request queue stops moving on Monday and nobody guesses why.',
  },
  {
    key: 'audit.retention_years', label: 'Audit retention', kind: 'integer', unit: 'years',
    min: 1, max: 50,
    description:
      'How long access events are kept. Driven by your record-retention rules and the practical life of a pension case, which can be reopened long after the officers who handled it have retired. Nothing deletes automatically today; this records the department’s decision.',
  },
  {
    key: 'render.dpi', label: 'Page rendering quality', kind: 'integer', unit: 'dpi',
    min: 72, max: 300,
    description:
      'How finely a page is rendered before it is sent. Higher is more legible and costs more CPU and bandwidth per page — roughly double the bytes from 150 to 220. 150 suits scanned service records.',
  },
  {
    key: 'render.cache_ttl_seconds', label: 'Rendered page cache', kind: 'integer', unit: 'seconds',
    min: 0, max: 3600,
    description:
      'How long a rendered page is held in memory so paging back and forth within a sitting does not re-render it. Not storage: a revoked grant drops its cached pages immediately regardless.',
  },
  {
    key: 'ppo.standard_length', label: 'Standard PPO length', kind: 'integer', unit: 'digits',
    min: 4, max: 20,
    description: 'The current PPO format. Files matching this are indexed without comment.',
  },
  {
    key: 'ppo.min_length', label: 'Shortest accepted PPO', kind: 'integer', unit: 'digits',
    min: 1, max: 20,
    description:
      'Legacy PPO numbers are shorter than today’s. Anything down to this length is indexed and flagged as non-standard; anything shorter is quarantined.',
  },
  {
    key: 'ppo.max_length', label: 'Longest accepted PPO', kind: 'integer', unit: 'digits',
    min: 4, max: 24,
    description: 'Above this, a filename’s digits are treated as something other than a PPO and the file is quarantined.',
  },
  {
    key: 'search.min_query_length', label: 'Shortest search', kind: 'integer', unit: 'characters',
    min: 1, max: 10,
    description:
      'Below this a search is refused rather than run, and the user is told why. “No records found” and “your search was too short” are different facts.',
  },
  {
    key: 'search.similarity_floor', label: 'Name match threshold', kind: 'number',
    min: 0.1, max: 0.9,
    description:
      'How close a name has to be to count as a match. Lower finds more and includes more noise; higher is stricter and starts missing genuine spelling variants. 0.35 is a reasonable default for transliterated names.',
  },
];

export const SPEC_BY_KEY = new Map(SETTING_SPECS.map((s) => [s.key, s]));

export type ValidationResult = { ok: true; value: unknown } | { ok: false; message: string };

export function validateSetting(key: string, raw: unknown): ValidationResult {
  const spec = SPEC_BY_KEY.get(key);
  if (!spec) return { ok: false, message: `${key} is not a known setting.` };

  const range = (n: number): string | null => {
    if (spec.min !== undefined && n < spec.min) return `Must be at least ${spec.min}.`;
    if (spec.max !== undefined && n > spec.max) {
      return spec.ceilingNote ? `Must be at most ${spec.max}. ${spec.ceilingNote}` : `Must be at most ${spec.max}.`;
    }
    return null;
  };

  if (spec.kind === 'integer-list') {
    const list = Array.isArray(raw) ? raw : null;
    if (!list || list.length === 0) return { ok: false, message: 'Give at least one number.' };
    const nums: number[] = [];
    for (const v of list) {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) return { ok: false, message: 'Use whole numbers of days, e.g. 7, 2.' };
      nums.push(n);
    }
    // Descending, so "warn at 7 then 2" reads in the order it happens.
    return { ok: true, value: [...new Set(nums)].sort((a, b) => b - a) };
  }

  const n = Number(raw);
  if (!Number.isFinite(n)) return { ok: false, message: 'That is not a number.' };
  if (spec.kind === 'integer' && !Number.isInteger(n)) return { ok: false, message: 'Use a whole number.' };
  const bad = range(n);
  if (bad) return { ok: false, message: bad };
  return { ok: true, value: n };
}
