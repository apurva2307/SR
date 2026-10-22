// Pages added to a service record after it was indexed.
//
// The original PDF stays exactly as it is in the read-only source folder. Each
// addition is its own PDF in config.additionsRoot, and the record is presented
// as one continuous run of pages: the original first, then every live addition
// in the order it was added. Page numbers therefore only ever grow at the end;
// withdrawing an addition is the one thing that shifts them.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as mupdf from 'mupdf';
import type { Queryable, Uuid } from '../domain/types.ts';
import { appendEvent } from '../audit/events.ts';
import { config } from '../config.ts';
import { countPages } from './render/pageRenderer.ts';
import { resolveInsideRoots } from './ingest/paths.ts';

const MAX_PAGES = 500;
/** Abandoned staged uploads are swept after this long. */
const STAGED_TTL_HOURS = 24;

const sha256 = (buf: Uint8Array): string => createHash('sha256').update(buf).digest('hex');

export type SourceKind = 'PDF' | 'IMAGE';

/** By the bytes, never by the declared type or the file name. */
export function sniff(bytes: Uint8Array): 'PDF' | 'PNG' | 'JPEG' | null {
  if (bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString('latin1') === '%PDF-') return 'PDF';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'PNG';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'JPEG';
  return null;
}

/** A4's long side in points. A photo of a page should read as a page. */
const PAGE_LONG_SIDE = 842;

/**
 * One image becomes a one-page PDF. Resolution metadata is honoured when it is
 * plausible (a 300 dpi scan of A4 comes out at A4); otherwise — a phone photo
 * at 4000 px with no DPI — the page is scaled so its long side is A4's.
 */
export function imageToPdf(bytes: Uint8Array): Buffer {
  const img = new mupdf.Image(bytes);
  const w = img.getWidth();
  const h = img.getHeight();
  const xres = img.getXResolution();
  const yres = img.getYResolution();
  let pw = xres >= 50 ? (w * 72) / xres : w;
  let ph = yres >= 50 ? (h * 72) / yres : h;
  const shrink = Math.min(1, PAGE_LONG_SIDE / Math.max(pw, ph));
  pw = Math.round(pw * shrink * 100) / 100;
  ph = Math.round(ph * shrink * 100) / 100;

  const doc = new mupdf.PDFDocument();
  const resources = { XObject: { I0: doc.addImage(img) } };
  const page = doc.addPage([0, 0, pw, ph], 0, resources, `q ${pw} 0 0 ${ph} 0 0 cm /I0 Do Q`);
  doc.insertPage(-1, page);
  return Buffer.from(doc.saveToBuffer('compress').asUint8Array());
}

export type StageRefusal =
  | 'RECORD_NOT_FOUND' | 'RECORD_NOT_ACTIVE' | 'EMPTY' | 'TOO_LARGE' | 'UNSUPPORTED_TYPE'
  | 'UNREADABLE' | 'ENCRYPTED' | 'TOO_MANY_PAGES' | 'DUPLICATE';

export type StageResult =
  | { ok: true; upload: { id: Uuid; pageCount: number; sourceKind: SourceKind } }
  | { ok: false; reason: StageRefusal; detail?: string };

/**
 * Step one of two: check the file, convert an image, and hold it as a staged
 * upload the custodian can page through before it joins the record. Nothing
 * here touches the record itself.
 */
export async function stage(
  db: Queryable,
  args: { recordId: Uuid; userId: Uuid; bytes: Uint8Array; originalName: string },
  root = config.additionsRoot,
): Promise<StageResult> {
  const { rows: rec } = await db.query<{ status: string }>(
    'SELECT status FROM service_records WHERE id = $1', [args.recordId],
  );
  if (!rec[0]) return { ok: false, reason: 'RECORD_NOT_FOUND' };
  if (rec[0].status !== 'ACTIVE') return { ok: false, reason: 'RECORD_NOT_ACTIVE' };
  if (args.bytes.length === 0) return { ok: false, reason: 'EMPTY' };
  if (args.bytes.length > config.additionMaxBytes) return { ok: false, reason: 'TOO_LARGE' };

  const kind = sniff(args.bytes);
  if (!kind) return { ok: false, reason: 'UNSUPPORTED_TYPE' };

  const sourceSha = sha256(args.bytes);
  const { rows: dup } = await db.query<{ ppo_number: string; seq: number }>(
    `SELECT r.ppo_number, a.seq FROM record_additions a
       JOIN service_records r ON r.id = a.service_record_id
      WHERE a.source_sha256 = $1 AND a.status = 'ACTIVE'`, [sourceSha],
  );
  if (dup[0]) {
    return { ok: false, reason: 'DUPLICATE', detail: `${dup[0].ppo_number}, addition ${dup[0].seq}` };
  }

  let pdf: Buffer;
  let pageCount: number;
  try {
    pdf = kind === 'PDF' ? Buffer.from(args.bytes) : imageToPdf(args.bytes);
    const doc = mupdf.Document.openDocument(pdf, 'application/pdf');
    if (doc.needsPassword()) return { ok: false, reason: 'ENCRYPTED' };
    pageCount = doc.countPages();
  } catch (err) {
    return { ok: false, reason: 'UNREADABLE', detail: (err as Error).message };
  }
  if (pageCount < 1) return { ok: false, reason: 'UNREADABLE', detail: 'No pages.' };
  if (pageCount > MAX_PAGES) return { ok: false, reason: 'TOO_MANY_PAGES' };

  const id = randomUUID();
  const dir = join(root, 'staged');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${id}.pdf`);
  await writeFile(path, pdf, { flag: 'wx' });

  const sourceKind: SourceKind = kind === 'PDF' ? 'PDF' : 'IMAGE';
  await db.query(
    `INSERT INTO addition_uploads
       (id, service_record_id, uploaded_by, original_name, source_kind, file_path,
        sha256, source_sha256, byte_size, page_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, args.recordId, args.userId, args.originalName.slice(0, 255), sourceKind, path,
     sha256(pdf), sourceSha, pdf.length, pageCount],
  );
  return { ok: true, upload: { id, pageCount, sourceKind } };
}

interface StagedRow {
  id: string; file_path: string; page_count: number; sha256: string; source_sha256: string;
  byte_size: string; original_name: string; source_kind: SourceKind;
}

/** A staged upload is visible only to the custodian who made it. */
export async function findStaged(
  db: Queryable, args: { recordId: Uuid; uploadId: Uuid; userId: Uuid },
): Promise<StagedRow | null> {
  const { rows } = await db.query<StagedRow>(
    `SELECT id, file_path, page_count, sha256, source_sha256, byte_size, original_name, source_kind
       FROM addition_uploads
      WHERE id = $1 AND service_record_id = $2 AND uploaded_by = $3`,
    [args.uploadId, args.recordId, args.userId],
  );
  return rows[0] ?? null;
}

export async function discard(
  db: Queryable, args: { recordId: Uuid; uploadId: Uuid; userId: Uuid },
): Promise<boolean> {
  const { rows } = await db.query<{ file_path: string }>(
    `DELETE FROM addition_uploads WHERE id = $1 AND service_record_id = $2 AND uploaded_by = $3
     RETURNING file_path`,
    [args.uploadId, args.recordId, args.userId],
  );
  if (!rows[0]) return false;
  await unlink(rows[0].file_path).catch(() => {});
  return true;
}

export type CommitResult =
  | { ok: true; id: Uuid; seq: number; firstPage: number; lastPage: number; stagedPath: string }
  | { ok: false; reason: 'NOT_FOUND' | 'RECORD_NOT_ACTIVE' | 'DUPLICATE' };

/**
 * Step two: the custodian has seen the pages and described them. Run inside a
 * transaction — the record row is locked so two additions cannot take the
 * same number. The staged file is copied, not moved, so a rolled-back
 * transaction leaves the staged upload intact; the caller removes the staged
 * copy once the transaction has committed.
 */
export async function commit(
  tx: Queryable,
  args: {
    recordId: Uuid; uploadId: Uuid; userId: Uuid;
    description: string; documentDate?: string | null;
  },
  root = config.additionsRoot,
): Promise<CommitResult> {
  const { rows: rec } = await tx.query<{ status: string; page_count: number | null; added_page_count: number; file_path: string }>(
    `SELECT status, page_count, added_page_count, file_path FROM service_records WHERE id = $1 FOR UPDATE`,
    [args.recordId],
  );
  if (!rec[0]) return { ok: false, reason: 'NOT_FOUND' };
  if (rec[0].status !== 'ACTIVE') return { ok: false, reason: 'RECORD_NOT_ACTIVE' };

  const up = await findStaged(tx, args);
  if (!up) return { ok: false, reason: 'NOT_FOUND' };

  const { rows: dup } = await tx.query(
    `SELECT 1 FROM record_additions WHERE source_sha256 = $1 AND status = 'ACTIVE'`, [up.source_sha256],
  );
  if (dup[0]) return { ok: false, reason: 'DUPLICATE' };

  // Content-addressed: the same bytes always land at the same path.
  const dir = join(root, 'files', up.sha256.slice(0, 2));
  await mkdir(dir, { recursive: true });
  const finalPath = join(dir, `${up.sha256}.pdf`);
  await copyFile(up.file_path, finalPath, constants.COPYFILE_EXCL).catch(async (err: NodeJS.ErrnoException) => {
    // Already there from an earlier, withdrawn addition of the same paper.
    if (err.code !== 'EEXIST') throw err;
  });

  const { rows: seqRow } = await tx.query<{ next: number }>(
    'SELECT coalesce(max(seq), 0) + 1 AS next FROM record_additions WHERE service_record_id = $1',
    [args.recordId],
  );
  const seq = seqRow[0]!.next;

  const { rows: ins } = await tx.query<{ id: string }>(
    `INSERT INTO record_additions
       (service_record_id, seq, description, document_date, original_name, source_kind,
        file_path, sha256, source_sha256, byte_size, page_count, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [args.recordId, seq, args.description.trim(), args.documentDate ?? null, up.original_name,
     up.source_kind, finalPath, up.sha256, up.source_sha256, up.byte_size, up.page_count, args.userId],
  );
  await tx.query(
    'UPDATE service_records SET added_page_count = added_page_count + $2 WHERE id = $1',
    [args.recordId, up.page_count],
  );
  await tx.query('DELETE FROM addition_uploads WHERE id = $1', [up.id]);

  const base = rec[0].page_count ?? await basePageCount(rec[0].file_path);
  const firstPage = base + rec[0].added_page_count + 1;
  const lastPage = firstPage + up.page_count - 1;
  const id = ins[0]!.id;

  await appendEvent(tx, {
    eventType: 'RECORD_PAGES_ADDED', actorId: args.userId, serviceRecordId: args.recordId,
    detail: {
      additionId: id, seq, description: args.description.trim(),
      documentDate: args.documentDate ?? null, pages: up.page_count,
      firstPage, lastPage, sourceKind: up.source_kind, file: up.original_name, sha256: up.sha256,
    },
  });
  return { ok: true, id, seq, firstPage, lastPage, stagedPath: up.file_path };
}

export type WithdrawResult =
  | { ok: true }
  | { ok: false; reason: 'NOT_FOUND' | 'ALREADY_WITHDRAWN' };

/** A mistaken upload is withdrawn, never deleted. Pages after it move up. */
export async function withdraw(
  tx: Queryable, args: { recordId: Uuid; additionId: Uuid; userId: Uuid; reason: string },
): Promise<WithdrawResult> {
  await tx.query('SELECT 1 FROM service_records WHERE id = $1 FOR UPDATE', [args.recordId]);
  const { rows } = await tx.query<{ status: string; seq: number; page_count: number }>(
    `SELECT status, seq, page_count FROM record_additions WHERE id = $1 AND service_record_id = $2`,
    [args.additionId, args.recordId],
  );
  const a = rows[0];
  if (!a) return { ok: false, reason: 'NOT_FOUND' };
  if (a.status !== 'ACTIVE') return { ok: false, reason: 'ALREADY_WITHDRAWN' };

  await tx.query(
    `UPDATE record_additions
        SET status = 'WITHDRAWN', withdrawn_by = $2, withdrawn_at = now(), withdrawal_reason = $3
      WHERE id = $1`,
    [args.additionId, args.userId, args.reason.trim()],
  );
  await tx.query(
    'UPDATE service_records SET added_page_count = added_page_count - $2 WHERE id = $1',
    [args.recordId, a.page_count],
  );
  await appendEvent(tx, {
    eventType: 'RECORD_PAGES_WITHDRAWN', actorId: args.userId, serviceRecordId: args.recordId,
    detail: { additionId: args.additionId, seq: a.seq, pages: a.page_count, reason: args.reason.trim() },
  });
  return { ok: true };
}

/**
 * When a fresh scan supersedes a record, the custodian decides whether the
 * additions follow it. A full rescan usually already contains those pages;
 * a partial one usually does not. Live additions move; withdrawn ones stay
 * with the record they were withdrawn from, as history.
 */
export async function carryForward(
  db: Queryable, args: { fromRecordId: Uuid; toRecordId: Uuid; custodianId: Uuid },
): Promise<number> {
  const { rows } = await db.query<{ id: string; page_count: number }>(
    `SELECT id, page_count FROM record_additions
      WHERE service_record_id = $1 AND status = 'ACTIVE' ORDER BY seq`,
    [args.fromRecordId],
  );
  if (rows.length === 0) return 0;

  const { rows: next } = await db.query<{ n: number }>(
    'SELECT coalesce(max(seq), 0) AS n FROM record_additions WHERE service_record_id = $1',
    [args.toRecordId],
  );
  let seq = next[0]!.n;
  let pages = 0;
  for (const a of rows) {
    seq += 1;
    pages += a.page_count;
    await db.query(
      'UPDATE record_additions SET service_record_id = $2, seq = $3 WHERE id = $1',
      [a.id, args.toRecordId, seq],
    );
  }
  await db.query('UPDATE service_records SET added_page_count = added_page_count - $2 WHERE id = $1',
    [args.fromRecordId, pages]);
  await db.query('UPDATE service_records SET added_page_count = added_page_count + $2 WHERE id = $1',
    [args.toRecordId, pages]);
  await appendEvent(db, {
    eventType: 'RECORD_ADDITIONS_CARRIED', actorId: args.custodianId, serviceRecordId: args.toRecordId,
    detail: { from: args.fromRecordId, additions: rows.map((r) => r.id), pages },
  });
  return rows.length;
}

/** Older records can lack a page count; the file itself is the authority. */
async function basePageCount(filePath: string): Promise<number> {
  return countPages(await resolveInsideRoots(filePath));
}

export interface Segment {
  kind: 'ORIGINAL' | 'ADDITION';
  firstPage: number;
  lastPage: number;
  additionId?: Uuid;
  seq?: number;
  description?: string;
  documentDate?: string | null;
  uploadedAt?: string;
  uploadedByName?: string;
}

interface Layout {
  total: number;
  segments: (Segment & { filePath: string; roots: string[] })[];
}

async function buildLayout(db: Queryable, recordId: Uuid): Promise<Layout | null> {
  const { rows: rec } = await db.query<{ file_path: string; page_count: number | null }>(
    'SELECT file_path, page_count FROM service_records WHERE id = $1', [recordId],
  );
  if (!rec[0]) return null;
  const base = rec[0].page_count ?? await basePageCount(rec[0].file_path);

  const { rows: adds } = await db.query<{
    id: string; seq: number; description: string; document_date: string | null;
    uploaded_at: Date; uploaded_by_name: string; page_count: number; file_path: string;
  }>(
    `SELECT a.id, a.seq, a.description, a.document_date::text AS document_date, a.uploaded_at,
            u.full_name AS uploaded_by_name, a.page_count, a.file_path
       FROM record_additions a JOIN users u ON u.id = a.uploaded_by
      WHERE a.service_record_id = $1 AND a.status = 'ACTIVE'
      ORDER BY a.seq`,
    [recordId],
  );

  const segments: Layout['segments'] = [
    { kind: 'ORIGINAL', firstPage: 1, lastPage: base, filePath: rec[0].file_path, roots: config.sourceRoots },
  ];
  let at = base;
  for (const a of adds) {
    segments.push({
      kind: 'ADDITION', firstPage: at + 1, lastPage: at + a.page_count,
      additionId: a.id, seq: a.seq, description: a.description, documentDate: a.document_date,
      uploadedAt: a.uploaded_at.toISOString(), uploadedByName: a.uploaded_by_name,
      filePath: a.file_path, roots: [config.additionsRoot],
    });
    at += a.page_count;
  }
  return { total: at, segments };
}

/** The page map shown to a reader. File paths never leave the server. */
export async function layout(db: Queryable, recordId: Uuid): Promise<{ total: number; segments: Segment[] } | null> {
  const l = await buildLayout(db, recordId);
  if (!l) return null;
  return { total: l.total, segments: l.segments.map(({ filePath: _f, roots: _r, ...s }) => s) };
}

/** Which file, and which page of it, a record-wide page number refers to. */
export async function locatePage(
  db: Queryable, recordId: Uuid, page: number,
): Promise<{ filePath: string; localPage: number; total: number } | 'OUT_OF_RANGE' | null> {
  const l = await buildLayout(db, recordId);
  if (!l) return null;
  const seg = l.segments.find((s) => page >= s.firstPage && page <= s.lastPage);
  if (!seg) return 'OUT_OF_RANGE';
  return {
    filePath: await resolveInsideRoots(seg.filePath, seg.roots),
    localPage: page - seg.firstPage + 1,
    total: l.total,
  };
}

/** Every addition, withdrawn ones included — the custodian's history view. */
export async function history(db: Queryable, recordId: Uuid) {
  const { rows } = await db.query(
    `SELECT a.id, a.seq, a.description, a.document_date::text AS document_date, a.page_count,
            a.source_kind, a.original_name, a.status, a.uploaded_at, u.full_name AS uploaded_by_name,
            a.withdrawn_at, w.full_name AS withdrawn_by_name, a.withdrawal_reason
       FROM record_additions a
       JOIN users u ON u.id = a.uploaded_by
       LEFT JOIN users w ON w.id = a.withdrawn_by
      WHERE a.service_record_id = $1
      ORDER BY a.seq`,
    [recordId],
  );
  return rows;
}

/** Staged uploads nobody confirmed. Hygiene only; they were never visible. */
export async function sweepStaged(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ file_path: string }>(
    `DELETE FROM addition_uploads WHERE created_at < now() - ($1 || ' hours')::interval
     RETURNING file_path`,
    [String(STAGED_TTL_HOURS)],
  );
  for (const r of rows) await unlink(r.file_path).catch(() => {});
  return rows.length;
}

/** Called after a successful commit transaction. */
export async function removeStagedFile(path: string): Promise<void> {
  await unlink(path).catch(() => {});
}

