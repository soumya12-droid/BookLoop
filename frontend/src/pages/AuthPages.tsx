import { useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { TextField } from '../components/Forms';
import { LogoMark } from '../components/Icons';
import { Notice } from '../components/States';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { fieldErrors, friendlyMessage } from '../lib/messages';
import { safeNext } from '../lib/redirect';

function AuthFrame({ title, lede, children, footer }: { title: string; lede: string; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="auth">
      <div className="auth__card">
        <p className="brand brand--center"><LogoMark /><span className="brand__word">BookLoop</span></p>
        <h1>{title}</h1>
        <p className="muted">{lede}</p>
        {children}
        <p className="auth__footer">{footer}</p>
      </div>
    </div>
  );
}

export function Login() {
  useDocumentTitle('Sign in');
  const { signIn, status, sessionNotice } = useAuth();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const next = safeNext(params.get('next'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The "session ended" notice is cleared by a successful sign-in (AuthContext), not on unmount.
  if (status === 'authenticated') return <Navigate to={next} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
      nav(next, { replace: true });
    } catch (err) {
      setError(friendlyMessage(err));
      setBusy(false);
    }
  };

  return (
    <AuthFrame title="Welcome back" lede="Sign in to borrow, lend and manage your books."
      footer={<>New to BookLoop? <Link to={`/register${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`}>Create an account</Link></>}>
      {sessionNotice && <Notice tone="info">{sessionNotice}</Notice>}
      <form onSubmit={submit} className="form" noValidate>
        <TextField label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <TextField label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <Notice tone="error">{error}</Notice>}
        <button type="submit" className="btn btn--primary btn--block" disabled={busy || !email || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </AuthFrame>
  );
}

export function Register() {
  useDocumentTitle('Join BookLoop');
  const { signUp, status } = useAuth();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const next = safeNext(params.get('next'));
  const [form, setForm] = useState({ displayName: '', email: '', password: '', contactInfo: '', defaultPickupLocation: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  if (status === 'authenticated') return <Navigate to={next} replace />;
  const set = (k: keyof typeof form) => (e: ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const local: Record<string, string> = {};
    if (!form.displayName.trim()) local.displayName = 'Please tell us what to call you.';
    if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) local.email = 'Enter a valid email address.';
    if (form.password.length < 10) local.password = 'Use at least 10 characters.';
    setFields(local);
    if (Object.keys(local).length > 0) return;

    setBusy(true);
    setError(null);
    try {
      await signUp({
        email: form.email.trim(),
        password: form.password,
        displayName: form.displayName.trim(),
        contactInfo: form.contactInfo.trim() || null,
        defaultPickupLocation: form.defaultPickupLocation.trim() || null,
      });
      nav(next, { replace: true });
    } catch (err) {
      setFields(fieldErrors(err));
      setError(friendlyMessage(err));
      setBusy(false);
    }
  };

  return (
    <AuthFrame title="Join BookLoop" lede="Share the books you have read and borrow the ones you want to."
      footer={<>Already a member? <Link to="/login">Sign in</Link></>}>
      <form onSubmit={submit} className="form" noValidate>
        <TextField label="Your name" autoComplete="name" required maxLength={80} value={form.displayName}
          onChange={set('displayName')} error={fields.displayName} />
        <TextField label="Email" type="email" autoComplete="email" required value={form.email}
          onChange={set('email')} error={fields.email} />
        <TextField label="Password" type="password" autoComplete="new-password" required value={form.password}
          onChange={set('password')} error={fields.password} hint="At least 10 characters." />
        <TextField label="Where you usually hand over books (optional)" maxLength={200} value={form.defaultPickupLocation}
          onChange={set('defaultPickupLocation')} error={fields.defaultPickupLocation}
          hint="For example “Library lobby”. Shown on your listings." />
        <TextField label="How owners and borrowers can reach you (optional)" maxLength={200} value={form.contactInfo}
          onChange={set('contactInfo')} error={fields.contactInfo}
          hint="Shared only with the other person while a request is approved or a book is on loan." />
        {error && <Notice tone="error">{error}</Notice>}
        <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
          {busy ? 'Creating your account…' : 'Create account'}
        </button>
      </form>
    </AuthFrame>
  );
}
