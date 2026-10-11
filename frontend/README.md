# BookLoop frontend

React 19 + Vite + TypeScript + React Router + plain CSS. It talks only to the BookLoop HTTP API
(see `../backend/docs/API.md`); it has no database access and no ORM.

## Run it

```bash
# 1. backend (from ../backend) – serves the API on 127.0.0.1:4000
npm run start:test-branch

# 2. frontend (from this folder)
npm install
cp .env.example .env      # only if you don't have a .env yet
npm run dev               # http://localhost:5173
```

## Environment

| Variable            | Purpose                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| `VITE_API_BASE_URL` | Public address of the backend. Default in `.env.example` is the local API. |

No secrets belong in this file: everything prefixed `VITE_` is shipped to the browser.

In development the browser calls `/api/...` on the Vite server, which proxies to
`VITE_API_BASE_URL` (the backend deliberately has no CORS origins configured). A production build
calls `VITE_API_BASE_URL` directly, so the backend must list the site's origin in `CORS_ORIGINS`.

## Scripts

| Command             | What it does                                  |
| ------------------- | --------------------------------------------- |
| `npm run dev`       | Vite dev server with the `/api` proxy         |
| `npm run typecheck` | `tsc --noEmit`                                |
| `npm run lint`      | ESLint (typescript-eslint, react-hooks)       |
| `npm test`          | Vitest (API client, formatting, due dates…)   |
| `npm run build`     | Type-check, then production build into `dist` |

## Structure

```
src/
  api/         typed client (envelope, error mapping, one safe retry), endpoint wrappers, DTO types
  auth/        session storage (sessionStorage + expiry), AuthContext, RequireAuth
  components/  Navbar, Footer, Cover, BookCard, CopyCard, RequestDialog, Forms, States, …
  hooks/       useAsync (keyed, race-safe), useDocumentTitle
  lib/         format (IST due dates), covers, copies, messages, redirect
  pages/       Discover, Catalogue, BookDetail, Genres, Login/Register, Dashboard (My Books),
               MyRequests, MyLoans, MyListings, ListBook, Profile, NotFound
  styles/      tokens, base, components, pages
```

## Behaviour worth knowing

- **Sessions** last one hour (no refresh token). On expiry or a 401 the app returns to the sign-in
  page with a notice and brings you back to where you were.
- **Due dates** are stored by the API as the start of the following day in Asia/Kolkata; the UI
  shows the due *day* the borrower was promised.
- **Browsing is public** (Discover, Catalogue, Book, Genres). Requesting a copy sends a visitor to
  sign in and brings them back to the same book. Anonymous visitors see owner names and condition,
  but not pickup places or notes.
- **Request-to-borrow** is made against a specific physical copy; the book page lists every copy.
- **Covers**: the API has no cover-image field, so each title gets a deterministic typographic cover.

## Known gaps (backend capabilities that do not exist yet)

- No cover images, no sort parameter ("recently added"), no `reviewed` flag on a loan, no
  statistics endpoint. The UI shows only numbers the API returns.
- Copies can be listed/unlisted but not edited.
