import type { NextFunction, Request, Response } from 'express';
import { AuthzError } from '../../domain/errors.ts';
import { PathEscapesRootError } from '../../services/ingest/paths.ts';

/** Errors explain what went wrong and how to fix it — no apologies, no vagueness. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AuthzError) {
    res.status(err.status).json({ error: err.code, message: err.message });
    return;
  }
  if (err instanceof PathEscapesRootError) {
    // Never echo the path back: it is exactly what an attacker is probing for.
    console.error('[path guard]', err.message);
    res.status(404).json({ error: 'NOT_FOUND', message: 'That record is not available.' });
    return;
  }
  console.error('[unhandled]', err);
  res.status(500).json({
    error: 'INTERNAL',
    message: 'Something failed on the server. The error has been logged.',
  });
}

/** Wraps an async handler so a rejected promise reaches the error handler. */
export const wrap =
  <T extends (req: Request, res: Response, next: NextFunction) => Promise<unknown>>(fn: T) =>
  (req: Request, res: Response, next: NextFunction): void => {
    void fn(req, res, next).catch(next);
  };
