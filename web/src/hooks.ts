import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';

export function useLoad<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);

  const reload = useCallback(async () => {
    if (!path) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      setData(await api.get<T>(path));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load this.');
    } finally {
      setLoading(false);
    }
  }, [path]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void reload(); }, [path, ...deps]);

  return { data, error, loading, reload, setData };
}

export const fmtDate = (v: string | null | undefined): string =>
  v ? new Date(v).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

export const fmtDateTime = (v: string | null | undefined): string =>
  v ? new Date(v).toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }) : '—';

export function daysLeft(until: string | null | undefined): number | null {
  if (!until) return null;
  return Math.ceil((new Date(until).getTime() - Date.now()) / 86_400_000);
}
