import type { ReactNode } from 'react';
import { ApiError } from '../api/client';
import { friendlyMessage } from '../lib/messages';

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="state state--loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <p>{label}</p>
    </div>
  );
}

export function ErrorState({
  error, onRetry, title = 'We couldn’t load this',
}: { error: unknown; onRetry?: () => void; title?: string }) {
  const network = error instanceof ApiError && error.code === 'NETWORK';
  return (
    <div className="state state--error" role="alert">
      <h3>{network ? 'BookLoop can’t be reached' : title}</h3>
      <p>{friendlyMessage(error)}</p>
      {onRetry && <button type="button" className="btn btn--ghost" onClick={onRetry}>Try again</button>}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="state state--empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

/** Inline, polite feedback for the result of an action. */
export function Notice({ tone = 'info', children, onDismiss }: {
  tone?: 'info' | 'success' | 'error'; children: ReactNode; onDismiss?: () => void;
}) {
  return (
    <div className={`notice notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <span>{children}</span>
      {onDismiss && (
        <button type="button" className="notice__close" onClick={onDismiss} aria-label="Dismiss message">×</button>
      )}
    </div>
  );
}
