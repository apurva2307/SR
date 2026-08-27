// §4.2 — path resolution is a guard, not a join.
//
// The database stores a path, but every use resolves it through realpath and
// asserts the result sits inside a configured root before opening anything. A
// corrupted or tampered file_path row then fails closed instead of reaching
// into /etc. Symlinks inside the folder resolve and are re-checked.
import { realpath } from 'node:fs/promises';
import { sep } from 'node:path';
import { config } from '../../config.ts';

export class PathEscapesRootError extends Error {}

const inside = (child: string, root: string): boolean =>
  child === root || child.startsWith(root.endsWith(sep) ? root : root + sep);

export async function resolveInsideRoots(candidate: string, roots = config.sourceRoots): Promise<string> {
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    throw new PathEscapesRootError(`Unreadable path: ${candidate}`);
  }
  for (const root of roots) {
    let realRoot: string;
    try { realRoot = await realpath(root); } catch { continue; }
    if (inside(real, realRoot)) return real;
  }
  throw new PathEscapesRootError(`Path resolves outside every configured root: ${candidate}`);
}
