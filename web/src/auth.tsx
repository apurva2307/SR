import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
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
}

const Ctx = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const { principal } = await api.get<{ principal: Principal }>('/auth/me');
      setPrincipal(principal);
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
    setPrincipal(body.principal);
  }, []);

  const signOut = useCallback(async () => {
    await api.post('/auth/logout');
    setPrincipal(null);
  }, []);

  const value = useMemo<AuthValue>(() => ({
    principal, loading, signIn, signOut, refresh,
    can: (...roles: string[]) => !!principal && roles.some((r) => principal.roles.includes(r)),
    isAccounts: !!principal && ['APPROVER', 'CUSTODIAN', 'CONTROLLING_OFFICER']
      .some((r) => principal.roles.includes(r)),
  }), [principal, loading, signIn, signOut, refresh]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
