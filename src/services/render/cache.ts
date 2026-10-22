// A rendered page is cached in memory, keyed by record, page, and the grant it
// was served under. The cache is for paging back and forth within a sitting,
// not for storage: eviction on revoke is why the grant id is part of the key.
import { config } from '../../config.ts';
import type { RenderedPage } from './pageRenderer.ts';

interface Entry { at: number; value: RenderedPage }

const store = new Map<string, Entry>();

const key = (recordId: string, page: number, grantKey: string, dpi: number) =>
  `${recordId}:${page}:${grantKey}:${dpi}`;

export function get(recordId: string, page: number, grantKey: string, dpi: number): RenderedPage | null {
  const k = key(recordId, page, grantKey, dpi);
  const hit = store.get(k);
  if (!hit) return null;
  if (Date.now() - hit.at > config.render.cacheTtlSeconds * 1000) {
    store.delete(k);
    return null;
  }
  // Refresh recency for the LRU eviction below.
  store.delete(k);
  store.set(k, hit);
  return hit.value;
}

export function put(recordId: string, page: number, grantKey: string, dpi: number, value: RenderedPage): void {
  store.set(key(recordId, page, grantKey, dpi), { at: Date.now(), value });
  while (store.size > config.render.cacheEntries) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/** Called on revoke: a revoked grant must not keep serving from cache. */
export function dropGrant(grantKey: string): void {
  for (const k of store.keys()) if (k.includes(`:${grantKey}:`)) store.delete(k);
}

/** Called when a record's pages are added or withdrawn: page numbers moved. */
export function dropRecord(recordId: string): void {
  for (const k of store.keys()) if (k.startsWith(`${recordId}:`)) store.delete(k);
}

export function clear(): void { store.clear(); }
export const size = (): number => store.size;
