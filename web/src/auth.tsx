import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, ApiError, type Principal } from './api';

interface AuthValue {
  principal: Principal | null;
  loading: boolean;
  signIn: (staffCode: string, password: string, totp?: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  can: (...roles: string[]) => boolean;
  isAccounts: boolean;
  /** True once the inactivity timer has signed the user out; the login page says so. */
  idleSignedOut: boolean;
  /** Seconds until the inactivity sign-out, while the warning is showing; else null. */
  idleWarning: number | null;
  stayActive: () => void;
}

/** Shared across tabs: activity in one keeps the others signed in too. */
const ACTIVITY_KEY = 'sr_last_activity';
const ACTIVITY_EVENTS = ['mousedown', 'mousemove', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;
/** How long before sign-out the warning appears. */
const WARN_MS = 60_000;
/** At most one keep-alive to the server per this long, and only when there is activity. */
const PING_MS = 60_000;

const Ctx = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [loading, setLoading] = useState(true);
  const [idleMinutes, setIdleMinutes] = useState(15);
  const [idleSignedOut, setIdleSignedOut] = useState(false);
  const [idleWarning, setIdleWarning] = useState<number | null>(null);
  const lastActivity = useRef(Date.now());
  const lastPing = useRef(Date.now());

  const refresh = useCallback(async () => {
    try {
      const me = await api.get<{ principal: Principal; idleMinutes?: number }>('/auth/me');
      setPrincipal(me.principal);
      if (me.idleMinutes) setIdleMinutes(me.idleMinutes);
    } catch {
      setPrincipal(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const signIn = useCallback(async (staffCode: string, password: string, totp?: string) => {
    const body = await api.post<{ principal?: Principal; error?: string; message?: string }>(
      '/auth/login', { staffCode, password, ...(totp ? { totp } : {}) },
    );
    // A 200 with TOTP_REQUIRED is a step, not a failure: the caller shows the
    // code field rather than an error.
    if (!body.principal) throw new ApiError(body.error ?? 'ERROR', body.message ?? 'Sign-in failed.', 200);
    lastActivity.current = Date.now();
    setIdleSignedOut(false);
    setPrincipal(body.principal);
    void refresh(); // picks up the current inactivity limit
  }, [refresh]);

  const signOut = useCallback(async () => {
    await api.post('/auth/logout');
    setPrincipal(null);
  }, []);

  const markActive = useCallback((broadcast = true) => {
    const now = Date.now();
    lastActivity.current = now;
    if (broadcast) { try { localStorage.setItem(ACTIVITY_KEY, String(now)); } catch { /* storage blocked */ } }
    // Keep the server-side session alive only while someone is actually here:
    // the server applies the same limit and will refuse a session left idle.
    if (now - lastPing.current > PING_MS) {
      lastPing.current = now;
      void refresh();
    }
  }, [refresh]);

  // Inactivity sign-out. The server refuses an idle session regardless; this
  // makes the screen follow, so a record left open on an unattended desk is
  // cleared rather than sitting there until someone clicks.
  const signedIn = !!principal;
  useEffect(() => {
    if (!signedIn) { setIdleWarning(null); return; }
    lastActivity.current = Date.now();
    lastPing.current = Date.now();
    const limitMs = idleMinutes * 60_000;

    const onActivity = () => markActive();
    const onStorage = (e: StorageEvent) => {
      if (e.key === ACTIVITY_KEY && e.newValue) lastActivity.current = Math.max(lastActivity.current, Number(e.newValue));
    };
    const check = () => {
      const left = limitMs - (Date.now() - lastActivity.current);
      if (left <= 0) {
        setIdleWarning(null);
        setIdleSignedOut(true);
        void api.post('/auth/logout').catch(() => {}).finally(() => setPrincipal(null));
      } else if (left <= WARN_MS) {
        setIdleWarning(Math.ceil(left / 1000));
      } else {
        setIdleWarning(null);
      }
    };

    for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, onActivity, { passive: true, capture: true });
    window.addEventListener('storage', onStorage);
    document.addEventListener('visibilitychange', check);
    const timer = window.setInterval(check, 1000);
    return () => {
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, onActivity, { capture: true });
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('visibilitychange', check);
      window.clearInterval(timer);
    };
  }, [signedIn, idleMinutes, markActive]);

  const stayActive = useCallback(() => { setIdleWarning(null); markActive(); }, [markActive]);

  const value = useMemo<AuthValue>(() => ({
    principal, loading, signIn, signOut, refresh,
    can: (...roles: string[]) => !!principal && roles.some((r) => principal.roles.includes(r)),
    isAccounts: !!principal && ['APPROVER', 'CUSTODIAN', 'CONTROLLING_OFFICER']
      .some((r) => principal.roles.includes(r)),
    idleSignedOut, idleWarning, stayActive,
  }), [principal, loading, signIn, signOut, refresh, idleSignedOut, idleWarning, stayActive]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
