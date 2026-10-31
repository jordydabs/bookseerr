https://github.com/user-attachments/assets/b77e54fb-c776-4f2b-8181-95248577df2d

<div align="center">

# 📚 BookSeerr

**A self-hosted eBook & audiobook request manager for [Chaptarr](https://github.com/Chaptarr/chaptarr) and [Listenarr](https://github.com/Listenarrs/Listenarr).**

Discover books picked from your own library, search eBooks and audiobooks in one place, and send requests straight to the right downloader — with per-user accounts, request limits, approvals, API keys, and Discord notifications.

[![CI](https://github.com/jordydabs/bookseerr/actions/workflows/ci.yml/badge.svg)](https://github.com/jordydabs/bookseerr/actions/workflows/ci.yml)
[![version](https://img.shields.io/github/package-json/v/jordydabs/bookseerr?label=version&color=8b5cf6)](CHANGELOG.md)
![node](https://img.shields.io/badge/node-20--alpine-339933?logo=nodedotjs&logoColor=white)
[![license](https://img.shields.io/badge/license-PolyForm%20Noncommercial-blue)](LICENSE)

[Quick start](#quick-start) · [Configuration](#configuration) · [API](#api-access) · [Security](#security) · [Changelog](CHANGELOG.md) · [Releases](https://github.com/jordydabs/bookseerr/releases)

</div>

---

## Overview

BookSeerr is a lightweight request frontend for your reading and listening stack. Users browse or search, hit **Request**, and BookSeerr hands it to the right place: **eBooks and authors go to Chaptarr**, **audiobooks go to Listenarr**. Think of it as an Overseerr-style experience for books.

It runs as a single small Node/Express app with a flat-file (`db.json`) database — no external database to manage — and ships hardened for Docker out of the box.

## Features

- **Discover, built from your library** — the landing page opens with rows grown from what's already on your shelf: **Recommended Audiobooks** and **eBooks You Might Like** (titles that readers and listeners of your books also loved), **Authors You Might Like** (people your library doesn't have yet), **New From Your Authors** (recent and upcoming releases), **Because You Like &lt;your top genres&gt;**, and a daily-rotating **Something Different** genre next to your taste that your shelf doesn't cover yet. Every card says why it's there (*Because you have Best Served Cold*), and anything you already own or have requested — plus translations and pre-orders — is left out. Similarity comes from Audible's "listeners also enjoyed" data, seeded from your Listenarr titles, your Chaptarr authors and your own requests; no API key and no LLM required.
- **More to browse** — below the personal rows: recently released and upcoming audiobooks from Audible, new eBook releases, and curated all-time greats in both formats. Rows with nothing to show are hidden, never left empty.
- **Unified search** — eBooks via Google Books (falling back to **Open Library** automatically when Google is down), audiobooks via Audible. Pick **Everything** to search both at once with grouped results, or narrow to eBooks, Audiobooks or Authors.
- **Library-aware everywhere** — search results and every Discover card are checked against your Chaptarr and Listenarr libraries. Anything you already have is badged **✓ In library**, and requesting it asks first instead of creating a duplicate. "In library" means actually *downloaded* (or downloading) — a book whose author is in Chaptarr, or a title the downloader has but never managed to grab, isn't flagged, because requesting it is exactly how it gets searched for.
- **The right downloader for the format** — an eBook by an author **already in Chaptarr** is found in that author's catalogue and searched for on its own (monitored first if needed); an eBook by a *new* author is added to Chaptarr as a whole-author add with a search fired straight away, while the request log still records the **exact title** asked for. Audiobooks go to **Listenarr** by Audible ASIN, so the exact edition is added — and one Listenarr already has but never downloaded is re-monitored and searched instead of just reported as "already there".
- **Request approvals (Overseerr-style)** — a global **auto-approve** switch plus per-user overrides. When a user isn't auto-approved, requests wait as **Pending** — nothing touches Chaptarr or Listenarr until an admin clicks **Approve** (which sends the exact stored request) or **Reject**. Admins and API keys are always auto-approved, errored sends get a one-click **Retry**, and rejected or cancelled requests refund the user's daily slot.
- **Duplicate detection** — separate from the library check: a title somebody already requested is flagged **⏳ Requested** with who asked and when, and a double-click can never send the same request twice.
- **Notifications** — point BookSeerr at a **Discord** webhook (or any URL) for submitted / approved / rejected / failed requests. Discord gets a rich embed with the cover art; anything else gets flat JSON. Delivered server-side, so nobody needs a tab open.
- **User management** — per-user accounts with daily request limits, a can-request toggle, last-seen times and lockout status.
- **In-app connections** — link Chaptarr and Listenarr (URL + API key) from **Settings**, with a one-click connection test. Saved server-side, applied instantly with no restart; `.env` remains a fallback and app values override it.
- **Format-aware Chaptarr support** — Chaptarr can hold eBooks *and* audiobooks; BookSeerr drives only its eBook side, offers only eBook-typed profiles and folders, and never touches the audiobook half.
- **Chaptarr-friendly by design** — Chaptarr's author list can take 20–45 seconds on a big library, so it's cached and refreshed in the background (stale-while-revalidate), book lists are read per author rather than the whole library, concurrent reads are capped, and upstream failures fall back to the last good answer instead of retry storms.
- **API keys** — service-account keys so dashboards and scripts can read stats and submit requests.
- **Dashboard summary endpoint** — one call to `/api/dashboard` returns request counts, a per-user breakdown, recent requests and upstream health for dashboard tiles (Homepage, Organizr, and the like).
- **Installable** — a web manifest and proper maskable icons, so **Add to Home Screen** gives a real app icon and a standalone window on phones.
- **Embeddable** — drops into an `<iframe>` (configurable `frame-ancestors` allowlist), with optional CORS for browser callers.
- **Hardened container** — non-root user, dropped Linux capabilities, read-only root filesystem, isolated network, resource limits and graceful shutdown. See [Security](#security).

## Project layout

```
bookseerr/
├── server.js            # Express backend
├── package.json
├── package-lock.json    # exact dependency tree (Docker installs from it)
├── Dockerfile
├── docker-compose.yml
├── entrypoint.sh        # fixes data-volume ownership, then drops to a non-root user
├── .env                 # your config (never commit this)
├── .env.example
├── CHANGELOG.md         # what changed in each release
├── CONTRIBUTING.md
├── SECURITY.md          # how to report a vulnerability
├── LICENSE              # PolyForm Noncommercial 1.0.0
├── .github/             # CI, tag-driven releases, issue & PR templates
├── test/                # headless end-to-end suites (npm test)
│   ├── approvals.js
│   └── security.js
└── public/              # frontend — served by Express
    ├── index.html
    ├── login.html
    ├── app.js
    ├── login.js
    ├── style.css
    ├── favicon.svg / favicon.ico / favicon-32.png
    ├── apple-touch-icon.png           # iOS home screen
    ├── icon-192*.png, icon-512*.png   # PWA / Android icons (regular + maskable)
    └── site.webmanifest               # installable web-app manifest
```

> The frontend files **must** live in `public/` — the server serves static assets from that folder.

## Quick start

### Docker (recommended)

```bash
# 1. Clone
git clone https://github.com/jordydabs/bookseerr.git
cd bookseerr

# 2. Configure
cp .env.example .env
#    Set ADMIN_PASS (and optionally JWT_SECRET):
#      openssl rand -hex 32   →   paste into JWT_SECRET
#    Set CHAPTARR_URL / CHAPTARR_API_KEY and LISTENARR_URL / LISTENARR_API_KEY here —
#    or leave them out and link both from inside the app later (Settings).

# 3. Build & run
docker compose up -d --build

# Open http://localhost:8099   ·   log in with the ADMIN_USER / ADMIN_PASS you set in .env
```

The container reaches your other services over `host.docker.internal`, which the compose file already maps. It runs as uid/gid 1000 by default and fixes `./data` ownership itself on start; set `PUID` / `PGID` to match a different host owner.

> **After changing anything in the source — including `public/` — rebuild with `docker compose up -d --build`.** The app is copied into the image at build time, so a plain `up -d` keeps serving the old files.

### Bare metal

```bash
npm ci --omit=dev
cp .env.example .env
#  set ADMIN_PASS, and change DATA_DIR=/app/data to DATA_DIR=./data
npm start                     # http://localhost:8099
```

## Configuration

| Variable | Required | Description |
|---|---|---|
| `CHAPTARR_URL` | No* | `http://your-chaptarr:8789` — or set in Settings |
| `CHAPTARR_API_KEY` | No* | Chaptarr → Settings → General → Security — or set in Settings |
| `LISTENARR_URL` | No* | `http://your-listenarr:4545` — or set in Settings |
| `LISTENARR_API_KEY` | No* | Listenarr → Settings → Security — or set in Settings |
| `ADMIN_USER` | No | Default: `admin` (created on first run) |
| `ADMIN_PASS` | **Yes** | Password for the bootstrap admin — **change it from the sample** |
| `JWT_SECRET` | No | 32+ random chars (`openssl rand -hex 32`). If unset, a random key is generated on first run and kept in `DATA_DIR/.jwt_secret` |
| `JWT_TTL` | No | How long a sign-in lasts (default `365d`); sessions are revocable at any time |
| `GOOGLE_BOOKS_API_KEY` | No | Raises Google Books' limits for eBook search; without it (or when Google is down) Open Library takes over |
| `AUDIBLE_BASE` / `AUDIBLE_REGION` | No | Audible marketplace (default `https://api.audible.com` / `us`; use `.co.uk`, `.de`, … for other regions) |
| `AUDIBLE_CATEGORY_ID` | No | Limit the general audiobook rows to one Audible category |
| `TRUST_PROXY` | No | Number of reverse proxies in front (default `1`; `false` if exposed directly) — keep it accurate, see [Security](#security) |
| `LOGIN_MAX_FAILS` / `LOGIN_LOCK_MINUTES` | No | Failed sign-ins before an account locks, and for how long (default `10` / `15`) |
| `CORS_ORIGINS` | No | Comma-separated origins allowed to call the API from a browser (`*` for any) |
| `FRAME_ANCESTORS` | No | Origins allowed to embed BookSeerr in an `<iframe>` (blank = anywhere) |
| `UPSTREAM_TIMEOUT_MS` | No | Timeout for Chaptarr / Listenarr / Audible calls (default `8000`) |
| `SEND_TIMEOUT_MS` | No | Timeout for *sending* a request to a downloader (default `30000`; never retried) |
| `LIBRARY_TIMEOUT_MS` | No | Timeout for Chaptarr's author/book lists (default `120000` — they can take 20–45 s on a big library) |
| `UPSTREAM_RETRIES` | No | Retries for transient failures on reads (default `2`; writes are never retried) |
| `DISCOVER_TTL_MINUTES` | No | How long the general Discover rows are cached (default `30`) |
| `DATA_DIR` | No | Docker: `/app/data` · bare metal: `./data` |
| `PORT` | No | Default: `8099` |
| `PUID` / `PGID` | No | uid/gid the container runs as and owns `./data` with (default `1000`) |

\* Chaptarr and Listenarr can be configured either in `.env` **or** from inside the app (**Settings → Chaptarr · eBooks / Listenarr · Audiobooks**, stored in `db.json`). App-saved values override `.env` and apply immediately without a restart. See `.env.example` for every option, annotated.

> **Upgrading from the old Bookshelf/Readarr integration?** `BOOKSHELF_*` / `READARR_*` are still read as a fallback, settings saved in-app under the old name are migrated automatically, and old requests keep showing the right destination.

## How requests work

1. A user finds a book via **Discover** or **Search**.
2. BookSeerr checks it against your libraries. A title that's already downloaded is badged **✓ In library**, and requesting it asks for confirmation first.
3. On request, the user picks a quality profile (plus metadata profile and root folder for Chaptarr; Listenarr files audiobooks under its own root folder).
4. **Approval gate** — if auto-approve is on (the default), or the requester is an admin / API key / a user set to always auto-approve, the request is sent immediately. Otherwise it's saved as **Pending** and waits on the All Requests page for an admin to approve or reject it.
5. On approval (or immediately, when auto-approved):
   - an **eBook by an author already in Chaptarr** is found in that author's catalogue — co-authors and title variants like `: A Novel` or `(Series, #2)` are allowed for, ambiguous matches never guessed — monitored if needed, and searched for on its own. If it isn't in the catalogue yet (a new release), Chaptarr refreshes the author first and the search follows when the refresh finishes; that follow-up survives a restart;
   - an **eBook by a new author** (or an **author** request) adds the author to Chaptarr, monitored, with a search fired straight away;
   - an **audiobook** is added to Listenarr by ASIN — or, if Listenarr already has it but never downloaded it, re-monitored and searched;
   - if the downloader rejects it, the request becomes an **error** an admin can **Retry**.
6. Every request is logged in **My Requests** and **All Requests** with its status and what was actually sent.

## API access

Log in as an admin and open **API Keys** in the sidebar to generate keys. Keys are stored in `db.json` (not in `.env`) and can be revoked at any time.

A key acts as an **admin service account** with no daily quota — it can read stats and submit requests, attributed to `apikey:<name>`. It deliberately **cannot** create or modify admin accounts, manage API keys, or read the connection and notification settings (which hold your upstream keys and webhook URL): those require a signed-in admin, so a leaked key can't exfiltrate your credentials or mint more keys.

Send the key as an `X-Api-Key` header (or `?apikey=`); a signed-in user's JWT works too, as `Authorization: Bearer <token>`.

```bash
# Request an audiobook (by Audible ASIN)
curl -X POST "http://your-host:8099/api/request" \
  -H "X-Api-Key: <your key>" \
  -H "Content-Type: application/json" \
  -d '{"kind":"audio","title":"Project Hail Mary","author":"Andy Weir","asin":"B08G9PRS1K","qualityProfileId":1}'

# Request an eBook (goes to Chaptarr)
curl -X POST "http://your-host:8099/api/request" \
  -H "X-Api-Key: <your key>" \
  -H "Content-Type: application/json" \
  -d '{"kind":"book","title":"Dune","author":"Frank Herbert","qualityProfileId":1,"metadataProfileId":1,"rootFolderPath":"/books"}'
```

### Selected endpoints

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /healthz` | none | Liveness + version (used by the Docker healthcheck) |
| `POST /api/auth/login` | none | Exchange username/password for a JWT |
| `GET /api/search` | session/key | Search — `?q=`, `?type=all\|books\|audio`, plus `minYear`, `maxYear`, `source`, `limit` |
| `GET /api/discover/for-you` | session/key | Library-based recommendation rows: `{ rows: [{ id, kind, title, subtitle, items }] }`, each item with a `why` |
| `GET /api/discover` | session/key | The general rows: new and upcoming audiobooks, new eBooks, all-time greats |
| `GET /api/library/check` | session/key | Is this already in the library? `?kind= &title= &author= &asin=` |
| `POST /api/library/check-batch` | session/key | The same check for a whole page: `{ "items": [{ kind, title, author, asin }, …] }` |
| `POST /api/request` | session/key | Create a request (eBooks/authors → Chaptarr, audiobooks → Listenarr) |
| `GET /api/requests` | session/key | Requests — your own, or everyone's for admins/keys. Filters: `status`, `kind`, `destination`, `user`, `q`, `since`, `until`, `limit`, `offset` |
| `DELETE /api/requests/:id` | session/key | Delete a request (cancelling your own pending one refunds the slot) |
| `POST /api/requests/:id/approve` | admin/key | Send a pending request now (also retries errored ones) |
| `POST /api/requests/:id/reject` | admin/key | Reject a pending request (optional `{"reason":"…"}`); refunds the slot |
| `GET /api/dashboard` | admin/key | One-call summary for dashboard tiles |
| `GET`/`PUT /api/admin/settings/approvals` | admin/key | Global auto-approve (`{ autoApproveAll }`) |
| `GET`/`PUT /api/admin/settings/integrations` | admin session | Chaptarr / Listenarr connection settings (keys masked) |
| `POST /api/admin/settings/integrations/test` | admin session | Test a connection without saving |
| `GET`/`PUT /api/admin/settings/notifications` | admin session | Webhook settings (URL masked) |
| `POST /api/admin/settings/notifications/test` | admin session | Send a sample notification |
| `POST /api/account/password` | session | Change your own password (signs out your other devices) |
| `POST /api/account/logout-all` | session | Sign out every other device |

## Dashboard integration

Read `/api/dashboard` with an API key from your dashboard's backend:

> [!WARNING]
> A BookSeerr API key is a **full-access admin service account**. Inject it only on the one endpoint your dashboard needs, and make sure that location is reachable only by your dashboard — never expose a blanket proxy that adds the key to every route.

```nginx
# Scoped to one endpoint. The key is injected here, never exposed in the browser.
location = /bookseerr/dashboard {
    proxy_pass http://host.docker.internal:8099/api/dashboard;
    proxy_set_header X-Api-Key  <your key>;   # from API Keys
    allow 172.16.0.0/12;                       # your dashboard's network only
    deny  all;
}
```

`/api/dashboard` returns everything a tile needs in one call:

```jsonc
{
  "app": "BookSeerr",
  "version": "4.10.0",
  "requests": { "total": 42, "sent": 37, "approved": 37, "pending": 2, "rejected": 1, "error": 2,
                "ebooks": 25, "audiobooks": 17, "today": 4 },
  "approvals": { "autoApproveAll": true },
  "byUser": [ { "username": "alex", "total": 12, "sent": 11, "pending": 1, "rejected": 0, "error": 0 } ],
  "users": { "total": 5 },
  "recent": [ /* the latest requests, with status and destination */ ],
  "chaptarr":  { "connected": true, "version": "…" },
  "listenarr": { "connected": true, "version": "…" }
}
```

It also advertises the available filter values and endpoint shapes, so a dashboard can build its controls dynamically. Regular users get a 403 — they see their own requests via `/api/requests`.

### Iframe embed

```html
<iframe src="http://your-host:8099" style="width:100%;height:100%;border:0"></iframe>
```

## Notifications

Settings → **Notifications**: paste a webhook URL, tick the events you want, and hit **Send test**.

For Discord: **Server Settings → Integrations → Webhooks → New Webhook → Copy Webhook URL**. BookSeerr detects Discord and posts a rich embed (cover art, requester, type, destination, status). Any other URL receives flat JSON:

```json
{
  "app": "BookSeerr", "version": "4.10.0", "event": "submitted",
  "at": "2026-10-24T12:00:00.000Z",
  "request": { "id": 42, "kind": "book", "title": "Dune", "author": "Frank Herbert",
               "username": "alex", "status": "pending", "destination": "chaptarr",
               "message": "Waiting for admin approval", "createdAt": "…" }
}
```

The webhook URL is treated as a secret — readable only by a signed-in admin and only ever echoed back masked. Delivery is fire-and-forget: an unreachable webhook logs a warning and never delays or fails a request.

## Passwords

- **Change your own:** **Account** → current password → new password. Every *other* device is signed out; this one gets a fresh token.
- **Sign out everywhere else:** **Account → Sign out everywhere else**.
- **Admin reset:** **Users** → **Edit** → type a new password (blank keeps the existing one).
- **Sessions are revocable.** Every request re-checks the account, so deleting a user, demoting an admin or changing a password takes effect immediately on every device.

## Data & backups

State lives in a single `data/db.json`. Writes are atomic, fsync'd and length-checked, and the previous good copy is kept as `db.json.bak` for automatic recovery. To back up BookSeerr, copy the `data/` directory.

**A damaged database stops the app instead of being replaced.** A missing `db.json` is a first run; one that exists but can't be read is recovered from `db.json.bak` if possible, otherwise BookSeerr stops with an explanation and keeps a copy as `db.json.corrupt` — quietly starting empty would lose accounts, keys and history that could have been recovered.

## Security

BookSeerr's container is hardened out of the box:

- **Pinned base** — `node:20.18.1-alpine3.20` (not `:latest`), installed with `npm ci` from `package-lock.json`, so builds are reproducible.
- **Least privilege** — runs as a non-root user (uid/gid 1000 by default); `cap_drop: ALL` with only the few capabilities the entrypoint needs added back; `no-new-privileges`.
- **Filesystem & network** — read-only root filesystem with a `tmpfs` for `/tmp`; only `./data` is writable. Runs on its own bridge network.
- **Containment** — `mem_limit` and `pids_limit` cap resources; `init: true` gives a real PID 1, and a 15 s stop grace period lets in-flight sends finish on `docker stop`.
- **Secrets** — nothing baked into the image (`.env` is excluded via `.dockerignore`); `JWT_SECRET` is generated if you don't set one, so tokens are never signed with a value from the source. Connection settings saved in the app live in `db.json` (same sensitivity as `.env` — keep `./data` private) and are readable only from a signed-in admin session, never via an API key, and never returned unmasked.
- **Sign-in** — bcrypt password hashes; brute-force protection **per account** (`LOGIN_MAX_FAILS` → lock for `LOGIN_LOCK_MINUTES`) as well as per IP; failed sign-ins look identical for real and non-existent accounts, so usernames can't be harvested.
- **Proxies** — set `TRUST_PROXY` to your real number of proxies. Higher than reality lets a caller forge their IP through `X-Forwarded-For` and slip the IP rate limiter (the per-account lockout still applies).
- **Upstream keys** — API keys are compared in constant time, and the connection **Test** button only reuses a saved key for the address it belongs to.

**Your responsibility:** keep Docker updated, and don't expose BookSeerr directly to the internet — put it behind a reverse proxy with TLS. Never commit `.env` or `data/` (the shipped `.gitignore` covers both).

Found a vulnerability? Please report it privately — see [SECURITY.md](SECURITY.md).

## Running the tests

Two headless suites boot the real server against mock Chaptarr, Listenarr, Audible, Google Books and Open Library — no Docker, no live services, and they never touch your `data/`:

```bash
npm test
```

`test/approvals.js` (132 checks) covers the approval workflow, Discover (including the library-based rows), the Open Library fallback, upstream caching, and requests whose author or audiobook the downloaders already have. `test/security.js` (87 checks) covers session revocation, login lockout, admin safety rails, the daily-limit race, webhooks, duplicate detection and crash-safe storage.

## Tech stack

- **Backend:** Node.js 20 · Express · JWT auth · bcrypt · helmet · express-rate-limit
- **Frontend:** vanilla JS / HTML / CSS (no build step), served from `public/`
- **Storage:** flat-file `db.json` (atomic writes)
- **External:** Chaptarr API · Listenarr API · Audible catalog · Google Books · Open Library

## Contributing

Issues and pull requests are welcome — [CONTRIBUTING.md](CONTRIBUTING.md) covers running the tests and what a good pull request looks like. For larger changes, please [open an issue](https://github.com/jordydabs/bookseerr/issues/new/choose) first to discuss what you'd like to change.

## License

Released under the [PolyForm Noncommercial License 1.0.0](LICENSE). You may use, change and share
BookSeerr for any noncommercial purpose (personal use, hobby projects, research, charities, schools
and similar), but you may not sell it or use it commercially.
