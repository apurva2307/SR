// Adding pages to a service record — the custodian's side (§5.2, additions).
// Mounted under /api/records/:id/additions.
import express, { Router } from 'express';
import { z } from 'zod';
import { getPool, withTransaction } from '../../db.ts';
import { config } from '../../config.ts';
import { appendEvent } from '../../audit/events.ts';
import {
  commit, discard, findStaged, history, removeStagedFile, stage, withdraw,
  type StageRefusal,
} from '../../services/additions.ts';
import { renderPage, PageOutOfRangeError } from '../../services/render/pageRenderer.ts';
import { resolveInsideRoots } from '../../services/ingest/paths.ts';
import * as cache from '../../services/render/cache.ts';
import { requireAuth, requireRole } from '../middleware/auth.ts';
import { rateLimit } from '../middleware/rateLimit.ts';
import { wrap } from '../middleware/errors.ts';
import { param, uuidParam } from '../middleware/context.ts';

export const additionRoutes = Router({ mergeParams: true });
additionRoutes.param('uid', uuidParam());
additionRoutes.param('aid', uuidParam());
additionRoutes.use((req, res, next) => uuidParam()(req, res, next, param(req, 'id')));
additionRoutes.use(requireAuth, requireRole('CUSTODIAN'));

additionRoutes.get('/', wrap(async (req, res) => {
  res.json({ additions: await history(getPool(), param(req, 'id')) });
}));

const STAGE_MESSAGES: Record<StageRefusal, string> = {
  RECORD_NOT_FOUND: 'No such record.',
  RECORD_NOT_ACTIVE: 'This record has been superseded. Add pages to the current version instead.',
  EMPTY: 'That file is empty.',
  TOO_LARGE: `That file is larger than ${Math.round(config.additionMaxBytes / 1024 / 1024)} MB.`,
  UNSUPPORTED_TYPE: 'Only PDF, JPG and PNG files can be added.',
  UNREADABLE: 'That file could not be opened. It may be damaged — try scanning it again.',
  ENCRYPTED: 'That PDF is password-protected. Remove the password and upload it again.',
  TOO_MANY_PAGES: 'That file has more than 500 pages. Split it and add it in parts.',
  DUPLICATE: 'This exact file is already part of a service record',
};

/**
 * The file arrives as the raw request body, not a multipart form: one file per
 * upload, its type judged from its bytes, its name in a header. The JSON
 * parser elsewhere stays at 256 KB; only this route accepts a large body.
 */
additionRoutes.post('/stage',
  rateLimit('additions-stage', 30, 3_600_000),
  express.raw({ type: () => true, limit: config.additionMaxBytes }),
  wrap(async (req, res) => {
    const bytes: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    let name = 'upload';
    try { name = decodeURIComponent(String(req.headers['x-file-name'] ?? 'upload')); } catch { /* keep default */ }

    const out = await stage(getPool(), {
      recordId: param(req, 'id'), userId: req.principal!.id, bytes, originalName: name,
    });
    if (!out.ok) {
      const message = out.reason === 'DUPLICATE'
        ? `${STAGE_MESSAGES.DUPLICATE} (${out.detail}).`
        : STAGE_MESSAGES[out.reason];
      res.status(out.reason === 'RECORD_NOT_FOUND' ? 404 : 400).json({ error: out.reason, message });
      return;
    }
    res.status(201).json(out.upload);
  }));

const pageParams = z.object({ n: z.coerce.number().int().min(1).max(5000) });

/**
 * The custodian checks what they uploaded before it joins the record. Same
 * rules as any page: an image, watermarked, never the file — and logged.
 */
additionRoutes.get('/staged/:uid/page/:n',
  rateLimit('pages-min', config.limits.pagesPerMin, 60_000),
  wrap(async (req, res) => {
    const recordId = param(req, 'id');
    const parsed = pageParams.safeParse({ n: param(req, 'n') });
    const up = await findStaged(getPool(), {
      recordId, uploadId: param(req, 'uid'), userId: req.principal!.id,
    });
    if (!up || !parsed.success) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'No such upload or page.' });
      return;
    }
    const { rows } = await getPool().query<{ ppo_number: string }>(
      'SELECT ppo_number FROM service_records WHERE id = $1', [recordId],
    );
    try {
      const rendered = await renderPage({
        filePath: await resolveInsideRoots(up.file_path, [config.additionsRoot]),
        page: parsed.data.n,
        watermark: {
          readerName: req.principal!.fullName, staffCode: req.principal!.staffCode,
          reference: `${rows[0]?.ppo_number ?? ''} · UNCONFIRMED UPLOAD`, ip: req.clientIp,
        },
      });
      await appendEvent(getPool(), {
        eventType: 'PAGE_SERVED', actorId: req.principal!.id, serviceRecordId: recordId,
        actorIp: req.clientIp, detail: { stagedUpload: up.id, page: parsed.data.n },
      });
      res.status(200).set({
        'Content-Type': rendered.contentType,
        'Cache-Control': 'no-store, private',
        'X-Page-Count': String(rendered.pageCount),
      }).send(rendered.body);
    } catch (err) {
      if (err instanceof PageOutOfRangeError) {
        res.status(404).json({ error: 'NO_SUCH_PAGE', message: 'That page does not exist.' });
        return;
      }
      throw err;
    }
  }));

additionRoutes.delete('/staged/:uid', wrap(async (req, res) => {
  const ok = await discard(getPool(), {
    recordId: param(req, 'id'), uploadId: param(req, 'uid'), userId: req.principal!.id,
  });
  res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'NOT_FOUND', message: 'No such upload.' });
}));

const commitBody = z.object({
  uploadId: z.string().uuid(),
  description: z.string().trim()
    .min(5, 'Describe what these pages are — at least 5 characters.')
    .max(300, 'Keep the description under 300 characters.'),
  documentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Give the date as YYYY-MM-DD.')
    .nullable().optional(),
});

const COMMIT_MESSAGES = {
  NOT_FOUND: 'That upload is no longer waiting. Upload the file again.',
  RECORD_NOT_ACTIVE: 'This record has been superseded. Add pages to the current version instead.',
  DUPLICATE: 'This exact file was added to a service record in the meantime.',
} as const;

additionRoutes.post('/', wrap(async (req, res) => {
  const body = commitBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({
      error: 'BAD_REQUEST', message: body.error.issues[0]?.message ?? 'Check the fields and try again.',
    });
    return;
  }
  const recordId = param(req, 'id');
  const out = await withTransaction((tx) => commit(tx, {
    recordId, uploadId: body.data.uploadId, userId: req.principal!.id,
    description: body.data.description, documentDate: body.data.documentDate ?? null,
  }));
  if (!out.ok) {
    res.status(400).json({ error: out.reason, message: COMMIT_MESSAGES[out.reason] });
    return;
  }
  await removeStagedFile(out.stagedPath);
  cache.dropRecord(recordId);
  res.status(201).json({ id: out.id, seq: out.seq, firstPage: out.firstPage, lastPage: out.lastPage });
}));

const withdrawBody = z.object({
  reason: z.string().trim().min(5, 'Say why these pages are being withdrawn — at least 5 characters.').max(500),
});

additionRoutes.post('/:aid/withdraw', wrap(async (req, res) => {
  const body = withdrawBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({
      error: 'BAD_REQUEST', message: body.error.issues[0]?.message ?? 'Give a reason.',
    });
    return;
  }
  const recordId = param(req, 'id');
  const out = await withTransaction((tx) => withdraw(tx, {
    recordId, additionId: param(req, 'aid'), userId: req.principal!.id, reason: body.data.reason,
  }));
  if (!out.ok) {
    res.status(out.reason === 'NOT_FOUND' ? 404 : 400).json({
      error: out.reason,
      message: out.reason === 'NOT_FOUND' ? 'No such addition.' : 'Those pages are already withdrawn.',
    });
    return;
  }
  // Page numbers after the withdrawn pages have moved; nothing cached may
  // answer for the old numbering.
  cache.dropRecord(recordId);
  res.json({ ok: true });
}));
