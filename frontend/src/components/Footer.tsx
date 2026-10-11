import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { LogoMark } from './Icons';

export function Footer() {
  const { status } = useAuth();
  const signedIn = status === 'authenticated';
  return (
    <footer className="footer">
      <div className="footer__inner">
        <div className="footer__about">
          <p className="brand brand--footer"><LogoMark /><span className="brand__word">BookLoop</span></p>
          <p>
            A peer-to-peer library for your community. List the books you have already read, borrow the
            ones you want to read, and keep good stories in circulation.
          </p>
        </div>
        <nav aria-label="Explore" className="footer__col">
          <h2>Explore</h2>
          <Link to="/books">All books</Link>
          <Link to="/genres">Genres</Link>
          {signedIn && <Link to="/list">Share a book</Link>}
        </nav>
        {signedIn ? (
          <nav aria-label="Your account" className="footer__col">
            <h2>Your account</h2>
            <Link to="/my">My Books</Link>
            <Link to="/my/requests">My Requests</Link>
            <Link to="/my/loans">My Loans</Link>
            <Link to="/profile">Profile</Link>
          </nav>
        ) : (
          <nav aria-label="Join BookLoop" className="footer__col">
            <h2>Join BookLoop</h2>
            <Link to="/register">Create an account</Link>
            <Link to="/login">Sign in</Link>
          </nav>
        )}
      </div>
      <p className="footer__legal">BookLoop is a university database-systems project. Lending is arranged between members.</p>
    </footer>
  );
}
