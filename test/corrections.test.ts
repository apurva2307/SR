// Correcting a record's name or PPO number after indexing. Needs DATABASE_URL.
import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {
  correctName, decidePpo, historyFor, proposePpo, withdrawPpo,
} from '../src/services/corrections.ts';
import { search } from '../src/services/search.ts';
import { seed, type World } from './helpers/fixtures.ts';

const url = process.env.DATABASE_URL;
const REASON = 'As per PSO no. 118/2026 dated 2 Oct 2026';

describe('record corrections', { skip: url ? false : 'DATABASE_URL not set' }, () => {
  let db: pg.Client;
  let w: World;

  before(async () => {
    db = new pg.Client({ connectionString: url });
    await db.connect();
  });
  after(async () => { await db.end(); });
  beforeEach(async () => {
    await db.query('TRUNCATE record_corrections CASCADE');
    w = await seed(db);
    await db.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'CUSTODIAN')`, [w.users.controller]);
  });

  const record = async () => (await db.query<{
    ppo_number: string; ppo_normalized: string; employee_name: string; name_normalized: string; name_sorted: string;
  }>('SELECT ppo_number, ppo_normalized, employee_name, name_normalized, name_sorted FROM service_records WHERE id = $1',
    [w.record])).rows[0]!;

  const events = async (type: string) => (await db.query<{ outcome: string; actor_id: string; detail: Record<string, unknown> }>(
    'SELECT outcome, actor_id, detail FROM access_events WHERE event_type = $1 ORDER BY seq', [type])).rows;

  test('a custodian corrects the name at once, and it is logged with both values', async () => {
    const out = await correctName(db, {
      recordId: w.record, userId: w.users.custodian, name: 'Shri Ram Kumar  Sharmaa', reason: REASON,
    });
    assert.ok(out.ok);

    const r = await record();
    assert.equal(r.employee_name, 'Shri Ram Kumar Sharmaa');
    assert.equal(r.name_normalized, 'RAM KUMAR SHARMAA');
    assert.equal(r.name_sorted, 'KUMAR RAM SHARMAA');

    const [ev] = await events('METADATA_CORRECTED');
    assert.equal(ev!.outcome, 'ALLOW');
    assert.equal(ev!.actor_id, w.users.custodian);
    assert.equal(ev!.detail['from'], 'Shri Ram Kumar Sharma');
    assert.equal(ev!.detail['to'], 'Shri Ram Kumar Sharmaa');
    assert.equal(ev!.detail['reason'], REASON);

    const h = await historyFor(db, w.record);
    assert.equal(h.length, 1);
    assert.equal(h[0]!.status, 'APPLIED');
  });

  test('the old spelling stays searchable', async () => {
    await correctName(db, { recordId: w.record, userId: w.users.custodian, name: 'Ram Kishore Verma', reason: REASON });
    const out = await search(db, { q: 'Ram Kumar Sharma', userId: w.users.requester, isCustodial: false });
    assert.ok(out.ok);
    assert.equal(out.hits[0]?.id, w.record);
  });

  test('an unchanged name is refused, and the refusal is logged', async () => {
    const out = await correctName(db, {
      recordId: w.record, userId: w.users.custodian, name: 'Shri Ram Kumar Sharma', reason: REASON,
    });
    assert.deepEqual(out, { ok: false, reason: 'NO_CHANGE' });
    const [ev] = await events('METADATA_CORRECTED');
    assert.equal(ev!.outcome, 'DENY');
  });

  test('a PPO proposal changes nothing until a controlling officer approves it', async () => {
    const p = await proposePpo(db, { recordId: w.record, userId: w.users.custodian, ppo: '4102-2110-0348', reason: REASON });
    assert.ok(p.ok);
    assert.equal((await record()).ppo_number, '410221100347');
    assert.equal((await events('CORRECTION_PROPOSED'))[0]!.outcome, 'ALLOW');

    const d = await decidePpo(db, { correctionId: p.correctionId, userId: w.users.controller, approve: true });
    assert.ok(d.ok);
    const r = await record();
    assert.equal(r.ppo_number, '4102-2110-0348');
    assert.equal(r.ppo_normalized, '410221100348');

    const [ev] = await events('METADATA_CORRECTED');
    assert.equal(ev!.actor_id, w.users.controller);
    assert.equal(ev!.detail['proposedBy'], w.users.custodian);
    assert.equal(ev!.detail['approvedBy'], w.users.controller);

    // The old number still finds the record.
    const s = await search(db, { q: '410221100347', userId: w.users.requester, isCustodial: false });
    assert.ok(s.ok);
    assert.equal(s.hits[0]?.id, w.record);
  });

  test('the proposer can never decide their own PPO correction', async () => {
    const p = await proposePpo(db, { recordId: w.record, userId: w.users.controller, ppo: '410221100348', reason: REASON });
    assert.ok(p.ok);
    const d = await decidePpo(db, { correctionId: p.correctionId, userId: w.users.controller, approve: true });
    assert.deepEqual(d, { ok: false, reason: 'SELF_DECISION' });
    assert.equal((await record()).ppo_number, '410221100347');
    assert.equal((await events('METADATA_CORRECTED'))[0]!.outcome, 'DENY');

    // And the database refuses it even if the service were bypassed.
    await assert.rejects(db.query(
      `UPDATE record_corrections SET status = 'APPLIED', decided_by = proposed_by, decided_at = now() WHERE id = $1`,
      [p.correctionId]));
  });

  test('a rejection needs remarks and leaves the record alone', async () => {
    const p = await proposePpo(db, { recordId: w.record, userId: w.users.custodian, ppo: '410221100348', reason: REASON });
    assert.ok(p.ok);
    assert.deepEqual(
      await decidePpo(db, { correctionId: p.correctionId, userId: w.users.controller, approve: false }),
      { ok: false, reason: 'REMARKS_REQUIRED' });
    const d = await decidePpo(db, {
      correctionId: p.correctionId, userId: w.users.controller, approve: false, remarks: 'Not in PSO register',
    });
    assert.ok(d.ok);
    assert.equal((await record()).ppo_number, '410221100347');
    const ev = (await events('CORRECTION_REJECTED')).find((e) => e.outcome === 'ALLOW');
    assert.equal(ev!.detail['remarks'], 'Not in PSO register');
  });

  test('a PPO already on another live record is refused', async () => {
    await db.query(
      `INSERT INTO service_records
         (ppo_number, ppo_normalized, employee_name, name_normalized, name_sorted,
          file_path, file_name, sha256, byte_size, page_count, source_root)
       VALUES ('410221100999','410221100999','Smt Geeta Devi','GEETA DEVI','DEVI GEETA',
               '/srv/sr/g.pdf','g.pdf', repeat('b',64), 1000, 3, '/srv/sr')`);
    const p = await proposePpo(db, { recordId: w.record, userId: w.users.custodian, ppo: '410221100999', reason: REASON });
    assert.equal(p.ok, false);
    assert.equal(!p.ok && p.reason, 'PPO_IN_USE');
    assert.equal((await events('CORRECTION_PROPOSED'))[0]!.outcome, 'DENY');
  });

  test('one open proposal per record; the proposer may withdraw it', async () => {
    const p = await proposePpo(db, { recordId: w.record, userId: w.users.custodian, ppo: '410221100348', reason: REASON });
    assert.ok(p.ok);
    const again = await proposePpo(db, { recordId: w.record, userId: w.users.custodian, ppo: '410221100349', reason: REASON });
    assert.equal(!again.ok && again.reason, 'ALREADY_PENDING');

    assert.deepEqual(await withdrawPpo(db, { correctionId: p.correctionId, userId: w.users.controller }),
      { ok: false, reason: 'NOT_PROPOSER' });
    assert.ok((await withdrawPpo(db, { correctionId: p.correctionId, userId: w.users.custodian })).ok);
    assert.equal((await events('CORRECTION_WITHDRAWN')).filter((e) => e.outcome === 'ALLOW').length, 1);
  });

  test('the correction history cannot be deleted or rewritten', async () => {
    const out = await correctName(db, { recordId: w.record, userId: w.users.custodian, name: 'Ram K Sharma', reason: REASON });
    assert.ok(out.ok);
    await assert.rejects(db.query('DELETE FROM record_corrections WHERE id = $1', [out.correctionId]));
    await assert.rejects(db.query(`UPDATE record_corrections SET reason = 'changed later, quietly' WHERE id = $1`,
      [out.correctionId]));
  });
});
