// DEMO / SYNTHETIC DATA. Every user, title, author and event here is fictional.
// The data replays the real lending lifecycle (PENDING -> APPROVED -> loan -> FULFILLED ...) with
// explicit historical timestamps, so all guard triggers and the commit-time pairing check run.
// Development-only login password: see SEED_PASSWORD in backend/.env.example (never reuse in production).
import bcrypt from 'bcryptjs';

const DEFAULT_DEV_PASSWORD = 'bookloop-dev-only';  // development only; overridable via SEED_PASSWORD

const USERS = [
  ['Aarav Mehta',    'admin@bookloop.test',   'ADMIN',  'Library lobby'],
  ['Diya Nair',      'diya.nair@bookloop.test',      'MEMBER', 'Hostel A common room'],
  ['Kabir Sethi',    'kabir.sethi@bookloop.test',    'MEMBER', 'Block C canteen'],
  ['Ishita Rao',     'ishita.rao@bookloop.test',     'MEMBER', 'Hostel B reading room'],
  ['Rohan Das',      'rohan.das@bookloop.test',      'MEMBER', 'Library lobby'],
  ['Meera Iyer',     'meera.iyer@bookloop.test',     'MEMBER', 'Main gate bench'],
  ['Vikram Joshi',   'vikram.joshi@bookloop.test',   'MEMBER', 'Block C canteen'],
  ['Ananya Bose',    'ananya.bose@bookloop.test',    'MEMBER', 'Hostel A common room'],
  ['Neil Fernandes', 'neil.fernandes@bookloop.test', 'MEMBER', 'Sports complex entrance'],
  ['Sana Qureshi',   'sana.qureshi@bookloop.test',   'MEMBER', 'Library lobby'],
  ['Tara Menon',     'tara.menon@bookloop.test',     'MEMBER', 'Hostel B reading room'],
  ['Yash Kulkarni',  'yash.kulkarni@bookloop.test',  'MEMBER', 'Block C canteen'],  // deactivated below
];
const DEACTIVATED = 11;

// [title, [authors], [genres], year, publisher]
const BOOKS = [
  ["The Cartographer's Apprentice", ['Lena Marchetti'], ['Fiction', 'Fantasy'], 2016, 'Northlight Press'],
  ['Orbits of Glass', ['Idris Okafor'], ['Science Fiction'], 2019, 'Meridian Books'],
  ['A Quiet Algorithm', ['Priya Venkatesan'], ['Fiction', 'Mystery'], 2021, 'Lantern House'],
  ['Foundations of Relational Systems', ['Marcus Hale', 'Ritu Banerjee'], ['Computer Science'], 2018, 'Ashgrove Academic'],
  ['Practical Query Optimisation', ['Marcus Hale'], ['Computer Science'], 2020, 'Ashgrove Academic'],
  ['Discrete Structures for Engineers', ['Helena Voss'], ['Mathematics', 'Computer Science'], 2017, 'Ashgrove Academic'],
  ['Linear Maps and Landscapes', ['Tomas Eriksen'], ['Mathematics'], 2015, 'Quill & Compass'],
  ['Quantum Mechanics Without Tears', ['Samira Haddad'], ['Physics'], 2014, 'Quill & Compass'],
  ['The Long River Empire', ['Oluwaseun Adeyemi'], ['History'], 2012, 'Meridian Books'],
  ['Letters from the Lighthouse', ['Margaret Linde'], ['Biography'], 2018, 'Lantern House'],
  ['Habits of the Unhurried', ['Karan Malhotra'], ['Self-Help'], 2022, 'Brightside'],
  ['Small Shops, Big Ideas', ['Elena Rossi'], ['Business'], 2019, 'Brightside'],
  ['Ethics for Everyday Machines', ['Samira Haddad', 'Tomas Eriksen'], ['Philosophy', 'Computer Science'], 2023, 'Quill & Compass'],
  ['The Salt Road Murders', ['Lena Marchetti'], ['Mystery'], 2013, 'Northlight Press'],
  ['Stars Over Kolkata', ['Anirban Sen'], ['Fiction', 'History'], 2020, 'Lantern House'],
  ['Data Structures in Plain Language', ['Ritu Banerjee'], ['Computer Science'], 2016, 'Ashgrove Academic'],
  ['Networks and the Quiet Wire', ['Helena Voss'], ['Computer Science'], 2021, 'Ashgrove Academic'],
  ['The Last Orchard', ['Margaret Linde'], ['Fiction'], 2011, 'Northlight Press'],
  ['Thermodynamics, Gently', ['Samira Haddad'], ['Physics'], 2017, 'Quill & Compass'],
  ['Startup Arithmetic', ['Elena Rossi', 'Karan Malhotra'], ['Business'], 2021, 'Brightside'],
  ['Mind the Gap Year', ['Karan Malhotra'], ['Self-Help', 'Biography'], 2020, 'Brightside'],
  ['Echoes of the Deep Archive', ['Idris Okafor'], ['Science Fiction', 'Mystery'], 2022, 'Meridian Books'],
  ['A Short History of Printing Presses', ['Oluwaseun Adeyemi'], ['History'], 2010, 'Meridian Books'],
  ['Statistics for the Sceptical', ['Tomas Eriksen'], ['Mathematics'], 2018, 'Quill & Compass'],
  ['Dragons of the Western Ghats', ['Anirban Sen'], ['Fantasy'], 2023, 'Northlight Press'],
];

// [bookIndex, ownerIndex, condition, listed]
const COPIES = [
  [0, 1, 'GOOD'], [0, 4, 'FAIR'], [1, 2, 'LIKE_NEW'], [2, 3, 'GOOD'], [3, 5, 'GOOD'],
  [3, 6, 'NEW'], [4, 5, 'FAIR'], [5, 7, 'GOOD'], [5, 2, 'POOR'], [6, 8, 'GOOD'],
  [7, 9, 'LIKE_NEW'], [8, 10, 'GOOD'], [9, 1, 'GOOD'], [10, 3, 'FAIR'], [11, 4, 'GOOD'],
  [12, 6, 'NEW'], [13, 7, 'GOOD'], [13, 2, 'GOOD'], [14, 8, 'FAIR'], [15, 9, 'GOOD'],
  [15, 5, 'LIKE_NEW'], [16, 10, 'GOOD'], [17, 1, 'GOOD'], [18, 3, 'GOOD'], [19, 4, 'FAIR'],
  [20, 6, 'GOOD'], [21, 7, 'NEW'], [22, 8, 'GOOD'], [23, 9, 'GOOD'], [24, 10, 'LIKE_NEW'],
  [1, 11, 'GOOD'], [8, 11, 'FAIR'], [3, 3, 'GOOD', false], [0, 8, 'GOOD'], [10, 2, 'GOOD'],
];

function isbn13(seq) {                       // synthetic, checksum-valid, 978-prefixed
  const body = `978${String(900000000 + seq).padStart(9, '0')}`;
  const sum = [...body].reduce((a, d, i) => a + Number(d) * (i % 2 ? 3 : 1), 0);
  return body + String((10 - (sum % 10)) % 10);
}

export async function loadDemo(c) {
  const q =(sql, p = []) => c.query(sql, p);
  const one = async (sql, p) => (await q(sql, p)).rows[0];

  const hash = bcrypt.hashSync(process.env.SEED_PASSWORD || DEFAULT_DEV_PASSWORD, 10);

  // users (created 120 days ago so deactivation / loan history timestamps are ordered)
  const U = [];
  for (const [name, email, role, pickup] of USERS) {
    U.push((await one(
      `INSERT INTO users (email, password_hash, display_name, role, default_pickup_location, contact_info, created_at)
       VALUES ($1,$2,$3,$4,$5,$6, now() - interval '120 days') RETURNING id`,
      [email, hash, name, role, pickup, role === 'ADMIN' ? null : `Reach me at ${pickup} (demo contact)`])).id);
  }
  await q(`UPDATE users SET deactivated_at = now() - interval '5 days' WHERE id = $1`, [U[DEACTIVATED]]);

  // authors / genres / books
  const genre = Object.fromEntries((await q('SELECT id, name FROM genres')).rows.map((g) => [g.name, g.id]));
  const author = {};
  const B = [];
  let seq = 0;
  for (const [title, authors, genres, year, publisher] of BOOKS) {
    const b = (await one(
      `INSERT INTO books (title, isbn, publication_year, publisher, description)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [title, isbn13(seq++), year, publisher, `Synthetic demo record for "${title}".`])).id;
    B.push(b);
    let order = 1;
    for (const a of authors) {
      author[a] ??= (await one(`INSERT INTO authors (name) VALUES ($1) RETURNING id`, [a])).id;
      await q(`INSERT INTO book_authors (book_id, author_id, author_order) VALUES ($1,$2,$3)`, [b, author[a], order++]);
    }
    for (const g of genres) await q(`INSERT INTO book_genres (book_id, genre_id) VALUES ($1,$2)`, [b, genre[g]]);
  }

  // copies
  const C = [];
  for (const [bi, oi, cond, listed = true] of COPIES) {
    C.push((await one(
      `INSERT INTO copies (book_id, owner_id, copy_condition, is_listed) VALUES ($1,$2,$3,$4) RETURNING id`,
      [B[bi], U[oi], cond, listed])).id);
  }

  // ---- lifecycle replay helpers (all timestamps are "days ago" relative to seed time) ----
  const D = (n) => `now() - make_interval(days => ${Number(n)})`;
  async function request(ci, ri, createdAgo, message = null) {
    return (await one(
      `INSERT INTO borrow_requests (copy_id, requester_id, message, created_at)
       VALUES ($1,$2,$3, ${D(createdAgo)}) RETURNING id`, [C[ci], U[ri], message])).id;
  }
  const approve = (id, ago) => q(`UPDATE borrow_requests SET status='APPROVED', decided_at=${D(ago)} WHERE id=$1`, [id]);
  const reject = (id, ago) => q(`UPDATE borrow_requests SET status='REJECTED', decided_at=${D(ago)} WHERE id=$1`, [id]);
  const cancel = (id, ago, byIdx) => q(
    `UPDATE borrow_requests SET status='CANCELLED', cancelled_at=${D(ago)}, cancelled_by=$2 WHERE id=$1`, [id, U[byIdx]]);
  // full handoff: request -> approved -> loan -> FULFILLED (optionally returned)
  async function loan(ci, borrowerIdx, borrowedAgo, term, returnedAgo = null) {
    const rid = await request(ci, borrowerIdx, borrowedAgo + 2, 'Would love to read this over the term.');
    await approve(rid, borrowedAgo + 1);
    const l = (await one(
      `INSERT INTO loans (request_id, copy_id, borrower_id, lender_id, borrowed_at, due_at, returned_at)
       SELECT r.id, r.copy_id, r.requester_id, cp.owner_id, ${D(borrowedAgo)},
              ${D(borrowedAgo)} + make_interval(days => ${Number(term)}),
              ${returnedAgo === null ? 'NULL' : D(returnedAgo)}
       FROM borrow_requests r JOIN copies cp ON cp.id = r.copy_id WHERE r.id = $1 RETURNING id`, [rid])).id;
    await q(`UPDATE borrow_requests SET status='FULFILLED' WHERE id=$1`, [rid]);
    return l;
  }

  // returned on time
  const l1 = await loan(0, 2, 40, 14, 30);
  const l2 = await loan(4, 3, 35, 14, 25);
  await loan(9, 4, 28, 14, 18);
  const l4 = await loan(10, 6, 45, 21, 30);
  await loan(19, 5, 22, 14, 12);
  const l6 = await loan(15, 1, 20, 10, 12);
  // returned late
  const l7 = await loan(2, 7, 50, 14, 30);
  await loan(13, 9, 33, 7, 20);
  const l9 = await loan(24, 10, 26, 14, 4);
  // history on a (now) deactivated member's copy
  await loan(30, 5, 60, 14, 50);
  // active, not overdue
  await loan(3, 4, 3, 14);
  await loan(11, 5, 5, 21);
  await loan(20, 8, 1, 14);
  await loan(28, 1, 8, 14);
  // active and overdue
  await loan(7, 6, 30, 14);
  await loan(14, 9, 25, 7);
  await loan(26, 2, 18, 10);

  // approved reservations still outstanding (one stale)
  await approve(await request(17, 3, 8), 6);
  await approve(await request(21, 7, 2), 1);
  // pending (two siblings on copy 29 = informal queue)
  await request(12, 4, 2); await request(16, 5, 1); await request(23, 8, 3);
  await request(25, 2, 1); await request(29, 3, 2); await request(29, 6, 1);
  // rejected
  await reject(await request(33, 2, 10), 9);
  await reject(await request(8, 9, 15), 14);
  // withdrawn while pending
  await cancel(await request(27, 4, 12), 11, 4);
  await cancel(await request(22, 10, 8), 7, 10);
  // cancelled after approval: owner no-show cancellation, and requester withdrawal
  const noShow = await request(1, 6, 14); await approve(noShow, 13); await cancel(noShow, 9, 4);
  const withdrew = await request(18, 3, 11); await approve(withdrew, 10); await cancel(withdrew, 8, 3);

  // reviews (borrower of a returned loan, once each)
  const review = (loanId, rating, comment, ago) => q(
    `INSERT INTO reviews (loan_id, rating, comment, created_at) VALUES ($1,$2,$3, ${D(ago)})`, [loanId, rating, comment]);
  await review(l1, 5, 'Beautifully written; passed it on happily.', 29);
  await review(l2, 4, 'Clear and well structured.', 24);
  await review(l4, 5, 'Could not put it down.', 29);
  await review(l6, 3, 'Interesting, a little long.', 11);
  await review(l7, 2, 'Not for me.', 29);
  await review(l9, 4, 'Good, with a strong ending.', 3);
}
