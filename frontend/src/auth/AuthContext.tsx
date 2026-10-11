import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { login as apiLogin, me, register as apiRegister } from '../api/endpoints';
import type { User } from '../api/types';
import { ApiError } from '../api/client';
import { clearSession, getToken, onUnauthorized, saveSession } from './session';

type Status = 'loading' | 'authenticated' | 'anonymous';

export interface SignUpInput {
  email: string;
  password: string;
  displayName: string;
  contactInfo?: string | null;
  defaultPickupLocation?: string | null;
}

interface AuthValue {
  user: User | null;
  status: Status;
  /** Set when a request found the session expired/invalid; shown once on the sign-in page. */
  sessionNotice: string | null;
  clearSessionNotice: () => void;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (input: SignUpInput) => Promise<void>;
  signOut: () => void;
  setUser: (u: User) => void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<Status>(() => (getToken() ? 'loading' : 'anonymous'));
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);

  // Restore the session from the stored token (the server re-validates it on every request).
  useEffect(() => {
    if (!getToken()) return;
    const ctrl = new AbortController();
    me(ctrl.signal).then(
      (u) => { setUser(u); setStatus('authenticated'); },
      (e: unknown) => {
        if ((e as { name?: string })?.name === 'AbortError') return;
        if (e instanceof ApiError && e.status === 401) clearSession();
        setUser(null);
        setStatus('anonymous');
      },
    );
    return () => ctrl.abort();
  }, []);

  // Any 401 from the API means the token is expired or the account was deactivated.
  useEffect(() => onUnauthorized(() => {
    setUser(null);
    setStatus('anonymous');
    setSessionNotice('Your session has ended. Please sign in again.');
  }), []);

  const signIn = useCallback(async (email: string, password: string) => {
    const r = await apiLogin({ email, password });
    saveSession(r.token, r.expiresIn);
    setUser(r.user);
    setStatus('authenticated');
    setSessionNotice(null);
  }, []);

  const signUp = useCallback(async (input: SignUpInput) => {
    const r = await apiRegister(input);
    saveSession(r.token, r.expiresIn);
    setUser(r.user);
    setStatus('authenticated');
    setSessionNotice(null);
  }, []);

  const signOut = useCallback(() => {
    clearSession();
    setUser(null);
    setStatus('anonymous');
  }, []);

  const value = useMemo<AuthValue>(() => ({
    user, status, sessionNotice,
    clearSessionNotice: () => setSessionNotice(null),
    signIn, signUp, signOut, setUser,
  }), [user, status, sessionNotice, signIn, signUp, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>');
  return v;
}
