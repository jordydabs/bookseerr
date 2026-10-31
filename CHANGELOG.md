# Changelog

All notable changes to BookSeerr are documented here.

## 4.10.0

Discover is now built from your own library, and eBook search keeps working when Google
Books doesn't.

### Upgrade notes

- No configuration or database migration is needed. The new rows work with the
  Chaptarr / Listenarr connection you already have; Audible's catalogue needs no key.
- The test suites moved into `test/` (`test/approvals.js`, `test/security.js`).
  `npm test` works as before.
- New optional settings `OPENLIBRARY_BASE` / `OPENLIBRARY_COVERS` exist only for
  pointing at a proxy or a mock.

### Added

- **"For you" Discover rows** (`GET /api/discover/for-you`), at the top of Discover:
  Recommended Audiobooks, eBooks You Might Like, Authors You Might Like, New From Your
  Authors, Because You Like *&lt;your top genres&gt;*, and a daily-rotating Something
  Different genre that sits next to your taste but isn't on your shelf yet.
  - Seeded from your Listenarr titles (newest first, plus a daily rotation, at most two
    per author), your Chaptarr authors with books on the shelf, and the signed-in
    user's own requests; similarity comes from Audible's "listeners also enjoyed" data.
  - Every card carries a reason (*Because you have …*, *Coming Mar 30*, …).
  - Titles already on the shelf (by ASIN or as another edition), already requested,
    translated, adult or not yet released are left out. eBook picks favour authors
    Chaptarr doesn't already collect, since those arrive on their own.
  - Cached per user for six hours (served stale while refreshing), with the shared
    Audible lookups warmed shortly after start and twice a day.
- **Open Library fallback** for eBook search and the all-time-greats row whenever Google
  Books fails, with covers from Open Library's cover service.

### Changed

- Discover rows with nothing to show are hidden instead of showing "No eBooks found".

### Fixed

- **Discover's eBook rows and eBook search came up empty** while Google Books answered
  every keyed query with `503 backendFailed` (and the keyless daily quota was spent).

## 4.9.0

Requests for books whose author — or audiobook — is already in your library now work end
to end.

### Fixed

- **eBook requests for an author already in Chaptarr failed or did nothing.** BookSeerr
  now looks the book up in that author's catalogue in your library (never relying on
  Chaptarr's flaky metadata search for it), monitors it if needed, and searches for just
  that book. Co-written books are tried under each author, title variants
  (`: A Novel`, `(Series, #2)`) are matched, and an ambiguous match is never guessed.
- **A book not yet in the author's catalogue** (a new release) now triggers an author
  refresh, then the search once the refresh finishes. The follow-up survives a restart
  and turns into a retriable error if the book never appears.
- **An author Chaptarr held for audiobooks only** gets the eBook side added first,
  instead of an eBook request silently monitoring nothing.
- **An audiobook Listenarr already has but never downloaded** is re-monitored and
  searched with Listenarr's own indexer search, instead of being reported as "already in
  your library".
- **Double-clicks** could send the same request twice in parallel; an identical submit is
  now refused while the first is still being sent.
- "✓ In library" now means *downloaded* (or downloading), and is format-aware: an author
  Chaptarr monitors only for audiobooks doesn't count for an eBook.

### Changed

- Chaptarr's slow author and book lists (20–45 s on a large library) are served
  stale-while-revalidate, read per author rather than the whole library, and capped in
  concurrency, so badges and requests no longer wait on them.
- The container shuts down gracefully: a 15 s stop grace period, `init: true`, and the
  `KILL` capability so `docker stop` reaches the app and in-flight sends can finish.

## 4.8.2 and earlier

Unified eBook and audiobook search; Chaptarr (formerly Bookshelf/Readarr) and Listenarr
integration; per-user accounts with daily limits; Overseerr-style approvals; Discord and
webhook notifications; duplicate detection; API keys and the `/api/dashboard` summary;
an installable PWA; and a hardened, non-root, read-only container.
