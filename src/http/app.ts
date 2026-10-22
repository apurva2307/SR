import express from 'express';
import cookieParser from 'cookie-parser';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.ts';
import { context } from './middleware/context.ts';
import { attachPrincipal } from './middleware/auth.ts';
import { csrf } from './middleware/csrf.ts';
import { errorHandler } from './middleware/errors.ts';
import { authRoutes } from './routes/auth.ts';
import { recordRoutes } from './routes/records.ts';
import { additionRoutes } from './routes/additions.ts';
import { correctionRoutes, recordCorrectionRoutes } from './routes/corrections.ts';
import { requestRoutes } from './routes/requests.ts';
import { grantRoutes } from './routes/grants.ts';
import { authorityRoutes } from './routes/authorities.ts';
import { custodyRoutes } from './routes/custody.ts';
import { auditRoutes } from './routes/audit.ts';
import { adminRoutes } from './routes/admin.ts';
import { notificationRoutes } from './routes/notifications.ts';

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use((_req, res, next) => {
    res.set({
      // No unsafe-inline, and the page may not be framed (§11).
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; " +
        "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      ...(config.session.cookieSecure
        ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload' }
        : {}),
    });
    next();
  });

  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());
  app.use(context);
  app.use(attachPrincipal);
  app.use(csrf);

  app.get('/api/health', (_req, res) => { res.json({ ok: true }); });
  app.use('/api/auth', authRoutes);
  app.use('/api/records/:id/additions', additionRoutes);
  app.use('/api/records/:id/corrections', recordCorrectionRoutes);
  app.use('/api/records', recordRoutes);
  app.use('/api/requests', requestRoutes);
  app.use('/api/grants', grantRoutes);
  app.use('/api/authorities', authorityRoutes);
  app.use('/api/custody', custodyRoutes);
  app.use('/api/corrections', correctionRoutes);
  app.use('/api/audit', auditRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/notifications', notificationRoutes);

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'NOT_FOUND', message: 'No such endpoint.' });
  });

  // The built client, when it exists. In development Vite serves it instead.
  const webDist = join(process.cwd(), 'web', 'dist');
  if (existsSync(webDist)) {
    app.use(express.static(webDist, { index: false }));
    app.get(/.*/, (_req, res) => { res.sendFile(join(webDist, 'index.html')); });
  }

  app.use(errorHandler);
  return app;
}
