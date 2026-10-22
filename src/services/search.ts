// §7 — search by PPO number and by name. The catalogue is deliberately open
// within the organisation; content is not. A requester can see that a record
// exists and still be unable to see a single page, which is what makes a
// request possible: you cannot ask for a file you cannot name.
import type { Queryable, Uuid } from '../domain/types.ts';
import { normalizeName, normalizePpo, sortNameTokens } from '../ingest/normalize.ts';

export type AccessState = 'CUSTODIAL' | 'GRANTED' | 'PENDING' | 'EXPIRED' | 'NO_ACCESS';

export interface SearchHit {
  id: Uuid;
  ppoNumber: string;
  employeeName: string;
  pageCount: number | null;
  indexedAt: Date;
  status: string;
  accessState: AccessState;
  grantValidUntil: Date | null;
  score: number;
}

export type SearchOutcome =
  | { ok: true; hits: SearchHit[]; total: number; branch: 'PPO' | 'NAME' | 'BOTH' }
  // "No records found" and "your search was too short to run" are different
  // facts. Conflating them teaches users the catalogue is incomplete (§7.1).
  | { ok: false; reason: 'QUERY_TOO_SHORT'; minLength: number };

const MIN_LENGTH = 3;
const FLOOR = 0.35;

const SQL = `
WITH scored AS (
  SELECT r.id, r.ppo_number, r.employee_name,
         r.page_count + r.added_page_count AS page_count, r.indexed_at, r.status,
         GREATEST(
           CASE WHEN $2::text <> '' AND r.ppo_normalized = $2 THEN 1.0
                WHEN $2::text <> '' AND r.ppo_normalized LIKE $2 || '%' THEN 0.9
                ELSE 0 END,
           CASE WHEN $3::text <> ''
                THEN GREATEST(similarity(r.name_normalized, $3), similarity(r.name_sorted, $4))
                ELSE 0 END,
           -- A corrected record still answers to the value it replaced: the
           -- requesting department may hold only the old PPO or spelling.
           COALESCE((
             SELECT max(CASE
                      WHEN a.alias_kind = 'PPO' AND $2::text <> '' AND a.value_normalized = $2 THEN 0.95
                      WHEN a.alias_kind = 'NAME' AND $3::text <> '' THEN similarity(a.value_normalized, $3)
                      ELSE 0 END)
             FROM record_aliases a WHERE a.service_record_id = r.id), 0)
         ) AS score
  FROM service_records r
  WHERE r.status = 'ACTIVE'
),
matched AS (
  SELECT * FROM scored WHERE score >= $5
),
live_grant AS (
  SELECT g.service_record_id, max(g.valid_until) AS valid_until
  FROM access_grants g
  WHERE g.user_id = $1 AND g.revoked_at IS NULL
    AND now() >= g.valid_from AND now() < g.valid_until
    AND (g.max_views IS NULL OR g.view_count < g.max_views)
  GROUP BY g.service_record_id
),
past_grant AS (
  SELECT DISTINCT g.service_record_id FROM access_grants g WHERE g.user_id = $1
),
pending AS (
  SELECT DISTINCT i.service_record_id
  FROM access_request_items i
  JOIN access_requests q ON q.id = i.request_id
  WHERE q.requester_id = $1 AND q.status = 'SUBMITTED' AND i.item_status = 'PENDING'
)
SELECT m.*, lg.valid_until,
       (p.service_record_id IS NOT NULL) AS is_pending,
       (pg.service_record_id IS NOT NULL) AS had_grant,
       count(*) OVER () AS total
FROM matched m
LEFT JOIN live_grant lg ON lg.service_record_id = m.id
LEFT JOIN pending   p  ON p.service_record_id  = m.id
LEFT JOIN past_grant pg ON pg.service_record_id = m.id
ORDER BY m.score DESC, m.employee_name
LIMIT $6 OFFSET $7`;

interface Row {
  id: string; ppo_number: string; employee_name: string; page_count: number | null;
  indexed_at: Date; status: string; score: string; valid_until: Date | null;
  is_pending: boolean; had_grant: boolean; total: string;
}

export interface SearchParams {
  q: string;
  userId: Uuid;
  isCustodial: boolean;
  limit?: number;
  offset?: number;
}

export async function search(db: Queryable, p: SearchParams): Promise<SearchOutcome> {
  const q = p.q.trim();
  if (q.length < MIN_LENGTH) return { ok: false, reason: 'QUERY_TOO_SHORT', minLength: MIN_LENGTH };

  // Routing (§7.1): four or more consecutive digits means someone typed a PPO.
  const digits = normalizePpo(q);
  const ppoBranch = digits.length >= 4;
  const nameBranch = /\p{L}/u.test(q);
  const branch: 'PPO' | 'NAME' | 'BOTH' = ppoBranch && nameBranch ? 'BOTH' : ppoBranch ? 'PPO' : 'NAME';

  const nameQuery = nameBranch ? normalizeName(q) : '';
  const { rows } = await db.query<Row>(SQL, [
    p.userId,
    ppoBranch ? digits : '',
    nameQuery,
    nameQuery ? sortNameTokens(nameQuery) : '',
    FLOOR,
    p.limit ?? 25,
    p.offset ?? 0,
  ]);

  const hits = rows.map((r): SearchHit => ({
    id: r.id,
    ppoNumber: r.ppo_number,
    employeeName: r.employee_name,
    pageCount: r.page_count,
    indexedAt: r.indexed_at,
    status: r.status,
    grantValidUntil: r.valid_until,
    score: Number(r.score),
    accessState: p.isCustodial ? 'CUSTODIAL'
      : r.valid_until ? 'GRANTED'
      : r.is_pending ? 'PENDING'
      : r.had_grant ? 'EXPIRED'
      : 'NO_ACCESS',
  }));

  return { ok: true, hits, total: rows[0] ? Number(rows[0].total) : 0, branch };
}
