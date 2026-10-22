// Correcting a record's employee name or PPO number after indexing
// (migration 016).
//
// A name is corrected by a custodian and applies at once. A PPO number is the
// record's identity, so a custodian proposes it and a controlling officer —
// never the proposer — approves or rejects it. Either way:
//   * every version of the record moves together, so an earlier scan never
//     answers to the old value while the current one answers to the new;
//   * the replaced value becomes an alias, so a department still holding the
//     old PPO or spelling finds the record;
//   * every step, refusals included, is an audit event in the same
//     transaction as the change it describes.
import type { Queryable, Uuid } from '../domain/types.ts';
import { appendEvent } from '../audit/events.ts';
import {
  classifyPpo, collapseWhitespace, deriveNameForms, normalizePpo, DEFAULT_PPO_RULES,
} from '../ingest/normalize.ts';

export type CorrectionField = 'EMPLOYEE_NAME' | 'PPO_NUMBER';

interface Actor { userId: Uuid; ip?: string | null }

interface RecordRow {
  id: Uuid; status: string; ppo_number: string; ppo_normalized: string;
  employee_name: string; name_normalized: string;
}

async function lockRecord(db: Queryable, recordId: Uuid): Promise<RecordRow | null> {
  const { rows } = await db.query<RecordRow>(
    `SELECT id, status, ppo_number, ppo_normalized, employee_name, name_normalized
       FROM service_records WHERE id = $1 FOR UPDATE`, [recordId],
  );
  return rows[0] ?? null;
}

/** The record and every version it superseded, newest first. */
async function versionChain(db: Queryable, recordId: Uuid): Promise<Uuid[]> {
  const { rows } = await db.query<{ id: Uuid }>(
    `WITH RECURSIVE chain AS (
       SELECT id, 0 AS depth FROM service_records WHERE id = $1
       UNION ALL
       SELECT r.id, c.depth + 1 FROM service_records r JOIN chain c ON r.superseded_by = c.id
     )
     SELECT id FROM chain ORDER BY depth`, [recordId],
  );
  return rows.map((r) => r.id);
}

async function addAlias(
  db: Queryable, recordId: Uuid, kind: 'PPO' | 'NAME', value: string, userId: Uuid,
): Promise<void> {
  if (!value) return;
  await db.query(
    `INSERT INTO record_aliases (service_record_id, alias_kind, value_normalized, source, created_by)
     VALUES ($1,$2,$3,'CORRECTION',$4)
     ON CONFLICT (service_record_id, alias_kind, value_normalized) DO NOTHING`,
    [recordId, kind, value, userId],
  );
}

/** Another live record — not a version of this one — already carrying the PPO. */
async function ppoHolder(db: Queryable, digits: string, chain: Uuid[]): Promise<RecordRow | null> {
  const { rows } = await db.query<RecordRow>(
    `SELECT id, status, ppo_number, ppo_normalized, employee_name, name_normalized
       FROM service_records
      WHERE ppo_normalized = $1 AND status = 'ACTIVE' AND NOT (id = ANY($2::uuid[]))
      LIMIT 1`, [digits, chain],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Name
// ---------------------------------------------------------------------------

export type NameRefusal = 'RECORD_NOT_FOUND' | 'RECORD_NOT_ACTIVE' | 'EMPTY_NAME' | 'NO_CHANGE';

export type NameResult =
  | { ok: true; correctionId: Uuid; versionsUpdated: number }
  | { ok: false; reason: NameRefusal };

export async function correctName(
  db: Queryable,
  args: Actor & { recordId: Uuid; name: string; reason: string },
): Promise<NameResult> {
  const rec = await lockRecord(db, args.recordId);
  if (!rec) return { ok: false, reason: 'RECORD_NOT_FOUND' };

  const refuse = async (reason: NameRefusal): Promise<NameResult> => {
    await appendEvent(db, {
      eventType: 'METADATA_CORRECTED', outcome: 'DENY', actorId: args.userId, actorIp: args.ip ?? null,
      serviceRecordId: rec.id,
      detail: { field: 'EMPLOYEE_NAME', refused: reason, from: rec.employee_name, to: args.name },
    });
    return { ok: false, reason };
  };

  if (rec.status !== 'ACTIVE') return refuse('RECORD_NOT_ACTIVE');
  const forms = deriveNameForms(args.name);
  if (!forms.nameNormalized) return refuse('EMPTY_NAME');
  if (forms.employeeName === rec.employee_name) return refuse('NO_CHANGE');

  const chain = await versionChain(db, rec.id);
  await db.query(
    `UPDATE service_records SET employee_name = $2, name_normalized = $3, name_sorted = $4
      WHERE id = ANY($1::uuid[])`,
    [chain, forms.employeeName, forms.nameNormalized, forms.nameSorted],
  );
  if (rec.name_normalized !== forms.nameNormalized) {
    await addAlias(db, rec.id, 'NAME', rec.name_normalized, args.userId);
  }

  const { rows } = await db.query<{ id: Uuid }>(
    `INSERT INTO record_corrections
       (service_record_id, field, old_value, new_value, reason, status,
        proposed_by, decided_by, decided_at)
     VALUES ($1,'EMPLOYEE_NAME',$2,$3,$4,'APPLIED',$5,$5,now()) RETURNING id`,
    [rec.id, rec.employee_name, forms.employeeName, args.reason.trim(), args.userId],
  );
  const correctionId = rows[0]!.id;

  await appendEvent(db, {
    eventType: 'METADATA_CORRECTED', actorId: args.userId, actorIp: args.ip ?? null,
    serviceRecordId: rec.id,
    detail: {
      correctionId, field: 'EMPLOYEE_NAME', from: rec.employee_name, to: forms.employeeName,
      reason: args.reason.trim(), versionsUpdated: chain.length,
    },
  });
  return { ok: true, correctionId, versionsUpdated: chain.length };
}

// ---------------------------------------------------------------------------
// PPO — proposed by a custodian, decided by a controlling officer
// ---------------------------------------------------------------------------

export type ProposeRefusal =
  | 'RECORD_NOT_FOUND' | 'RECORD_NOT_ACTIVE' | 'BAD_PPO' | 'NO_CHANGE'
  | 'PPO_IN_USE' | 'ALREADY_PENDING';

export type ProposeResult =
  | { ok: true; correctionId: Uuid }
  | { ok: false; reason: ProposeRefusal; detail?: string };

export async function proposePpo(
  db: Queryable,
  args: Actor & { recordId: Uuid; ppo: string; reason: string },
): Promise<ProposeResult> {
  const rec = await lockRecord(db, args.recordId);
  if (!rec) return { ok: false, reason: 'RECORD_NOT_FOUND' };

  const newValue = collapseWhitespace(args.ppo);
  const refuse = async (reason: ProposeRefusal, detail?: string): Promise<ProposeResult> => {
    await appendEvent(db, {
      eventType: 'CORRECTION_PROPOSED', outcome: 'DENY', actorId: args.userId, actorIp: args.ip ?? null,
      serviceRecordId: rec.id,
      detail: { field: 'PPO_NUMBER', refused: reason, from: rec.ppo_number, to: newValue },
    });
    return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
  };

  if (rec.status !== 'ACTIVE') return refuse('RECORD_NOT_ACTIVE');
  const digits = normalizePpo(newValue);
  if (classifyPpo(digits, DEFAULT_PPO_RULES) === 'OUT_OF_RANGE') return refuse('BAD_PPO');
  if (newValue === rec.ppo_number) return refuse('NO_CHANGE');

  const chain = await versionChain(db, rec.id);
  const holder = await ppoHolder(db, digits, chain);
  if (holder) return refuse('PPO_IN_USE', holder.employee_name);

  const { rows: open } = await db.query(
    `SELECT 1 FROM record_corrections WHERE service_record_id = $1 AND status = 'PENDING'`, [rec.id],
  );
  if (open.length > 0) return refuse('ALREADY_PENDING');

  const { rows } = await db.query<{ id: Uuid }>(
    `INSERT INTO record_corrections
       (service_record_id, field, old_value, new_value, reason, status, proposed_by)
     VALUES ($1,'PPO_NUMBER',$2,$3,$4,'PENDING',$5) RETURNING id`,
    [rec.id, rec.ppo_number, newValue, args.reason.trim(), args.userId],
  );
  const correctionId = rows[0]!.id;
  await appendEvent(db, {
    eventType: 'CORRECTION_PROPOSED', actorId: args.userId, actorIp: args.ip ?? null,
    serviceRecordId: rec.id,
    detail: {
      correctionId, field: 'PPO_NUMBER', from: rec.ppo_number, to: newValue, reason: args.reason.trim(),
    },
  });
  return { ok: true, correctionId };
}

interface CorrectionRow {
  id: Uuid; service_record_id: Uuid; field: CorrectionField; old_value: string; new_value: string;
  reason: string; status: string; proposed_by: Uuid;
}

async function lockCorrection(db: Queryable, id: Uuid): Promise<CorrectionRow | null> {
  const { rows } = await db.query<CorrectionRow>(
    `SELECT id, service_record_id, field, old_value, new_value, reason, status, proposed_by
       FROM record_corrections WHERE id = $1 FOR UPDATE`, [id],
  );
  return rows[0] ?? null;
}

export type DecideRefusal =
  | 'NOT_FOUND' | 'NOT_PENDING' | 'SELF_DECISION' | 'REMARKS_REQUIRED'
  | 'RECORD_NOT_ACTIVE' | 'RECORD_CHANGED' | 'PPO_IN_USE';

export type DecideResult =
  | { ok: true; recordId: Uuid; status: 'APPLIED' | 'REJECTED'; versionsUpdated: number }
  | { ok: false; reason: DecideRefusal; detail?: string };

export async function decidePpo(
  db: Queryable,
  args: Actor & { correctionId: Uuid; approve: boolean; remarks?: string | null },
): Promise<DecideResult> {
  const c = await lockCorrection(db, args.correctionId);
  if (!c) return { ok: false, reason: 'NOT_FOUND' };
  const remarks = args.remarks?.trim() || null;

  const refuse = async (reason: DecideRefusal, detail?: string): Promise<DecideResult> => {
    await appendEvent(db, {
      eventType: args.approve ? 'METADATA_CORRECTED' : 'CORRECTION_REJECTED', outcome: 'DENY',
      actorId: args.userId, actorIp: args.ip ?? null, serviceRecordId: c.service_record_id,
      detail: {
        correctionId: c.id, field: c.field, refused: reason, from: c.old_value, to: c.new_value,
      },
    });
    return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
  };

  if (c.status !== 'PENDING') return refuse('NOT_PENDING');
  if (c.proposed_by === args.userId) return refuse('SELF_DECISION');

  if (!args.approve) {
    if (!remarks) return refuse('REMARKS_REQUIRED');
    await db.query(
      `UPDATE record_corrections
          SET status = 'REJECTED', decided_by = $2, decided_at = now(), decision_remarks = $3
        WHERE id = $1`, [c.id, args.userId, remarks],
    );
    await appendEvent(db, {
      eventType: 'CORRECTION_REJECTED', actorId: args.userId, actorIp: args.ip ?? null,
      serviceRecordId: c.service_record_id,
      detail: {
        correctionId: c.id, field: c.field, from: c.old_value, to: c.new_value,
        proposedBy: c.proposed_by, remarks,
      },
    });
    return { ok: true, recordId: c.service_record_id, status: 'REJECTED', versionsUpdated: 0 };
  }

  // The world may have moved since the proposal: check it again, under lock.
  const rec = await lockRecord(db, c.service_record_id);
  if (!rec || rec.status !== 'ACTIVE') return refuse('RECORD_NOT_ACTIVE');
  if (rec.ppo_number !== c.old_value) return refuse('RECORD_CHANGED');
  const digits = normalizePpo(c.new_value);
  const chain = await versionChain(db, rec.id);
  const holder = await ppoHolder(db, digits, chain);
  if (holder) return refuse('PPO_IN_USE', holder.employee_name);

  await db.query(
    `UPDATE service_records SET ppo_number = $2, ppo_normalized = $3 WHERE id = ANY($1::uuid[])`,
    [chain, c.new_value, digits],
  );
  if (rec.ppo_normalized !== digits) {
    await addAlias(db, rec.id, 'PPO', rec.ppo_normalized, args.userId);
  }
  await db.query(
    `UPDATE record_corrections
        SET status = 'APPLIED', decided_by = $2, decided_at = now(), decision_remarks = $3
      WHERE id = $1`, [c.id, args.userId, remarks],
  );
  await appendEvent(db, {
    eventType: 'METADATA_CORRECTED', actorId: args.userId, actorIp: args.ip ?? null,
    serviceRecordId: rec.id,
    detail: {
      correctionId: c.id, field: 'PPO_NUMBER', from: c.old_value, to: c.new_value,
      reason: c.reason, proposedBy: c.proposed_by, approvedBy: args.userId, remarks,
      versionsUpdated: chain.length,
    },
  });
  return { ok: true, recordId: rec.id, status: 'APPLIED', versionsUpdated: chain.length };
}

export type WithdrawRefusal = 'NOT_FOUND' | 'NOT_PENDING' | 'NOT_PROPOSER';

export async function withdrawPpo(
  db: Queryable, args: Actor & { correctionId: Uuid },
): Promise<{ ok: true; recordId: Uuid } | { ok: false; reason: WithdrawRefusal }> {
  const c = await lockCorrection(db, args.correctionId);
  if (!c) return { ok: false, reason: 'NOT_FOUND' };
  const refusal: WithdrawRefusal | null =
    c.status !== 'PENDING' ? 'NOT_PENDING' : c.proposed_by !== args.userId ? 'NOT_PROPOSER' : null;
  if (refusal) {
    await appendEvent(db, {
      eventType: 'CORRECTION_WITHDRAWN', outcome: 'DENY', actorId: args.userId, actorIp: args.ip ?? null,
      serviceRecordId: c.service_record_id,
      detail: { correctionId: c.id, field: c.field, refused: refusal },
    });
    return { ok: false, reason: refusal };
  }
  await db.query(
    `UPDATE record_corrections SET status = 'WITHDRAWN', decided_by = $2, decided_at = now()
      WHERE id = $1`, [c.id, args.userId],
  );
  await appendEvent(db, {
    eventType: 'CORRECTION_WITHDRAWN', actorId: args.userId, actorIp: args.ip ?? null,
    serviceRecordId: c.service_record_id,
    detail: { correctionId: c.id, field: c.field, from: c.old_value, to: c.new_value },
  });
  return { ok: true, recordId: c.service_record_id };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const LIST_SQL = `
SELECT c.id, c.service_record_id, c.field, c.old_value, c.new_value, c.reason, c.status,
       c.proposed_at, c.decided_at, c.decision_remarks,
       p.full_name AS proposed_by_name, p.staff_code AS proposed_by_code, c.proposed_by,
       d.full_name AS decided_by_name, d.staff_code AS decided_by_code,
       r.employee_name, r.ppo_number
FROM record_corrections c
JOIN users p ON p.id = c.proposed_by
LEFT JOIN users d ON d.id = c.decided_by
JOIN service_records r ON r.id = c.service_record_id`;

/** Every correction ever made to this record or an earlier version of it. */
export async function historyFor(db: Queryable, recordId: Uuid) {
  const chain = await versionChain(db, recordId);
  const { rows } = await db.query(
    `${LIST_SQL} WHERE c.service_record_id = ANY($1::uuid[]) ORDER BY c.proposed_at DESC`, [chain],
  );
  return rows;
}

export async function listPending(db: Queryable) {
  const { rows } = await db.query(`${LIST_SQL} WHERE c.status = 'PENDING' ORDER BY c.proposed_at`);
  return rows;
}

export async function listRecentlyDecided(db: Queryable, limit = 50) {
  const { rows } = await db.query(
    `${LIST_SQL} WHERE c.field = 'PPO_NUMBER' AND c.status <> 'PENDING'
     ORDER BY c.decided_at DESC LIMIT $1`, [limit],
  );
  return rows;
}
