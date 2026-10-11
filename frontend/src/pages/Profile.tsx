import { useState, type FormEvent } from 'react';
import { updateProfile } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import { TextField } from '../components/Forms';
import { Notice } from '../components/States';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { formatDate } from '../lib/format';
import { fieldErrors, friendlyMessage } from '../lib/messages';

export default function Profile() {
  useDocumentTitle('Profile');
  const { user, setUser, signOut } = useAuth();
  // The page only renders for a signed-in member, so the form can start from the profile directly.
  const [form, setForm] = useState(() => ({
    displayName: user?.displayName ?? '',
    defaultPickupLocation: user?.defaultPickupLocation ?? '',
    contactInfo: user?.contactInfo ?? '',
  }));
  const [busy, setBusy] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  if (!user) return null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!form.displayName.trim()) { setFields({ displayName: 'Your name cannot be empty.' }); return; }
    setBusy(true); setNotice(null); setFields({});
    try {
      const updated = await updateProfile({
        displayName: form.displayName.trim(),
        defaultPickupLocation: form.defaultPickupLocation.trim() || null,
        contactInfo: form.contactInfo.trim() || null,
      });
      setUser(updated);
      setNotice({ tone: 'success', text: 'Your profile has been updated.' });
    } catch (err) {
      setFields(fieldErrors(err));
      setNotice({ tone: 'error', text: friendlyMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dash">
      <header className="dash__head">
        <div>
          <h1>Profile</h1>
          <p className="muted">Member since {formatDate(user.createdAt)}</p>
        </div>
      </header>

      <section className="panel">
        <dl className="facts">
          <dt>Email</dt><dd>{user.email}</dd>
          <dt>Role</dt><dd>{user.role === 'ADMIN' ? 'Administrator' : 'Member'}</dd>
        </dl>
      </section>

      <form className="panel form" onSubmit={submit} noValidate>
        <h2>Your details</h2>
        <TextField label="Display name" required maxLength={80} value={form.displayName} error={fields.displayName}
          onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
        <TextField label="Default pickup place" maxLength={200} value={form.defaultPickupLocation} error={fields.defaultPickupLocation}
          hint="Used for your listings that don’t set their own pickup place."
          onChange={(e) => setForm({ ...form, defaultPickupLocation: e.target.value })} />
        <TextField label="Contact details" maxLength={200} value={form.contactInfo} error={fields.contactInfo}
          hint="Shared only with the other person while a request is approved or a book is on loan."
          onChange={(e) => setForm({ ...form, contactInfo: e.target.value })} />
        {notice && <Notice tone={notice.tone} onDismiss={() => setNotice(null)}>{notice.text}</Notice>}
        <div className="form__actions">
          <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
        </div>
      </form>

      <section className="panel">
        <h2>Session</h2>
        <p className="muted">You stay signed in for up to an hour. Signing out removes the session from this browser tab.</p>
        <button type="button" className="btn btn--outline" onClick={signOut}>Sign out</button>
      </section>
    </div>
  );
}
