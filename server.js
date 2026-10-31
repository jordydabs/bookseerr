'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const https = require('https');
const http = require('http');
const { URL } = require('url');
require('dotenv').config();

const app = express();
const APP_VERSION = '4.10.0';
const PORT = parseInt(process.env.PORT || '8099', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');

// ── eBooks → Chaptarr ────────────────────────────────
// .env values are the FALLBACK. Admins can also set URL + API key in the app
// (Admin → Settings); those live in db.json and take precedence, so they sync
// across every browser/phone and survive restarts without editing .env.
// BOOKSHELF_* / READARR_* are still read so an existing install keeps working after
// the upgrade without anyone having to edit .env first.
const ENV_CHAPTARR_URL = (process.env.CHAPTARR_URL || process.env.BOOKSHELF_URL || process.env.READARR_URL || '').replace(/\/$/, '');
const ENV_CHAPTARR_KEY = process.env.CHAPTARR_API_KEY || process.env.BOOKSHELF_API_KEY || process.env.READARR_API_KEY || '';

// ── Audiobooks → Listenarr ─────────────────────────────────────────────────
const ENV_LISTENARR_URL = (process.env.LISTENARR_URL || 'http://host.docker.internal:4545').replace(/\/$/, '');
const ENV_LISTENARR_KEY = process.env.LISTENARR_API_KEY || '';

// Effective integration config used by EVERY upstream call. Recomputed from
// db.json (app-saved values win) + env fallbacks at startup and whenever an
// admin saves the Settings page — no restart needed.
const CFG = { chaptarrUrl: '', chaptarrKey: '', listenarrUrl: '', listenarrKey: '' };
function refreshIntegrations(db){
  const ig = (((db || loadDB()).settings) || {}).integrations || {};
  // Settings saved under the old "bookshelf" key are still honoured, so an admin who
  // configured it in the app doesn't come back to a blank Settings page.
  const b = ig.chaptarr || ig.bookshelf || {}, l = ig.listenarr || {};
  CFG.chaptarrUrl = String(b.url    || ENV_CHAPTARR_URL || '').replace(/\/+$/, '');
  CFG.chaptarrKey = String(b.apiKey || ENV_CHAPTARR_KEY || '');
  CFG.listenarrUrl = String(l.url    || ENV_LISTENARR_URL || '').replace(/\/+$/, '');
  CFG.listenarrKey = String(l.apiKey || ENV_LISTENARR_KEY || '');
  // Connection details changed → every cached upstream answer (libraries, options,
  // health probes, searches) may now be wrong. Start fresh.
  cacheBust('');
  // …and start reloading the Chaptarr author list now, so the first request doesn't
  // sit through it. Deferred: at boot this runs before the cache helpers exist.
  setTimeout(warmChaptarrAuthors, 3000).unref();
}

// ── Audible catalog (Discover: recent + upcoming audiobooks) ────────────────
// api.audible.com (US). For other marketplaces set AUDIBLE_BASE to the matching
// host, e.g. https://api.audible.co.uk / https://api.audible.de
const AUDIBLE_BASE = (process.env.AUDIBLE_BASE || 'https://api.audible.com').replace(/\/$/, '');
const AUDIBLE_REGION = process.env.AUDIBLE_REGION || 'us';
const AUDIBLE_CATEGORY_ID = process.env.AUDIBLE_CATEGORY_ID || ''; // optional genre/category filter

const GB_KEY = process.env.GOOGLE_BOOKS_API_KEY || '';
// Host for the Google Books API. Configurable for the same reason AUDIBLE_BASE is:
// so the Discover/search rows can be pointed at a mock (or a proxy) instead of only
// ever being exercisable against the live service.
const GB_BASE = (process.env.GOOGLE_BOOKS_BASE || 'https://www.googleapis.com/books/v1').replace(/\/$/, '');

// ── CORS for dashboards / external programs calling the API from a browser ────
// Comma-separated allowed origins, e.g. CORS_ORIGINS=https://dashboard.example.com,https://example.com
// Use "*" to allow any origin. Leave blank (default) to disable CORS entirely —
// server-to-server callers (and same-origin / nginx-proxied dashboards) don't need it.
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

// ── iframe embedding (dashboards) ────────────────────────────────────────────
// By default BookSeerr is embeddable anywhere (no X-Frame-Options, no CSP
// frame-ancestors). If you'd rather lock embedding to specific dashboards, set
// FRAME_ANCESTORS to a space/comma-separated list of origins, e.g.
//   FRAME_ANCESTORS=https://dashboard.example.com https://example.com
// Leave blank (default) to allow any site to embed it.
const FRAME_ANCESTORS = (process.env.FRAME_ANCESTORS || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean);

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme';

fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Session signing key ──────────────────────────────────────────────────────
// A sign-in token is only as trustworthy as the key that signs it: anyone who
// knows the key can mint an "admin" token for themselves without a password.
// Older builds fell back to a hard-coded string that ships in this file, which
// meant an unconfigured install was trivially forgeable. Now, if JWT_SECRET is
// missing (or still set to one of the well-known placeholders) we generate a
// random 256-bit key ONCE and persist it in the data dir, so the app is secure
// out of the box AND sessions still survive a restart.
const PLACEHOLDER_SECRETS = new Set([
  '', 'bookseerr-secret-change-me', 'change_me_to_a_long_random_string', 'changeme', 'secret'
]);
const SECRET_FILE = path.join(DATA_DIR, '.jwt_secret');
function resolveJwtSecret(){
  const fromEnv = String(process.env.JWT_SECRET || '').trim();
  if (!PLACEHOLDER_SECRETS.has(fromEnv)) return fromEnv;
  try {
    const saved = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (saved.length >= 32) return saved;
  } catch { /* not generated yet */ }
  const generated = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(SECRET_FILE, generated, { mode: 0o600 });
    console.warn('[BookSeerr] JWT_SECRET is unset or still a placeholder — generated a random key and saved it to ' + SECRET_FILE + '.');
    console.warn('[BookSeerr] Set JWT_SECRET in .env (openssl rand -hex 32) to control it yourself.');
  } catch (e) {
    console.warn('[BookSeerr] JWT_SECRET is unset and ' + SECRET_FILE + ' is not writable (' + e.message + ') — using a key that changes on every restart, so everyone will be signed out when the app restarts.');
  }
  return generated;
}
const JWT_SECRET = resolveJwtSecret();
// How long a sign-in lasts. Tokens can now be revoked server-side (see tokenVersion),
// so a long TTL is no longer a one-way door — but it's configurable either way.
const JWT_TTL = process.env.JWT_TTL || '365d';
if (ADMIN_PASS === 'changeme') console.warn('[BookSeerr] ADMIN_PASS is still the default "changeme" — change it in .env before exposing this app.');
const DB_TMP = DB_PATH + '.tmp';
const DB_BAK = DB_PATH + '.bak';
function defaultDB(){ return { users: [], requests: [], apiKeys: [], settings: { nextUserId: 1, nextRequestId: 1, nextApiKeyId: 1 } }; }
function backfill(db){
  // Backfill new fields so older db.json files keep working without manual edits.
  if (!Array.isArray(db.users)) db.users = [];
  if (!Array.isArray(db.requests)) db.requests = [];
  if (!Array.isArray(db.apiKeys)) db.apiKeys = [];
  if (!db.settings) db.settings = {};
  if (db.settings.nextUserId == null) db.settings.nextUserId = (db.users.reduce((m,u)=>Math.max(m,u.id||0),0) + 1) || 1;
  if (db.settings.nextRequestId == null) db.settings.nextRequestId = (db.requests.reduce((m,r)=>Math.max(m,r.id||0),0) + 1) || 1;
  if (db.settings.nextApiKeyId == null) db.settings.nextApiKeyId = (db.apiKeys.reduce((m,k)=>Math.max(m,k.id||0),0) + 1) || 1;
  // App-saved integration settings (Admin → Settings). Optional per service:
  //   { chaptarr: { url, apiKey }, listenarr: { url, apiKey } }
  if (!db.settings.integrations || typeof db.settings.integrations !== 'object') db.settings.integrations = {};
  // Per-user notification marker: the highest request id this user has SEEN on the
  // All Requests page. Stored server-side so "already checked" syncs across every
  // browser and phone (the old build kept this in localStorage → per-device only).
  for (const u of db.users) { if (u.lastSeenRequestId == null) u.lastSeenRequestId = 0; }
  // Approval system (Overseerr-style). Global toggle defaults to ON so existing
  // installs keep their current "everything goes straight through" behaviour.
  if (!db.settings.approvals || typeof db.settings.approvals !== 'object') db.settings.approvals = {};
  if (db.settings.approvals.autoApproveAll == null) db.settings.approvals.autoApproveAll = true;
  // Per-user override: 'default' (follow the global toggle) | 'on' | 'off'.
  for (const u of db.users) { if (u.autoApprove == null) u.autoApprove = 'default'; }
  // Session revocation counter. Every issued token carries the value it was signed
  // with; bumping it here instantly invalidates every token for that user (used on
  // password change, "sign out everywhere", and admin-forced password resets).
  for (const u of db.users) { if (u.tokenVersion == null) u.tokenVersion = 0; }
  // Older builds persisted failed-login counters here; they're in-memory now (see
  // loginFails). Strip them so stale values can't lock somebody out after an upgrade.
  for (const u of db.users) { if (u.failedLogins !== undefined) delete u.failedLogins; if (u.lockedUntil !== undefined) delete u.lockedUntil; }
  return db;
}
// Keep a damaged database around instead of letting the next write bury it. A
// truncated db.json is usually still 99% intact text — every username, API key and
// request title is sitting right there — so it is worth far more on disk than in a
// stack trace.
function quarantineDB(raw){
  try {
    const dest = DB_PATH + '.corrupt';
    if (!fs.existsSync(dest)) { fs.writeFileSync(dest, raw); return dest; }
    return dest;
  } catch { return null; }
}
function fatalDataError(what, detail, saved){
  console.error('\n[BookSeerr] REFUSING TO START — ' + what);
  console.error('[BookSeerr] ' + detail);
  if (saved) console.error('[BookSeerr] The damaged file was preserved as: ' + saved);
  console.error('[BookSeerr] Nothing has been overwritten. Restore ' + DB_PATH + ' from a backup');
  console.error('[BookSeerr] (or repair it by hand), then start BookSeerr again.');
  console.error('[BookSeerr] To start over from scratch instead, delete the files in ' + DATA_DIR + '.\n');
  process.exit(1);
}
function loadDB(){
  // Corruption-safe load. The old version collapsed EVERY failure — a corrupt file,
  // a permissions error, a half-finished restore — into "return an empty database",
  // and the very next saveDB() then overwrote the real db.json with that emptiness
  // and clobbered the .bak on the way past. Verified: a truncated 6.3KB db.json
  // holding 2 accounts, an API key and 28 requests came back as a 457-byte file with
  // all of it gone, silently, with nothing in the log.
  //
  // So: a MISSING file is a first run (fine, start fresh). A file that exists but
  // cannot be read or parsed is a data-integrity failure — recover from .bak, and if
  // that is not possible, stop rather than destroy anything.
  let raw = null;
  try { raw = fs.readFileSync(DB_PATH, 'utf8'); }
  catch (readErr) {
    if (readErr.code !== 'ENOENT') {
      fatalDataError('data/db.json exists but could not be read', readErr.message, null);
    }
    // No db.json at all — try a leftover .bak before assuming a fresh install.
    try {
      const db = backfill(JSON.parse(fs.readFileSync(DB_BAK, 'utf8')));
      console.warn('[BookSeerr] db.json is missing — recovered from db.json.bak');
      return db;
    } catch { return defaultDB(); }   // genuinely first run
  }

  try { return backfill(JSON.parse(raw)); }
  catch (parseErr) {
    try {
      const db = backfill(JSON.parse(fs.readFileSync(DB_BAK, 'utf8')));
      const saved = quarantineDB(raw);
      console.warn('[BookSeerr] db.json is corrupt (' + parseErr.message + ') — recovered from db.json.bak');
      if (saved) console.warn('[BookSeerr] The corrupt file was preserved as ' + saved);
      return db;
    } catch (bakErr) {
      fatalDataError('data/db.json is corrupt and db.json.bak could not be used',
        parseErr.message + ' / backup: ' + bakErr.message, quarantineDB(raw));
    }
  }
}
// Atomic, durable write: serialise → temp file → fsync → back up the current good
// file → atomic rename. A crash at any point leaves either the old file or the new
// one intact (never a half-written db.json), so admin changes are truly permanent.
function saveDB(db){
  const data = Buffer.from(JSON.stringify(db, null, 2), 'utf8');
  const fd = fs.openSync(DB_TMP, 'w');
  try {
    // writeSync is allowed to write FEWER bytes than asked (notably as a disk fills).
    // Ignoring the return value meant a short write produced a truncated temp file
    // that was then fsync'd and renamed straight over the good database, while the
    // HTTP response still reported success. Loop until it is all down.
    let off = 0;
    while (off < data.length) {
      const n = fs.writeSync(fd, data, off, data.length - off);
      if (!(n > 0)) throw new Error('write stalled at ' + off + '/' + data.length + ' bytes');
      off += n;
    }
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  // Belt and braces: never promote a temp file that isn't the size we meant to write.
  const written = fs.statSync(DB_TMP).size;
  if (written !== data.length) throw new Error('short write to db.json (' + written + '/' + data.length + ' bytes) — the database was left untouched');
  try { if (fs.existsSync(DB_PATH)) fs.copyFileSync(DB_PATH, DB_BAK); } catch {}
  fs.renameSync(DB_TMP, DB_PATH); // atomic on the same filesystem
}
// Atomic read-modify-write. Use this in any handler that performs an `await`
// (upstream HTTP, bcrypt) BEFORE persisting: it re-reads the freshest db, applies
// the change synchronously, then saves — closing the window where a concurrent
// request could clobber the update with a stale snapshot.
function mutate(fn){ const db = loadDB(); const out = fn(db); saveDB(db); return out; }

// One-time migration: hash any legacy plaintext passwords found in db.json
function migratePasswords(){
  const db = loadDB();
  let changed = false;
  for (const u of db.users) {
    if (u.password !== undefined) {
      if (!u.passwordHash) u.passwordHash = bcrypt.hashSync(String(u.password), 10);
      delete u.password;
      changed = true;
    }
  }
  saveDB(db); // also persists the backfilled settings/apiKeys structure
  if (changed) console.log('[BookSeerr] Migrated plaintext passwords to bcrypt hashes.');
}
migratePasswords();

function ensureAdmin(){ const db = loadDB(); if (!db.users.find(u => u.username === ADMIN_USER)) { db.users.push({ id: db.settings.nextUserId++, username: ADMIN_USER, passwordHash: bcrypt.hashSync(ADMIN_PASS, 10), role: 'admin', canRequest: true, limit: 999, requests: 0 }); saveDB(db); } }
ensureAdmin();
refreshIntegrations(); // load app-saved Chaptarr/Listenarr config (falls back to .env)

// ── Daily request limits ───────────────────────────────────────────────────
function todayKey(){ return new Date().toLocaleDateString('en-CA'); } // YYYY-MM-DD, server-local
// Which local day does this stored timestamp belong to? createdAt is a UTC instant
// while todayKey() is a LOCAL date, so comparing createdAt.slice(0,10) to todayKey()
// silently disagrees for part of every day whenever the server isn't on UTC — the
// refund on a same-day reject/cancel was skipped (or wrongly granted) depending on
// the hour. Convert the instant to the same local basis instead of string-slicing it.
function dayKeyOf(iso){ const d = new Date(iso); return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-CA'); }
// Where a request went (or would go). eBooks/authors → Chaptarr, audiobooks →
// Listenarr. Requests stored before the Chaptarr switch carry destination:'bookshelf';
// they are reported as 'chaptarr' so old rows still filter, display and total up
// correctly instead of silently dropping out of every destination view.
function destOf(rec){
  const d = String((rec && rec.destination) || ((rec && rec.kind) === 'audio' ? 'listenarr' : 'chaptarr')).toLowerCase();
  return d === 'bookshelf' ? 'chaptarr' : d;
}
// A cancelled, rejected or discarded request gives the user their daily slot back —
// but only if it was made today, since yesterday's counter has already reset.
function refundDailySlot(db, rec){
  const uu = db.users.find(x => x.id === rec.userId);
  if (!uu) return false;
  const today = todayKey();
  if (dayKeyOf(rec.createdAt) !== today || uu.requestsDate !== today || !(uu.requests > 0)) return false;
  uu.requests -= 1;
  return true;
}
function resetDailyCounts(db){
  const today = todayKey();
  let changed = false;
  for (const u of db.users) {
    if (u.requestsDate !== today) { u.requestsDate = today; u.requests = 0; changed = true; }
  }
  return changed;
}
function loadDBDaily(){
  const db = loadDB();
  if (resetDailyCounts(db)) saveDB(db);
  return db;
}

// ── Request approvals (Overseerr-style) ─────────────────────────────────────
// Who gets auto-approved, in priority order:
//   1. Admins and API-key callers — always.
//   2. The user's own override (Users → Edit): 'on' = always, 'off' = never.
//   3. Otherwise the GLOBAL toggle (Settings → Requests & Approvals).
// Anyone NOT auto-approved has their requests held as `pending` until an admin
// approves (sends upstream) or rejects them.
const AA_VALUES = ['default', 'on', 'off'];
function approvalsSettings(db){
  const a = ((db || loadDB()).settings || {}).approvals || {};
  return { autoApproveAll: a.autoApproveAll !== false };
}
function isAutoApproved(db, u){
  if (!u) return true;                          // service principals (API keys)
  if (u.role === 'admin') return true;          // admins always auto-approve
  if (u.autoApprove === 'on') return true;
  if (u.autoApprove === 'off') return false;
  return approvalsSettings(db).autoApproveAll;  // 'default' → follow the global toggle
}

// ── Tiny HTTP/JSON client used for all upstream (Chaptarr / Listenarr / Audible) ──
const UPSTREAM_TIMEOUT_MS = parseInt(process.env.UPSTREAM_TIMEOUT_MS || '8000', 10);
// Hard ceiling on how much we'll buffer from an upstream reply. Without it, a
// broken (or hostile) Chaptarr/Listenarr/Audible endpoint streaming an endless
// body would grow the string until the process runs out of memory and dies.
const MAX_UPSTREAM_BYTES = parseInt(process.env.MAX_UPSTREAM_BYTES || String(16 * 1024 * 1024), 10);
function requestJsonOnce(url, method='GET', body=null, headers={}, timeoutMs=UPSTREAM_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const bodyStr = body ? JSON.stringify(body) : null;
    const bodyBuf = bodyStr ? Buffer.from(bodyStr, 'utf8') : null;
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: Object.assign(
        { 'User-Agent': 'BookSeerr/' + APP_VERSION, 'Accept': 'application/json' },
        headers,
        bodyBuf ? { 'Content-Type': 'application/json', 'Content-Length': bodyBuf.length } : {}
      )
    };
    let data='', bytes=0, settled=false;
    // ONE place that settles this promise, so no exit path can be missed.
    const fail = e => { if (settled) return; settled = true; reject(e); };
    const req = lib.request(opts, res => {
      // Decode as UTF-8 up front. Concatenating raw Buffers with `+=` decodes each
      // chunk independently, so a multi-byte character split across a chunk boundary
      // (accented author names, non-Latin titles) came out as replacement chars.
      res.setEncoding('utf8');
      // A peer that drops the connection AFTER the headers reports it on the RESPONSE
      // stream, not on the request — so with only req.on('error') wired, this promise
      // never settled at all. The caller awaited forever, the browser request that
      // triggered it hung, and cached() had already stored the pending promise as its
      // in-flight entry, so every later caller joined the same dead fetch: one cut
      // connection while reading the author list stopped every "in library" badge in
      // the app until a restart. Both listeners below close that hole.
      res.on('aborted', () => fail(new Error('Upstream closed the connection before the response finished')));
      res.on('error', fail);
      res.on('data', c => {
        if (settled) return;
        bytes += Buffer.byteLength(c, 'utf8');
        if (bytes > MAX_UPSTREAM_BYTES) { settled = true; req.destroy(); return reject(new Error('Upstream response exceeded ' + MAX_UPSTREAM_BYTES + ' bytes')); }
        data += c;
      });
      res.on('end', () => { if (settled) return; settled = true; try { resolve({ status: res.statusCode, data: JSON.parse(data || '{}') }); } catch { resolve({ status: res.statusCode, data: data || {} }); } });
    });
    // Don't let a dead/slow upstream (Audible, Listenarr, Chaptarr) hang a whole
    // request (Discover, the dashboard summary, etc). Abort and reject after timeout.
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('Upstream timed out after ' + timeoutMs + 'ms')); });
    req.on('error', fail);
    // Last resort. 'close' always fires when the request is done with its socket, and
    // by then a successful read has already resolved — so this only ever catches an
    // ending nothing else accounted for, and guarantees the promise cannot leak.
    req.on('close', () => fail(new Error('Upstream connection closed before a complete response')));
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// Retry wrapper for TRANSIENT upstream failures.
//
// Google Books in particular answers the very first call in a burst with a
// 503 "Service temporarily unavailable" and then serves the identical query fine
// on the next attempt. Without a retry that single blip emptied a whole Discover
// row (the caller swallowed the error and rendered "No eBooks found").
//
// Only GET is retried by default: it's idempotent, so a repeat is free. Writes
// (adding an author to Chaptarr, adding an audiobook to Listenarr) are NEVER retried
// automatically — a "failed" POST may well have been applied upstream, and silently
// re-sending it would duplicate the add.
const UPSTREAM_RETRIES = parseInt(process.env.UPSTREAM_RETRIES || '2', 10);
// Chaptarr stalls for 20-30s at a stretch while it runs internal work — measured on a
// live 0.9.911 instance, where /api/v1/system/status and /api/v1/qualityprofile each
// took >30s while the app was otherwise perfectly healthy. At the 8s default that
// turned a legitimate request into "Upstream timed out after 8000ms" and the user had
// to notice and press Retry. Giving up costs real work ONLY on the send path, so that
// path alone waits longer — and takes ONE honest attempt rather than retrying, since
// three 30s tries would be worse than one.
const SEND_TIMEOUT_MS = parseInt(process.env.SEND_TIMEOUT_MS || '30000', 10);
// Chaptarr's author and book LISTS are slower again, because it computes statistics for
// every row. Measured live (0.9.965: 216 authors, ~48k monitored-missing books):
// GET /author 21-44s, GET /book?authorId= 3s for a 30-book author but 29s for Stephen
// King's 2,403, and even GET /author/{id} 22s. Under the 8s default every one of them
// timed out — after two retries, ~25s of re-asking a server that was already busy — and
// the failure was swallowed, so BookSeerr decided authors the library held weren't
// there and tried to add them again. These reads get their own long timeout and no
// automatic retries, and they're cached stale-while-revalidate (see cached()) so a
// user never waits on one once it has loaded.
const LIBRARY_TIMEOUT_MS = parseInt(process.env.LIBRARY_TIMEOUT_MS || '120000', 10);
const RETRY_BASE_MS = 400;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isTransient = status => status === 408 || status === 429 || (status >= 500 && status <= 599);
async function requestJson(url, method='GET', body=null, headers={}, timeoutMs=UPSTREAM_TIMEOUT_MS, retries=null) {
  const attempts = retries != null ? retries : (method === 'GET' ? UPSTREAM_RETRIES : 0);
  let lastResponse = null, lastError = null;
  for (let i = 0; i <= attempts; i++) {
    if (i > 0) await sleep(RETRY_BASE_MS * i);   // 400ms, then 800ms — brief, bounded
    try {
      const r = await requestJsonOnce(url, method, body, headers, timeoutMs);
      if (!isTransient(r.status) || i === attempts) return r;
      lastResponse = r;
    } catch (e) {
      lastError = e;
      if (i === attempts) throw e;
    }
  }
  if (lastResponse) return lastResponse;
  throw lastError || new Error('Upstream request failed');
}
const listenarrHeaders = () => ({ 'X-Api-Key': CFG.listenarrKey });
const chaptarrHeaders = () => ({ 'X-Api-Key': CFG.chaptarrKey });

// ── Auth ────────────────────────────────────────────────────────────────────
// Two ways to authenticate:
//   1. A logged-in user/admin via JWT  (Authorization: Bearer <token>)
//   2. An external program via a BookSeerr API key (X-Api-Key: <key> or ?apikey=)
// API-key callers are granted admin scope (same model as Sonarr/Radarr) so other
// programs can read and write everything over the API.
// Compare secrets in constant time so an attacker can't recover a key byte-by-byte
// from how long the comparison takes. (`===` on strings bails at the first
// differing character, which is exactly the signal a timing attack measures.)
function safeEqual(a, b){
  const A = Buffer.from(String(a || ''), 'utf8'), B = Buffer.from(String(b || ''), 'utf8');
  if (A.length !== B.length || !A.length) return false;
  return crypto.timingSafeEqual(A, B);
}
function findApiKey(db, key){ return key ? db.apiKeys.find(k => safeEqual(k.key, key)) : null; }
function auth(req,res,next){
  const presented = req.headers['x-api-key'] || (req.query && req.query.apikey);
  if (presented) {
    const db = loadDB();
    const k = findApiKey(db, String(presented));
    if (k) {
      // throttle lastUsed writes to ~once/min to avoid hammering the disk
      const now = Date.now();
      if (!k.lastUsedAt || now - new Date(k.lastUsedAt).getTime() > 60000) { k.lastUsedAt = new Date().toISOString(); saveDB(db); }
      req.user = { id: 0, username: 'apikey:' + k.name, role: 'admin', viaApiKey: true };
      return next();
    }
    return res.status(401).json({ error: 'Invalid API key' });
  }
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  let claims;
  try { claims = jwt.verify(token, JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Unauthorized' }); }
  // A token proves you signed in once — it is NOT a standing grant. Re-resolve the
  // account on every call so deletions, role changes and revocations take effect
  // immediately. (Previously the claims were trusted as-is for the token's whole
  // 365-day life: a deleted user could keep using the API, and an admin demoted to
  // 'user' kept full admin rights — including the ability to mint a new admin.)
  const db = loadDB();
  const u = db.users.find(x => x.id === claims.id);
  if (!u) return res.status(401).json({ error: 'Session no longer valid — sign in again' });
  if ((u.tokenVersion || 0) !== (claims.tv || 0)) return res.status(401).json({ error: 'Session expired — sign in again' });
  req.user = { id: u.id, username: u.username, role: u.role };
  next();
}
// Issue a session token bound to the account's current revocation counter.
function issueToken(u){
  return jwt.sign({ id: u.id, username: u.username, role: u.role, tv: u.tokenVersion || 0 }, JWT_SECRET, { expiresIn: JWT_TTL });
}
function adminOnly(req,res,next){ return req.user && req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Forbidden' }); }

// ── Proxy trust ──────────────────────────────────────────────────────────────
// Behind a reverse proxy we must read the client IP from X-Forwarded-For, or every
// visitor looks like the proxy and shares one rate-limit bucket. But trusting that
// header when NOT behind a proxy lets any caller invent an IP per request and slip
// the limiter entirely — so this is configurable, and the per-account login lockout
// below is the real brute-force defence either way.
//   TRUST_PROXY=1      → one proxy in front (default; matches the shipped compose)
//   TRUST_PROXY=false  → direct exposure, ignore X-Forwarded-For
//   TRUST_PROXY=2      → two hops (e.g. Cloudflare → nginx → BookSeerr)
const TRUST_PROXY_RAW = String(process.env.TRUST_PROXY ?? '1').trim();
app.set('trust proxy',
  TRUST_PROXY_RAW === 'false' ? false :
  TRUST_PROXY_RAW === 'true'  ? true  :
  /^\d+$/.test(TRUST_PROXY_RAW) ? parseInt(TRUST_PROXY_RAW, 10) : TRUST_PROXY_RAW);

// Build the CSP. We never restrict who may embed us UNLESS FRAME_ANCESTORS is set;
// when it is, we add a `frame-ancestors` allowlist (helmet keeps X-Frame-Options off
// either way, since X-Frame-Options can't express an allowlist of multiple origins).
const cspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc:  ["'self'"],
  styleSrc:   ["'self'", "'unsafe-inline'"],
  imgSrc:     ["'self'", "data:", "https:", "http:"], // covers + Audible/Amazon art over http/https
  connectSrc: ["'self'"],
  objectSrc:  ["'none'"]
};
if (FRAME_ANCESTORS.length) {
  // Restrict embedding to the listed dashboards only.
  cspDirectives.frameAncestors = ["'self'", ...FRAME_ANCESTORS];
} else {
  // Embeddable ANYWHERE. helmet injects a default `frame-ancestors 'self'` into any
  // CSP, which would block cross-site dashboards — set it to null to drop the
  // directive entirely so no site is excluded.
  cspDirectives.frameAncestors = null;
}

app.use(helmet({
  contentSecurityPolicy: { directives: cspDirectives },
  // Allow BookSeerr to be embedded in an <iframe> on another site:
  frameguard: false,                                   // drop X-Frame-Options (DENY/SAMEORIGIN)
  crossOriginOpenerPolicy: false,                      // don't isolate the browsing context
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginEmbedderPolicy: false,                    // don't force COEP on embedders
  originAgentCluster: false,                           // avoid origin-keyed agent cluster surprises in frames
  referrerPolicy: { policy: 'same-origin' }
}));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// ── CORS (opt-in via CORS_ORIGINS) ────────────────────────────────────────────
// Lets a browser-based dashboard send the API key (X-Api-Key) cross-origin.
if (CORS_ORIGINS.length) {
  const allowAny = CORS_ORIGINS.includes('*');
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (allowAny || CORS_ORIGINS.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', allowAny ? '*' : origin);
      if (!allowAny) res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
}

app.use(express.static(path.join(__dirname, 'public')));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many login attempts — try again in 15 minutes.' } });
const apiLimiter   = rateLimit({ windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false, message: { error: 'Rate limit exceeded.' } });
app.use('/api/', apiLimiter);

// ── Health check (unauthenticated, cheap) — used by Docker HEALTHCHECK ─────────
// Deliberately outside /api/ so it isn't counted against the API rate limiter.
app.get('/healthz', (req,res)=>res.json({ ok: true, app: 'BookSeerr', version: APP_VERSION }));

// ── Auth / current user ──────────────────────────────────────────────────────
// ── Per-account login lockout ────────────────────────────────────────────────
// The IP rate limiter alone is not enough: anyone able to set X-Forwarded-For (or
// simply using a handful of addresses) gets a fresh bucket per request. Counting
// failures against the ACCOUNT instead makes password guessing hopeless no matter
// where the attempts come from. A correct password clears the counter instantly,
// so a legitimate user who mistypes a few times is never stuck for long.
const LOGIN_MAX_FAILS = parseInt(process.env.LOGIN_MAX_FAILS || '10', 10);
const LOGIN_LOCK_MS = parseInt(process.env.LOGIN_LOCK_MINUTES || '15', 10) * 60 * 1000;
// Hashing a throwaway password costs the same as checking a real one. Comparing
// against this when the account doesn't exist keeps the response time flat —
// otherwise "no such user" returns in ~4ms while a real user costs ~230ms of bcrypt,
// which is a reliable oracle for harvesting valid usernames.
const DUMMY_HASH = bcrypt.hashSync('bookseerr-timing-equaliser', 10);
// Failed-attempt counters live in memory for EVERY username — real or not.
//
// Two reasons this isn't stored in db.json:
//   1. Symmetry. If real accounts were tracked on disk and unknown ones in memory,
//      the two paths do measurably different work: persisting a failure costs an
//      fsync'd write that a non-existent account never pays. Measured, that gap was
//      ~55ms of clean separation — a reliable oracle for harvesting valid usernames.
//      Identical code paths are the only way to make the two genuinely
//      indistinguishable, in wording, status code AND timing.
//   2. It keeps disk I/O out of the authentication path entirely, so a burst of
//      failed logins can't be used to hammer the disk.
// Throttling state is ephemeral by nature; losing it on restart is fine, and an
// attacker has no way to restart the server. The map is bounded so it can't be
// grown into a memory-exhaustion vector.
const loginFails = new Map();   // username → { n, until }
const LOGIN_FAILS_MAX_KEYS = 5000;
const lockMessage = (until) => {
  const mins = Math.max(1, Math.ceil((until - Date.now()) / 60000));
  return 'Too many failed sign-in attempts — try again in ' + mins + ' minute' + (mins > 1 ? 's' : '') + '.';
};
function loginLockedUntil(name){ const e = loginFails.get(name); return e && Date.now() < e.until ? e.until : 0; }
function recordLoginFailure(name){
  const e = loginFails.get(name) || { n: 0, until: 0 };
  e.n += 1;
  if (e.n >= LOGIN_MAX_FAILS) { e.until = Date.now() + LOGIN_LOCK_MS; e.n = 0; }
  if (loginFails.size > LOGIN_FAILS_MAX_KEYS && !loginFails.has(name)) loginFails.clear();
  loginFails.set(name, e);
}
app.post('/api/auth/login', loginLimiter, async (req,res)=>{
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const name = String(username).slice(0, 128);

  // Identical shape for existing and non-existent accounts, in this exact order:
  // lockout check → one bcrypt compare → same response. Nothing below branches on
  // whether the account exists except which hash is compared.
  const until = loginLockedUntil(name);
  if (until) return res.status(429).json({ error: lockMessage(until) });

  const db = loadDB();
  const u = db.users.find(x => x.username === username);
  const hash = (u && u.passwordHash) ? u.passwordHash : DUMMY_HASH;
  const match = await bcrypt.compare(String(password), hash);
  const ok = !!(u && u.passwordHash && match);

  if (!ok) {
    recordLoginFailure(name);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  loginFails.delete(name);   // a correct password clears the throttle immediately
  const fresh = mutate(db2 => {
    const uu = db2.users.find(x => x.id === u.id);
    if (!uu) return null;
    // Drop the counters older builds persisted here; they're in-memory now.
    delete uu.failedLogins; delete uu.lockedUntil;
    uu.lastLoginAt = new Date().toISOString();
    return { id: uu.id, username: uu.username, role: uu.role, tokenVersion: uu.tokenVersion || 0 };
  });
  if (!fresh) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ token: issueToken(fresh), username: fresh.username, role: fresh.role });
});
app.get('/api/me', auth, (req,res)=>{
  if (req.user.viaApiKey) return res.json({ id: 0, username: req.user.username, role: 'admin', canRequest: true, limit: 999, requests: 0, autoApprove: 'on', autoApproved: true });
  const db = loadDBDaily(); const u = db.users.find(x => x.id === req.user.id); if (!u) return res.status(404).json({ error: 'Not found' });
  // autoApproved = the EFFECTIVE result (override + global + role), so the UI can
  // say "Submit for approval" instead of "Send" when requests will be held.
  res.json({ id: u.id, username: u.username, role: u.role, canRequest: u.canRequest, limit: u.limit, requests: u.requests, lastSeenRequestId: u.lastSeenRequestId || 0, autoApprove: u.autoApprove || 'default', autoApproved: isAutoApproved(db, u) });
});

// ── Notifications (server-side, so "seen" syncs across every browser/phone) ───
// The old build tracked the last-seen request id in localStorage, which is
// per-browser — so checking notifications on your phone never cleared them on
// your desktop. The marker now lives on the user record in db.json:
//   GET  /api/notifications        → { lastSeenRequestId, latestRequestId, unseen, items }
//   POST /api/notifications/seen   → marks everything (or a given id) as seen, everywhere
// "Unseen" counts requests from OTHER users (your own submissions don't ping you).
app.get('/api/notifications', auth, (req,res)=>{
  if (req.user.viaApiKey) return res.json({ lastSeenRequestId: 0, latestRequestId: 0, unseen: 0, items: [] });
  const db = loadDB();
  const u = db.users.find(x => x.id === req.user.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  const latest = db.requests.reduce((m,r)=>Math.max(m, r.id||0), 0);
  if (u.role !== 'admin') return res.json({ lastSeenRequestId: u.lastSeenRequestId || 0, latestRequestId: latest, unseen: 0, pending: 0, items: [] });
  const seen = u.lastSeenRequestId || 0;
  const fresh = db.requests
    .filter(r => (r.id||0) > seen && r.userId !== u.id)
    .sort((a,b)=>(b.id||0)-(a.id||0));
  res.json({
    lastSeenRequestId: seen,
    latestRequestId: latest,
    unseen: fresh.length,
    // Pending is ACTIONABLE (needs an approve/reject), so it's reported separately —
    // the badge shows it even after the requests were "seen".
    pending: db.requests.filter(r => r.status === 'pending').length,
    items: fresh.slice(0, 5).map(r => ({ id: r.id, kind: r.kind, title: r.title || r.author || '', author: r.author || '', username: r.username || '', status: r.status, createdAt: r.createdAt }))
  });
});
app.post('/api/notifications/seen', auth, (req,res)=>{
  if (req.user.viaApiKey) return res.status(403).json({ error: 'API keys have no notification state' });
  const upTo = Number((req.body || {}).lastSeenRequestId);
  const out = mutate(db => {
    const u = db.users.find(x => x.id === req.user.id);
    if (!u) return null;
    const latest = db.requests.reduce((m,r)=>Math.max(m, r.id||0), 0);
    // Monotonic: a stale tab can never move the marker backwards.
    const target = Number.isFinite(upTo) && upTo > 0 ? Math.min(upTo, latest) : latest;
    u.lastSeenRequestId = Math.max(u.lastSeenRequestId || 0, target);
    return u.lastSeenRequestId;
  });
  if (out === null) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true, lastSeenRequestId: out });
});

// ── Change your own password (any logged-in user, including admins) ───────────
// Verifies the current password first. API-key callers can't change a password.
app.post('/api/account/password', auth, async (req,res)=>{
  if (req.user.viaApiKey) return res.status(403).json({ error: 'API keys cannot change account passwords' });
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password are required' });
  if (String(newPassword).length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  const existing = loadDB().users.find(x => x.id === req.user.id);
  if (!existing || !existing.passwordHash) return res.status(404).json({ error: 'Account not found' });
  if (!(await bcrypt.compare(String(currentPassword), existing.passwordHash))) return res.status(401).json({ error: 'Current password is incorrect' });
  const newHash = bcrypt.hashSync(String(newPassword), 10);
  // Persist against the freshest db (bcrypt above is async) so a concurrent admin
  // write isn't clobbered by a stale snapshot. Bumping tokenVersion signs out every
  // OTHER device holding a token minted with the old password — the whole point of
  // changing it — and we hand this caller a replacement token so they stay signed in.
  const fresh = mutate(db => {
    const u = db.users.find(x => x.id === req.user.id);
    if (!u) return null;
    u.passwordHash = newHash;
    u.tokenVersion = (u.tokenVersion || 0) + 1;
    return { id: u.id, username: u.username, role: u.role, tokenVersion: u.tokenVersion };
  });
  if (!fresh) return res.status(404).json({ error: 'Account not found' });
  res.json({ ok: true, token: issueToken(fresh) });
});

// Revoke every session for this account (including this one's old token) and hand
// back a fresh token for the current device. Use it if a phone is lost or a token
// may have leaked — there was previously no way to invalidate a token before its
// 365-day expiry short of changing the JWT secret and signing EVERYONE out.
app.post('/api/account/logout-all', auth, (req,res)=>{
  if (req.user.viaApiKey) return res.status(403).json({ error: 'API keys have no sessions — revoke the key instead' });
  const fresh = mutate(db => {
    const u = db.users.find(x => x.id === req.user.id);
    if (!u) return null;
    u.tokenVersion = (u.tokenVersion || 0) + 1;
    return { id: u.id, username: u.username, role: u.role, tokenVersion: u.tokenVersion };
  });
  if (!fresh) return res.status(404).json({ error: 'Account not found' });
  res.json({ ok: true, token: issueToken(fresh) });
});
function publicUser(u){ return { id: u.id, username: u.username, role: u.role, canRequest: u.canRequest, limit: u.limit, requests: u.requests, autoApprove: u.autoApprove || 'default', lastLoginAt: u.lastLoginAt || null, locked: !!loginLockedUntil(u.username) }; }
app.get('/api/users', auth, adminOnly, (req,res)=>{ const db = loadDBDaily(); res.json(db.users.map(publicUser)); });
// Same floor the self-service password change enforces — an admin-created account
// was previously allowed a 1-character password.
const PASSWORD_MIN = 6;
const normUsername = (s) => String(s == null ? '' : s).trim();
// API-key callers carry admin scope so dashboards can read stats and submit requests,
// but they must not be able to ESCALATE. Without this, a leaked key could create its
// own admin account, sign in as that admin, and walk straight past noApiKeyCallers to
// read the stored Chaptarr/Listenarr keys — defeating the whole point of that guard.
function noApiKeyPrivilegeChange(req,res,next){
  if (!req.user || !req.user.viaApiKey) return next();
  const role = (req.body || {}).role;
  if (role === 'admin') return res.status(403).json({ error: 'API keys cannot create or promote admin accounts — use a signed-in admin' });
  next();
}
app.post('/api/users', auth, adminOnly, noApiKeyPrivilegeChange, (req,res)=>{
  const { username, password, role, limit, canRequest, autoApprove } = req.body || {};
  const name = normUsername(username);
  if (!name || !password) return res.status(400).json({ error: 'Username and password required' });
  if (role !== undefined && role !== 'admin' && role !== 'user') return res.status(400).json({ error: 'role must be "admin" or "user"' });
  if (String(password).length < PASSWORD_MIN) return res.status(400).json({ error: 'Password must be at least ' + PASSWORD_MIN + ' characters' });
  const db = loadDB();
  // Case-insensitive: "Brad" and "brad" as separate accounts is a footgun, not a feature.
  if (db.users.find(u => u.username.toLowerCase() === name.toLowerCase())) return res.status(400).json({ error: 'User already exists' });
  const u = { id: db.settings.nextUserId++, username: name, passwordHash: bcrypt.hashSync(String(password), 10), role: role === 'admin' ? 'admin' : 'user', limit: Number(limit) || 10, canRequest: canRequest !== false, autoApprove: AA_VALUES.includes(autoApprove) ? autoApprove : 'default', requests: 0, tokenVersion: 0, failedLogins: 0 };
  db.users.push(u); saveDB(db);
  res.json(publicUser(u));
});
app.patch('/api/users/:id', auth, adminOnly, noApiKeyPrivilegeChange, (req,res)=>{
  const db = loadDB();
  const u = db.users.find(x => x.id === Number(req.params.id));
  if (!u) return res.status(404).json({ error: 'Not found' });
  // An API key must not be able to seize an existing admin account either (e.g. by
  // resetting its password and signing in as it).
  if (req.user.viaApiKey && u.role === 'admin') return res.status(403).json({ error: 'API keys cannot modify admin accounts' });
  const { username, password, role, limit, canRequest, autoApprove } = req.body || {};

  // ── Validate EVERYTHING before mutating ──
  // The old order applied the username/password first and only then checked the
  // last-admin rule, leaving a half-applied user object behind on rejection.
  const name = username !== undefined ? normUsername(username) : null;
  if (name !== null) {
    if (!name) return res.status(400).json({ error: 'Username cannot be empty' });
    // Renaming onto an existing name used to be allowed, producing two accounts with
    // the same username — after which sign-in silently resolved to whichever came first.
    if (db.users.some(x => x.id !== u.id && x.username.toLowerCase() === name.toLowerCase()))
      return res.status(400).json({ error: 'Another user already has that username' });
  }
  if (password !== undefined && password !== '' && String(password).length < PASSWORD_MIN)
    return res.status(400).json({ error: 'Password must be at least ' + PASSWORD_MIN + ' characters' });
  // Validate the role STRICTLY, and check the last-admin rule against the role we
  // will actually store. The old guard compared the raw input to 'user', but the
  // assignment coerced anything that wasn't 'admin' down to 'user' — so PATCHing
  // {role:"member"} skipped the check and still demoted, and demoting the only
  // admin left the install with ZERO admins and no way to create one.
  if (role !== undefined && role !== 'admin' && role !== 'user')
    return res.status(400).json({ error: 'role must be "admin" or "user"' });
  const nextRole = role !== undefined ? role : null;
  if (nextRole === 'user' && u.role === 'admin' && db.users.filter(x => x.role === 'admin').length === 1)
    return res.status(400).json({ error: 'Cannot demote the last admin' });

  // ── Apply ──
  // Renaming, changing the password, or dropping admin rights all invalidate the
  // account's existing tokens, so the change takes effect on every signed-in device
  // instead of only after the token would have expired.
  let revoke = false;
  if (name !== null && name !== u.username) { u.username = name; revoke = true; }
  if (password) { u.passwordHash = bcrypt.hashSync(String(password), 10); revoke = true; }
  if (nextRole) { if (nextRole !== u.role) revoke = true; u.role = nextRole; }
  if (limit !== undefined) u.limit = Number(limit) || 0;
  if (canRequest !== undefined) u.canRequest = !!canRequest;
  if (autoApprove !== undefined) u.autoApprove = AA_VALUES.includes(autoApprove) ? autoApprove : 'default';
  if (revoke) u.tokenVersion = (u.tokenVersion || 0) + 1;
  saveDB(db);
  res.json(publicUser(u));
});
app.delete('/api/users/:id', auth, adminOnly, (req,res)=>{
  const db = loadDB();
  const idx = db.users.findIndex(x => x.id === Number(req.params.id));
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  const target = db.users[idx];
  // Same escalation reasoning as PATCH: a service principal must not be able to
  // remove the humans who administer it.
  if (req.user.viaApiKey && target.role === 'admin') return res.status(403).json({ error: 'API keys cannot delete admin accounts' });
  // The old rule refused to delete ANY admin, so a second admin account could never
  // be removed at all. What actually needs protecting is the LAST admin (otherwise
  // nobody can administer the app) and your own account (locking yourself out).
  if (target.role === 'admin' && db.users.filter(x => x.role === 'admin').length === 1)
    return res.status(400).json({ error: 'Cannot delete the last admin' });
  if (!req.user.viaApiKey && target.id === req.user.id)
    return res.status(400).json({ error: 'You cannot delete your own account' });
  db.users.splice(idx,1); saveDB(db);
  res.json({ ok: true });
});

// ── BookSeerr API keys (admin) — let other programs connect to BookSeerr ──────
// API-key management is deliberately human-only (noApiKeyCallers). Letting a key
// list every other key in plaintext, mint new ones, or revoke them turns one leaked
// key into permanent, self-renewing access — and the list response is the one place
// keys are returned unmasked.
function publicKey(k){ return { id: k.id, name: k.name, key: k.key, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt || null }; }
app.get('/api/apikeys', auth, adminOnly, noApiKeyCallers, (req,res)=>{ const db = loadDB(); res.json(db.apiKeys.map(publicKey)); });
app.post('/api/apikeys', auth, adminOnly, noApiKeyCallers, (req,res)=>{
  const db = loadDB();
  const name = String((req.body && req.body.name) || '').trim() || ('key-' + db.settings.nextApiKeyId);
  const k = { id: db.settings.nextApiKeyId++, name, key: 'bsr_' + crypto.randomBytes(24).toString('hex'), createdAt: new Date().toISOString(), lastUsedAt: null };
  db.apiKeys.push(k); saveDB(db);
  res.json(publicKey(k));
});
app.delete('/api/apikeys/:id', auth, adminOnly, noApiKeyCallers, (req,res)=>{ const db = loadDB(); const idx = db.apiKeys.findIndex(k => k.id === Number(req.params.id)); if (idx < 0) return res.status(404).json({ error: 'Not found' }); db.apiKeys.splice(idx,1); saveDB(db); res.json({ ok: true }); });

// ── Integration settings (admin) — link Chaptarr & Listenarr from the UI ─────
// Saved in db.json (so they sync across every browser/phone and survive restarts)
// and take precedence over the .env values. Security:
//   • Only a signed-in ADMIN can read or change these — BookSeerr API keys are
//     refused, so a leaked key can't repoint your upstreams or read their keys.
//   • Upstream API keys are WRITE-ONLY: responses only ever show a masked tail
//     (••••1234), never the full key. Leave the key field blank to keep it.
//   • URLs must be http(s); no other schemes are accepted.
const SERVICES = ['chaptarr', 'listenarr'];
// Accept the old name from any client that hasn't been updated yet.
const SERVICE_ALIASES = { bookshelf: 'chaptarr' };
const normService = (s) => SERVICE_ALIASES[String(s || '').toLowerCase()] || String(s || '').toLowerCase();
function maskKey(k){ return k ? '••••••••' + String(k).slice(-4) : ''; }
function looksMasked(k){ return /[•*]/.test(String(k || '')); }
function normUrl(u){
  const s = String(u || '').trim();
  if (!s) return '';
  let parsed;
  try { parsed = new URL(s); } catch { return null; }               // null = invalid
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return s.replace(/\/+$/, '');
}
function integrationsView(){
  const ig = loadDB().settings.integrations || {};
  const view = (svc, envUrl, envKey) => {
    // Fall back to the pre-Chaptarr key so an existing saved config still shows.
    const o = ig[svc] || (svc === 'chaptarr' ? ig.bookshelf : null) || {};
    const url = o.url || envUrl || '';
    const key = o.apiKey || envKey || '';
    return {
      url,
      apiKeySet: !!key,
      apiKeyMasked: maskKey(key),
      source: (o.url || o.apiKey) ? 'app' : ((envUrl || envKey) ? 'env' : 'none')
    };
  };
  return {
    chaptarr: view('chaptarr', ENV_CHAPTARR_URL, ENV_CHAPTARR_KEY),
    listenarr: view('listenarr', ENV_LISTENARR_URL, ENV_LISTENARR_KEY)
  };
}
function noApiKeyCallers(req,res,next){
  if (req.user && req.user.viaApiKey) return res.status(403).json({ error: 'Integration settings require a signed-in admin (not an API key)' });
  next();
}
app.get('/api/admin/settings/integrations', auth, adminOnly, noApiKeyCallers, (req,res)=>{
  res.json(integrationsView());
});
app.put('/api/admin/settings/integrations', auth, adminOnly, noApiKeyCallers, (req,res)=>{
  const { url, apiKey, clear } = req.body || {};
  const service = normService((req.body || {}).service);
  if (!SERVICES.includes(service)) return res.status(400).json({ error: 'service must be "chaptarr" or "listenarr"' });
  if (clear) {
    // Drop the app-saved override → fall back to whatever .env provides. Clearing
    // chaptarr also drops any leftover pre-Chaptarr "bookshelf" block, otherwise the
    // migration fallback would quietly resurrect the old values.
    const db2 = mutate(db => {
      const ig = db.settings.integrations || {};
      delete ig[service];
      if (service === 'chaptarr') delete ig.bookshelf;
      return db;
    });
    refreshIntegrations(db2);
    return res.json({ ok: true, ...integrationsView() });
  }
  const cleanUrl = normUrl(url);
  if (cleanUrl === null) return res.status(400).json({ error: 'URL must be a valid http:// or https:// address' });
  const keyStr = String(apiKey || '').trim();
  const db2 = mutate(db => {
    const ig = db.settings.integrations = db.settings.integrations || {};
    const cur = ig[service] || (service === 'chaptarr' ? ig.bookshelf : null) || {};
    ig[service] = {
      url: cleanUrl || cur.url || '',
      // Blank or masked key input = keep whatever is already stored.
      apiKey: (keyStr && !looksMasked(keyStr)) ? keyStr : (cur.apiKey || '')
    };
    // Once saved under the new name, retire the old one so there is a single source.
    if (service === 'chaptarr') delete ig.bookshelf;
    return db;
  });
  refreshIntegrations(db2);
  res.json({ ok: true, ...integrationsView() });
});
// Test a connection — with the values in the form (unsaved), the stored ones, or
// a mix (blank/masked fields fall back to what's currently in effect).
app.post('/api/admin/settings/integrations/test', auth, adminOnly, noApiKeyCallers, async (req,res)=>{
  const { url, apiKey } = req.body || {};
  const service = normService((req.body || {}).service);
  if (!SERVICES.includes(service)) return res.status(400).json({ error: 'service must be "chaptarr" or "listenarr"' });
  const cleanUrl = normUrl(url);
  if (cleanUrl === null) return res.status(400).json({ error: 'URL must be a valid http:// or https:// address' });
  const keyStr = String(apiKey || '').trim();
  const storedUrl = service === 'chaptarr' ? CFG.chaptarrUrl : CFG.listenarrUrl;
  const storedKey = service === 'chaptarr' ? CFG.chaptarrKey : CFG.listenarrKey;
  const testUrl = cleanUrl || storedUrl;
  const suppliedKey = (keyStr && !looksMasked(keyStr)) ? keyStr : '';
  // The stored upstream key is only ever sent to the address it belongs to.
  // Previously a blank/masked key field fell back to the REAL saved key and shipped
  // it as X-Api-Key to whatever URL was in the request body — so "Test" against an
  // attacker-controlled host handed over the live Chaptarr/Listenarr key in plaintext,
  // defeating the write-only-key design. To test a different address you must now
  // supply the key that goes with it.
  const sameTarget = !!storedUrl && testUrl === storedUrl;
  const testKey = suppliedKey || (sameTarget ? storedKey : '');
  if (!testUrl) return res.json({ connected: false, error: 'URL and API key are required' });
  if (!testKey) return res.json({ connected: false, error: sameTarget
    ? 'URL and API key are required'
    : 'Enter the API key for this URL — the saved key is only used to test the saved address.' });
  const infoPath = service === 'chaptarr' ? '/api/v1/system/status' : '/api/v1/system/info';
  try {
    // No retries — "Test connection" should tell the admin what's actually happening
    // right now, not paper over a flaky service with a second attempt.
    const r = await requestJson(testUrl + infoPath, 'GET', null, { 'X-Api-Key': testKey }, 5000, 0);
    // Same trap as the health probe: an unknown /api path on Listenarr returns the
    // SPA page with a 200, which would read as a successful test.
    if (r.status >= 200 && r.status < 300 && (!r.data || typeof r.data !== 'object')) {
      return res.json({ connected: false, error: 'That address answered, but not with the ' + (service === 'chaptarr' ? 'Chaptarr' : 'Listenarr') + ' API — check the URL and port.' });
    }
    if (r.status >= 200 && r.status < 300) {
      const v = r.data && (r.data.version || r.data.appVersion || r.data.listenarrVersion);
      return res.json({ connected: true, version: v || null, appName: (r.data && r.data.appName) || (service === 'chaptarr' ? 'Chaptarr' : 'Listenarr') });
    }
    if (r.status === 401) return res.json({ connected: false, error: 'Bad API key (401)' });
    return res.json({ connected: false, error: 'Unexpected status ' + r.status });
  } catch (e) { res.json({ connected: false, error: e.message }); }
});

// ── Approval settings (admin) — the global auto-approve toggle ────────────────
// Per-user overrides live on the user record (PATCH /api/users/:id { autoApprove }).
// Unlike integration settings there are no secrets here, so API-key callers (which
// have admin scope) may read/change it too — e.g. from a dashboard.
app.get('/api/admin/settings/approvals', auth, adminOnly, (req,res)=>{
  res.json(approvalsSettings(loadDB()));
});
app.put('/api/admin/settings/approvals', auth, adminOnly, (req,res)=>{
  const { autoApproveAll } = req.body || {};
  if (typeof autoApproveAll !== 'boolean') return res.status(400).json({ error: 'autoApproveAll must be true or false' });
  const out = mutate(db => { db.settings.approvals = db.settings.approvals || {}; db.settings.approvals.autoApproveAll = autoApproveAll; return approvalsSettings(db); });
  res.json({ ok: true, ...out });
});

// ── Outbound notifications (Discord / generic webhook) ───────────────────────
// Posts to a webhook when a request is submitted, approved, rejected or fails, so
// admins learn about pending approvals without keeping a tab open.
//
// The webhook URL is treated as a SECRET — a Discord webhook URL embeds a token
// that lets anyone post to the channel — so it's stored like the upstream API keys:
// signed-in admins only (never an API key), and only ever echoed back masked.
const NOTIFY_EVENTS = ['submitted', 'approved', 'rejected', 'error'];
function notificationsSettings(db){
  const n = ((db || loadDB()).settings || {}).notifications || {};
  const ev = n.events || {};
  return {
    enabled: !!n.enabled,
    url: String(n.url || ''),
    // Default every event on; an explicit false turns one off.
    events: NOTIFY_EVENTS.reduce((a, e) => { a[e] = ev[e] !== false; return a; }, {})
  };
}
function maskUrl(u){
  if (!u) return '';
  try { const p = new URL(u); return p.origin + '/…' + String(u).slice(-4); }
  catch { return '••••' + String(u).slice(-4); }
}
function notificationsView(db){
  const s = notificationsSettings(db);
  return { enabled: s.enabled, urlSet: !!s.url, urlMasked: maskUrl(s.url), events: s.events, supportedEvents: NOTIFY_EVENTS };
}

const EVENT_TITLE = { submitted: 'New request', approved: 'Request approved', rejected: 'Request rejected', error: 'Request failed' };
const EVENT_COLOR = { submitted: 0xf59e0b, approved: 0x22c55e, rejected: 0xef4444, error: 0xef4444 };
const kindWord = k => k === 'audio' ? 'Audiobook' : k === 'author' ? 'Author' : 'eBook';
function isDiscordWebhook(u){
  try { const h = new URL(u).hostname.toLowerCase(); return h === 'discord.com' || h === 'discordapp.com' || h.endsWith('.discord.com'); }
  catch { return false; }
}
function buildWebhookBody(url, event, rec, note){
  const dest = destOf(rec);
  const title = rec.title || rec.author || 'Untitled';
  if (isDiscordWebhook(url)) {
    const fields = [
      { name: 'Requested by', value: String(rec.username || 'unknown'), inline: true },
      { name: 'Type', value: kindWord(rec.kind), inline: true },
      { name: 'Destination', value: dest === 'listenarr' ? 'Listenarr' : 'Chaptarr', inline: true }
    ];
    if (rec.author && rec.kind !== 'author') fields.push({ name: 'Author', value: String(rec.author).slice(0, 200), inline: true });
    if (rec.status) fields.push({ name: 'Status', value: String(rec.status), inline: true });
    const embed = {
      title: (EVENT_TITLE[event] || 'Request update') + ': ' + String(title).slice(0, 200),
      description: String(note || rec.message || '').slice(0, 500) || undefined,
      color: EVENT_COLOR[event] || 0x7c3aed,
      fields,
      footer: { text: 'BookSeerr v' + APP_VERSION },
      timestamp: rec.createdAt || new Date().toISOString()
    };
    // Discord only renders https images; an http cover would just break the embed.
    if (rec.image && /^https:\/\//i.test(rec.image)) embed.thumbnail = { url: rec.image };
    return { username: 'BookSeerr', embeds: [embed] };
  }
  // Generic receiver — a flat, predictable JSON shape.
  return {
    app: 'BookSeerr', version: APP_VERSION, event, at: new Date().toISOString(),
    request: { id: rec.id, kind: rec.kind, title: rec.title || '', author: rec.author || '', username: rec.username || '', status: rec.status, destination: dest, message: note || rec.message || '', createdAt: rec.createdAt }
  };
}
async function fireWebhook(event, rec, note){
  let s;
  try { s = notificationsSettings(loadDB()); } catch { return; }
  if (!s.enabled || !s.url || !s.events[event]) return;
  try {
    // retries=0: a POST is never auto-retried, so a slow Discord can't produce
    // duplicate messages in the channel.
    const r = await requestJson(s.url, 'POST', buildWebhookBody(s.url, event, rec, note), {}, 5000, 0);
    if (r.status >= 400) console.warn('[BookSeerr] webhook returned ' + r.status);
  } catch (e) { console.warn('[BookSeerr] webhook failed: ' + e.message); }
}
// Fire-and-forget. A notification must never delay a user's request or turn a
// successful download hand-off into a visible error because Discord was down.
function notify(event, rec, note){ setImmediate(() => { fireWebhook(event, rec, note).catch(() => {}); }); }

app.get('/api/admin/settings/notifications', auth, adminOnly, noApiKeyCallers, (req,res)=>{
  res.json(notificationsView(loadDB()));
});
app.put('/api/admin/settings/notifications', auth, adminOnly, noApiKeyCallers, (req,res)=>{
  const { enabled, url, events, clear } = req.body || {};
  if (clear) {
    const db2 = mutate(db => { delete db.settings.notifications; return db; });
    return res.json({ ok: true, ...notificationsView(db2) });
  }
  const cleanUrl = normUrl(url);
  if (cleanUrl === null) return res.status(400).json({ error: 'Webhook URL must be a valid http:// or https:// address' });
  const db2 = mutate(db => {
    const cur = db.settings.notifications || {};
    const nextEvents = Object.assign({}, cur.events || {});
    if (events && typeof events === 'object') for (const e of NOTIFY_EVENTS) if (events[e] !== undefined) nextEvents[e] = !!events[e];
    db.settings.notifications = {
      // Blank or masked input keeps the stored URL, same rule as the API-key fields.
      url: (cleanUrl && !/[•…]/.test(String(url))) ? cleanUrl : (cur.url || ''),
      enabled: enabled !== undefined ? !!enabled : !!cur.enabled,
      events: nextEvents
    };
    return db;
  });
  res.json({ ok: true, ...notificationsView(db2) });
});
app.post('/api/admin/settings/notifications/test', auth, adminOnly, noApiKeyCallers, async (req,res)=>{
  const { url } = req.body || {};
  const cleanUrl = normUrl(url);
  if (cleanUrl === null) return res.status(400).json({ error: 'Webhook URL must be a valid http:// or https:// address' });
  const stored = notificationsSettings(loadDB());
  const target = (cleanUrl && !/[•…]/.test(String(url))) ? cleanUrl : stored.url;
  if (!target) return res.json({ ok: false, error: 'Enter a webhook URL first' });
  const sample = { id: 0, kind: 'book', title: 'The Hitchhiker\'s Guide to the Galaxy', author: 'Douglas Adams', username: req.user.username, status: 'sent', destination: 'chaptarr', message: 'This is a BookSeerr test notification.', createdAt: new Date().toISOString() };
  try {
    const r = await requestJson(target, 'POST', buildWebhookBody(target, 'submitted', sample, 'This is a BookSeerr test notification.'), {}, 5000, 0);
    if (r.status >= 200 && r.status < 300) return res.json({ ok: true, status: r.status, flavour: isDiscordWebhook(target) ? 'Discord' : 'generic' });
    return res.json({ ok: false, error: 'Webhook returned status ' + r.status });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ── Duplicate-request detection ──────────────────────────────────────────────
// "Is it in the library?" and "has somebody already asked for it?" are different
// questions. A title requested an hour ago isn't downloaded yet, so the library
// check says no — and a second user happily requests it again. This finds an
// existing request that is still pending or already sent, so the UI can say
// "Brad requested this 2 days ago" before anyone duplicates the work.
const ACTIVE_REQUEST_STATUSES = ['pending', 'sent'];
function findExistingRequest(db, item){
  const kind = String(item.kind || 'book').toLowerCase();
  const asin = String(item.asin || '').trim().toLowerCase();
  const titleN = norm(item.title || '');
  const authorN = norm(String(item.author || '').split(',')[0]);
  const hits = (db.requests || []).filter(r => {
    if (!ACTIVE_REQUEST_STATUSES.includes(r.status)) return false;
    const rk = String(r.kind || 'book').toLowerCase();
    if (kind === 'audio') {
      if (rk !== 'audio') return false;
      if (asin && r.asin && String(r.asin).toLowerCase() === asin) return true;
      return !!titleN && norm(r.title) === titleN;
    }
    if (kind === 'author') {
      if (rk !== 'author') return false;
      const want = norm(item.author || item.title || '');
      return !!want && (norm(r.author) === want || norm(r.title) === want);
    }
    // eBook: the title must match AND the authors must agree.
    // Falling back to title-only whenever either side lacked an author produced
    // confident false positives on common one-word titles — Google Books results
    // frequently have no `authors`, so requesting Marilynne Robinson's "Home" would
    // report "already requested by …" pointing at an unrelated book also called
    // "Home". Requiring both sides to name an author (or neither to) trades a few
    // missed warnings for not lying about the ones it does show.
    if (rk === 'audio') return false;
    if (!titleN || norm(r.title) !== titleN) return false;
    const rAuthorN = norm(String(r.author || '').split(',')[0]);
    if (!authorN && !rAuthorN) return true;      // neither names an author — title is all we have
    return !!authorN && !!rAuthorN && rAuthorN === authorN;
  });
  if (!hits.length) return null;
  hits.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return summariseRequest(hits[0]);
}
function summariseRequest(r){
  return { id: r.id, username: r.username || '', status: r.status, createdAt: r.createdAt || '', title: r.title || r.author || '' };
}

// Indexed form of findExistingRequest for batch use: build the lookup tables ONCE
// per request instead of rescanning (and re-normalising) every stored request for
// every item on the page. The keys below encode exactly the same matching rules the
// single-item path applies, so both endpoints always agree.
function requestMatchKeys(kind, title, author, asin){
  const titleN = norm(title || '');
  const authorN = norm(String(author || '').split(',')[0]);
  if (kind === 'audio') {
    const keys = [];
    if (asin) keys.push('audio:asin:' + String(asin).trim().toLowerCase());
    if (titleN) keys.push('audio:title:' + titleN);
    return keys;
  }
  if (kind === 'author') {
    const want = norm(author || title || '');
    return want ? ['author:' + want] : [];
  }
  if (!titleN) return [];
  // Authors must agree, or neither side may name one (see findExistingRequest).
  return [authorN ? 'book:' + titleN + '|' + authorN : 'book:' + titleN + '|'];
}
function buildRequestIndex(db){
  const idx = new Map();
  const add = (key, r) => {
    const cur = idx.get(key);
    // Keep the newest match, matching the single-item path's sort.
    if (!cur || String(r.createdAt || '') > String(cur.createdAt || '')) idx.set(key, r);
  };
  for (const r of (db.requests || [])) {
    if (!ACTIVE_REQUEST_STATUSES.includes(r.status)) continue;
    const rk = String(r.kind || 'book').toLowerCase();
    if (rk === 'audio') {
      for (const k of requestMatchKeys('audio', r.title, r.author, r.asin)) add(k, r);
      continue;
    }
    // The scan's eBook branch excludes only `audio`, so an 'author' record can also
    // satisfy a book-kind query. Indexing author records under author keys ALONE
    // silently lost those matches — caught by the differential test against the scan.
    for (const k of requestMatchKeys('book', r.title, r.author, r.asin)) add(k, r);
    if (rk === 'author') {
      for (const k of requestMatchKeys('author', r.title, r.author, r.asin)) add(k, r);
      const t = norm(r.title || ''); if (t) add('author:' + t, r);   // author rows match on title too
    }
  }
  return idx;
}
function lookupExistingRequest(idx, item){
  const kind = String(item.kind || 'book').toLowerCase();
  let best = null;
  // Check every key an item can match on (an audiobook matches by ASIN *or* title)
  // and keep the newest, so the batch answer is identical to the scan-based one
  // rather than "whichever key happened to be tried first".
  for (const k of requestMatchKeys(kind, item.title, item.author, item.asin)) {
    const hit = idx.get(k);
    if (hit && (!best || String(hit.createdAt || '') > String(best.createdAt || ''))) best = hit;
  }
  return best ? summariseRequest(best) : null;
}

// ── Requests ──────────────────────────────────────────────────────────────────
// Supports optional filtering for dashboards (all params are AND-combined):
//   ?status=sent|pending|error    ?kind=audio|book|author
//   ?destination=listenarr|chaptarr
//   ?user=<username or id>         (admins only; ignored for normal users)
//   ?q=<text>                      (matches title / author / username, case-insensitive)
//   ?since=YYYY-MM-DD              (createdAt on/after this date)
//   ?until=YYYY-MM-DD              (createdAt on/before this date, inclusive)
//   ?limit=<n>&offset=<n>          (paging; newest first when any filter/paging is used)
// With no params the response is unchanged (full list) for backward compatibility.
app.get('/api/requests', auth, (req,res)=>{
  const db = loadDB();
  let list = req.user.role === 'admin' ? db.requests : db.requests.filter(r => r.userId === req.user.id);

  const q = String(req.query.q || '').trim().toLowerCase();
  const status = String(req.query.status || '').trim().toLowerCase();
  const kind = String(req.query.kind || '').trim().toLowerCase();
  const destination = String(req.query.destination || '').trim().toLowerCase();
  const user = String(req.query.user || '').trim().toLowerCase();
  const since = String(req.query.since || '').trim();
  const until = String(req.query.until || '').trim();
  const hasFilter = q || status || kind || destination || user || since || until ||
                    req.query.limit != null || req.query.offset != null;

  if (status) list = list.filter(r => String(r.status || '').toLowerCase() === status);
  if (kind) list = list.filter(r => String(r.kind || '').toLowerCase() === kind);
  if (destination) { const want = destination === 'bookshelf' ? 'chaptarr' : destination; list = list.filter(r => destOf(r) === want); }
  if (user && req.user.role === 'admin') list = list.filter(r => String(r.username || '').toLowerCase() === user || String(r.userId) === user);
  if (since) list = list.filter(r => String(r.createdAt || '').slice(0, 10) >= since);
  if (until) list = list.filter(r => String(r.createdAt || '').slice(0, 10) <= until);
  if (q) list = list.filter(r => (String(r.title || '') + ' ' + String(r.author || '') + ' ' + String(r.username || '')).toLowerCase().includes(q));

  if (hasFilter) {
    // Newest first, with paging, when the caller is actively querying.
    list = list.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    const total = list.length;
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const limit = req.query.limit != null ? Math.max(0, parseInt(req.query.limit, 10) || 0) : 0;
    if (offset) list = list.slice(offset);
    if (limit) list = list.slice(0, limit);
    res.setHeader('X-Total-Count', String(total));
  }
  res.json(list);
});
app.delete('/api/requests/:id', auth, (req,res)=>{
  const reqId = Number(req.params.id);
  if (sendingRequests.has(reqId)) return res.status(409).json({ error: 'This request is being sent right now — try again in a moment.' });
  const db = loadDB();
  const idx = db.requests.findIndex(r => r.id === reqId && (req.user.role === 'admin' || r.userId === req.user.id));
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  const rec = db.requests[idx];
  // Discarding a request that never reached the downloader gives the slot back.
  // 'error' counts as well as 'pending': the request failed, nothing was downloaded,
  // and charging the user for it (with no way to reclaim it) was simply a bug.
  if (rec.status === 'pending' || rec.status === 'error') refundDailySlot(db, rec);
  db.requests.splice(idx,1);
  saveDB(db);
  res.json({ ok: true });
});

// ── Chaptarr profile/folder options for the eBook request modal ────
// Chaptarr manages BOTH eBooks and audiobooks, so its profiles and root folders are
// typed. BookSeerr only drives the eBook half (audiobooks go to Listenarr), so the
// audiobook-typed entries are filtered out — offering them would let someone file an
// eBook request against an audiobook profile or folder, which Chaptarr would then
// either reject or file in the wrong library. Verified against Chaptarr 0.9.911:
//   qualityProfile.profileType  : "ebook" | "audiobook"
//   metadataProfile.profileType : 2 = ebook, 1 = audiobook, 0 = None (type-agnostic)
//   rootFolder.folderType       : 2 = ebook, 1 = audiobook  (+ a nested .ebook block)
const isEbookQualityProfile  = q => String((q && q.profileType) || '').toLowerCase() === 'ebook';
const isEbookMetadataProfile = m => !!m && (m.profileType === 2 || m.profileType === 0);
const isEbookRootFolder      = r => !!r && (r.folderType === 2 || !!r.ebook);
app.get('/api/chaptarr/options', auth, async (req,res)=>{
  if (!CFG.chaptarrUrl || !CFG.chaptarrKey) return res.json({ qualityProfiles: [], metadataProfiles: [], rootFolders: [] });
  try {
    // Profiles/folders barely ever change — cache 5 min so opening the request
    // modal doesn't cost three upstream calls every time.
    res.json(await cached('ch:options', OPTIONS_TTL_MS, async () => {
      const [qp, mp, rf] = await Promise.all([
        requestJson(CFG.chaptarrUrl + '/api/v1/qualityprofile', 'GET', null, chaptarrHeaders()),
        requestJson(CFG.chaptarrUrl + '/api/v1/metadataprofile', 'GET', null, chaptarrHeaders()),
        requestJson(CFG.chaptarrUrl + '/api/v1/rootfolder', 'GET', null, chaptarrHeaders())
      ]);
      const arr = d => Array.isArray(d) ? d : [];
      const quality  = arr(qp.data).filter(isEbookQualityProfile);
      const metadata = arr(mp.data).filter(isEbookMetadataProfile);
      const roots    = arr(rf.data).filter(isEbookRootFolder);
      return {
        // If Chaptarr ever stops typing these, fall back to the unfiltered list so the
        // modal is never empty and unusable.
        qualityProfiles:  quality.length  ? quality  : arr(qp.data),
        metadataProfiles: metadata.length ? metadata : arr(mp.data),
        rootFolders:      roots.length    ? roots    : arr(rf.data)
      };
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Old path kept so a dashboard or cached browser tab pointing at the pre-Chaptarr
// route keeps working.
app.get('/api/bookshelf/options', auth, (req,res)=>res.redirect(307, '/api/chaptarr/options'));

// ── Listenarr profile/folder options for the audiobook request modal ──────────
app.get('/api/listenarr/options', auth, async (req,res)=>{
  if (!CFG.listenarrUrl || !CFG.listenarrKey) return res.json({ qualityProfiles: [], rootFolders: [] });
  try {
    res.json(await cached('la:options', OPTIONS_TTL_MS, async () => {
      const [qp, rf] = await Promise.all([
        requestJson(CFG.listenarrUrl + '/api/v1/qualityprofile', 'GET', null, listenarrHeaders()),
        requestJson(CFG.listenarrUrl + '/api/v1/rootfolders', 'GET', null, listenarrHeaders())
      ]);
      const quality = Array.isArray(qp.data) ? qp.data : [];
      const roots = Array.isArray(rf.data) ? rf.data : [];
      return {
        qualityProfiles: quality.map(q => ({ id: q.id, name: q.name || ('Quality ' + q.id) })),
        rootFolders: roots.map(r => ({ id: r.id, path: r.path || r.name || '', name: r.name || r.path || '' }))
      };
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Upstream call cache (protects Chaptarr / Listenarr / external APIs) ──────
// Everything BookSeerr reads from upstream is either a slow-changing list (your
// library, quality profiles) or a repeatable query (search text, health pings).
// This tiny cache means each of those is fetched AT MOST once per TTL window, no
// matter how many users, tabs, keystrokes, or dashboard polls ask for it:
//   • in-flight dedupe — concurrent callers share ONE upstream fetch
//   • stale-on-error — if upstream hiccups, serve the last good copy briefly
//   • size-capped    — search keys can't grow unbounded
// Writes (adding an author/audiobook) BUST the relevant keys so "✓ In library"
// badges update immediately after a request is sent.
var upCache = upCache || new Map();   // `var` so boot-time cacheBust() (before this line runs) is safe
// A fetch that started BEFORE a bust must not write its now-outdated answer back —
// otherwise a slow library read that began before a request was sent would re-install
// the pre-add snapshot and keep "✓ In library" wrong for a further full TTL. Each
// in-flight entry carries a token, and a fetch only writes while its own entry is still
// the one in the map: a bust that covers the key removes or replaces it. This used to
// be a single global counter, so busting ANY key also disowned fetches for unrelated
// keys — whose entries then kept their settled promise and were served from it forever
// (a Listenarr health pill or library snapshot could freeze until the next restart).
// How long a stale value may be served once upstream is failing. Beyond this we stop
// pretending we know: the caller sees the real error instead of an answer that could
// be hours old.
const STALE_GRACE_MS = 5 * 60 * 1000;
// The size cap exists to bound SEARCH keys, which are unbounded (one per query
// string). Everything else — library snapshots, health probes, profile lists,
// Discover rows — is a small fixed set inserted at boot, so an insertion-ordered
// sweep evicted exactly the expensive long-lived entries it was never meant to touch
// and left the search keys alone. Evict search keys first, oldest-used first.
function evictIfNeeded(){
  if (upCache.size <= 300) return;
  const evictable = [...upCache.entries()]
    .filter(([k, v]) => k.startsWith('search:') && !v.promise)
    .sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
  let n = upCache.size - 250;
  for (const [k] of evictable) { if (n-- <= 0) break; upCache.delete(k); }
}
// ttlMs may be a NUMBER or a function of the fetched value. The second form lets a
// cheap, uninteresting answer ("the downloader didn't reply") expire far sooner than
// an expensive good one, without giving every caller its own cache.
//
// opts.swr (ms) turns on stale-while-revalidate: once the TTL has passed, a copy
// younger than `swr` is handed back AT ONCE while a single refresh runs behind it.
// That's for reads too slow to sit through on a request path — Chaptarr's author list
// takes 20-45s — where an answer from a few minutes ago is still the right one.
// opts.swr = 0 (the default) keeps the classic behaviour: wait for the refresh.
async function cached(key, ttlMs, fetcher, opts){
  const swr = (opts && opts.swr) || 0;
  const dynamicTtl = typeof ttlMs === 'function';
  const ttlFor = (data) => (dynamicTtl ? ttlMs(data) : ttlMs);
  const baseTtl = dynamicTtl ? ttlMs(undefined) : ttlMs;
  const now = Date.now();
  const e = upCache.get(key);
  if (e && e.data !== undefined && now - e.at < e.ttl) return e.data;   // fresh hit
  const serveStale = swr > 0 && !!e && e.data !== undefined && now - (e.staleSince || e.at) < swr;
  if (e && e.promise) return serveStale ? e.data : e.promise;           // join in-flight fetch
  const stale = e ? e.data : undefined;
  const staleSince = e ? (e.staleSince || e.at) : 0;
  const keepSwr = swr || (e && e.swr) || 0;   // a one-off fresh read doesn't strip the key's SWR
  const token = {};
  const ours = () => { const cur = upCache.get(key); return !!cur && cur.token === token; };
  const promise = (async () => {
    try {
      const data = await fetcher();
      if (!ours()) return data;   // busted mid-flight — don't cache
      evictIfNeeded();
      upCache.set(key, { at: Date.now(), ttl: ttlFor(data), data, swr: keepSwr });
      return data;
    } catch (err) {
      // Only clean up our OWN entry. A bust while we were out may have replaced it,
      // and a newer fetch may already be running there; deleting that threw its copy away.
      if (!ours()) throw err;
      upCache.delete(key);
      // Serve the last good copy for a bounded grace period. `staleSince` keeps the
      // ORIGINAL timestamp: re-stamping `at` on every failure made "briefly" mean
      // "forever", so an upstream that stayed down for hours kept handing out an
      // ever-older snapshot that looked fresh.
      if (stale !== undefined && Date.now() - staleSince < Math.max(STALE_GRACE_MS, keepSwr)) {
        upCache.set(key, { at: Date.now(), ttl: Math.min(baseTtl, 30000), data: stale, staleSince, swr: keepSwr });
        return stale;
      }
      throw err;
    }
  })();
  upCache.set(key, { at: e ? e.at : 0, ttl: e ? e.ttl : baseTtl, data: stale, staleSince, promise, token, swr: keepSwr });
  if (serveStale) { promise.catch(() => {}); return stale; }
  return promise;
}
// How old the copy held for `key` is (Infinity when there's none).
function cacheAge(key){
  const e = upCache.get(key);
  return e && e.data !== undefined ? Date.now() - (e.staleSince || e.at) : Infinity;
}
// opts.keepStale: mark matching entries out of date instead of dropping them, so a
// stale-while-revalidate reader still gets an instant answer while the refresh runs.
// Meant for our OWN writes — after adding one author the snapshot is still right about
// every other one. A connection change (possibly a different server) must drop
// everything, which is what the default does.
// Removing or replacing an entry also disowns any fetch in flight for it (see above).
function cacheBust(prefix, opts){
  if (!upCache) return;
  const keep = !!(opts && opts.keepStale);
  for (const [k, e] of [...upCache.entries()]) {
    if (prefix && !k.startsWith(prefix)) continue;
    if (keep && e && e.swr && e.data !== undefined) upCache.set(k, { at: 0, ttl: e.ttl, data: e.data, staleSince: e.staleSince || e.at, swr: e.swr });
    else upCache.delete(k);
  }
}

const LIB_TTL_MS     = 90 * 1000;       // library contents — badges stay ≤90s stale
const OPTIONS_TTL_MS = 5 * 60 * 1000;   // quality/metadata profiles & root folders
const HEALTH_TTL_MS  = 60 * 1000;       // system-status pings (dashboard + widgets share these)
// …but only a SUCCESSFUL one. rawProbe returns "not connected" instead of throwing,
// so a single slow reply used to be cached as down for the full minute — Chaptarr
// briefly busy (a library refresh pushes it past the 4s probe) left a red "Not
// connected" pill sitting there long after it was answering again. A failed ping is
// cheap to repeat, so it expires in seconds and the pill self-corrects.
const HEALTH_FAIL_TTL_MS = 10 * 1000;
const healthTtl = (p) => (p && p.connected) ? HEALTH_TTL_MS : HEALTH_FAIL_TTL_MS;
const SEARCH_TTL_MS  = 5 * 60 * 1000;   // repeated search queries (retyping, backspacing)

// Chaptarr's author list is the slow one (20-45s live), and it only changes when an
// author is added, so it's refreshed at most every 5 minutes and — stale-while-
// revalidate — the previous copy keeps answering for up to a day while that runs.
// Whatever BookSeerr adds itself is folded in immediately (rememberChaptarrAuthor).
const AUTHORS_TTL_MS = 5 * 60 * 1000;
const LIBRARY_SWR_MS = 24 * 60 * 60 * 1000;
// Only the fields matching and the eBook checks read. The full records (overview,
// images, links, ratings, statistics) are ~25x the size and none of it is used.
const slimAuthor = a => ({
  id: a.id, authorName: a.authorName || '', foreignAuthorId: String(a.foreignAuthorId || ''),
  files: (a.statistics && a.statistics.bookFileCount) || 0,   // how much of them is on the shelf (Discover "for you")
  monitored: a.monitored, ebookMonitored: a.ebookMonitored,
  ebookQualityProfileId: a.ebookQualityProfileId, ebookMetadataProfileId: a.ebookMetadataProfileId, ebookRootFolderPath: a.ebookRootFolderPath,
  audiobookQualityProfileId: a.audiobookQualityProfileId, audiobookRootFolderPath: a.audiobookRootFolderPath
});
const slimBook = b => ({
  id: b.id, title: b.title || '', foreignBookId: String(b.foreignBookId || ''), mediaType: b.mediaType || '',
  monitored: b.monitored, ebookMonitored: b.ebookMonitored, hasFiles: b.hasFiles,
  statistics: b.statistics ? { bookFileCount: b.statistics.bookFileCount } : undefined
});
// At most `max` of these calls run at once; the rest queue. A page of search results
// can name a dozen library authors, and a dozen 3-30s book-list reads fired together
// pile up inside Chaptarr and slow down everything else it is doing.
function limiter(max){
  let active = 0;
  const queue = [];
  const pump = () => {
    while (active < max && queue.length) {
      const job = queue.shift();
      active++;
      Promise.resolve().then(job.fn).then(job.resolve, job.reject).finally(() => { active--; pump(); });
    }
  };
  return fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
}
const chaptarrBookReads = limiter(2);

// Library snapshots — each fetched at most once per TTL, shared by every check.
// opts.fresh waits for an up-to-date list instead of taking the stale-while-revalidate
// copy — for when Chaptarr has just contradicted the snapshot.
const getChaptarrAuthors = (opts) => cached('ch:authors', AUTHORS_TTL_MS, async () => {
  const r = await requestJson(CFG.chaptarrUrl + '/api/v1/author', 'GET', null, chaptarrHeaders(), LIBRARY_TIMEOUT_MS, 0);
  // NOT `: []`. A truncated or non-JSON body parses to a string, and quietly calling
  // that an empty library is a wrong ANSWER, not a missing one: every "in library"
  // badge vanishes and cached() stores the emptiness for the whole TTL. Failing here
  // lets cached() serve the last good snapshot instead.
  if (!Array.isArray(r.data)) throw new Error('Chaptarr author list was not a JSON array (status ' + r.status + ')');
  return r.data.map(slimAuthor);
}, { swr: opts && opts.fresh ? 0 : LIBRARY_SWR_MS });
function warmChaptarrAuthors(){
  if (CFG.chaptarrUrl && CFG.chaptarrKey) getChaptarrAuthors().catch(() => {});
}
// Fold an author we just added (or gave an eBook side) into the snapshot right away.
// Re-reading the list takes Chaptarr 20-45s; until that lands, the next request for
// the same author wouldn't see them and would try to add them all over again.
function rememberChaptarrAuthor(a){
  cacheBust('ch:authors', { keepStale: true });   // a background re-read confirms it
  const e = upCache.get('ch:authors');
  if (!a || a.id == null || !e || !Array.isArray(e.data)) return;
  const slim = slimAuthor(a);
  e.data = e.data.filter(x => x.id !== slim.id).concat([slim]);
}
// Books for ONE author, not the whole library.
//
// GET /api/v1/book returns every book Chaptarr knows about — on a real instance that
// measured 30,809 books / 46 MB, which blows straight past MAX_UPSTREAM_BYTES and
// would spike memory on every refresh. It is also far more than this check needs: the
// only question is "does this author already have a book with this title?", so the
// query is scoped with ?authorId= and cached per author. opts.fresh skips the
// stale-while-revalidate copy, for when a stale "not there" isn't good enough.
const getChaptarrAuthorBooks = (authorId, opts) => cached('ch:books:' + authorId, LIB_TTL_MS, () => chaptarrBookReads(async () => {
  const r = await requestJson(CFG.chaptarrUrl + '/api/v1/book?authorId=' + encodeURIComponent(authorId), 'GET', null, chaptarrHeaders(), LIBRARY_TIMEOUT_MS, 0);
  if (!Array.isArray(r.data)) throw new Error('Chaptarr book list was not a JSON array (status ' + r.status + ')');
  return r.data.map(slimBook);
}), { swr: opts && opts.fresh ? 0 : LIBRARY_SWR_MS });
// Resolve to the value if it arrives within `ms`, otherwise to undefined. The work
// itself carries on and lands in the cache, so the next ask gets the full answer —
// this only stops a badge check from hanging on Chaptarr's slowest reads.
function withBudget(p, ms){
  let t;
  return Promise.race([Promise.resolve(p).catch(() => undefined), new Promise(r => { t = setTimeout(r, ms); })])
    .finally(() => clearTimeout(t));
}
// Listenarr's whole audiobook library. Small enough to hold in one snapshot
// (~102 titles / 80 KB on a real instance) and cached for the same 90s window.
//
// Only /api/v1/library exists — Listenarr has NO /api/v1/book, and because it serves
// its web UI from the same host, an unknown /api/... path comes back 200 with the
// SPA's HTML rather than a 404. The old code therefore spent an extra round-trip on
// every refresh getting a page of HTML it then threw away. Anything that isn't a
// JSON array is treated as "no library", never as an empty one.
const getListenarrLibrary = () => cached('la:library', LIB_TTL_MS, async () => {
  const r = await requestJson(CFG.listenarrUrl + '/api/v1/library', 'GET', null, listenarrHeaders());
  if (Array.isArray(r.data)) return r.data;
  // Listenarr answers 200 with its web page for any /api path it doesn't know, so a
  // non-array here means "that wasn't the library", never "the library is empty".
  const wrapped = arrify(r.data);
  if (Array.isArray(wrapped) && wrapped.length) return wrapped;
  throw new Error('Listenarr library was not a JSON array (status ' + r.status + ')');
});

// Health probes — ONE cached ping per service per minute, shared by the dashboard
// endpoint AND the status widgets, however many tabs/panels are polling.
async function rawProbe(url, key, infoPath, hdr){
  if (!url || !key) return { connected: false, version: null, error: 'not configured' };
  try {
    // No retries: a health probe should report reality quickly, and the result is
    // already cached for 60s. Retrying would just delay an honest "down".
    const r = await requestJson(url + infoPath, 'GET', null, hdr(), 4000, 0);
    // A 2xx alone is NOT proof the API answered: Listenarr serves its web UI from the
    // same host and replies 200 with the SPA's HTML for any /api path it doesn't
    // know, so a moved endpoint would show a confident green "connected" pill over a
    // service BookSeerr can no longer talk to. requestJson hands back the raw string
    // when the body isn't JSON, so insist on a parsed object.
    if (r.status >= 200 && r.status < 300) {
      if (!r.data || typeof r.data !== 'object') return { connected: false, version: null, error: 'not an API response (got a web page)' };
      const v = r.data.version || r.data.appVersion || r.data.listenarrVersion;
      return { connected: true, version: v || null };
    }
    if (r.status === 401) return { connected: false, version: null, error: 'bad API key (401)' };
    return { connected: false, version: null, error: 'status ' + r.status };
  } catch (e) { return { connected: false, version: null, error: e.message }; }
}
const probeChaptarr = () => cached('health:ch', healthTtl, () => rawProbe(CFG.chaptarrUrl, CFG.chaptarrKey, '/api/v1/system/status', chaptarrHeaders));
const probeListenarr = () => cached('health:la', healthTtl, () => rawProbe(CFG.listenarrUrl, CFG.listenarrKey, '/api/v1/system/info', listenarrHeaders));

// ── Approval-aware sending ────────────────────────────────────────────────────
// The actual "hand it to the downloader" logic lives in these two functions so it
// can run either IMMEDIATELY (auto-approved requests — same behaviour as before)
// or LATER, when an admin clicks Approve on a pending request. Both take a plain
// payload object (stored on pending records for exact replay) and return
// { status: 'sent'|'error', message, apiResult, ... }.

// Listenarr already holds this audiobook (the add came back 409). Whether that means
// "nothing to do" depends on whether it was ever DOWNLOADED. It used to be reported as
// "Already in your Listenarr library" either way and left there — so a title Listenarr
// had added but never managed to grab was never looked for again, however many times
// someone requested it. Now: downloaded → say so; downloading → leave it alone;
// anything else → make sure it's monitored and run Listenarr's own indexer search
// (the Wanted page's "Search"), in the background because that can take a minute+.
async function existingAudiobook(conflict, p){
  const already = { status: 'sent', message: 'Already in your Listenarr library' };
  // Listenarr's 409 body carries the record it already has: { message, audiobook }.
  const held = conflict && typeof conflict === 'object' && conflict.audiobook && typeof conflict.audiobook === 'object' ? conflict.audiobook : null;
  let id = held && held.id != null ? held.id : null;
  // Two reads, because each has half the answer (Listenarr 1.3.4, live): the LIST row
  // carries the computed status ('downloading', 'no-file', …) and fileCount, while the
  // single-item read has the files but no status at all. Going by the single item
  // alone, a title that is downloading right now looks missing — and would be searched
  // for and grabbed a second time. The list is read fresh for the same reason.
  let row = null;
  try {
    cacheBust('la:library');
    const want = String(p.asin || '').toLowerCase();
    row = (await getListenarrLibrary()).find(it => (id != null && it.id === id) || laAsin(it) === want) || null;
  } catch { /* can't tell more than Listenarr's "it exists" */ }
  if (id == null && row && row.id != null) id = row.id;
  if (id == null) return already;
  let detail = null;
  try {
    const r = await requestJson(CFG.listenarrUrl + '/api/v1/library/' + encodeURIComponent(id), 'GET', null, listenarrHeaders(), SEND_TIMEOUT_MS, 0);
    if (r.status >= 200 && r.status < 300 && r.data && typeof r.data === 'object') detail = r.data;
  } catch { /* the list row (or the 409 body) will have to do */ }
  const item = Object.assign({}, held, row, detail);
  const state = laState(item);
  if (state === 'downloaded' || state === 'unknown') return Object.assign(already, { listenarrId: id });
  if (state === 'downloading') return { status: 'sent', message: 'Already downloading in Listenarr', listenarrId: id };
  if (item && item.monitored === false) {
    try { await requestJson(CFG.listenarrUrl + '/api/v1/library/' + encodeURIComponent(id), 'PUT', { monitored: true }, listenarrHeaders(), SEND_TIMEOUT_MS, 0); }
    catch { /* the search below still runs; monitoring is what makes Listenarr retry later */ }
  }
  return {
    status: 'sent', listenarrId: id,
    message: 'Already in Listenarr but not downloaded yet — searching for it now',
    followUp: { service: 'listenarr', audiobookId: id, title: p.title || '' }
  };
}

async function sendAudioToListenarr(p){
  let status = 'error', message = 'Request failed', apiResult = null, listenarrId = null, followUp = null;
  if (!CFG.listenarrUrl || !CFG.listenarrKey) return { status, message: 'Listenarr is not configured', apiResult };
  if (!String((p && p.asin) || '').trim()) {
    return { status, message: 'This audiobook has no ASIN, so Listenarr cannot identify it — search for it again from the Audiobooks tab and re-submit.', apiResult };
  }
  try {
    // Listenarr's AddToLibraryRequest is { Metadata, SearchResult, Monitored,
    // QualityProfileId, AutoSearch }. The audiobook details — crucially the ASIN —
    // must live INSIDE `metadata`/`searchResult`, not at the top level.
    //
    // IMPORTANT: Listenarr's metadata model is strongly typed, so sending a field
    // with the wrong type (e.g. releaseDate:"" where a DateTime is expected, or
    // seriesNumber:"" where a number is expected) triggers a 400 "validation errors"
    // response. We therefore build a MINIMAL, string/array-only metadata object and
    // never send empty dates/numbers. Listenarr enriches everything else from the
    // ASIN via Audimeta/Audnexus after the add.
    //
    // We deliberately do NOT forward Listenarr's raw search object as `searchResult`:
    // its `genres` (and similar) arrays contain objects, but Listenarr's typed
    // AddToLibraryRequest.SearchResult expects List<string>, so echoing it raw causes
    // `$.searchResult.genres[0] → could not convert to String` and rejects the request.
    // We send only clean string / string-array fields in both slots.
    const meta = { asin: p.asin, title: p.title };
    if (p.author) { meta.author = p.author; meta.authors = [p.author]; }
    if (p.narrator) { meta.narrator = p.narrator; meta.narrators = [p.narrator]; }
    if (p.image) { meta.cover = p.image; meta.coverUrl = p.image; meta.image = p.image; meta.imageUrl = p.image; }
    if (p.description) meta.description = p.description;
    const addBody = {
      metadata: meta,
      searchResult: meta,
      monitored: true,
      qualityProfileId: p.qualityProfileId,
      autoSearch: true
    };
    apiResult = await requestJson(CFG.listenarrUrl + '/api/v1/library/add', 'POST', addBody, listenarrHeaders(), SEND_TIMEOUT_MS, 0);
    status = apiResult.status >= 200 && apiResult.status < 300 ? 'sent' : 'error';
    if (status === 'sent') {
      message = 'Sent to Listenarr — searching for a release';
      // 1.3.x answers { audiobook: {...} }; older builds the record itself.
      const added = apiResult.data && typeof apiResult.data === 'object' ? (apiResult.data.audiobook || apiResult.data) : null;
      if (added && added.id != null) listenarrId = added.id;
    } else {
      const d = apiResult.data;
      let detail = '';
      if (d && d.errors && typeof d.errors === 'object') {
        // ASP.NET ValidationProblemDetails: { errors: { "$.field": ["msg"], ... } }
        detail = Object.entries(d.errors).map(([k, v]) => k + ' → ' + (Array.isArray(v) ? v.join('; ') : v)).join(' | ');
      } else {
        detail = (d && (d.message || d.error || d.title)) || (typeof d === 'string' ? d.slice(0, 200) : '');
      }
      // Listenarr replies 409 (or an "already exists" message) when the audiobook is
      // already in the library. That's not a failure — but it isn't automatically
      // "done" either: see existingAudiobook().
      if (apiResult.status === 409 || /already\s+(exists|added|in (your )?library)/i.test(detail)) {
        const ex = await existingAudiobook(apiResult.data, p);
        status = ex.status; message = ex.message;
        listenarrId = ex.listenarrId != null ? ex.listenarrId : null;
        followUp = ex.followUp || null;
      } else {
        message = 'Listenarr API error ' + apiResult.status + (detail ? ': ' + detail : '');
      }
    }
  } catch (e) { message = 'Cannot reach Listenarr: ' + e.message; }
  if (status === 'sent') cacheBust('la:');   // library changed → refresh "in library" badges
  return { status, message, apiResult, listenarrId, followUp };
}

// ── Chaptarr author helpers (eBook side only) ────────────────────────────────
// Chaptarr serves eBooks AND audiobooks out of one library and prefixes every author
// field with the format it belongs to. BookSeerr drives only the eBook half here —
// audiobooks are Listenarr's job — so nothing below ever writes an audiobook* field.
const authorHasEbook = (a) => !!(a && (a.ebookRootFolderPath || a.ebookQualityProfileId));
function ebookFields(p){
  return {
    ebookQualityProfileId:  p.qualityProfileId,
    ebookMetadataProfileId: p.metadataProfileId,
    ebookRootFolderPath:    p.rootFolderPath,
    ebookMonitorExisting:   1,
    ebookMonitorFuture:     true
  };
}
// Keep only the eBook rows. Chaptarr tags every book with mediaType, so an author's
// AUDIOBOOK of a title must not make an eBook request look "already in library".
const ebookBooks = (books) => (books || []).filter(b => {
  const mt = String((b && b.mediaType) || '').toLowerCase();
  return mt ? mt === 'ebook' : true;   // untyped rows still count, rather than vanishing
});
function chaptarrErrorDetail(errData){
  if (Array.isArray(errData) && errData.length && errData[0].errorMessage) return String(errData[0].errorMessage);
  if (errData && errData.message) return String(errData.message);
  if (typeof errData === 'string') return errData.slice(0, 200);
  return '';
}
// Monitoring on its own downloads nothing — this command is what starts the grab.
// Always best-effort: a request Chaptarr accepted must not be reported as failed
// just because the follow-up search call hiccuped.
async function chaptarrAuthorSearch(authorId){
  if (!authorId) return;
  try {
    await requestJson(CFG.chaptarrUrl + '/api/v1/command', 'POST', { name: 'AuthorSearch', authorId }, chaptarrHeaders(), SEND_TIMEOUT_MS, 0);
  } catch (e) { console.warn('[BookSeerr] Chaptarr AuthorSearch failed for author ' + authorId + ': ' + e.message); }
}
// A command whose outcome IS the request — search this book, refresh this author — so
// unlike the best-effort AuthorSearch above, a refusal is an error the admin can Retry.
// The payloads are the ones Chaptarr's own UI sends: { name:'BookSearch', bookIds:[id] }
// and { name:'RefreshAuthor', authorId }. Resolves to the queued command ({ id, … }).
async function chaptarrCommand(body){
  const r = await requestJson(CFG.chaptarrUrl + '/api/v1/command', 'POST', body, chaptarrHeaders(), SEND_TIMEOUT_MS, 0);
  if (!(r.status >= 200 && r.status < 300)) {
    const d = chaptarrErrorDetail(r.data);
    throw new Error('Chaptarr refused the ' + body.name + ' command (status ' + r.status + (d ? ': ' + d : '') + ')');
  }
  return r.data && typeof r.data === 'object' ? r.data : {};
}
async function monitorChaptarrBook(bookId){
  const r = await requestJson(CFG.chaptarrUrl + '/api/v1/book/monitor', 'PUT', { bookIds: [bookId], monitored: true }, chaptarrHeaders(), SEND_TIMEOUT_MS, 0);
  if (!(r.status >= 200 && r.status < 300)) {
    const d = chaptarrErrorDetail(r.data);
    throw new Error('Chaptarr would not monitor book ' + bookId + ' (status ' + r.status + (d ? ': ' + d : '') + ')');
  }
}
// Chaptarr's metadata search, shared between concurrent identical asks. Two identical
// lookups racing inside Chaptarr each write a row for the same URL into its HTTP cache,
// and from then on every search for that term fails ("Sequence contains more than one
// element") — that is how its searches for "stephen king" and "leigh bardugo" broke
// for good after a double-click. Answers are kept for 10 minutes; an empty one isn't
// kept at all, and a transport failure is still reported as one.
const LOOKUP_EMPTY = 'Chaptarr lookup found nothing';
async function chaptarrLookup(kind, term){
  const t = String(term || '').trim();
  if (!t) return [];
  try {
    return await cached('ch:lookup:' + kind + ':' + norm(t), 10 * 60 * 1000, async () => {
      // A book lookup measured 44-58s live, past the send timeout — hence the long one.
      const r = await requestJson(CFG.chaptarrUrl + '/api/v1/' + kind + '/lookup?term=' + encodeURIComponent(t), 'GET', null, chaptarrHeaders(), LIBRARY_TIMEOUT_MS, 0);
      const list = Array.isArray(r.data) ? r.data : [];
      if (!list.length) throw new Error(LOOKUP_EMPTY);
      return list;
    });
  } catch (e) {
    if (e && e.message === LOOKUP_EMPTY) return [];
    throw e;
  }
}
// Locate an author already in the library. Matching on foreignAuthorId alone is not
// enough: Chaptarr's lookup can return a Goodreads id ("gr:3389") for an author the
// library stored under a Hardcover one ("hc:1126820") — Stephen King, live — so fall
// back to the normalised name, which is what actually catches those.
function findLibraryAuthor(lib, foreignId, authorName){
  return lib.find(a => foreignId && String(a.foreignAuthorId || '') === foreignId)
      || lib.find(a => norm(a.authorName) === norm(authorName))
      || null;
}
// Everyone a request could be filed under, in the order to try them. An eBook result
// names every author ("Stephen King, Peter Straub"), and a co-written book lives under
// just ONE of them in Chaptarr — so each is checked, not only the first.
function candidateAuthorNames(p){
  const out = [];
  const add = n => { n = String(n || '').trim(); if (n && !out.some(x => norm(x) === norm(n))) out.push(n); };
  if (p.authorRaw && p.authorRaw.authorName) add(p.authorRaw.authorName);
  if (p.kind === 'author') add(p.author || p.name);
  else String(p.author || '').split(',').forEach(add);
  return out.slice(0, 4);
}
function libraryAuthorsFor(lib, names, foreignId){
  const found = [];
  const push = a => { if (a && !found.includes(a)) found.push(a); };
  if (foreignId) push(lib.find(a => String(a.foreignAuthorId || '') === foreignId));
  for (const n of names) push(findLibraryAuthor(lib, '', n));
  return found;
}
// Give an author already in Chaptarr their eBook side. Not a rare path: an author added
// for AUDIOBOOKS inside Chaptarr has no eBook profile or root folder, and a second POST
// for them only returns 400 "This author has already been added" — the eBook side would
// never be monitored and the request would look successful while doing nothing. Merges
// onto the full record and saves it back; moveFiles=false because this adds a format
// alongside what's there rather than relocating anything.
async function addEbookSide(existing, p){
  const cur = await requestJson(CFG.chaptarrUrl + '/api/v1/author/' + existing.id, 'GET', null, chaptarrHeaders(), LIBRARY_TIMEOUT_MS, 0);
  if (!(cur.status >= 200 && cur.status < 300) || !cur.data || typeof cur.data !== 'object') {
    throw new Error('Could not read author ' + existing.id + ' from Chaptarr (status ' + cur.status + ')');
  }
  const body = Object.assign({}, cur.data, ebookFields(p), { monitored: true });
  const apiResult = await requestJson(CFG.chaptarrUrl + '/api/v1/author/' + existing.id + '?moveFiles=false', 'PUT', body, chaptarrHeaders(), SEND_TIMEOUT_MS, 0);
  if (apiResult.status >= 200 && apiResult.status < 300) { rememberChaptarrAuthor(body); return { ok: true, apiResult }; }
  const d = chaptarrErrorDetail(apiResult.data);
  return { ok: false, apiResult, message: 'Chaptarr API error ' + apiResult.status + ' updating author' + (d ? ': ' + d : '') };
}
// An AUTHOR request for someone already in Chaptarr: make sure the eBook side is on,
// then search everything of theirs that's missing — "get me this author" means all of it.
async function applyEbookToAuthor(existing, p, authorName){
  if (authorHasEbook(existing)) {
    await chaptarrAuthorSearch(existing.id);
    return { status: 'sent', apiResult: null,
      message: 'Already in Chaptarr — ' + authorName + ' is monitored for eBooks; searching for anything missing' };
  }
  const up = await addEbookSide(existing, p);
  if (!up.ok) return { status: 'error', apiResult: up.apiResult, message: up.message };
  await chaptarrAuthorSearch(existing.id);
  return { status: 'sent', apiResult: up.apiResult, message: 'Added eBook monitoring to existing author "' + authorName + '"' };
}

// ── One eBook, by an author Chaptarr already has ─────────────────────────────
// Requesting a book whose author is already in the library should do exactly one
// thing: find THAT book and search for it. It used to try to add the whole author
// again (which Chaptarr rejects as a duplicate) or, at best, fire AuthorSearch — a
// search for every missing book they have, 1,100+ for Stephen King — which hammers
// the indexers and still never grabs the requested title if Chaptarr has it unmonitored.
const chBookHasFiles = b => !!b && (b.hasFiles === true || ((b.statistics && b.statistics.bookFileCount) || 0) > 0);
const chBookMonitored = b => !!b && b.monitored !== false && b.ebookMonitored !== false;
// Catalogues disagree on the trimmings around a title: Google Books has "The Women: A
// Novel", Goodreads "Other Worlds Than These (The Talisman, #3)", Chaptarr's own record
// usually neither. So: the exact title first, then without series/edition brackets,
// then with a subtitle dropped from ONE side. A loose match only counts when it is
// unambiguous — "Dune: House Atreides" and "Dune: House Harkonnen" both shrink to
// "dune", and guessing between them would download the wrong book.
const normTitle = s => norm(String(s || '').replace(/&/g, ' and '));
const noSeries = s => normTitle(String(s || '').replace(/\s*[([][^)\]]*[)\]]/g, ' '));
const noSubtitle = s => noSeries(String(s || '').split(/\s*[:;]\s+|\s+[-–—]\s+/)[0]);
function findBookByTitle(books, title){
  const want = normTitle(title);
  if (!want) return null;
  // Chaptarr keeps duplicate records of a title (three of "The Stand", live): prefer one
  // that's downloaded, then one that's monitored, then the oldest.
  const best = rows => rows.slice().sort((a, b) =>
    (chBookHasFiles(b) - chBookHasFiles(a)) || (chBookMonitored(b) - chBookMonitored(a)) || ((a.id || 0) - (b.id || 0)))[0];
  const tiers = [
    b => normTitle(b.title) === want,
    b => noSeries(b.title) === noSeries(title),
    b => noSubtitle(b.title) === noSeries(title),   // Chaptarr's has a subtitle the request lacks
    b => noSeries(b.title) === noSubtitle(title)    // the request has one Chaptarr's lacks
  ];
  for (let i = 0; i < tiers.length; i++) {
    const rows = (books || []).filter(b => b && b.title && tiers[i](b));
    if (!rows.length) continue;
    if (i > 0 && new Set(rows.map(b => normTitle(b.title))).size > 1) return null;   // ambiguous
    return best(rows);
  }
  return null;
}
// The requested title among one author's eBooks — from the cached list first, and if
// that copy is old enough to predate the book, from a fresh read before giving up.
async function findEbookFor(author, title){
  let hit = findBookByTitle(ebookBooks(await getChaptarrAuthorBooks(author.id)), title);
  if (!hit && cacheAge('ch:books:' + author.id) > LIB_TTL_MS) {
    hit = findBookByTitle(ebookBooks(await getChaptarrAuthorBooks(author.id, { fresh: true })), title);
  }
  return hit;
}
// Found it: downloaded already → nothing to do; otherwise monitor it if it isn't, and
// search for that one book.
async function searchChaptarrBook(author, book){
  if (chBookHasFiles(book)) {
    return { status: 'sent', chaptarrBookId: book.id, message: 'Already in Chaptarr — "' + book.title + '" by ' + author.authorName + ' is downloaded' };
  }
  if (!chBookMonitored(book)) await monitorChaptarrBook(book.id);
  await chaptarrCommand({ name: 'BookSearch', bookIds: [book.id] });
  cacheBust('ch:books:' + author.id, { keepStale: true });
  return { status: 'sent', chaptarrBookId: book.id, message: 'Searching Chaptarr for "' + book.title + '" — ' + author.authorName + ' is already in your library' };
}
// A request for someone the library already has (`matches`: their library rows, best first).
async function sendToExistingAuthor(matches, p){
  if (p.kind === 'author') {
    const a = matches.find(authorHasEbook) || matches[0];
    return Object.assign(await applyEbookToAuthor(a, p, a.authorName), { sentAsAuthor: a.authorName, resolvedForeignId: a.foreignAuthorId });
  }
  const title = String(p.title || p.name || '').trim();
  const withEbook = matches.filter(authorHasEbook);
  for (const a of withEbook) {
    const hit = await findEbookFor(a, title);
    if (hit) return Object.assign(await searchChaptarrBook(a, hit), { sentAsAuthor: a.authorName, resolvedForeignId: a.foreignAuthorId });
  }
  // Not in any of their book lists. Chaptarr only learns an author's books on a refresh
  // — a new release, or one an older refresh didn't pick up — so ask for one; the
  // follow-up searches for the book once it has finished.
  const a = withEbook[0] || matches[0];
  const base = { sentAsAuthor: a.authorName, resolvedForeignId: a.foreignAuthorId, apiResult: null };
  let message;
  if (!authorHasEbook(a)) {
    const up = await addEbookSide(a, p);
    if (!up.ok) return Object.assign(base, { status: 'error', apiResult: up.apiResult, message: up.message });
    message = 'Added eBook monitoring to ' + a.authorName + ' in Chaptarr — once it has loaded their eBooks, BookSeerr will search for "' + title + '"';
  } else {
    message = a.authorName + ' is already in Chaptarr, but "' + title + '" isn\'t in their book list yet — refreshing the author; BookSeerr will search for it once it shows up';
  }
  const cmd = await chaptarrCommand({ name: 'RefreshAuthor', authorId: a.id });
  return Object.assign(base, { status: 'sent', message,
    followUp: { service: 'chaptarr', authorId: a.id, authorName: a.authorName, title, commandId: cmd.id != null ? cmd.id : null } });
}

async function sendBookToChaptarr(p){
  let status = 'error', message = 'Request failed', apiResult = null;
  let sentAsAuthor = '', resolvedForeignId = '';
  // Reads the variables at the moment it is called, so `result({})` reports the current
  // state and `result(other)` lets a sub-flow's answer override it.
  const result = (extra) => Object.assign({ status, message, apiResult, sentAsAuthor, resolvedForeignId }, extra);
  if (!CFG.chaptarrUrl || !CFG.chaptarrKey) return result({ message: 'Chaptarr is not configured' });
  const kind = p.kind, name = String(p.name || p.title || p.author || '').trim();
  const authorRaw = p.authorRaw;
  const hintId = String((authorRaw && authorRaw.foreignAuthorId) || '');
  // The library snapshot. null means Chaptarr didn't answer — which is NOT "not in the
  // library". Conflating the two is what sent existing authors down the add path.
  let lib = null;
  try { lib = await getChaptarrAuthors(); } catch { /* handled where it matters below */ }
  try {
    // ── 1. Already in the library? Ask the LIBRARY first. ──
    // The old order asked Chaptarr's metadata search first, and that is the flakiest
    // thing it has: live, `author/lookup?term=Stephen King` returned nothing at all, so
    // every eBook request for an author the library already held failed with
    // "Author not found in Chaptarr".
    const inLib = lib ? libraryAuthorsFor(lib, candidateAuthorNames(p), hintId) : [];
    if (inLib.length) return result(await sendToExistingAuthor(inLib, p));

    // ── 2. A new author: an AUTHOR add, for eBook and author requests alike. ──
    // POST /api/v1/book is slow and unreliable (it often creates a record the app
    // then never grabs), so an eBook request resolves its author and adds/monitors
    // that author with a search — the same path author requests use, which works.
    // We figure out which author to add:
    let authorName = String((authorRaw && authorRaw.authorName) || '').trim();
    if (!authorName) {
      if (kind === 'author') {
        authorName = (p.author || name || '').trim();
      } else {
        // eBook: use the author carried on the picked result (first author if several);
        // if the result had none, look the book up in Chaptarr to discover its author.
        authorName = String(p.author || '').split(',')[0].trim();
        if (!authorName) {
          const searchTerm = p.title || name;
          const candidates = await chaptarrLookup('book', searchTerm);
          const bm = candidates.find(b => norm(b.title) === norm(searchTerm)) || candidates[0];
          authorName = String((bm && (bm.authorName || (bm.author && bm.author.authorName))) || '').trim();
          // …and that may well be an author the library already has.
          const known = lib && authorName ? libraryAuthorsFor(lib, [authorName], String((bm && bm.author && bm.author.foreignAuthorId) || '')) : [];
          if (known.length) return result(await sendToExistingAuthor(known, Object.assign({}, p, { author: authorName })));
        }
      }
    }
    if (!authorName) throw new Error('Could not work out which author to send to Chaptarr — try a more specific title or name.');

    // Resolve a real Chaptarr foreignAuthorId (a Google Books "key" is just the name, so look it up).
    resolvedForeignId = hintId;
    if (!resolvedForeignId) {
      const candidates = await chaptarrLookup('author', authorName);
      if (!candidates.length) {
        throw new Error(lib
          ? 'Author "' + authorName + '" not found in Chaptarr — try a different name'
          : 'Chaptarr didn\'t return its author list in time, and its metadata search found no "' + authorName + '" — try again in a minute');
      }
      const nameLower = authorName.toLowerCase();
      const match = candidates.find(a => (a.authorName || '').toLowerCase() === nameLower)
                 || candidates.find(a => norm(a.authorName) === norm(authorName))
                 || candidates[0];
      resolvedForeignId = String(match.foreignAuthorId || '');
      authorName = match.authorName || authorName;
    }
    if (!resolvedForeignId) throw new Error('Author not found in Chaptarr — no foreignAuthorId returned. Try a more specific name.');
    sentAsAuthor = authorName;

    // Chaptarr's author model is format-prefixed because it handles eBooks AND
    // audiobooks: the ebook* fields below are what it actually reads. Readarr's flat
    // qualityProfileId / metadataProfileId / rootFolderPath are silently ignored and
    // the add is then rejected with "At least one quality profile must be selected"
    // and "Invalid Path" — verified against Chaptarr 0.9.911. We only ever set the
    // eBook side; audiobooks stay with Listenarr and are left untouched here.
    const body = Object.assign(
      { authorName, foreignAuthorId: resolvedForeignId, monitored: true },
      ebookFields(p),
      { addOptions: { monitor: 'all', searchForMissingBooks: true } }
    );
    apiResult = await requestJson(CFG.chaptarrUrl + '/api/v1/author', 'POST', body, chaptarrHeaders(), SEND_TIMEOUT_MS, 0);

    status = apiResult.status >= 200 && apiResult.status < 300 ? 'sent' : 'error';
    if (status === 'sent') {
      // Into the snapshot straight away, so a second request for this author (before
      // Chaptarr's 20-45s list has been re-read) finds them instead of re-adding them.
      rememberChaptarrAuthor(Object.assign({}, body, apiResult.data && typeof apiResult.data === 'object' ? apiResult.data : {}));
      // addOptions.searchForMissingBooks is sent above and accepted, but an explicit
      // AuthorSearch command is the documented trigger and is what guarantees a
      // request actually starts downloading rather than sitting monitored-but-idle.
      await chaptarrAuthorSearch(apiResult.data && apiResult.data.id);
      // For an eBook we still send the WHOLE author to Chaptarr (so it grabs every
      // book by them), but we record the specific book the user picked and note which
      // author it was sent under — so admins can see exactly what was requested.
      message = kind === 'author'
        ? 'Sent to Chaptarr (author monitored)'
        : 'Requested book sent to Chaptarr as author "' + authorName + '"';
    } else {
      const detail = chaptarrErrorDetail(apiResult.data);
      if (/already.*added|already exists/i.test(detail)) {
        // Chaptarr has them after all: the snapshot was stale, or Chaptarr didn't answer
        // for it. Read the list again — waiting for it this time — and take the
        // existing-author path. This used to report "Already in Chaptarr — author is
        // monitored" as a success while searching for nothing at all.
        let fresh = null;
        cacheBust('ch:authors', { keepStale: true });   // even a copy inside its TTL is now suspect
        try { fresh = await getChaptarrAuthors({ fresh: true }); } catch { /* reported below */ }
        const again = fresh ? libraryAuthorsFor(fresh, [authorName].concat(candidateAuthorNames(p)), resolvedForeignId) : [];
        if (again.length) return result(await sendToExistingAuthor(again, p));
        status = 'error';
        message = 'Chaptarr says ' + authorName + ' is already in the library, but didn\'t return its author list in time to find them — try again in a minute';
      } else {
        message = 'Chaptarr API error ' + apiResult.status + (detail ? ': ' + detail : '');
      }
    }
  } catch (e) { status = 'error'; message = e.message; }
  return result({});
}

// ── Follow-ups: finishing a request after its response has gone back ──────────
// Two cases need work that can outlast a browser request:
//   • Chaptarr has the author but not (yet) the requested eBook → a RefreshAuthor was
//     queued; wait for it to finish, then find the book and search for it.
//   • Listenarr has the audiobook but never downloaded it → run its indexer search,
//     which can take a minute or more.
// The marker lives on the request record in db.json, so a restart picks it back up
// instead of leaving a request that says "will search" when nothing ever will.
const FOLLOWUP_POLL_MS = 15 * 1000;
const FOLLOWUP_MAX_MS = 60 * 60 * 1000;
const runningFollowUps = new Set();
function startFollowUp(reqId, f){
  if (!f || runningFollowUps.has(reqId)) return;
  runningFollowUps.add(reqId);
  const run = f.service === 'listenarr' ? listenarrFollowUp : chaptarrFollowUp;
  setImmediate(() => {
    run(reqId, f)
      .catch(e => finishFollowUp(reqId, 'error', 'Follow-up failed: ' + (e.message || e) + ' — Retry to try again'))
      .finally(() => runningFollowUps.delete(reqId));
  });
}
// Still worth doing? Not if the request was deleted meanwhile.
function followUpWanted(reqId){
  try { const r = loadDB().requests.find(x => x.id === reqId); return !!(r && r.followUp); } catch { return false; }
}
function finishFollowUp(reqId, status, message, extra){
  let rec = null;
  try {
    rec = mutate(db => {
      const r = db.requests.find(x => x.id === reqId);
      if (!r || !r.followUp) return null;
      r.status = status; r.message = message;
      delete r.followUp;
      if (extra) Object.assign(r, extra);
      return Object.assign({}, r);
    });
  } catch (e) { console.warn('[BookSeerr] could not record the outcome of request ' + reqId + ': ' + e.message); }
  if (rec && status === 'error') notify('error', rec);
  return rec;
}
async function chaptarrFollowUp(reqId, f){
  if (!CFG.chaptarrUrl || !CFG.chaptarrKey) return finishFollowUp(reqId, 'error', 'Chaptarr is no longer configured — link it in Settings, then Retry');
  const deadline = (Date.parse(f.startedAt || '') || Date.now()) + FOLLOWUP_MAX_MS;
  // 1. Wait for the refresh to finish: asked straight away, then every 15s.
  let outcome = 'completed';
  if (f.commandId != null) {
    outcome = 'timeout';
    for (let first = true; Date.now() < deadline; first = false) {
      if (!first) await sleep(FOLLOWUP_POLL_MS);
      if (!followUpWanted(reqId)) return;
      try {
        const r = await requestJson(CFG.chaptarrUrl + '/api/v1/command/' + encodeURIComponent(f.commandId), 'GET', null, chaptarrHeaders(), UPSTREAM_TIMEOUT_MS, 0);
        // 404: Chaptarr no longer knows the command (it restarted, or pruned it) — just look.
        if (r.status === 404) { outcome = 'completed'; break; }
        const st = String((r.data && r.data.status) || '').toLowerCase();
        if (['completed', 'failed', 'aborted', 'cancelled', 'orphaned'].includes(st)) { outcome = st; break; }
      } catch { /* Chaptarr busy — keep waiting */ }
    }
  }
  if (!followUpWanted(reqId)) return;
  // 2. Look again, with a fresh read of the author's books — the copy from before the
  //    refresh is exactly the one that didn't have the book, however recent it is.
  let books;
  cacheBust('ch:books:' + f.authorId, { keepStale: true });
  try { books = ebookBooks(await getChaptarrAuthorBooks(f.authorId, { fresh: true })); }
  catch (e) { return finishFollowUp(reqId, 'error', 'Chaptarr didn\'t return ' + f.authorName + '\'s book list (' + e.message + ') — Retry to look again'); }
  const hit = findBookByTitle(books, f.title);
  if (hit) {
    const out = await searchChaptarrBook({ id: f.authorId, authorName: f.authorName }, hit);
    return finishFollowUp(reqId, 'sent', out.message, { chaptarrBookId: hit.id });
  }
  const why = outcome === 'timeout'
    ? 'Chaptarr still hadn\'t finished refreshing ' + f.authorName + ' after an hour, and "' + f.title + '" isn\'t in their book list yet — Retry once it has'
    : outcome !== 'completed'
      ? 'Chaptarr\'s refresh of ' + f.authorName + ' ' + outcome + ', and "' + f.title + '" isn\'t in their book list — Retry later'
      : '"' + f.title + '" isn\'t in Chaptarr\'s book list for ' + f.authorName + ', even after a refresh — its metadata profile may be filtering it out, or Chaptarr lists it under another title. Add it in Chaptarr, then Retry here';
  finishFollowUp(reqId, 'error', why);
}
async function listenarrFollowUp(reqId, f){
  if (!CFG.listenarrUrl || !CFG.listenarrKey) return finishFollowUp(reqId, 'error', 'Listenarr is no longer configured — link it in Settings, then Retry');
  if (!followUpWanted(reqId)) return;
  let r;
  try {
    r = await requestJson(CFG.listenarrUrl + '/api/v1/download/search-and-download', 'POST', { audiobookId: f.audiobookId }, listenarrHeaders(), LIBRARY_TIMEOUT_MS, 0);
  } catch (e) {
    // No answer isn't a no: the search may well still be running inside Listenarr.
    return finishFollowUp(reqId, 'sent', 'Already in Listenarr — asked it to search, but it hasn\'t answered (' + e.message + '); check Listenarr\'s Activity page');
  }
  const d = r.data && typeof r.data === 'object' ? r.data : {};
  if (r.status >= 200 && r.status < 300) {
    if (d.success) return finishFollowUp(reqId, 'sent', 'Already in Listenarr — found a release' + (d.indexerUsed ? ' on ' + d.indexerUsed : '') + ', downloading');
    return finishFollowUp(reqId, 'sent', 'Already in Listenarr and monitored — no release found yet (' + (d.message || 'no matches') + ')');
  }
  const detail = d.message || d.error || d.title || (typeof r.data === 'string' ? r.data.slice(0, 200) : '');
  finishFollowUp(reqId, 'error', 'Listenarr search failed (status ' + r.status + ')' + (detail ? ': ' + detail : '') + ' — Retry to search again');
}
// Pick up whatever was still waiting when the server last stopped.
function resumeFollowUps(){
  let db;
  try { db = loadDB(); } catch { return; }
  for (const r of db.requests) if (r.followUp && r.status === 'sent') startFollowUp(r.id, r.followUp);
}
// What a send learned that's worth keeping on the record: the downloader's own id for
// the title, and any follow-up still to run (stamped with its start, for the deadline).
function recordSendOutcome(rec, out){
  if (out.chaptarrBookId != null) rec.chaptarrBookId = out.chaptarrBookId;
  if (out.listenarrId != null) rec.listenarrId = out.listenarrId;
  if (out.followUp) rec.followUp = Object.assign({}, out.followUp, { startedAt: new Date().toISOString() });
  else delete rec.followUp;
}
// Submits being sent right now (see the duplicate guard in POST /api/request).
const submitsInFlight = new Set();

// ── Submit a request: eBooks/Authors → Chaptarr, Audiobooks → Listenarr ──────
// Approval flow (Overseerr/Jellyseerr-style):
//   • If the requesting user is AUTO-APPROVED — the global toggle is on, or their
//     per-user override says "always", or they're an admin / API-key caller — the
//     request is sent upstream immediately, exactly like before.
//   • Otherwise the request is saved as **pending**: nothing touches Chaptarr or
//     Listenarr until an admin approves it (POST /api/requests/:id/approve) or
//     rejects it (POST /api/requests/:id/reject). The full send payload is stored
//     on the pending record so approval replays the identical add.
app.post('/api/request', auth, async (req,res)=>{
  const db = loadDBDaily();
  // An API key is a SERVICE principal, not a person. It used to be resolved to
  // "whichever admin happens to be first in the file" and charged against that
  // admin's daily allowance — so an automated dashboard silently ate a human's quota,
  // its requests were attributed to them, and toggling that admin's canRequest off
  // (or them hitting their own limit) broke the integration for reasons nobody would
  // guess. A key now requests as itself: no quota, attributed to the key's name.
  const viaKey = !!req.user.viaApiKey;
  const u = viaKey ? null : db.users.find(x => x.id === req.user.id);
  if (!viaKey && !u) return res.status(401).json({ error: 'Unauthorized' });
  if (!viaKey && !u.canRequest) return res.status(403).json({ error: 'Requests disabled for your account' });

  const { kind, title, author, narrator, image, year, description, asin, qualityProfileId, metadataProfileId, rootFolderId, rootFolderPath, foreignAuthorId, bookId, authorRaw } = req.body || {};
  const isAudio = kind === 'audio';
  const name = String(title || author || '').trim();
  if (!name) return res.status(400).json({ error: 'Title/author required' });

  // API-key callers have admin scope → always auto-approved.
  const autoApprove = viaKey ? true : isAutoApproved(db, u);
  // Who the stored record is attributed to.
  const asUserId = viaKey ? 0 : u.id;
  const asUsername = viaKey ? req.user.username : u.username;   // 'apikey:<name>' for keys

  // ── Validate the whole request BEFORE reserving a daily slot ────────────────
  // Everything below is pure validation + payload construction, so a rejected
  // request never consumes one of the user's daily allowance.
  let payload, buildRecord;
  if (isAudio) {
    // ═══ AUDIOBOOKS → Listenarr ══════════════════════════════════════════════
    if (!CFG.listenarrUrl || !CFG.listenarrKey) return res.status(400).json({ error: 'Listenarr is not configured' });
    const qid = Number(qualityProfileId);
    const rid = rootFolderId != null && rootFolderId !== '' ? Number(rootFolderId) : null;
    const resolvedAsin = asin || bookId || '';
    if (!qid || qid <= 0) return res.status(400).json({ error: 'Quality profile required' });
    if (!resolvedAsin) return res.status(400).json({ error: 'This audiobook has no ASIN, so Listenarr cannot identify it — pick a result that came from the Audiobooks search/Discover.' });

    payload = { kind: 'audio', title: title || name, author: author || '', narrator: narrator || '', image: image || '', description: description || '', asin: resolvedAsin, qualityProfileId: qid };
    buildRecord = (db2, out) => ({ id: db2.settings.nextRequestId++, userId: asUserId, username: asUsername, kind: 'audio', title: title || '', author: author || '', narrator: narrator || '', image: image || '', year: year || '', description: description || '', asin: resolvedAsin, qualityProfileId: qid, rootFolderId: rid, rootFolderPath: rootFolderPath || '', destination: 'listenarr', status: out.status, message: out.message, createdAt: new Date().toISOString() });
  } else {
    // ═══ EBOOKS & AUTHORS → Chaptarr ══════════════════════════════
    const qid = Number(qualityProfileId);
    const mid = Number(metadataProfileId);
    const root = String(rootFolderPath || '').trim();
    if (!qid || qid <= 0) return res.status(400).json({ error: 'Quality profile required' });
    if (!mid || mid <= 0) return res.status(400).json({ error: 'Metadata profile required' });
    if (!root) return res.status(400).json({ error: 'Root folder path required' });
    if (!CFG.chaptarrUrl || !CFG.chaptarrKey) return res.status(400).json({ error: 'Chaptarr is not configured' });

    payload = {
      kind: kind || 'book', title: title || '', author: author || '', name,
      qualityProfileId: qid, metadataProfileId: mid, rootFolderPath: root,
      foreignAuthorId: foreignAuthorId || '',
      // Keep only the two authorRaw fields the send actually uses (don't bloat db.json).
      authorRaw: (authorRaw && typeof authorRaw === 'object')
        ? { authorName: authorRaw.authorName || '', foreignAuthorId: authorRaw.foreignAuthorId || '' }
        : undefined
    };
    buildRecord = (db2, out) => ({ id: db2.settings.nextRequestId++, userId: asUserId, username: asUsername, kind: kind || 'book', title: title || '', author: author || '', sentAsAuthor: out.sentAsAuthor || '', image: image || '', year: year || '', description: description || '', qualityProfileId: qid, metadataProfileId: mid, rootFolderPath: root, foreignAuthorId: out.resolvedForeignId || foreignAuthorId || '', bookId: bookId || '', destination: 'chaptarr', status: out.status, message: out.message, createdAt: new Date().toISOString() });
  }

  // ── One copy of a request in flight at a time ───────────────────────────────
  // A double-click used to send the same eBook twice in parallel (live: requests
  // #106/#107, 200ms apart). Besides the duplicate, two identical lookups racing inside
  // Chaptarr is exactly what corrupted its search cache. Same caller + same title →
  // the second one is turned away until the first has finished.
  const dupKey = [asUserId + ':' + asUsername, isAudio ? 'audio' : (kind || 'book'), norm(title || name),
    norm(String(author || '').split(',')[0]), isAudio ? String(asin || bookId || '').toLowerCase() : ''].join('|');
  if (submitsInFlight.has(dupKey)) return res.status(409).json({ error: 'That request is already being sent — give it a moment.' });
  submitsInFlight.add(dupKey);
  try { await submitRequest(); }
  finally { submitsInFlight.delete(dupKey); }

  async function submitRequest(){
    // ── Reserve the daily slot atomically, BEFORE the upstream send ───────────
    // The check and the increment used to sit on either side of an `await`, so ten
    // concurrent submits all read the same pre-increment count and every one passed:
    // a user limited to 3/day could land 10. Claiming the slot in a single
    // read-modify-write (Node runs this synchronously, uninterrupted) makes the limit
    // hold no matter how many requests arrive at once.
    // API keys have no daily allowance to reserve — they are a service principal.
    const reserved = viaKey ? { ok: true } : mutate(db2 => {
      resetDailyCounts(db2);
      const uu = db2.users.find(x => x.id === u.id);
      if (!uu) return { err: 401, msg: 'Unauthorized' };
      if (!uu.canRequest) return { err: 403, msg: 'Requests disabled for your account' };
      if (uu.requests >= uu.limit) return { err: 429, msg: `Daily limit reached (${uu.limit}/day) — your requests reset at midnight` };
      uu.requests += 1;
      return { ok: true };
    });
    if (reserved.err) return res.status(reserved.err).json({ error: reserved.msg });

    let out = { status: 'pending', message: 'Waiting for admin approval', apiResult: null, sentAsAuthor: '', resolvedForeignId: '' };
    if (autoApprove) {
      try {
        const sent = isAudio ? await sendAudioToListenarr(payload) : await sendBookToChaptarr(payload);
        out = Object.assign(out, sent);
      } catch (e) {
        // A thrown send (rather than a returned error) used to escape to Express's
        // default handler, leaving the slot spent and no record of the attempt.
        out.status = 'error'; out.message = e.message || 'Send failed';
      }
    }

    // Persisting the record is the last step, and if it fails the reservation above
    // must not silently eat one of the user's daily requests.
    let r;
    try {
      r = mutate(db2 => {
        const rec = buildRecord(db2, out);
        if (autoApprove) { rec.approval = 'auto'; rec.approvedBy = 'auto'; rec.approvedAt = rec.createdAt; }
        else { rec.approval = 'required'; rec.payload = payload; }
        recordSendOutcome(rec, out);
        db2.requests.push(rec);   // the slot was already claimed by the reservation above
        return rec;
      });
    } catch (e) {
      // Give the slot back — the user has no record to show for it.
      if (!viaKey) { try { mutate(db2 => { const uu = db2.users.find(x => x.id === u.id); if (uu && uu.requests > 0) uu.requests -= 1; }); } catch {} }
      console.error('[BookSeerr] could not save request: ' + e.message);
      return res.status(500).json({ error: 'Could not save the request: ' + e.message });
    }
    notify(r.status === 'error' ? 'error' : 'submitted', r);
    if (r.followUp) startFollowUp(r.id, r.followUp);
    res.json({ ok: true, ...r, apiStatus: out.apiResult ? out.apiResult.status : null, apiBody: out.apiResult ? out.apiResult.data : null });
  }
});

// ── Approve / reject requests (admin) ─────────────────────────────────────────
// Approve sends the stored request to Chaptarr/Listenarr NOW — the exact payload
// captured at submit time — and stamps who approved it. It also doubles as a
// "Retry" for requests that previously errored (e.g. the downloader was offline).
// Requests currently mid-send. The status check and the status write sit either side
// of an upstream call that can take seconds, so without this a second click (or a
// Reject landing during the send) races the first: the same add is delivered twice,
// or a request the admin rejected still reaches the downloader and has its 'rejected'
// status overwritten with 'sent' — after the user's daily slot was already refunded.
// Node is single-threaded, so a plain Set is a sound lock here.
const sendingRequests = new Set();
app.post('/api/requests/:id/approve', auth, adminOnly, async (req,res)=>{
  const reqId = Number(req.params.id);
  const db = loadDB();
  const rec = db.requests.find(r => r.id === reqId);
  if (!rec) return res.status(404).json({ error: 'Not found' });
  if (rec.status !== 'pending' && rec.status !== 'error') return res.status(400).json({ error: 'Only pending (or failed) requests can be approved/retried' });
  if (sendingRequests.has(reqId)) return res.status(409).json({ error: 'This request is already being sent — give it a moment.' });

  const isAudioReq = rec.destination === 'listenarr' || rec.kind === 'audio';
  // If the downloader isn't configured, keep the record PENDING (don't flip it to
  // error) so nothing is lost — the admin can approve again after Settings.
  if (isAudioReq && (!CFG.listenarrUrl || !CFG.listenarrKey)) return res.status(400).json({ error: 'Listenarr is not configured — link it in Settings first' });
  if (!isAudioReq && (!CFG.chaptarrUrl || !CFG.chaptarrKey)) return res.status(400).json({ error: 'Chaptarr is not configured — link it in Settings first' });

  // Pending records carry the exact submit-time payload. Older/errored rows may
  // not, so reconstruct one from the fields saved on the record itself.
  const p = rec.payload || (isAudioReq
    ? { kind: 'audio', title: rec.title || rec.author || '', author: rec.author || '', narrator: rec.narrator || '', image: rec.image || '', description: rec.description || '', asin: rec.asin || '', qualityProfileId: rec.qualityProfileId }
    : { kind: rec.kind || 'book', title: rec.title || '', author: rec.author || '', name: rec.title || rec.author || '', qualityProfileId: rec.qualityProfileId, metadataProfileId: rec.metadataProfileId, rootFolderPath: rec.rootFolderPath || '', foreignAuthorId: rec.foreignAuthorId || '' });

  sendingRequests.add(reqId);
  let out;
  try {
    out = isAudioReq ? await sendAudioToListenarr(p) : await sendBookToChaptarr(p);
  } catch (e) {
    sendingRequests.delete(reqId);
    return res.status(502).json({ error: 'Send failed: ' + (e.message || 'unknown error') });
  } finally {
    sendingRequests.delete(reqId);
  }

  const updated = mutate(db2 => {
    const r2 = db2.requests.find(r => r.id === rec.id);
    if (!r2) return null;
    // Re-check under the lock: if the row moved on while we were talking to the
    // downloader, don't stamp our result over whatever it became.
    if (r2.status !== 'pending' && r2.status !== 'error') return { conflict: r2.status };
    r2.status = out.status; r2.message = out.message;
    if (out.sentAsAuthor) r2.sentAsAuthor = out.sentAsAuthor;
    if (out.resolvedForeignId) r2.foreignAuthorId = out.resolvedForeignId;
    r2.approval = 'manual';
    r2.approvedBy = req.user.username;
    r2.approvedAt = new Date().toISOString();
    delete r2.rejectedBy; delete r2.rejectedAt;
    recordSendOutcome(r2, out);
    if (out.status === 'sent') { delete r2.payload; r2.message = out.message + ' · approved by ' + req.user.username; }
    return r2;
  });
  if (!updated) return res.status(404).json({ error: 'Not found' });
  if (updated.conflict) return res.status(409).json({ error: 'This request was ' + updated.conflict + ' while it was being sent — reload to see its current state.' });
  notify(updated.status === 'sent' ? 'approved' : 'error', updated);
  if (updated.followUp) startFollowUp(updated.id, updated.followUp);
  res.json({ ok: true, ...updated, apiStatus: out.apiResult ? out.apiResult.status : null, apiBody: out.apiResult ? out.apiResult.data : null });
});

// Reject a pending request. Nothing is (or ever was) sent upstream; the record is
// kept with status "rejected" so the user can see what happened. The user's daily
// request slot is refunded if the request was made today.
app.post('/api/requests/:id/reject', auth, adminOnly, (req,res)=>{
  const reqId = Number(req.params.id);
  const reason = String(((req.body || {}).reason) || '').trim().slice(0, 200);
  // Refuse while an approve is mid-flight, so a reject can't refund a slot for a
  // request that is at this moment being handed to the downloader.
  if (sendingRequests.has(reqId)) return res.status(409).json({ error: 'This request is being sent right now — wait for it to finish, then delete it if you still want it gone.' });
  const out = mutate(db => {
    const r = db.requests.find(x => x.id === reqId);
    if (!r) return { err: 404 };
    if (r.status !== 'pending') return { err: 400 };
    r.status = 'rejected';
    r.message = 'Rejected by ' + req.user.username + (reason ? ' — ' + reason : '');
    r.approval = 'manual';
    r.rejectedBy = req.user.username;
    r.rejectedAt = new Date().toISOString();
    delete r.payload;
    refundDailySlot(db, r);
    return { rec: r };
  });
  if (out.err === 404) return res.status(404).json({ error: 'Not found' });
  if (out.err === 400) return res.status(400).json({ error: 'Only pending requests can be rejected' });
  notify('rejected', out.rec);
  res.json({ ok: true, ...out.rec });
});

// ── Helpers to normalise Audible-shaped products into BookSeerr card items ────
function stripHtml(s){ return String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(); }
function audibleImage(p){
  const pi = p && (p.product_images || p.productImages);
  if (pi && typeof pi === 'object') { const keys = Object.keys(pi); const big = pi['500'] || pi['900'] || (keys.length ? pi[keys[keys.length-1]] : ''); if (big) return String(big); }
  return p.cover || p.coverUrl || p.image || p.imageUrl || '';
}
function names(arr){ return Array.isArray(arr) ? arr.map(a => (typeof a === 'string' ? a : (a && (a.name || a.authorName)) || '')).filter(Boolean).join(', ') : ''; }
function mapAudibleProduct(p){
  return {
    title: p.title || '',
    author: names(p.authors) || p.author || '',
    narrator: names(p.narrators) || p.narrator || '',
    image: audibleImage(p),
    year: (p.release_date || p.releaseDate || p.issue_date || '').toString().slice(0, 10),
    description: stripHtml(p.merchandising_summary || p.publisher_summary || p.description || '').slice(0, 240),
    asin: p.asin || '',
    key: p.asin || '',
    source: 'Audible',
    audio: true
  };
}
function arrify(data){
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  return data.products || data.results || data.items || data.books || data.searchResults || [];
}

// ── Audible catalog browse for Discover (recent + upcoming audiobooks) ────────
// Sorted by -ReleaseDate, Audible hands back the FURTHEST-FUTURE titles first. One
// page of 50 was therefore 50 pre-orders and not a single released book, so the
// "Recently Released Audiobooks" row was always empty while "Upcoming" was full —
// measured live: page 0 = 50 future / 0 past, page 1 = 42/8, page 2 = 0/50. Three
// pages straddle the boundary and fill both rows.
const AUDIBLE_PAGES = 3;
async function audibleCatalog(){
  const pageUrl = (page) => {
    const params = new URLSearchParams({
      num_results: '50',
      products_sort_by: '-ReleaseDate',
      response_groups: 'contributors,media,product_desc,product_attrs,series',
      image_sizes: '500,900',
      page: String(page)
    });
    if (AUDIBLE_CATEGORY_ID) params.set('category_id', AUDIBLE_CATEGORY_ID);
    return AUDIBLE_BASE + '/1.0/catalog/products?' + params.toString();
  };
  const pages = await Promise.all(
    Array.from({ length: AUDIBLE_PAGES }, (_, i) => requestJson(pageUrl(i)).then(r => r.data).catch(() => null))
  );
  const seen = {}, items = [];
  for (const data of pages) {
    for (const p of arrify(data)) {
      const b = mapAudibleProduct(p);
      const id = (b.asin || b.title).toLowerCase();
      if (!b.title || seen[id]) continue;
      seen[id] = 1; items.push(b);
    }
  }
  if (!items.length) throw new Error('Audible returned no products');   // don't cache an empty catalog
  const today = todayKey();
  const recent = items.filter(b => b.year && b.year <= today).sort((a,b) => (b.year || '').localeCompare(a.year || ''));
  const upcoming = items.filter(b => b.year && b.year > today).sort((a,b) => (a.year || '').localeCompare(b.year || ''));
  // Both rows empty means the fetch failed, not that Audible has no catalogue —
  // throwing keeps cached() serving the last good copy instead of two blank rows.
  if (!recent.length && !upcoming.length) throw new Error('Audible returned no dated products');
  return { recent, upcoming };
}

// ── Discover caching ─────────────────────────────────────────────────────────
// These two rows were the only upstream reads in the whole app NOT going through
// the shared cache: every visit to Discover — by every user, on every page load —
// fired four Google Books queries plus an Audible catalog fetch. That's what
// exhausted the daily Google quota (the anonymous fallback was returning HTTP 429
// "Quota exceeded"). The underlying data changes daily at most, so a 30-minute
// window keeps the rows fresh while collapsing all that traffic into one fetch.
const DISCOVER_TTL_MS = parseInt(process.env.DISCOVER_TTL_MINUTES || '30', 10) * 60 * 1000;
// The eBook row fans out to ~24 Google Books queries (it has to ask for each subject
// by year — see googleNewBooks), so refreshing it every 30 minutes would be ~1,150
// calls a day and straight past the free quota. New books do not appear hourly, so
// this row gets a longer window of its own; everything else keeps DISCOVER_TTL.
const NEW_BOOKS_TTL_MS = Math.max(DISCOVER_TTL_MS, 6 * 60 * 60 * 1000);
const googleNewBooksCached = () => cached('gb:new', NEW_BOOKS_TTL_MS, googleNewBooks);
const audibleCatalogCached = () => cached('audible:catalog', DISCOVER_TTL_MS, audibleCatalog);

// ── Discover eBooks: pull genuinely recent releases from Google Books ──────────
// Strategy: query several subjects newest-first, merge + dedupe, then keep only
// books published recently (this year / last year) so the rows are ALWAYS current.
// The subject set rotates by day so the rows feel fresh on repeat visits, while
// the date filter guarantees nothing stale slips in.
const GB_SUBJECTS = ['fiction','nonfiction','mystery','thriller','fantasy','science fiction','romance','biography','history','young adult','horror','poetry'];
function gbMap(v){
  const vi = v.volumeInfo || {};
  return {
    title: vi.title || '',
    author: Array.isArray(vi.authors) ? vi.authors.join(', ') : '',
    image: (vi.imageLinks?.thumbnail || vi.imageLinks?.smallThumbnail || '').replace(/^http:/, 'https:'),
    year: (vi.publishedDate || '').slice(0, 4),
    pubDate: vi.publishedDate || '',
    description: (vi.description || '').slice(0, 240),
    source: 'Google Books',
    key: v.id || ''
  };
}
// Google Books IGNORES orderBy=newest. Verified against the live API: `subject:fiction`
// with orderBy=newest, orderBy=relevance, and no filters at all return the byte-identical
// list, headed by a 1992 title — so this row was quietly serving 1997-2019 books under a
// "New & Trending" heading. Only 2 of 20 results were even from the last two years, the
// "thin row" fallback below fired every single time, and the stale list got cached.
//
// The year IS honoured as a query TERM, so each subject is asked for explicitly by year.
// That fans out wider (subjects x 2 years x 2 pages), hence the longer cache window on
// this row — see NEW_BOOKS_TTL_MS.
const GB_SUBJECT_COUNT = 6;
const GB_PAGES = 2;
async function googleNewBooks(){
  const now = new Date();
  const year = now.getFullYear();
  // Subjects shift each day (stable within a day) for variety.
  const dayIdx = Math.floor(Date.now() / 86400000);
  const subjects = [];
  for (let i = 0; i < GB_SUBJECT_COUNT; i++) subjects.push(GB_SUBJECTS[(dayIdx + i * 3) % GB_SUBJECTS.length]);
  const queries = [];
  for (const s of subjects) {
    for (const y of [year, year - 1]) {
      for (let page = 0; page < GB_PAGES; page++) {
        queries.push(GB_BASE + '/volumes?q=' + encodeURIComponent('subject:' + s + ' ' + y) +
          '&orderBy=newest&maxResults=40&startIndex=' + (page * 40) +
          '&printType=books&langRestrict=en' + (GB_KEY ? '&key=' + GB_KEY : ''));
      }
    }
  }
  const results = await Promise.all(queries.map(u => requestJson(u).then(r => r.data).catch(() => ({}))));
  const merged = [];
  const seen = {};
  for (const data of results) {
    const items = Array.isArray(data && data.items) ? data.items : [];
    for (const v of items) {
      const b = gbMap(v);
      const id = (b.key || b.title).toLowerCase();
      // A card needs a cover to look right, and an author + a real blurb to be worth
      // showing (and requestable — Chaptarr is added BY AUTHOR). Asking Google Books
      // for a specific year surfaces a lot of catalogues and listings; this drops them.
      if (!b.title || !b.image || !b.author || (b.description || '').length < 60 || seen[id]) continue;
      seen[id] = 1; merged.push(b);
    }
  }
  // Keep only recent releases (last year → next year), newest first. There is NO
  // "fall back to whatever we got" any more: a row headed "New & Trending" showing
  // 1997 is worse than a short row, and the fallback is what hid this bug for so long.
  const list = merged
    .filter(b => { const y = parseInt(b.year, 10); return y && y >= year - 1 && y <= year + 1; })
    .sort((a, b) => (b.pubDate || '').localeCompare(a.pubDate || ''));
  // Nothing recent at all means the queries failed (rate limit, outage, bad API key).
  // Throw rather than return [] so the cache doesn't store the emptiness for the whole
  // TTL — cached() keeps serving the last good row instead of "No eBooks found".
  if (!list.length) throw new Error('Google Books returned no recent results');
  return list.slice(0, 40);
}

// ── Discover: "Top of all time" lists ─────────────────────────────────────────
// Curated, time-tested classics. We look each title up so the cards get real
// covers/metadata and a working request key, exactly like the other rows.
// Results are cached in-memory for a day (these lists don't change minute-to-minute)
// so Discover stays snappy and we don't hammer the upstream APIs on every visit.
const TOP_EBOOKS = [
  ['To Kill a Mockingbird', 'Harper Lee'],
  ['1984', 'George Orwell'],
  ['Pride and Prejudice', 'Jane Austen'],
  ['The Great Gatsby', 'F. Scott Fitzgerald'],
  ['One Hundred Years of Solitude', 'Gabriel García Márquez'],
  ['The Catcher in the Rye', 'J. D. Salinger'],
  ['Crime and Punishment', 'Fyodor Dostoevsky'],
  ['The Lord of the Rings', 'J. R. R. Tolkien'],
  ['Brave New World', 'Aldous Huxley'],
  ['Jane Eyre', 'Charlotte Brontë'],
  ['Moby-Dick', 'Herman Melville'],
  ['War and Peace', 'Leo Tolstoy'],
  ['The Hobbit', 'J. R. R. Tolkien'],
  ['Fahrenheit 451', 'Ray Bradbury'],
  ['Wuthering Heights', 'Emily Brontë'],
  ['Beloved', 'Toni Morrison'],
  ['The Brothers Karamazov', 'Fyodor Dostoevsky'],
  ['Frankenstein', 'Mary Shelley'],
  ['The Grapes of Wrath', 'John Steinbeck'],
  ['Lolita', 'Vladimir Nabokov'],
  ['Don Quixote', 'Miguel de Cervantes'],
  ['Catch-22', 'Joseph Heller'],
  ['The Odyssey', 'Homer'],
  ['Anna Karenina', 'Leo Tolstoy']
];
const TOP_AUDIOBOOKS = [
  ['The Martian', 'Andy Weir'],
  ['Project Hail Mary', 'Andy Weir'],
  ['Born a Crime', 'Trevor Noah'],
  ['Becoming', 'Michelle Obama'],
  ['The Name of the Wind', 'Patrick Rothfuss'],
  ['Educated', 'Tara Westover'],
  ['Sapiens', 'Yuval Noah Harari'],
  ['Dune', 'Frank Herbert'],
  ['The Way of Kings', 'Brandon Sanderson'],
  ['Daisy Jones & The Six', 'Taylor Jenkins Reid'],
  ['World War Z', 'Max Brooks'],
  ['Lincoln in the Bardo', 'George Saunders'],
  ['American Gods', 'Neil Gaiman'],
  ['The Hitchhiker\'s Guide to the Galaxy', 'Douglas Adams'],
  ['A Gentleman in Moscow', 'Amor Towles'],
  ['Atomic Habits', 'James Clear'],
  ['Where the Crawdads Sing', 'Delia Owens'],
  ['The Silent Patient', 'Alex Michaelides']
];
const TOP_TTL_MS = 24 * 60 * 60 * 1000;

// ── Open Library: the keyless fallback for eBook metadata ─────────────────────
// Google Books can go dark for days: live (2026-10-23/24) every keyed query came back
// 503 "backendFailed" and the keyless quota was spent (429), which emptied eBook search
// and every Google-fed Discover row. Open Library needs no key and answers the same
// two questions — "find books matching this" and "find this one title" — so both fall
// back to it rather than to nothing. Covers come from its cover service.
const OL_BASE = (process.env.OPENLIBRARY_BASE || 'https://openlibrary.org').replace(/\/$/, '');
const OL_COVERS = (process.env.OPENLIBRARY_COVERS || 'https://covers.openlibrary.org').replace(/\/$/, '');
const OL_FIELDS = 'key,title,author_name,first_publish_year,cover_i,first_sentence';
function olMap(d){
  const first = Array.isArray(d.first_sentence) ? d.first_sentence[0] : d.first_sentence;
  return {
    title: d.title || '',
    author: Array.isArray(d.author_name) ? d.author_name.join(', ') : '',
    image: d.cover_i ? OL_COVERS + '/b/id/' + d.cover_i + '-L.jpg' : '',
    year: d.first_publish_year ? String(d.first_publish_year) : '',
    description: String(first || '').slice(0, 240),
    source: 'Open Library',
    key: d.key || ''
  };
}
async function openLibrarySearch(params){
  const r = await requestJson(OL_BASE + '/search.json?' + new URLSearchParams(Object.assign({ fields: OL_FIELDS }, params)));
  if (r.status < 200 || r.status >= 300 || !r.data || !Array.isArray(r.data.docs)) throw new Error('Open Library returned status ' + r.status);
  return r.data.docs.map(olMap).filter(b => b.title);
}

// Look up one title on Google Books (Open Library if Google won't answer) and return a
// card-shaped eBook (or null).
async function gbLookupOne(title, author){
  try {
    const q = 'intitle:' + title + '+inauthor:' + author;
    const url = GB_BASE + '/volumes?q=' + encodeURIComponent(q) +
      '&maxResults=5&printType=books&langRestrict=en' + (GB_KEY ? '&key=' + GB_KEY : '');
    const r = await requestJson(url);
    const items = Array.isArray(r.data && r.data.items) ? r.data.items : [];
    for (const v of items) {
      const b = gbMap(v);
      if (b.title && b.image) return b; // first hit that has a usable cover
    }
  } catch { /* fall through to Open Library */ }
  try {
    const docs = await openLibrarySearch({ title, author, limit: '5' });
    return docs.find(b => b.image) || null;
  } catch { /* best-effort */ }
  return null;
}
// These two rows are the most expensive thing Discover does: each is ~20 individual
// upstream lookups. They now go through cached(), which matters for more than the
// TTL — it gives them IN-FLIGHT DEDUPE. Previously three users opening Discover at
// the same moment each fired the full fan-out, and with retries a rate-limited
// Google Books turned one page view into hundreds of requests, which is how the
// daily quota gets burned in the first place. Now concurrent callers share one fetch.
// Throwing on a thin result keeps a half-empty row out of the 24h cache (cached()
// then serves the previous good row) instead of freezing it in place for a day.
const CACHE_QUORUM = 0.6;
async function topEbooks(){
  return cached('top:ebooks', TOP_TTL_MS, async () => {
    const found = await Promise.all(TOP_EBOOKS.map(([t,a]) => gbLookupOne(t, a)));
    const data = found.filter(Boolean);
    if (data.length < TOP_EBOOKS.length * CACHE_QUORUM) throw new Error('too few Top eBooks resolved (' + data.length + '/' + TOP_EBOOKS.length + ')');
    return data;
  });
}

// Look up one audiobook on Audible (via Listenarr if available) and return a card.
async function audibleLookupOne(title, author){
  const kw = title + ' ' + author;
  if (CFG.listenarrUrl && CFG.listenarrKey) {
    try {
      const r = await requestJson(CFG.listenarrUrl + '/api/v1/search/audible?query=' + encodeURIComponent(kw) + '&region=' + encodeURIComponent(AUDIBLE_REGION), 'GET', null, listenarrHeaders());
      if (r.status >= 200 && r.status < 300) {
        const hit = arrify(r.data).map(mapAudibleProduct).find(b => b.title && b.image && b.asin);
        if (hit) return { ...hit, source: 'Listenarr · Audible' };
      }
    } catch { /* fall through to direct Audible */ }
  }
  try {
    const params = new URLSearchParams({ keywords: kw, num_results: '5', response_groups: 'contributors,media,product_desc,product_attrs', image_sizes: '500,900' });
    const r = await requestJson(AUDIBLE_BASE + '/1.0/catalog/products?' + params.toString());
    const hit = arrify(r.data).map(mapAudibleProduct).find(b => b.title && b.image && b.asin);
    if (hit) return hit;
  } catch { /* best-effort */ }
  return null;
}
async function topAudiobooks(){
  return cached('top:audio', TOP_TTL_MS, async () => {
    const found = await Promise.all(TOP_AUDIOBOOKS.map(([t,a]) => audibleLookupOne(t, a)));
    const data = found.filter(Boolean);
    if (data.length < TOP_AUDIOBOOKS.length * CACHE_QUORUM) throw new Error('too few Top audiobooks resolved (' + data.length + '/' + TOP_AUDIOBOOKS.length + ')');
    return data;
  });
}

// ── Discover: "For you" — rows grown from what's already in the library ────────
// The rows further down are the same on every server: what's new on Audible and a
// fixed list of classics. These are built from THIS library — Listenarr's audiobooks
// (each carries its Audible ASIN), Chaptarr's authors, and what the signed-in user has
// requested — so they read like the shelf they came from, plus two rows that step just
// outside it on purpose. Audible supplies the "listeners also enjoyed" links
// (/catalog/products/{asin}/sims), the genre ladders and the author/genre browsing, all
// without a key. Google Books plays no part.
const RECS_TTL_MS = 6 * 60 * 60 * 1000;                // one user's finished rows
const RECS_EMPTY_TTL_MS = 10 * 60 * 1000;              // …but an empty library is re-checked soon
const AUDIBLE_SLOW_TTL_MS = 3 * 24 * 60 * 60 * 1000;   // "also enjoyed" lists, title genres, an author's best-known titles
const AUDIBLE_NEW_TTL_MS = 24 * 60 * 60 * 1000;        // an author's newest releases, genre bestsellers
const RECS_RG = 'contributors,media,product_attrs,product_desc,category_ladders';
// A cold build is ~60 Audible reads; four at a time keeps it a few seconds without
// looking like a flood to Audible.
const audibleReads = limiter(4);
async function audibleJson(pathAndQuery){
  const r = await audibleReads(() => requestJson(AUDIBLE_BASE + pathAndQuery));
  if (r.status < 200 || r.status >= 300 || !r.data || typeof r.data !== 'object') throw new Error('Audible returned status ' + r.status);
  return r.data;
}
// Audible credits translators and foreword writers as authors ("Michel Pagel - traducteur").
const creditName = s => String(s || '').split(' - ')[0].trim();
// The same work whatever the edition: "(Unabridged)", "[Dramatized]", "…: A Novel" and
// "…: The Complete Edition" don't make it a different book (the shelf's "World War Z:
// The Complete Edition" kept recommending "World War Z"). Real subtitles stay — "Dune:
// House Atreides" and "Dune: House Harkonnen" are not the same book.
const workTitle = s => noSeries(String(s || '')
  .replace(/\s*[:;]\s*an?\s+(novel|novella|thriller|memoir|mystery|story)\b.*$/i, '')
  .replace(/\s*[:;]\s*(the\s+)?[\w'&\s-]{0,30}\bedition\b.*$/i, ''));
const workKey = (title, author) => workTitle(title) + '|' + norm(creditName(String(author || '').split(',')[0]));
// What the rows need from an Audible product — about a sixth of the full record.
function recProduct(p){
  if (!p || !p.asin || !p.title) return null;
  const authors = (Array.isArray(p.authors) ? p.authors : []).map(a => creditName(a && a.name)).filter(Boolean);
  return Object.assign(mapAudibleProduct(p), {
    author: authors.join(', '),
    authors,
    language: String(p.language || '').toLowerCase(),
    adult: !!p.is_adult_product,
    contentType: String(p.content_type || ''),
    // [[{id, name}, …], …] — each ladder root-first, as Audible lists them
    ladders: (Array.isArray(p.category_ladders) ? p.category_ladders : [])
      .map(l => (Array.isArray(l && l.ladder) ? l.ladder : []).map(c => ({ id: String(c.id), name: String(c.name || '') })))
      .filter(l => l.length)
  });
}
const audibleAlsoLiked = asin => cached('aud:sims:' + asin, AUDIBLE_SLOW_TTL_MS, async () => {
  const d = await audibleJson('/1.0/catalog/products/' + encodeURIComponent(asin) + '/sims?' + new URLSearchParams({ similarity_type: 'RawSimilarities', num_results: '30', response_groups: RECS_RG, image_sizes: '500,900' }));
  return arrify(d.similar_products).map(recProduct).filter(Boolean);
});
// `top` = the author's best-known titles (a seed to find similar ones from), `new` = their
// newest releases. Audible's author filter is a keyword match — "Stephen King" also
// brings back Stephen R. King and anthologies that merely include him — so only titles
// whose FIRST credited author is this one are kept.
const audibleByAuthor = (name, sort) => cached('aud:author:' + sort + ':' + norm(name), sort === 'new' ? AUDIBLE_NEW_TTL_MS : AUDIBLE_SLOW_TTL_MS, async () => {
  const d = await audibleJson('/1.0/catalog/products?' + new URLSearchParams({ author: name, products_sort_by: sort === 'new' ? '-ReleaseDate' : 'BestSellers', num_results: '40', response_groups: RECS_RG, image_sizes: '500,900' }));
  return arrify(d.products).map(recProduct).filter(p => p && p.authors.length && norm(p.authors[0]) === norm(name));
});
const audibleBestsellers = catId => cached('aud:best:' + catId, AUDIBLE_NEW_TTL_MS, async () => {
  const d = await audibleJson('/1.0/catalog/products?' + new URLSearchParams({ category_id: catId, products_sort_by: 'BestSellers', num_results: '40', response_groups: RECS_RG, image_sizes: '500,900' }));
  return arrify(d.products).map(recProduct).filter(Boolean);
});
// Genres of the library's own titles: asked for in bulk (?asins=, 40 per call) and kept
// per ASIN, since a title's categories don't change — a new arrival costs one lookup.
const libraryLadders = new Map();   // asin (lower case) → { at, ladders }
async function fillLibraryLadders(asins){
  const now = Date.now();
  const missing = asins.filter(a => { const e = libraryLadders.get(a); return !e || now - e.at > AUDIBLE_SLOW_TTL_MS; });
  for (let i = 0; i < missing.length; i += 40) {
    const chunk = missing.slice(i, i + 40);
    let products = [];
    try { products = arrify((await audibleJson('/1.0/catalog/products?' + new URLSearchParams({ asins: chunk.join(',').toUpperCase(), response_groups: 'category_ladders' }))).products); }
    catch { continue; }   // try again on the next build
    // Remembered even when Audible has nothing for it (delisted titles), so it isn't
    // asked for again on every build.
    chunk.forEach(a => libraryLadders.set(a, { at: now, ladders: [] }));
    for (const p of products) {
      const rp = recProduct(Object.assign({ title: p.title || p.asin }, p));
      if (rp) libraryLadders.set(String(rp.asin).toLowerCase(), { at: now, ladders: rp.ladders });
    }
  }
}
// Too broad to make a row of ("Popular in Genre Fiction" says nothing).
const GENERIC_GENRES = new Set(['genre fiction', 'literary fiction', 'literature & fiction', 'fiction', 'general']);
// Every category a title sits in below the root, once each.
function genreNodes(ladders){
  const out = new Map();
  for (const l of ladders || []) l.forEach((c, depth) => {
    if (depth >= 1 && c.id && !GENERIC_GENRES.has(c.name.toLowerCase())) out.set(c.id, { id: c.id, name: c.name, depth, parent: l[depth - 1].name, root: l[0].name });
  });
  return [...out.values()];
}
const genreLabel = g => g.depth >= 2 ? g.name + ' (' + g.parent + ')' : g.name;
// Stable within a day, different tomorrow: the rows shouldn't settle into one fixed list.
const dayIndex = () => Math.floor(Date.now() / 86400000);
function rotate(list, n, salt){
  if (list.length <= n) return list.slice();
  const start = (dayIndex() * 7 + (salt || 0)) % list.length;
  return list.slice(start).concat(list.slice(0, start)).slice(0, n);
}
const dateKeyFromNow = days => new Date(Date.now() + days * 86400000).toLocaleDateString('en-CA');
const shortDate = d => { const t = new Date(d + 'T12:00:00'); return isNaN(t.getTime()) ? d : t.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
// Only the fields a card and a request read. The working records carry genre ladders
// and author lists that would just bloat every card's payload.
const audioCard = (p, why) => ({ title: p.title, author: p.author, narrator: p.narrator, image: p.image, year: p.year, description: p.description, asin: p.asin, key: p.asin, source: 'Audible', audio: true, why });
// The eBook of an audiobook doesn't carry the audio edition's trimmings.
const ebookTitle = t => String(t || '').replace(/\s*[([](?:dramati[sz]ed[^)\]]*|unabridged|abridged|full[- ]cast[^)\]]*)[)\]]/gi, '').trim();
const ebookCard = (p, why) => ({ title: ebookTitle(p.title), author: p.author, image: p.image, year: String(p.year || '').slice(0, 4), description: p.description, source: 'Recommended', key: '', why });
// Why a title is in the pool, in the words of the side that put it there.
const becauseOf = e => e.why.audio ? 'Because you have ' + e.why.audio : 'Because you read ' + e.why.ebook;

async function buildForYou(user){
  const laOn = !!(CFG.listenarrUrl && CFG.listenarrKey), chOn = !!(CFG.chaptarrUrl && CFG.chaptarrKey);
  const [la, ch] = await Promise.all([
    laOn ? getListenarrLibrary().catch(() => []) : [],
    chOn ? withBudget(getChaptarrAuthors(), 20000).then(x => x || []) : []
  ]);
  if (!la.length && !ch.length) return { rows: [], note: 'Recommendations appear once Chaptarr or Listenarr has some books in it.' };

  // ── What is already here ──
  const ownedAsins = new Set(), ownedWorks = new Set();
  const libAuthors = new Map();   // norm(name) → { name, titles (Listenarr), files (Chaptarr) }
  const addAuthor = (name, titles, files) => {
    const n = norm(creditName(name)); if (!n) return;
    const e = libAuthors.get(n) || { name: creditName(name), titles: 0, files: 0 };
    e.titles += titles; e.files += files; libAuthors.set(n, e);
  };
  const langs = {};
  for (const it of la) {
    const authors = (Array.isArray(it.authors) ? it.authors : [it.author]).map(creditName).filter(Boolean);
    if (laAsin(it)) ownedAsins.add(laAsin(it));
    ownedWorks.add(workKey(laTitle(it), authors[0]));
    if (authors[0]) addAuthor(authors[0], 1, 0);
    const lang = String(it.language || '').toLowerCase();
    if (lang) langs[lang] = (langs[lang] || 0) + 1;
  }
  for (const a of ch) addAuthor(a.authorName, 0, a.files || 0);
  // Recommend in the language the shelf is in: Audible's "also enjoyed" lists mix in
  // translations ("Proyecto Hail Mary" next to "Project Hail Mary").
  const language = (Object.entries(langs).sort((x, y) => y[1] - x[1])[0] || ['english'])[0];
  let reqIdx = null, mine = [];
  try {
    const db = loadDB();
    reqIdx = buildRequestIndex(db);
    if (user && !user.viaApiKey) mine = (db.requests || []).filter(r => r.userId === user.id && ACTIVE_REQUEST_STATUSES.includes(r.status)).slice(-12).reverse();
  } catch { /* requests only refine the rows */ }
  const requested = (p, kind) => !!(reqIdx && lookupExistingRequest(reqIdx, { kind: kind || 'audio', title: p.title, author: p.author, asin: p.asin }));
  const owned = p => ownedAsins.has(String(p.asin).toLowerCase()) || ownedWorks.has(workKey(p.title, p.authors[0]));
  const usable = p => !!p && p.language === language && !p.adult && !!p.image && p.authors.length > 0 && !/podcast|episode|show/i.test(p.contentType);
  // Pre-orders belong in "New From Your Authors"; everywhere else a card should be
  // something that can be had today.
  const today = todayKey();
  const released = p => !p.year || String(p.year).slice(0, 10) <= today;
  // An eBook the shelf already has — only answerable for authors whose book list is
  // already cached; fetching Stephen King's 2,400 records for this would be absurd. The
  // card's "✓ In library" badge check covers the rest.
  const chByName = new Map(ch.map(a => [norm(a.authorName), a]));
  const ownsEbook = p => {
    const a = chByName.get(norm(p.authors[0])); if (!a) return false;
    const e = upCache.get('ch:books:' + a.id);
    const b = e && Array.isArray(e.data) ? findBookByTitle(ebookBooks(e.data), p.title) : null;
    return chBookHasFiles(b);
  };

  // ── Seeds: what the recommendations grow from ──
  // The user's own requests count most (the clearest signal there is), then the newest
  // arrivals (what the household is into NOW), then a handful of older titles that
  // changes daily. No author gets more than two seeds, so one prolific favourite can't
  // drown out the rest of the shelf.
  const seeds = [], perAuthor = {};
  const takeSeed = (asin, title, author, weight) => {
    const a = norm(author), key = String(asin || '').toLowerCase();
    if (!key || (perAuthor[a] || 0) >= 2 || seeds.some(s => s.asin === key)) return;
    perAuthor[a] = (perAuthor[a] || 0) + 1;
    seeds.push({ asin: key, title, author, weight });
  };
  mine.filter(r => r.kind === 'audio' && r.asin).forEach(r => takeSeed(r.asin, r.title, creditName(String(r.author || '').split(',')[0]), 2));
  const shelf = la.filter(it => laAsin(it) && laState(it) !== 'missing').sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0));
  const seedRow = it => takeSeed(laAsin(it), laTitle(it), creditName((it.authors || [])[0]), shelf.indexOf(it) < 8 ? 1.5 : 1);
  shelf.slice(0, 8).forEach(seedRow);
  rotate(shelf.slice(8), 10, 1).forEach(seedRow);
  // The eBook side: Chaptarr authors with books on the shelf, seeded through their
  // best-known audiobook. Same pattern — the biggest shelves plus a daily rotation —
  // and the user's own eBook/author requests first.
  const seededAuthors = new Set(seeds.map(s => norm(s.author)));
  const authorSeeds = [];
  const takeAuthor = (name, weight) => { const n = norm(name); if (n && !seededAuthors.has(n) && !authorSeeds.some(a => norm(a.name) === n)) authorSeeds.push({ name, weight }); };
  mine.filter(r => r.kind !== 'audio').forEach(r => takeAuthor(creditName(String(r.sentAsAuthor || r.author || r.title || '').split(',')[0]), 1.5));
  const shelfAuthors = ch.filter(a => (a.files || 0) > 0).sort((a, b) => (b.files || 0) - (a.files || 0));
  shelfAuthors.slice(0, 6).concat(rotate(shelfAuthors.slice(6), 4, 2))
    .forEach(a => takeAuthor(a.authorName, 0.6 + Math.min(0.8, Math.log2(1 + a.files) / 10)));
  if (!seeds.length && !authorSeeds.length) return { rows: [], note: 'Recommendations appear once Chaptarr or Listenarr has some books in it.' };

  // Seeds are matched lower-case (laAsin); Audible wants ASINs as it issues them.
  const simLists = await Promise.all(seeds.map(s => audibleAlsoLiked(s.asin.toUpperCase()).catch(() => [])));
  const authorTops = await Promise.all(authorSeeds.map(a => audibleByAuthor(a.name, 'top').then(l => l.find(usable) || null).catch(() => null)));
  const authorSims = await Promise.all(authorTops.map(p => p ? audibleAlsoLiked(p.asin).catch(() => []) : []));

  // ── The pool: everything those seeds point at, scored ──
  // A title listed by several seeds outranks one listed once, and a seed's first
  // suggestions count for more than its thirtieth.
  const pool = new Map();   // workKey → entry
  const consider = (list, weight, because, side) => (list || []).forEach((p, i) => {
    if (!usable(p) || owned(p) || !released(p)) return;
    const wk = workKey(p.title, p.authors[0]);
    const s = weight / Math.sqrt(i + 1);
    let e = pool.get(wk);
    if (!e) { e = { p, score: 0, audio: 0, ebook: 0, why: { audio: null, ebook: null }, best: { audio: 0, ebook: 0 }, seeds: new Set() }; pool.set(wk, e); }
    e.score += s; e[side] += s; e.seeds.add(because);
    if (s > e.best[side]) { e.best[side] = s; e.why[side] = because; }
  });
  seeds.forEach((s, i) => consider(simLists[i], s.weight, s.title, 'audio'));
  authorSeeds.forEach((a, i) => consider(authorSims[i], a.weight, a.name, 'ebook'));

  const rows = [];
  const shown = new Set();   // each title appears on one row only
  // reuse: a title already on an audiobook row may still be offered as an eBook — it's
  // the other format, and a small library would otherwise leave the eBook row empty.
  const pick = (cands, n, capPerAuthor, ofP, reuse) => {
    const out = [], per = {};
    for (const c of cands) {
      if (out.length >= n) break;
      const p = ofP ? ofP(c) : c;
      const a = norm(p.authors[0]);
      if ((per[a] || 0) >= capPerAuthor || (!reuse && shown.has(p.asin))) continue;
      per[a] = (per[a] || 0) + 1; shown.add(p.asin); out.push(c);
    }
    return out;
  };
  const entries = [...pool.values()];

  // 1. Audiobooks like the ones on the shelf
  const audioRanked = entries.filter(e => !requested(e.p)).sort((a, b) => (b.audio - a.audio) || (b.score - a.score));
  rows.push({ id: 'for-you-audio', kind: 'audio', title: 'Recommended Audiobooks', subtitle: 'Listeners who enjoyed what\'s on your shelf also loved these',
    items: pick(audioRanked, 24, 3, e => e.p).map(e => audioCard(e.p, becauseOf(e))) });

  // 2. eBooks — the same pool, ranked by the Chaptarr side. An author Chaptarr already
  // collects eBooks for is monitored as a whole, so their next book arrives by itself;
  // recommending it is mostly noise. Those still qualify, but well down the list.
  const collected = p => { const a = chByName.get(norm(p.authors[0])); return !!(a && authorHasEbook(a)); };
  const ebookScore = e => (e.ebook + e.audio * 0.5) * (collected(e.p) ? 0.35 : 1);
  const ebookRanked = entries.filter(e => !requested(e.p, 'book') && !ownsEbook(e.p)).sort((a, b) => ebookScore(b) - ebookScore(a));
  let ebookPicks = pick(ebookRanked, 24, 2, e => e.p);
  if (ebookPicks.length < 8) ebookPicks = ebookPicks.concat(pick(ebookRanked.filter(e => !ebookPicks.includes(e)), 24 - ebookPicks.length, 2, e => e.p, true));
  rows.push({ id: 'for-you-ebooks', kind: 'book', title: 'eBooks You Might Like', subtitle: 'Picked from the authors and books already in your library',
    items: ebookPicks.map(e => ebookCard(e.p, e.why.ebook ? 'Because you read ' + e.why.ebook : becauseOf(e))) });

  // 3. Authors who aren't on the shelf at all — the "never thought of them" row
  const byAuthor = new Map();
  for (const e of entries) {
    const n = norm(e.p.authors[0]);
    if (!n || libAuthors.has(n)) continue;
    const g = byAuthor.get(n) || { name: e.p.authors[0], score: 0, top: null };
    g.score += e.score;
    if (!g.top || e.score > g.top.score) g.top = e;
    byAuthor.set(n, g);
  }
  const newAuthors = [...byAuthor.values()]
    .filter(g => !(reqIdx && lookupExistingRequest(reqIdx, { kind: 'author', title: g.name, author: g.name })))
    .sort((a, b) => b.score - a.score).slice(0, 18);
  rows.push({ id: 'new-authors', kind: 'author', title: 'Authors You Might Like', subtitle: 'Not in your library yet — their readers overlap with yours',
    items: newAuthors.map(g => ({ name: g.name, image: g.top.p.image, description: 'Known for ' + g.top.p.title + (g.top.p.description ? '. ' + g.top.p.description : ''), source: 'Recommended', key: g.name, why: becauseOf(g.top) })) });

  // 4. New and upcoming releases from authors already on the shelf: what came out in
  // the last few months first (it can be had now), then what's coming soon. Re-issues
  // a year out are left for later.
  const favourites = [...libAuthors.values()]
    .sort((a, b) => (b.titles * 3 + Math.log2(1 + b.files)) - (a.titles * 3 + Math.log2(1 + a.files))).slice(0, 24);
  const newLists = await Promise.all(favourites.map(a => audibleByAuthor(a.name, 'new').catch(() => [])));
  const since = dateKeyFromNow(-150), until = dateKeyFromNow(90);
  const fresh = [];
  newLists.forEach((list, i) => {
    let k = 0;
    for (const p of list) {
      if (k >= 2) break;
      const d = String(p.year || '').slice(0, 10);
      if (!usable(p) || owned(p) || requested(p) || !d || d < since || d > until) continue;
      fresh.push({ p, d, author: favourites[i].name }); k++;
    }
  });
  const ordered = fresh.filter(f => f.d <= today).sort((a, b) => b.d.localeCompare(a.d))
    .concat(fresh.filter(f => f.d > today).sort((a, b) => a.d.localeCompare(b.d)));
  rows.push({ id: 'new-from-authors', kind: 'audio', title: 'New From Your Authors', subtitle: 'Recent and upcoming audiobooks from authors already in your library',
    items: pick(ordered, 24, 2, f => f.p).map(f => audioCard(f.p, f.d > today ? 'Coming ' + shortDate(f.d) : 'New from ' + f.author)) });

  // 5. The shelf's favourite genres, and one next to them it doesn't have yet
  const shelfAsins = la.map(laAsin).filter(Boolean);
  await fillLibraryLadders(shelfAsins);
  const libGenres = new Map();
  for (const a of shelfAsins) for (const g of genreNodes((libraryLadders.get(a) || {}).ladders)) {
    const x = libGenres.get(g.id) || Object.assign({ count: 0 }, g); x.count++; libGenres.set(g.id, x);
  }
  // A genre row is drawn from the pool first — titles in that genre that are ALSO like
  // the shelf. Audible's own bestseller list for a category only tops it up: on its own
  // it's dominated by whatever launched this week (light novels under Horror, romance
  // under Thriller & Suspense, live), which is popular but nothing like the shelf.
  const genreRow = async (g, id, title, subtitle, why) => {
    const fromPool = entries
      .filter(e => !requested(e.p) && genreNodes(e.p.ladders).some(x => x.id === g.id))
      .sort((a, b) => b.score - a.score).map(e => e.p);
    let items = pick(fromPool, 18, 2);
    if (items.length < 10) {
      const best = (await audibleBestsellers(g.id).catch(() => [])).filter(p => usable(p) && released(p) && !owned(p) && !requested(p));
      items = items.concat(pick(best, 18 - items.length, 2));
    }
    rows.push({ id, kind: 'audio', title, subtitle, items: items.map(p => audioCard(p, why)) });
  };
  const favGenres = [...libGenres.values()].filter(g => g.depth === 1).sort((a, b) => b.count - a.count).slice(0, 2);
  for (const g of favGenres) await genreRow(g, 'genre-' + g.id, 'Because You Like ' + g.name, g.count + ' of your audiobooks are ' + g.name, 'More ' + g.name);
  // "Something different": a genre the recommendations keep landing in that the shelf
  // has (almost) none of. Close enough to like, far enough to be new. Rotates daily.
  const poolGenres = new Map();
  for (const e of entries) for (const g of genreNodes(e.p.ladders)) {
    const x = poolGenres.get(g.id) || Object.assign({ count: 0 }, g); x.count++; poolGenres.set(g.id, x);
  }
  const favNames = new Set(favGenres.map(g => g.name.toLowerCase()));
  const nearby = [...poolGenres.values()]
    .filter(g => g.count >= 4 && ((libGenres.get(g.id) || {}).count || 0) <= 1 && !favNames.has(g.name.toLowerCase()) && !/erotica/i.test(g.root))
    .sort((a, b) => b.count - a.count).slice(0, 5);
  const different = rotate(nearby, 1, 3)[0];
  if (different) await genreRow(different, 'different-' + different.id, 'Something Different: ' + genreLabel(different), 'Close to what you like, but not on your shelf yet', 'Try ' + genreLabel(different));

  const out = rows.filter(r => r.items.length);
  // Seeds but nothing came back means Audible didn't answer — not a verdict to keep
  // for six hours. Throwing lets cached() serve the last good set instead.
  if (!out.length) throw new Error('Audible returned no recommendations');
  return { rows: out, generatedAt: new Date().toISOString(), basedOn: { audiobooks: la.length, authors: ch.length, seeds: seeds.length + authorSeeds.length } };
}
// Per user (their requests are part of the taste), stale-while-revalidate so a refresh
// never makes anyone wait: after six hours the old rows answer at once while new ones
// are built behind them.
const forYouCached = user => cached('recs:' + (user && !user.viaApiKey ? user.id : 'key'), d => (d && d.rows && d.rows.length ? RECS_TTL_MS : RECS_EMPTY_TTL_MS),
  () => buildForYou(user), { swr: 24 * 60 * 60 * 1000 });
app.get('/api/discover/for-you', auth, async (req,res)=>{
  try { res.json(await forYouCached(req.user)); }
  catch (e) { res.json({ rows: [], error: e.message }); }
});
// Fill the shared caches (similar titles, genres, author lists) shortly after boot and
// twice a day, so the first person to open Discover doesn't pay for the cold build.
function warmForYou(){ buildForYou(null).catch(() => {}); }

// ── Discover: eBooks (Google Books) + Audiobooks (Audible) ────────────────────
app.get('/api/discover', auth, async (req,res)=>{
  const out = { authors: [], ebooks: [], topEbooks: [], audioRecent: [], audioUpcoming: [], topAudio: [] };

  // eBooks + authors from Google Books (genuinely recent releases, refreshed daily)
  try {
    out.ebooks = await googleNewBooksCached();
    const seen = {};
    out.ebooks.forEach(b => {
      if (!b.author) return;
      // first listed author of each book → Trending Authors row
      const an = b.author.split(',')[0].trim();
      if (an && !seen[an.toLowerCase()]) { seen[an.toLowerCase()] = 1; out.authors.push({ name: an, image: b.image, description: b.description, source: 'Google Books', key: an }); }
    });
  } catch (e) { /* eBook discover is best-effort */ }

  // Audiobooks from Audible (recent + upcoming)
  try {
    const { recent, upcoming } = await audibleCatalogCached();
    out.audioRecent = recent.slice(0, 18);
    out.audioUpcoming = upcoming.slice(0, 18);
  } catch (e) { /* audiobook discover is best-effort */ }

  // "Top of all time" curated rows (cached daily; each is best-effort).
  const [te, ta] = await Promise.all([
    topEbooks().catch(() => []),
    topAudiobooks().catch(() => [])
  ]);
  out.topEbooks = te;
  out.topAudio = ta;

  res.json(out);
});

// ── Search: type "books" → Google Books, type "audio" → Listenarr/Audible ─────
// Dashboards can also pass:
//   ?type=all                 → search BOTH eBooks (Google Books) and audiobooks
//   ?minYear=YYYY&maxYear=YYYY → keep only results within a publication-year range
//   ?source=<substring>       → keep only results whose source matches (e.g. "audible")
//   ?limit=<n>                → cap each result list
app.get('/api/search', auth, async (req,res)=>{
  const q = (req.query.q || '').trim();
  const type = (req.query.type || '').trim().toLowerCase();
  if (!q) return res.json({ authors: [], books: [], audio: [] });

  // Post-filters applied to whichever lists we build below.
  const minYear = parseInt(req.query.minYear, 10) || 0;
  const maxYear = parseInt(req.query.maxYear, 10) || 0;
  const sourceFilter = String(req.query.source || '').trim().toLowerCase();
  const limit = req.query.limit != null ? Math.max(0, parseInt(req.query.limit, 10) || 0) : 0;
  const applyFilters = (arr) => {
    let a = Array.isArray(arr) ? arr : [];
    if (minYear) a = a.filter(x => (parseInt(x.year, 10) || 0) >= minYear);
    if (maxYear) a = a.filter(x => (parseInt(x.year, 10) || 0) <= maxYear);
    if (sourceFilter) a = a.filter(x => String(x.source || '').toLowerCase().includes(sourceFilter));
    if (limit) a = a.slice(0, limit);
    return a;
  };

  // ── Audiobook search (Listenarr's Audible-backed catalog, direct Audible fallback) ──
  async function searchAudio() {
    return cached('search:audio:' + AUDIBLE_REGION + ':' + q.toLowerCase(), SEARCH_TTL_MS, async () => {
    let audio = [];
    // Track whether ANY source actually answered. If they all errored we must not
    // cache the resulting empty list — same reasoning as the eBook path above.
    let answered = false;
    if (CFG.listenarrUrl && CFG.listenarrKey) {
      try {
        const r = await requestJson(CFG.listenarrUrl + '/api/v1/search/audible?query=' + encodeURIComponent(q) + '&region=' + encodeURIComponent(AUDIBLE_REGION), 'GET', null, listenarrHeaders());
        if (r.status >= 200 && r.status < 300) { answered = true; audio = arrify(r.data).filter(it => it && (it.title || it.Title)).map(it => ({ ...mapAudibleProduct(it), source: 'Listenarr · Audible' })); }
      } catch (e) { /* fall through to direct Audible */ }
    }
    if (!audio.length) {
      try {
        const params = new URLSearchParams({ keywords: q, num_results: '24', response_groups: 'contributors,media,product_desc,product_attrs', image_sizes: '500,900' });
        const r = await requestJson(AUDIBLE_BASE + '/1.0/catalog/products?' + params.toString());
        if (r.status >= 200 && r.status < 300) { answered = true; audio = arrify(r.data).filter(it => it && it.title).map(it => ({ ...mapAudibleProduct(it) })); }
      } catch (e) { /* leave empty */ }
    }
    if (!answered) throw new Error('No audiobook source answered');
    return audio;
    });
  }

  // ── eBook / author search (Google Books, with covers; Open Library when it's down) ──
  async function searchBooks() {
    return cached('search:books:' + q.toLowerCase(), SEARCH_TTL_MS, async () => {
    const url = GB_BASE + '/volumes?q=' + encodeURIComponent(q) + '&maxResults=20' + (GB_KEY ? '&key=' + GB_KEY : '');
    let books;
    try {
      const r = await requestJson(url);
      // An upstream failure is NOT "no results": a genuine 200-with-zero-hits caches,
      // a 503 (which Google Books hands out readily — for days at a time, live) falls
      // through to Open Library instead of blanking eBook search.
      if (r.status < 200 || r.status >= 300) throw new Error('Google Books returned status ' + r.status);
      const items = Array.isArray(r.data && r.data.items) ? r.data.items : [];
      books = items.map(v => ({ title: v.volumeInfo?.title || '', author: Array.isArray(v.volumeInfo?.authors) ? v.volumeInfo.authors.join(', ') : '', image: (v.volumeInfo?.imageLinks?.thumbnail || v.volumeInfo?.imageLinks?.smallThumbnail || '').replace(/^http:/, 'https:'), year: (v.volumeInfo?.publishedDate || '').slice(0, 4), description: (v.volumeInfo?.description || '').slice(0, 220), source: 'Google Books', key: v.id || '' })).filter(b => b.title);
    } catch (e) {
      // Both down → throw, so cached() keeps serving the last good answer rather than
      // storing an empty list for the full TTL.
      books = await openLibrarySearch({ q, limit: '20' });
    }
    const authors = []; const seen = {};
    books.forEach(b => { if (b.author) b.author.split(',').map(s => s.trim()).filter(Boolean).forEach(an => { if (!seen[an.toLowerCase()]) { seen[an.toLowerCase()] = 1; authors.push({ name: an, image: b.image, description: '', source: 'Google Books', key: an }); } }); });
    return { authors, books };
    });
  }

  try {
    if (type === 'audio') {
      const audio = applyFilters(await searchAudio());
      return res.json({ authors: [], books: [], audio });
    }
    if (type === 'all') {
      // Search both catalogs in parallel for a unified dashboard view.
      const [audio, be] = await Promise.all([
        searchAudio().catch(() => []),
        searchBooks().catch(() => ({ authors: [], books: [] }))
      ]);
      return res.json({
        authors: be.authors,
        books: applyFilters(be.books),
        audio: applyFilters(audio)
      });
    }
    // default → eBooks / authors
    const be = await searchBooks();
    res.json({ authors: be.authors, books: applyFilters(be.books), audio: [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Library check: is this title/author/audiobook ALREADY in the library? ─────
// Used by the search UI to flag results that are already present so users don't
// re-request something they already have — and, just as much, NOT to flag what isn't,
// so a request that would work isn't talked out of.
//   eBooks → Chaptarr: "in library" means Chaptarr has THAT book downloaded. It used to
//     mean "the author is in Chaptarr", which put "✓ In library" and an "already
//     there — request anyway?" prompt on books nobody had. Now an eBook whose author is
//     in Chaptarr but which isn't downloaded comes back with authorInLibrary (and
//     missing:true when Chaptarr has the record but no file) — requesting it searches
//     for exactly that book.
//   Authors → Chaptarr: in library when monitored for eBooks.
//   Audiobooks → Listenarr: matched by ASIN first, then by title/author; in library
//     when Listenarr has (or is downloading) the files, missing:true when it has the
//     title but never downloaded it.
// Query params: ?kind=book|author|audio  &title=  &author=  &asin=
// Response: { inLibrary, where: 'chaptarr'|'listenarr'|null, label, matchedTitle,
//             missing?, authorInLibrary?, alreadyRequested }
// Accents are folded first ("Brontë" → "bronte"): catalogues disagree on them.
function norm(s){ return String(s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); }
// Listenarr library rows: { title, authors: ["Stephen King", "Joe Hill - introduction"],
// narrators, asin, ... }. These readers also accept the older/alternative shapes so a
// Listenarr version change can't silently turn every check into "not in library".
const laAsin  = it => String((it && (it.asin || it.ASIN)) || (it && it.metadata && it.metadata.asin) || '').toLowerCase();
const laTitle = it => String((it && (it.title || it.Title)) || (it && it.metadata && it.metadata.title) || '');
// Where a Listenarr title stands. 1.3.x reports a status ('quality-match',
// 'quality-mismatch', 'downloading', 'wanted', 'missing', 'no-file') alongside
// fileCount/filePath. A row with no file information at all comes from a build that
// doesn't report it, and is taken at its word that it's in the library.
function laState(it){
  if (!it || typeof it !== 'object') return 'unknown';
  const s = String(it.status || '').toLowerCase();
  if (s === 'downloading') return 'downloading';
  const files = typeof it.fileCount === 'number' ? it.fileCount : Array.isArray(it.files) ? it.files.length : null;
  if ((files != null && files > 0) || it.filePath) return 'downloaded';
  if (s === 'quality-match' || s === 'quality-mismatch') return 'downloaded';
  if (s === 'wanted' || s === 'missing' || s === 'no-file' || files === 0) return 'missing';
  return 'unknown';
}
function audioCheckResult(hit, title){
  const matchedTitle = laTitle(hit) || title;
  const st = laState(hit);
  if (st === 'missing') return { inLibrary: false, missing: true, where: 'listenarr', label: 'In Listenarr but not downloaded yet — requesting it starts a search', matchedTitle };
  return { inLibrary: true, where: 'listenarr', label: st === 'downloading' ? 'Already downloading in Listenarr' : 'Already in Listenarr', matchedTitle };
}
// `book` is the matching eBook under `authorRow`, or null when it isn't in their list
// (or the list didn't arrive in time — either way, requesting it searches for it).
function ebookCheckResult(authorRow, book){
  if (book && chBookHasFiles(book)) return { inLibrary: true, where: 'chaptarr', label: 'Already in Chaptarr', matchedTitle: book.title };
  if (book) return { inLibrary: false, missing: true, authorInLibrary: true, where: 'chaptarr', label: 'In Chaptarr but not downloaded yet — requesting it starts a search', matchedTitle: book.title };
  return { inLibrary: false, authorInLibrary: true, where: 'chaptarr', label: authorRow.authorName + ' is already in Chaptarr — requesting this searches for just this book', matchedTitle: authorRow.authorName };
}
// Every name a check should look for: an author request is one name, an eBook result
// lists all of its authors ("Stephen King, Peter Straub").
function checkAuthorNames(kind, title, author){
  if (kind === 'author') return [String(author || title).split(',')[0].trim()].filter(Boolean);
  return String(author || '').split(',').map(s => s.trim()).filter(Boolean);
}
// How long a badge check may wait on Chaptarr's slow reads. What it can't wait for
// still arrives — into the cache, for the next check — so this only bounds the wait.
const CHECK_AUTHORS_BUDGET_MS = 6000;
const CHECK_BOOKS_BUDGET_MS = 8000;
const CHECK_BATCH_BOOKS_BUDGET_MS = 4000;
const CHECK_BATCH_MAX_AUTHORS = 8;
// Does this row credit the author we were asked about? Titles alone are not unique —
// several different audiobooks are called "Dune" — so a title match only counts when
// the author agrees. Author strings are free text ("Joe Hill - introduction"), hence
// the containment test rather than equality, and a row with no author information at
// all is accepted rather than rejected.
function laAuthorMatches(it, authorName){
  const want = norm(authorName);
  if (!want) return true;
  const have = []
    .concat((it && (it.authors || it.Authors)) || [], (it && (it.author || it.Author)) || [])
    .map(a => norm(typeof a === 'string' ? a : (a && (a.name || a.authorName)) || ''))
    .filter(Boolean);
  if (!have.length) return true;
  // Exact always counts. Containment is there for free-text credits like
  // "Joe Hill - introduction" or "Stephen King and Peter Straub", but on a 1-3
  // character string it would match nearly anything, so it needs a real name.
  const LONG_ENOUGH = 5;
  return have.some(a => a === want
    || (want.length >= LONG_ENOUGH && a.includes(want))
    || (a.length    >= LONG_ENOUGH && want.includes(a)));
}
app.get('/api/library/check', auth, async (req,res)=>{
  const kind   = String(req.query.kind || 'book').trim().toLowerCase();
  const title  = String(req.query.title || '').trim();
  const author = String(req.query.author || '').trim();
  const asin   = String(req.query.asin || '').trim();

  // Has somebody already asked for this? Independent of the library check below —
  // a request made an hour ago hasn't been downloaded yet, so the library says no.
  let alreadyRequested = null;
  try { alreadyRequested = findExistingRequest(loadDB(), { kind, title, author, asin }); } catch { /* best-effort */ }
  const withReq = (o) => Object.assign(o, { alreadyRequested });

  try {
    // ═══ AUDIOBOOK → Listenarr ════════════════════════════════════════════════
    if (kind === 'audio') {
      if (!CFG.listenarrUrl || !CFG.listenarrKey) return res.json(withReq({ inLibrary: false, where: null }));
      let lib = [];
      try { lib = await getListenarrLibrary(); } catch { /* leave empty */ }
      const asinL = asin.toLowerCase();
      const titleN = norm(title);
      // ASIN is Audible's own identifier, so it settles the question on its own.
      // A bare title match does not: it used to badge any same-titled audiobook by
      // anyone as "already in Listenarr", so the author has to agree as well.
      const hit = (asinL && lib.find(it => laAsin(it) === asinL))
               || (titleN && lib.find(it => norm(laTitle(it)) === titleN && laAuthorMatches(it, author)))
               || null;
      if (hit) return res.json(withReq(audioCheckResult(hit, title)));
      return res.json(withReq({ inLibrary: false, where: null }));
    }

    // ═══ EBOOK / AUTHOR → Chaptarr ═════════════════════════════════
    if (!CFG.chaptarrUrl || !CFG.chaptarrKey) return res.json(withReq({ inLibrary: false, where: null }));

    // The cached author snapshot — instant once loaded. On a cold start it can take
    // Chaptarr 20-45s, and a badge isn't worth that wait: answer "don't know" now.
    const existingAuthors = await withBudget(getChaptarrAuthors(), CHECK_AUTHORS_BUDGET_MS);
    if (!existingAuthors) return res.json(withReq({ inLibrary: false, where: null }));
    // Being in Chaptarr is not enough — it has to be monitored for EBOOKS. Chaptarr
    // also holds audiobook-only authors (it serves both formats), and those have no
    // eBook profile or root folder, so no eBook of theirs is ever coming. Badging
    // that "✓ in library" would talk the user out of a request that would work.
    const rows = libraryAuthorsFor(existingAuthors, checkAuthorNames(kind, title, author), '').filter(authorHasEbook);
    if (!rows.length) return res.json(withReq({ inLibrary: false, where: null }));

    if (kind === 'author') {
      return res.json(withReq({ inLibrary: true, where: 'chaptarr', label: 'Author already in Chaptarr', matchedTitle: rows[0].authorName }));
    }

    // eBook: look for THIS book under each of its authors that Chaptarr has — just
    // their books (?authorId=), not the entire library, and only the eBook ones, so an
    // author's audiobook of the same title doesn't answer for it.
    const until = Date.now() + CHECK_BOOKS_BUDGET_MS;
    for (const row of rows) {
      const books = await withBudget(getChaptarrAuthorBooks(row.id), Math.max(0, until - Date.now()));
      const hit = Array.isArray(books) ? findBookByTitle(ebookBooks(books), title) : null;
      if (hit) return res.json(withReq(ebookCheckResult(row, hit)));
    }
    return res.json(withReq(ebookCheckResult(rows[0], null)));
  } catch (e) {
    // Never let a library-check failure block searching — just report "unknown".
    return res.json(withReq({ inLibrary: false, where: null, error: e.message }));
  }
});

// ── Library check (BATCH) — one call for a whole page of items ────────────────
// Discover renders many rows at once; checking each card with /api/library/check
// would fetch the ENTIRE upstream library once per card (dozens of identical
// round-trips). This endpoint pulls each upstream library AT MOST ONCE, builds
// in-memory lookup sets, and matches every item against them — so a full Discover
// page costs ~3 upstream calls instead of ~100+.
//
// Body: { items: [ { kind:'book'|'author'|'audio', title, author, asin }, ... ] }
// Response: { results: [ { inLibrary, where, label, matchedTitle, … }, ... ] }  (same
// order/shape as the single-item endpoint, so the client can reuse its badging).
const CHECK_BATCH_MAX = 250;   // a Discover page is well under this
app.post('/api/library/check-batch', auth, async (req,res)=>{
  const all = Array.isArray(req.body && req.body.items) ? req.body.items : [];
  // Bound the work per call. Duplicate detection is per-item, so an unbounded list
  // (a 100kb body holds thousands of entries) turned one authenticated request into
  // millions of synchronous string comparisons that block the event loop for
  // everyone. Clients only ever send one screen at a time.
  const items = all.slice(0, CHECK_BATCH_MAX);
  if (!items.length) return res.json({ results: [] });

  const kindOf = it => String((it && it.kind) || 'book').toLowerCase();
  const needChaptarr  = items.some(it => kindOf(it) !== 'audio');
  const needListenarr = items.some(it => kindOf(it) === 'audio');
  const chaptarrOn = needChaptarr && !!(CFG.chaptarrUrl && CFG.chaptarrKey);

  // ── Fetch each upstream library at most once (best-effort, time-boxed). ──
  // Chaptarr authors (for eBook/author rows) + their books for exact-title matches.
  let authorsByNorm = new Map();      // normalised authorName → author row
  let booksByAuthorId = new Map();    // authorId → [eBook rows]  (matched authors whose list arrived in time)
  if (chaptarrOn) {
    const authors = await withBudget(getChaptarrAuthors(), CHECK_AUTHORS_BUDGET_MS) || [];
    for (const a of authors) { const n = norm(a.authorName); if (n) authorsByNorm.set(n, a); }
    // Exact-title confirmation for eBook rows. We deliberately do NOT pull the whole
    // book library here (46 MB / 30k rows on a real instance); instead we work out
    // which authors this page actually matched — usually a handful — and fetch just
    // those, each cached per author. A list that doesn't arrive within the budget keeps
    // loading in the background; its rows answer at the author level this time.
    const wantedAuthorIds = [];
    for (const it of items) {
      if (kindOf(it) !== 'book') continue;
      for (const an of checkAuthorNames('book', it.title, it.author)) {
        const row = authorsByNorm.get(norm(an));
        // An audiobook-only author can't answer an eBook check, so don't spend an
        // upstream call fetching their books.
        if (row && row.id != null && authorHasEbook(row) && !wantedAuthorIds.includes(row.id)) wantedAuthorIds.push(row.id);
      }
    }
    const ids = wantedAuthorIds.slice(0, CHECK_BATCH_MAX_AUTHORS);
    const lists = await Promise.all(ids.map(id => withBudget(getChaptarrAuthorBooks(id), CHECK_BATCH_BOOKS_BUDGET_MS)));
    ids.forEach((id, i) => { if (Array.isArray(lists[i])) booksByAuthorId.set(id, ebookBooks(lists[i])); });
  }

  // Listenarr library (for audiobook rows), matched by ASIN first then title.
  let listenByAsin = new Map();   // asin(lower) → row
  let listenByTitle = new Map();  // norm(title) → [rows]  (a title is not unique)
  if (needListenarr && CFG.listenarrUrl && CFG.listenarrKey) {
    let lib = [];
    try { lib = await getListenarrLibrary(); } catch { /* leave empty */ }
    for (const it of lib) {
      const ia = laAsin(it);
      if (ia) listenByAsin.set(ia, it);
      // Keep EVERY row under a title, not just the first: two audiobooks can share a
      // title, and the author check below needs the chance to pick the right one.
      const itTitle = norm(laTitle(it));
      if (itTitle) { const bucket = listenByTitle.get(itTitle); if (bucket) bucket.push(it); else listenByTitle.set(itTitle, [it]); }
    }
  }

  // Existing requests are matched from ONE db read for the whole page, the same way
  // the upstream libraries are fetched once above — and indexed once, so matching is
  // a hash lookup per item rather than a full scan of every request per item.
  let requestIndex = null;
  try { requestIndex = buildRequestIndex(loadDB()); } catch { /* duplicate info is best-effort */ }

  // ── Match every requested item against the prefetched sets (pure in-memory). ──
  const results = items.map(it => {
    const kind   = kindOf(it);
    const title  = String((it && it.title) || '').trim();
    const author = String((it && it.author) || '').trim();
    const asin   = String((it && it.asin) || '').trim();
    const alreadyRequested = requestIndex ? lookupExistingRequest(requestIndex, { kind, title, author, asin }) : null;
    const withReq = (o) => Object.assign(o, { alreadyRequested });

    if (kind === 'audio') {
      if (!(needListenarr && CFG.listenarrUrl && CFG.listenarrKey)) return withReq({ inLibrary: false, where: null });
      const asinL = asin.toLowerCase();
      const titleN = norm(title);
      // Same rule as the single-item check: an ASIN is decisive, a title needs the
      // author to agree before it counts.
      const hit = (asinL && listenByAsin.get(asinL))
               || (titleN && (listenByTitle.get(titleN) || []).find(row => laAuthorMatches(row, author)))
               || null;
      if (hit) return withReq(audioCheckResult(hit, title));
      return withReq({ inLibrary: false, where: null });
    }

    // eBook / author → Chaptarr
    if (!chaptarrOn) return withReq({ inLibrary: false, where: null });
    // Must be monitored for EBOOKS — an audiobook-only author in Chaptarr is not
    // going to produce the eBook this row is asking about.
    const rows = [];
    for (const n of checkAuthorNames(kind, title, author)) {
      const row = authorsByNorm.get(norm(n));
      if (row && authorHasEbook(row) && !rows.includes(row)) rows.push(row);
    }
    if (!rows.length) return withReq({ inLibrary: false, where: null });

    if (kind === 'author') {
      return withReq({ inLibrary: true, where: 'chaptarr', label: 'Author already in Chaptarr', matchedTitle: rows[0].authorName });
    }
    for (const row of rows) {
      const hit = findBookByTitle(booksByAuthorId.get(row.id) || [], title);
      if (hit) return withReq(ebookCheckResult(row, hit));
    }
    return withReq(ebookCheckResult(rows[0], null));
  });

  res.json({ results });
});

// ── Connection status widgets ─────────────────────────────────────────────────
// Both status widgets serve from the SAME 60s-cached probes the dashboard uses,
// so N open tabs + a polling dashboard still cost at most one upstream ping per
// service per minute.
// Regular users get the connected/version pill only. The internal upstream URL is
// admin information — it maps out the host's private network for anyone with an
// account, and a normal user has no use for it.
app.get('/api/chaptarr/status', auth, async (req,res)=>{
  const isAdmin = req.user && req.user.role === 'admin';
  if (!CFG.chaptarrUrl || !CFG.chaptarrKey) return res.json({ connected: false, version: null, url: null, error: 'Chaptarr not configured' });
  const p = await probeChaptarr();
  res.json({ connected: p.connected, version: p.version || null, url: isAdmin ? CFG.chaptarrUrl : null, appName: 'Chaptarr', error: isAdmin ? p.error : (p.connected ? undefined : 'Not connected') });
});
// Old path kept working for anything still pointing at it.
app.get('/api/bookshelf/status', auth, (req,res)=>res.redirect(307, '/api/chaptarr/status'));
app.get('/api/listenarr/status', auth, async (req,res)=>{
  const isAdmin = req.user && req.user.role === 'admin';
  if (!CFG.listenarrUrl || !CFG.listenarrKey) return res.json({ connected: false, version: null, url: null, error: 'Listenarr not configured' });
  const p = await probeListenarr();
  res.json({ connected: p.connected, version: p.version || null, url: isAdmin ? CFG.listenarrUrl : null, appName: 'Listenarr', error: isAdmin ? p.error : (p.connected ? undefined : 'Not connected') });
});

// ── Dashboard summary — one call that powers an external panel (e.g. a homelab dashboard) ──
// Authenticate with a BookSeerr API key (X-Api-Key header or ?apikey=) or a JWT.
// Returns app info, request counts, the latest requests, and upstream health in a
// single, compact JSON object so a dashboard tile can render without extra calls.
// adminOnly: this endpoint aggregates EVERY user's requests (titles, who asked, the
// per-user breakdown and the total account count). It was previously reachable by any
// signed-in user, which quietly handed a regular user the whole request history —
// even though GET /api/requests correctly limits them to their own rows.
// API-key callers keep access, since they carry admin scope by design.
app.get('/api/dashboard', auth, adminOnly, async (req,res)=>{
  const db = loadDBDaily();
  const reqs = Array.isArray(db.requests) ? db.requests : [];
  const today = todayKey();
  const count = (fn) => reqs.filter(fn).length;
  const recent = reqs.slice().sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||''))).slice(0, 10)
    .map(r => ({ id: r.id, kind: r.kind, title: r.title || r.author || '', author: r.author || '', destination: destOf(r), status: r.status, message: r.message || '', username: r.username || '', createdAt: r.createdAt }));

  // Upstream health — served from the shared 60s cache, so an external panel can
  // poll this endpoint as often as it likes without pinging the downloaders.
  const [chaptarr, listenarr] = await Promise.all([probeChaptarr(), probeListenarr()]);

  res.json({
    app: 'BookSeerr',
    version: APP_VERSION,
    requests: {
      total: reqs.length,
      sent: count(r => r.status === 'sent'),
      approved: count(r => r.status === 'sent'),   // alias — "approved & sent to the downloader"
      pending: count(r => r.status === 'pending'),
      rejected: count(r => r.status === 'rejected'),
      error: count(r => r.status === 'error'),
      ebooks: count(r => r.kind !== 'audio'),
      audiobooks: count(r => r.kind === 'audio'),
      today: count(r => String(r.createdAt || '').slice(0,10) === today)
    },
    approvals: approvalsSettings(db),
    // Per-user request totals WITH a status breakdown, so a dashboard can render a
    // leaderboard and per-user pending/approved/rejected tiles without extra calls.
    byUser: Object.values(reqs.reduce((acc, r) => {
      const key = r.username || ('user:' + r.userId);
      const e = (acc[key] = acc[key] || { username: r.username || '', userId: r.userId, total: 0, sent: 0, pending: 0, rejected: 0, error: 0 });
      e.total++;
      if (e[r.status] != null) e[r.status]++;
      return acc;
    }, {})).sort((a, b) => b.total - a.total),
    users: { total: db.users.length },
    recent,
    chaptarr,
    // Kept alongside the new name so an existing dashboard reading .bookshelf
    // (e.g. an older dashboard panel) doesn't go blank the moment this is deployed.
    bookshelf: chaptarr,
    listenarr,
    // Tells a dashboard which filter values and query endpoints are available, so it can
    // build search/filter controls dynamically against this BookSeerr instance.
    filters: {
      statuses: ['sent', 'pending', 'rejected', 'error'],
      kinds: ['book', 'author', 'audio'],
      destinations: ['chaptarr', 'listenarr']
    },
    endpoints: {
      requests: '/api/requests?status=&kind=&destination=&user=&q=&since=&until=&limit=&offset=',
      search: '/api/search?type=all|books|audio&q=&minYear=&maxYear=&source=&limit=',
      discover: '/api/discover'
    },
    generatedAt: new Date().toISOString()
  });
});

const server = app.listen(PORT, '0.0.0.0', () => console.log('BookSeerr v' + APP_VERSION + ' running on ' + PORT));
// Requests that were mid-follow-up when the server last stopped carry on from here.
setTimeout(resumeFollowUps, 5000).unref();
// Discover's "for you" rows: warm the shared Audible lookups once things have settled.
setTimeout(warmForYou, 45000).unref();
setInterval(warmForYou, 12 * 60 * 60 * 1000).unref();

// ── Shut down cleanly ────────────────────────────────────────────────────────
// `docker compose restart/stop/up --build` sends SIGTERM. With no handler Node exits
// immediately, so anything in flight — most importantly a send that is at that moment
// handing a request to Chaptarr or Listenarr — was severed with the browser still
// waiting and the outcome never written down. Stop taking new connections, let what
// is already running finish, and keep a hard cap so a held-open browser tab can't
// block the restart forever. (db.json itself is safe either way: saveDB writes and
// fsyncs synchronously, so a kill can't land in the middle of one.)
let shuttingDown = false;
function shutdown(signal){
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[BookSeerr] ' + signal + ' received — finishing in-flight requests…');
  const forced = setTimeout(() => {
    console.warn('[BookSeerr] still busy after 10s — exiting anyway');
    process.exit(0);
  }, 10000);
  forced.unref();
  server.close(() => { clearTimeout(forced); console.log('[BookSeerr] closed cleanly'); process.exit(0); });
  // Keep-alive sockets sitting idle would otherwise hold server.close() open for the
  // full 10s on every restart.
  if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
