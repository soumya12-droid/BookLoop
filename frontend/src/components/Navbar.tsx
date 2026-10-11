import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { initials } from '../lib/format';
import { CloseIcon, LogoMark, MenuIcon } from './Icons';
import { SearchBar } from './SearchBar';

const LINKS = [
  { to: '/', label: 'Discover', end: true },
  { to: '/genres', label: 'Genres' },
  { to: '/my', label: 'My Books', end: true },
  { to: '/my/requests', label: 'My Requests' },
  { to: '/my/loans', label: 'My Loans' },
];

export function Navbar() {
  const { user, status, signOut } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  // Menus are "open for" the location they were opened at, so any navigation closes them
  // without an effect.
  const here = loc.pathname + loc.search;
  const [openAt, setOpenAt] = useState<string | null>(null);
  const [menuAt, setMenuAt] = useState<string | null>(null);
  const open = openAt === here;
  const menuOpen = menuAt === here;
  const setOpen = (v: boolean | ((p: boolean) => boolean)) =>
    setOpenAt((cur) => ((typeof v === 'function' ? v(cur === here) : v) ? here : null));
  const setMenuOpen = (v: boolean | ((p: boolean) => boolean)) =>
    setMenuAt((cur) => ((typeof v === 'function' ? v(cur === here) : v) ? here : null));
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menus on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpenAt(null); setMenuAt(null); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenuAt(null); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [menuOpen]);

  const search = (q: string) => nav(q ? `/books?q=${encodeURIComponent(q)}` : '/books');

  return (
    <header className="navbar">
      <div className="navbar__inner">
        <Link to="/" className="brand" aria-label="BookLoop home">
          <LogoMark />
          <span className="brand__word">BookLoop</span>
        </Link>

        <nav id="primary-nav" className={`navbar__links${open ? ' is-open' : ''}`} aria-label="Primary">
          {LINKS.filter((l) => status === 'authenticated' || !l.to.startsWith('/my')).map((l) => (
            <NavLink key={l.to} to={l.to} end={l.end} className={({ isActive }) => `navlink${isActive ? ' is-active' : ''}`}>
              {l.label}
            </NavLink>
          ))}
          <div className="navbar__mobile-search">
            <SearchBar onSubmit={search} size="default" />
          </div>
          {status !== 'authenticated' && (
            <div className="navbar__mobile-auth">
              <Link to="/login" className="btn btn--ghost">Sign in</Link>
              <Link to="/register" className="btn btn--primary">Join BookLoop</Link>
            </div>
          )}
        </nav>

        <div className="navbar__search"><SearchBar onSubmit={search} /></div>

        <div className="navbar__actions">
          {status === 'authenticated' && user ? (
            <div className="usermenu" ref={menuRef}>
              <button type="button" className="avatar" aria-haspopup="menu" aria-expanded={menuOpen}
                aria-label={`Account menu for ${user.displayName}`} onClick={() => setMenuOpen((v) => !v)}>
                {initials(user.displayName)}
              </button>
              {menuOpen && (
                <div className="usermenu__panel" role="menu">
                  <p className="usermenu__name">{user.displayName}</p>
                  <Link role="menuitem" to="/profile">Profile</Link>
                  <Link role="menuitem" to="/my/listings">My listings</Link>
                  <Link role="menuitem" to="/list">List a book</Link>
                  <button role="menuitem" type="button" onClick={() => { signOut(); nav('/'); }}>Sign out</button>
                </div>
              )}
            </div>
          ) : (
            <div className="navbar__auth">
              <Link to="/login" className="btn btn--ghost btn--sm">Sign in</Link>
              <Link to="/register" className="btn btn--primary btn--sm">Join</Link>
            </div>
          )}
          <button type="button" className="navbar__toggle" aria-expanded={open} aria-controls="primary-nav"
            aria-label={open ? 'Close menu' : 'Open menu'} onClick={() => setOpen((v) => !v)}>
            {open ? <CloseIcon /> : <MenuIcon />}
          </button>
        </div>
      </div>
    </header>
  );
}
