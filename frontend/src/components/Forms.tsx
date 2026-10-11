import { useId, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

interface FieldShell { label: string; hint?: string; error?: string; children: (a: { id: string; describedBy?: string; invalid: boolean }) => ReactNode }

function Field({ label, hint, error, children }: FieldShell) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`field${error ? ' field--invalid' : ''}`}>
      <label htmlFor={id}>{label}</label>
      {children({ id, describedBy, invalid: !!error })}
      {hint && <p className="field__hint" id={hintId}>{hint}</p>}
      {error && <p className="field__error" id={errId} role="alert">{error}</p>}
    </div>
  );
}

type Common = { label: string; hint?: string; error?: string };

export function TextField({ label, hint, error, ...rest }: Common & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <Field label={label} hint={hint} error={error}>
      {({ id, describedBy, invalid }) => <input id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined} {...rest} />}
    </Field>
  );
}

export function TextArea({ label, hint, error, ...rest }: Common & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <Field label={label} hint={hint} error={error}>
      {({ id, describedBy, invalid }) => <textarea id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined} {...rest} />}
    </Field>
  );
}

export function SelectField({ label, hint, error, children, ...rest }: Common & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <Field label={label} hint={hint} error={error}>
      {({ id, describedBy, invalid }) => <select id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined} {...rest}>{children}</select>}
    </Field>
  );
}

/**
 * Two-step confirmation for consequential actions (cancel, record return…). Avoids accidental
 * clicks without a modal. Disabled while the action runs, which also prevents double submission.
 */
export function ConfirmButton({
  label, confirmLabel = 'Confirm', onConfirm, busy = false, tone = 'ghost', disabled = false,
}: {
  label: string; confirmLabel?: string; onConfirm: () => void; busy?: boolean;
  tone?: 'ghost' | 'danger' | 'primary'; disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return <button type="button" className={`btn btn--${tone} btn--sm`} disabled={disabled || busy} onClick={() => setArmed(true)}>{label}</button>;
  }
  return (
    <span className="confirm">
      <button type="button" className="btn btn--danger btn--sm" disabled={busy}
        onClick={() => { setArmed(false); onConfirm(); }}>{confirmLabel}</button>
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => setArmed(false)}>Keep</button>
    </span>
  );
}
