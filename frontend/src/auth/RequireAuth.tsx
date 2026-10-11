import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { LoadingState } from '../components/States';
import { useAuth } from './AuthContext';

/** Guards a group of routes. Anonymous visitors are sent to sign in and returned afterwards. */
export function RequireAuth() {
  const { status } = useAuth();
  const loc = useLocation();
  if (status === 'loading') return <LoadingState label="Checking your session…" />;
  if (status === 'anonymous') {
    const next = encodeURIComponent(loc.pathname + loc.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  return <Outlet />;
}
