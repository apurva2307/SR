// Pages added to a service record after indexing. Needs DATABASE_URL, and
// SR_ADDITIONS_ROOT pointing at a writable scratch folder.
import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import pg from 'pg';
import * as mupdf from 'mupdf';
import { createCanvas } from '@napi-rs/canvas';
import { config } from '../src/config.ts';
import {
  carryForward, commit, findStaged, layout, locatePage, sniff, stage, withdraw,
} from '../src/services/additions.ts';
import { seed, type World } from './helpers/fixtures.ts';

const url = process.env.DATABASE_URL;

/** A PDF of `pages` blank pages; `tag` makes the bytes unique. */
function makePdf(pages: number, tag: string): Buffer {
  const doc = new mupdf.PDFDocument();
  for (let i = 0; i < pages; i++) {
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, {}, `% ${tag} ${i}\n`));
  }
  return Buffer.from(doc.saveToBuffer().asUint8Array());
}

async function makePng(shade: string): Promise<Buffer> {
  const c = createCanvas(240, 320);
  const ctx = c.getContext('2d');
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, 240, 320);
  return c.encode('png');
}

describe('record additions', { skip: url ? false : 'DATABASE_URL not set' }, () => {
  let db: pg.Client;
  let w: World;

  before(async () => {
    db = new pg.Client({ connectionString: url });
    await db.connect();
  });
  after(async () => {
    await db.end();
    await rm(config.additionsRoot, { recursive: true, force: true });
  });
  beforeEach(async () => {
    w = await seed(db);
    await rm(config.additionsRoot, { recursive: true, force: true });
    await mkdir(config.additionsRoot, { recursive: true });
  });

  /** Stage and commit in one go, as a custodian would in two clicks. */
  async function add(bytes: Buffer, description = 'Increment order 2026-27', recordId = w.record) {
    const s = await stage(db, { recordId, userId: w.users.custodian, bytes, originalName: 'x.pdf' });
    assert.ok(s.ok, `staging refused: ${JSON.stringify(s)}`);
    const c = await commit(db, {
      recordId, uploadId: s.upload.id, userId: w.users.custodian, description,
    });
    assert.ok(c.ok, `commit refused: ${JSON.stringify(c)}`);
    return c;
  }

  test('added pages follow the original, numbered on from its last page', async () => {
    const c = await add(makePdf(3, 'a'));
    assert.equal(c.seq, 1);
    assert.equal(c.firstPage, 85); // the fixture record has 84 pages
    assert.equal(c.lastPage, 87);

    const l = await layout(db, w.record);
    assert.equal(l!.total, 87);
    assert.deepEqual(l!.segments.map((s) => [s.kind, s.firstPage, s.lastPage]),
      [['ORIGINAL', 1, 84], ['ADDITION', 85, 87]]);
    assert.equal(l!.segments[1]!.description, 'Increment order 2026-27');

    const { rows } = await db.query<{ added_page_count: number }>(
      'SELECT added_page_count FROM service_records WHERE id = $1', [w.record]);
    assert.equal(rows[0]!.added_page_count, 3);

    const { rows: ev } = await db.query<{ detail: { firstPage: number } }>(
      `SELECT detail FROM access_events WHERE event_type = 'RECORD_PAGES_ADDED'`);
    assert.equal(ev[0]!.detail.firstPage, 85);
  });

  test('a page number finds the right file and the right page within it', async () => {
    await add(makePdf(2, 'b'));
    await add(makePdf(3, 'c'), 'Transfer order');
    // 84 original + 2 from the first addition: page 88 is the second addition's second page.
    const p = await locatePage(db, w.record, 88);
    assert.ok(p && p !== 'OUT_OF_RANGE');
    assert.equal(p.localPage, 2);
    assert.equal(p.total, 89);
    assert.ok(p.filePath.startsWith(config.additionsRoot));
    assert.equal(await locatePage(db, w.record, 90), 'OUT_OF_RANGE');
  });

  test('a JPG or PNG becomes a one-page PDF', async () => {
    const s = await stage(db, {
      recordId: w.record, userId: w.users.custodian, bytes: await makePng('#ccc'), originalName: 'scan.png',
    });
    assert.ok(s.ok);
    assert.equal(s.upload.sourceKind, 'IMAGE');
    assert.equal(s.upload.pageCount, 1);
  });

  test('the type is judged from the bytes, not the name', async () => {
    assert.equal(sniff(Buffer.from('%PDF-1.7')), 'PDF');
    const s = await stage(db, {
      recordId: w.record, userId: w.users.custodian, bytes: Buffer.from('MZ not a pdf'), originalName: 'x.pdf',
    });
    assert.deepEqual(s, { ok: false, reason: 'UNSUPPORTED_TYPE' });
  });

  test('the same file cannot be added twice', async () => {
    const bytes = makePdf(1, 'dup');
    await add(bytes);
    const again = await stage(db, { recordId: w.record, userId: w.users.custodian, bytes, originalName: 'x.pdf' });
    assert.equal(again.ok, false);
    assert.equal(!again.ok && again.reason, 'DUPLICATE');
  });

  test('a staged upload is seen only by the custodian who made it', async () => {
    const s = await stage(db, {
      recordId: w.record, userId: w.users.custodian, bytes: makePdf(1, 'mine'), originalName: 'x.pdf',
    });
    assert.ok(s.ok);
    assert.equal(await findStaged(db, { recordId: w.record, uploadId: s.upload.id, userId: w.users.approver }), null);
    // …and confirming someone else's upload fails the same way.
    const c = await commit(db, {
      recordId: w.record, uploadId: s.upload.id, userId: w.users.approver, description: 'Not mine to add',
    });
    assert.deepEqual(c, { ok: false, reason: 'NOT_FOUND' });
  });

  test('withdrawing keeps the history and moves later pages up', async () => {
    const first = await add(makePdf(2, 'w1'));
    await add(makePdf(1, 'w2'), 'Leave order');

    const out = await withdraw(db, {
      recordId: w.record, additionId: first.id, userId: w.users.custodian, reason: 'Wrong employee',
    });
    assert.deepEqual(out, { ok: true });

    const l = await layout(db, w.record);
    assert.equal(l!.total, 85);
    assert.equal(l!.segments[1]!.description, 'Leave order');
    assert.equal(l!.segments[1]!.firstPage, 85);

    assert.deepEqual(
      await withdraw(db, { recordId: w.record, additionId: first.id, userId: w.users.custodian, reason: 'again' }),
      { ok: false, reason: 'ALREADY_WITHDRAWN' });

    // Withdrawn, not deleted — and the same paper may now be added again.
    const { rows } = await db.query('SELECT 1 FROM record_additions WHERE id = $1', [first.id]);
    assert.equal(rows.length, 1);
  });

  test('a withdrawal without a reason is refused by the database itself', async () => {
    const c = await add(makePdf(1, 'nr'));
    await assert.rejects(db.query(
      `UPDATE record_additions SET status = 'WITHDRAWN', withdrawn_at = now(), withdrawn_by = $2
        WHERE id = $1`, [c.id, w.users.custodian]));
  });

  test('a superseded record takes no new pages', async () => {
    await db.query(`UPDATE service_records SET status = 'SUPERSEDED' WHERE id = $1`, [w.record]);
    const s = await stage(db, {
      recordId: w.record, userId: w.users.custodian, bytes: makePdf(1, 'old'), originalName: 'x.pdf',
    });
    assert.deepEqual(s, { ok: false, reason: 'RECORD_NOT_ACTIVE' });
  });

  test('additions carry forward to a new scan when the custodian says so', async () => {
    await add(makePdf(2, 'cf'));
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO service_records
         (ppo_number, ppo_normalized, employee_name, name_normalized, name_sorted,
          file_path, file_name, sha256, byte_size, page_count, source_root, version_no)
       VALUES ('410221100347','410221100347','Shri Ram Kumar Sharma','RAM KUMAR SHARMA',
               'KUMAR RAM SHARMA','/srv/sr/v2.pdf','v2.pdf', repeat('b',64), 1, 90, '/srv/sr', 2)
       RETURNING id`);
    const v2 = rows[0]!.id;

    assert.equal(await carryForward(db, { fromRecordId: w.record, toRecordId: v2, custodianId: w.users.custodian }), 1);
    const l = await layout(db, v2);
    assert.equal(l!.total, 92);
    assert.equal(l!.segments[1]!.firstPage, 91);
    assert.equal((await layout(db, w.record))!.total, 84);
  });
});
