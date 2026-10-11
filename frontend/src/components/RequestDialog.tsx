import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Copy } from '../api/types';
import { CONDITION_LABEL } from '../lib/copies';
import { TextArea } from './Forms';

interface Props {
  copy: Copy | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (message: string) => void;
}

/** Modal (native <dialog>: focus trapping, Escape and backdrop are handled by the browser). */
export function RequestDialog({ copy, busy, error, onCancel, onSubmit }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (copy && !d.open) { setMessage(''); d.showModal(); }
    if (!copy && d.open) d.close();
  }, [copy]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!busy) onSubmit(message.trim());
  };

  return (
    <dialog ref={ref} className="dialog" onCancel={(e) => { e.preventDefault(); if (!busy) onCancel(); }} aria-labelledby="req-title">
      {copy && (
        <form onSubmit={submit} className="dialog__body">
          <h2 id="req-title">Request to borrow</h2>
          <p className="muted">
            <strong>{copy.bookTitle}</strong> · {CONDITION_LABEL[copy.condition] ?? copy.condition}, shared by {copy.owner.displayName}.
            The owner will decide on your request; nothing is reserved until they approve it.
          </p>
          <TextArea label="A short note to the owner (optional)" value={message} maxLength={500} rows={3}
            onChange={(e) => setMessage(e.target.value)} hint="For example when you could pick it up." />
          {error && <p className="field__error" role="alert">{error}</p>}
          <div className="dialog__actions">
            <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={busy}>Not now</button>
            <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? 'Sending…' : 'Send request'}</button>
          </div>
        </form>
      )}
    </dialog>
  );
}
