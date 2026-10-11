import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import { RequireAuth } from './auth/RequireAuth';
import { AccountLayout, AppShell } from './components/Layouts';
import { LoadingState } from './components/States';
import { Login, Register } from './pages/AuthPages';
import Discover from './pages/Discover';
import NotFound from './pages/NotFound';

// Heavier / member-only screens are code-split so the landing page stays light.
const Catalogue = lazy(() => import('./pages/Catalogue'));
const BookDetail = lazy(() => import('./pages/BookDetail'));
const Genres = lazy(() => import('./pages/Genres'));
const ListBook = lazy(() => import('./pages/ListBook'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const MyRequests = lazy(() => import('./pages/MyRequests'));
const MyLoans = lazy(() => import('./pages/MyLoans'));
const MyListings = lazy(() => import('./pages/MyListings'));
const Profile = lazy(() => import('./pages/Profile'));

export default function App() {
  return (
    <Suspense fallback={<LoadingState />}>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<Discover />} />
          <Route path="login" element={<Login />} />
          <Route path="register" element={<Register />} />

          {/* Public, read-only browsing: the API serves these without a token. */}
          <Route path="books" element={<Catalogue />} />
          <Route path="books/:bookId" element={<BookDetail />} />
          <Route path="genres" element={<Genres />} />

          {/* Everything below needs a signed-in member (the API enforces it as well). */}
          <Route element={<RequireAuth />}>
            <Route path="list" element={<ListBook />} />
            <Route element={<AccountLayout />}>
              <Route path="my" element={<Dashboard />} />
              <Route path="my/requests" element={<MyRequests />} />
              <Route path="my/loans" element={<MyLoans />} />
              <Route path="my/listings" element={<MyListings />} />
              <Route path="profile" element={<Profile />} />
            </Route>
          </Route>

          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
