import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { getPool } from '../../db.ts';
import { config } from '../../config.ts';
import { search } from '../../services/search.ts';
import { checkGrant, consumeView } from '../../authz/grantCheck.ts';
import { appendEvent } from '../../audit/events.ts';
import { renderPage, PageOutOfRangeError } from '../../services/render/pageRenderer.ts';
import * as cache from '../../services/render/cache.ts';
import { layout, locatePage } from '../../services/additions.ts';
import { isCustodial, requireAuth } from '../middleware/auth.ts';
import { rateLimit } from '../middleware/rateLimit.ts';
import { audit, param, uuidParam } from '../middleware/context.ts';
import { wrap } from '../middleware/errors.ts';

export const recordRoutes = Router();
recordRoutes.param('id', uuidParam());
recordRoutes.use(requireAuth);

// Every search is an audit event: knowing that someone has a service record on
// file is itself information (§7.2).
recordRoutes.get('/',
  rateLimit('search', config.limits.searchPerMin, 60_000),
  wrap(async (req, res) => {
    const q = String(req.query['q'] ?? '');
    const page = Math.max(0, Number(req.query['page'] ?? 0));
    const custodial = isCustodial(req);

    const out = await search(getPool(), {
      q, userId: req.principal!.id, isCustodial: custodial,
      limit: 25, offset: page * 25,
    });

    if (!out.ok) {
      res.status(400).json({
        error: out.reason,
        message: `Type at least ${out.minLength} characters — a shorter search would match too much to be useful.`,
      });
      return;
    }
    await appendEvent(getPool(), {
      eventType: 'SEARCH', actorId: req.principal!.id, actorIp: req.clientIp,
      detail: { q, branch: out.branch, hits: out.hits.length },
    });
    res.json(out);
  }));

recordRoutes.get('/:id', wrap(async (req, res) => {
  const id = param(req, 'id');
  const { rows } = await getPool().query(
    `SELECT r.id, r.ppo_number, r.employee_name, r.page_count, r.added_page_count, r.byte_size,
            r.indexed_at, r.last_verified_at, r.status, r.version_no, r.metadata
     FROM service_records r WHERE r.id = $1`, [id],
  );
  const record = rows[0];
  if (!record) { res.status(404).json({ error: 'NOT_FOUND', message: 'No such record.' }); return; }

  const decision = await checkGrant(getPool(), req.principal!.id, id);
  const { rows: history } = await getPool().query(
    `SELECT q.request_no, q.status AS request_status, q.purpose, q.submitted_at,
            i.item_status, i.decided_at, i.decision_remarks
     FROM access_request_items i
     JOIN access_requests q ON q.id = i.request_id
     WHERE i.service_record_id = $1 AND q.requester_id = $2
     ORDER BY q.submitted_at DESC NULLS LAST LIMIT 20`,
    [id, req.principal!.id],
  );

  // Which pages are the original and which were added, with each addition's
  // description. Only for someone who may read the record: a description
  // ("disciplinary order, 2026") is itself part of its contents.
  const pages = decision.allowed ? await layout(getPool(), id) : null;

  await appendEvent(getPool(), {
    eventType: 'RECORD_METADATA_VIEWED', actorId: req.principal!.id,
    serviceRecordId: id, actorIp: req.clientIp,
  });
  res.json({ record, access: decision, myRequests: history, pages });
}));

/**
 * The one binary endpoint. Returns a watermarked IMAGE of a single page —
 * never the PDF. §6.1 runs per page; there is no download variant anywhere in
 * this surface (§4.1).
 */
const pageParams = z.object({ n: z.coerce.number().int().min(1).max(5000) });

recordRoutes.get('/:id/page/:n',
  rateLimit('pages-min', config.limits.pagesPerMin, 60_000),
  rateLimit('pages-hour', config.limits.pagesPerHour, 3_600_000),
  wrap(async (req, res) => {
    const recordId = param(req, 'id');
    const parsed = pageParams.safeParse({ n: param(req, 'n') });
    if (!parsed.success) {
      res.status(400).json({ error: 'BAD_PAGE', message: 'Page number is out of range.' });
      return;
    }
    const pageNo = parsed.data.n;
    const decision = await checkGrant(getPool(), req.principal!.id, recordId);

    if (!decision.allowed) {
      // Denials are recorded as loudly as allows: a run of these against
      // sequential ids is exactly the pattern worth alerting on (§6.3).
      await appendEvent(getPool(), {
        eventType: 'PAGE_DENIED', outcome: 'DENY', actorId: req.principal!.id,
        serviceRecordId: recordId, actorIp: req.clientIp,
        detail: { page: pageNo, reason: decision.reason },
      });
      res.status(403).json({
        error: 'NO_GRANT',
        message: 'You do not have access to this service record. Raise a request to ask for it.',
      });
      return;
    }

    const { rows } = await getPool().query<{ ppo_number: string }>(
      `SELECT ppo_number FROM service_records WHERE id = $1`, [recordId],
    );
    if (!rows[0]) { res.status(404).json({ error: 'NOT_FOUND', message: 'No such record.' }); return; }

    // The original's pages first, then each live addition in order (§5.2).
    const located = await locatePage(getPool(), recordId, pageNo);
    if (located === 'OUT_OF_RANGE' || located === null) {
      res.status(404).json({ error: 'NO_SUCH_PAGE', message: 'That page does not exist.' });
      return;
    }

    const grantKey = decision.via === 'GRANT' ? decision.grantId : `custodial:${req.principal!.id}`;

    // One sitting, one view session, so the audit log stays readable (§12.1).
    let sessionId: string;
    const { rows: open } = await getPool().query<{ id: string }>(
      `SELECT id FROM view_sessions
        WHERE user_id = $1 AND service_record_id = $2 AND closed_at IS NULL
          AND last_page_at > now() - interval '30 minutes'
        ORDER BY opened_at DESC LIMIT 1`,
      [req.principal!.id, recordId],
    );
    if (open[0]) {
      sessionId = open[0].id;
    } else {
      const { rows: created } = await getPool().query<{ id: string }>(
        `INSERT INTO view_sessions (user_id, service_record_id, grant_id, via, ip, user_agent, first_page)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [req.principal!.id, recordId,
         decision.via === 'GRANT' ? decision.grantId : null, decision.via,
         req.clientIp, audit(req).userAgent, pageNo],
      );
      sessionId = created[0]!.id;
      await appendEvent(getPool(), {
        eventType: 'VIEW_SESSION_OPENED', actorId: req.principal!.id,
        serviceRecordId: recordId, viewSessionId: sessionId, actorIp: req.clientIp,
        grantId: decision.via === 'GRANT' ? decision.grantId : null,
        detail: { via: decision.via },
      });
    }

    if (decision.via === 'GRANT' && decision.viewsLeft !== null) {
      // Losing here is legitimate under concurrency and must deny.
      if (!(await consumeView(getPool(), decision.grantId))) {
        await appendEvent(getPool(), {
          eventType: 'PAGE_DENIED', outcome: 'DENY', actorId: req.principal!.id,
          serviceRecordId: recordId, viewSessionId: sessionId,
          detail: { page: pageNo, reason: 'VIEW_CAP_REACHED' },
        });
        res.status(403).json({ error: 'VIEW_CAP_REACHED', message: 'This grant has no views left.' });
        return;
      }
    }

    let rendered = cache.get(recordId, pageNo, grantKey, config.render.dpi);
    if (!rendered) {
      try {
        rendered = await renderPage({
          filePath: located.filePath,
          page: located.localPage,
          watermark: {
            readerName: req.principal!.fullName,
            staffCode: req.principal!.staffCode,
            reference: rows[0].ppo_number,
            ip: req.clientIp,
          },
        });
      } catch (err) {
        if (err instanceof PageOutOfRangeError) {
          res.status(404).json({ error: 'NO_SUCH_PAGE', message: 'That page does not exist.' });
          return;
        }
        throw err;
      }
      cache.put(recordId, pageNo, grantKey, config.render.dpi, rendered);
    }

    await getPool().query(
      `UPDATE view_sessions
          SET pages_served = pages_served + 1, last_page_at = now(),
              last_page = $2, first_page = coalesce(first_page, $2)
        WHERE id = $1`,
      [sessionId, pageNo],
    );
    await appendEvent(getPool(), {
      eventType: 'PAGE_SERVED', actorId: req.principal!.id, serviceRecordId: recordId,
      viewSessionId: sessionId, actorIp: req.clientIp,
      grantId: decision.via === 'GRANT' ? decision.grantId : null,
      detail: { page: pageNo },
    });

    res
      .status(200)
      .set({
        'Content-Type': rendered.contentType,
        // No caching, no range requests, no Content-Disposition: there is
        // nothing here to save and nothing to resume.
        'Cache-Control': 'no-store, private',
        'X-Page-Count': String(located.total),
        'X-Page-Width': String(rendered.width),
        'X-Page-Height': String(rendered.height),
      })
      .send(rendered.body);
  }));

recordRoutes.post('/:id/close-view', wrap(async (req, res) => {
  const { rows } = await getPool().query<{ id: string; pages_served: number }>(
    `UPDATE view_sessions SET closed_at = now()
      WHERE user_id = $1 AND service_record_id = $2 AND closed_at IS NULL
      RETURNING id, pages_served`,
    [req.principal!.id, param(req, 'id')],
  );
  for (const s of rows) {
    await appendEvent(getPool(), {
      eventType: 'VIEW_SESSION_CLOSED', actorId: req.principal!.id,
      serviceRecordId: param(req, 'id'), viewSessionId: s.id,
      detail: { pagesServed: s.pages_served },
    });
  }
  res.json({ ok: true, closed: rows.length });
}));

/**
 * The viewer reports the things a browser can see someone doing to capture a
 * page — the Print Screen key, a print or save shortcut, opening developer
 * tools. None of these can be reliably stopped from a web page; they are
 * recorded so the audit log shows who tried, on which record and page.
 */
const captureBody = z.object({
  kind: z.enum(['PRINT_SCREEN', 'PRINT', 'SAVE', 'COPY', 'DEVTOOLS']),
  page: z.number().int().min(1).max(5000).optional(),
});

recordRoutes.post('/:id/capture-attempt',
  rateLimit('capture', 30, 60_000),
  wrap(async (req, res) => {
    const body = captureBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: 'BAD_REQUEST', message: 'Unknown capture kind.' }); return; }
    await appendEvent(getPool(), {
      eventType: 'SCREEN_CAPTURE_ATTEMPT', actorId: req.principal!.id,
      serviceRecordId: param(req, 'id'), actorIp: req.clientIp,
      detail: { kind: body.data.kind, page: body.data.page ?? null },
    });
    res.json({ ok: true });
  }));
