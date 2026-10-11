import { useEffect } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { initials } from '../lib/format';
import { Footer } from './Footer';
import { HomeIcon, InboxIcon, BookIcon, StackIcon, UserIcon } from './Icons';
import { Navbar } from './Navbar';

/** Single-page navigation does not reset scroll by itself; a new page should start at the top. */
function ScrollToTop() {
  const { pathname, search } = useLocation();
  useEffect(() => { window.scrollTo(0, 0); }, [pathname, search]);
  return null;
}

/** Application shell: skip link, header, page content, footer. */
export function AppShell() {
  return (
    <div className="app">
      <ScrollToTop />
      <a href="#main" className="skip-link">Skip to content</a>
      <Navbar />
      <main id="main" className="main" tabIndex={-1}>
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}

const ACCOUNT_LINKS = [
  { to: '/my', label: 'Dashboard', icon: <HomeIcon />, end: true },
  { to: '/my/requests', label: 'My Requests', icon: <InboxIcon /> },
  { to: '/my/loans', label: 'My Loans', icon: <BookIcon /> },
  { to: '/my/listings', label: 'My Listings', icon: <StackIcon /> },
  { to: '/profile', label: 'Profile', icon: <UserIcon /> },
];

/** Sidebar layout for the member area; becomes a horizontal tab strip on small screens. */
export function AccountLayout() {
  const { user } = useAuth();
  return (
    <div className="account container">
      <aside className="account__side" aria-label="Your account">
        {user && (
          <div className="account__who">
            <span className="avatar avatar--lg" aria-hidden="true">{initials(user.displayName)}</span>
            <div>
              <p className="account__name">{user.displayName}</p>
              <NavLink to="/profile" className="account__profile-link">View profile</NavLink>
            </div>
          </div>
        )}
        <nav className="account__nav">
          {ACCOUNT_LINKS.map((l) => (
            <NavLink key={l.to} to={l.to} end={l.end} className={({ isActive }) => `account__link${isActive ? ' is-active' : ''}`}>
              {l.icon}<span>{l.label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>
      <section className="account__content">
        <Outlet />
      </section>
    </div>
  );
}
