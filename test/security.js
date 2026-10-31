'use strict';
/* Headless test harness for BookSeerr's auth model, request limits and
   notifications. Companion to test_approvals.js — run both:

     node test_approvals.js
     node test_security.js

   Boots a mock Chaptarr upstream, a mock webhook receiver and the real
   server, then checks the things that are easy to regress silently:

     [1] Session revocation  — deleted / demoted / renamed users, password changes
     [2] Login lockout       — per-account, survives source-IP rotation
     [3] Admin safety rails  — last admin, self-deletion, duplicate usernames
     [4] Daily request limit — holds under a concurrent burst
     [5] Webhooks            — event filtering, secrecy, failure isolation
     [6] Duplicates          — "already requested" detection
     [7] Discord payload     — embed shape and Discord's documented limits
     [8] Privilege bounds    — API-key escalation, aggregate data exposure,
                               upstream-key exfiltration, role-string bypass
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MOCK_PORT = 9971, HOOK_PORT = 9972, APP_PORT = 9973, MOCK_LA_PORT = 9975;
const DATA_DIR = path.join(__dirname, 'test-data-security');
fs.rmSync(DATA_DIR, { recursive: true, force: true });

let hooks = [];

// ── Mock Chaptarr (eBooks and authors) ──
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const u = req.url.split('?')[0];
    if (u === '/api/v1/author/lookup') return send(200, [{ authorName: 'Test Author', foreignAuthorId: 'fa-123' }]);
    if (u === '/api/v1/book/lookup') return send(200, [{ title: 'Some Book', author: { authorName: 'Test Author', foreignAuthorId: 'fa-123' } }]);
    // Everything is an author add now. A magic title lets a test force an upstream
    // failure, and the deliberate delay gives the concurrency tests something to race.
    if (u === '/api/v1/author' && req.method === 'POST') {
      if (body.indexOf('FAILME') >= 0) return send(500, { message: 'mock upstream refused' });
      return setTimeout(() => send(201, { id: 1 }), 250);
    }
    if (u === '/api/v1/command' && req.method === 'POST') return send(201, { id: 5 });
    if (u === '/api/v1/author') return send(200, []);
    if (u === '/api/v1/book') return send(200, []);
    if (u === '/api/v1/system/status') return send(200, { version: '1.2.3', appName: 'Chaptarr' });
    if (u === '/api/v1/system/info') return send(200, { version: '2.0.0' });
    if (u === '/api/v1/qualityprofile') return send(200, [
      { id: 1, name: 'E-Book', profileType: 'ebook' }, { id: 2, name: 'Audiobook', profileType: 'audiobook' }]);
    if (u === '/api/v1/metadataprofile') return send(200, [
      { id: 2, name: 'Ebook Default', profileType: 2 }, { id: 1, name: 'Audiobook Default', profileType: 1 }]);
    if (u === '/api/v1/rootfolder' || u === '/api/v1/rootfolders') return send(200, [
      { id: 1, name: 'eBooks', path: '/books', folderType: 2 },
      { id: 2, name: 'Audiobooks', path: '/audiobooks', folderType: 1 }]);
    return send(200, {});
  });
});

// ── Mock Listenarr (audiobooks) ──
// The 250ms delay mirrors the Chaptarr mock's, so the approve/reject race tests in
// [9] have a real in-flight window to land inside. Unknown /api paths answer 200
// with HTML, exactly as the real Listenarr does (it serves its web UI from the same
// host), so anything that trusts a bare 2xx is caught here.
const laMock = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const u = req.url.split('?')[0];
    if (u === '/api/v1/library/add' && req.method === 'POST') {
      if (body.indexOf('FAILME') >= 0) return send(400, { errors: { '$.metadata.asin': ['mock upstream refused'] } });
      return setTimeout(() => send(201, { id: 9 }), 250);
    }
    if (u === '/api/v1/library') return send(200, []);
    if (u === '/api/v1/system/info') return send(200, { version: '1.0.11' });
    if (u === '/api/v1/qualityprofile') return send(200, [{ id: 9, name: 'Audio Default' }]);
    if (u === '/api/v1/rootfolders') return send(200, [{ id: 3, name: 'Audiobooks', path: '/audiobooks' }]);
    if (u === '/api/v1/search/audible') return send(200, { results: [], totalResults: 0 });
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!DOCTYPE html><html><body>Listenarr</body></html>');
  });
});

// ── Mock webhook receiver: records everything BookSeerr posts ──
const hook = http.createServer((req, res) => {
  let b = '';
  req.on('data', c => b += c);
  req.on('end', () => { try { hooks.push(JSON.parse(b || '{}')); } catch { hooks.push(b); } res.writeHead(204); res.end(); });
});

function call(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: APP_PORT, path: p, method,
      headers: Object.assign({}, headers, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(d || '{}') }); } catch { resolve({ status: res.statusCode, data: d }); } }); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// See the note in test_approvals.js: strip every BookSeerr env var from the inherited
// environment so the suite tests the code, not the developer's local configuration.
const BOOKSEERR_ENV_VARS = [
  'PORT', 'DATA_DIR', 'CHAPTARR_URL', 'CHAPTARR_API_KEY', 'BOOKSHELF_URL', 'BOOKSHELF_API_KEY', 'READARR_URL', 'READARR_API_KEY',
  'LISTENARR_URL', 'LISTENARR_API_KEY',
  'AUDIBLE_BASE', 'AUDIBLE_REGION', 'AUDIBLE_CATEGORY_ID', 'OPENLIBRARY_BASE', 'OPENLIBRARY_COVERS',
  'GOOGLE_BOOKS_API_KEY', 'CORS_ORIGINS', 'FRAME_ANCESTORS', 'JWT_SECRET', 'JWT_TTL',
  'ADMIN_USER', 'ADMIN_PASS', 'UPSTREAM_TIMEOUT_MS', 'UPSTREAM_RETRIES', 'MAX_UPSTREAM_BYTES',
  'DISCOVER_TTL_MINUTES', 'LOGIN_MAX_FAILS', 'LOGIN_LOCK_MINUTES', 'TRUST_PROXY'
];
function cleanEnv(overrides) {
  const env = Object.assign({}, process.env);
  for (const k of BOOKSEERR_ENV_VARS) delete env[k];
  return Object.assign(env, overrides);
}

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra !== undefined ? ' — got: ' + JSON.stringify(extra) : '')); }
}

// ── [7] runs in-process: lift the pure payload builders out of server.js ──
function loadPayloadBuilders() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const grab = (name) => {
    // Match the name EXACTLY — 'function requestJson' is a prefix of
    // 'function requestJsonOnce' — and keep a leading `async`.
    let start = src.indexOf('function ' + name + '(');
    if (start < 0) throw new Error('cannot find function ' + name);
    if (src.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
    // Skip the PARAMETER list before counting braces: a default like `headers={}`
    // contains braces, so counting from the first '{' ends the function early.
    let i = src.indexOf('(', src.indexOf(name, start)), pd = 0;
    for (; i < src.length; i++) { if (src[i] === '(') pd++; else if (src[i] === ')') { pd--; if (pd === 0) { i++; break; } } }
    i = src.indexOf('{', i);
    let depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    }
    throw new Error('unbalanced braces in ' + name);
  };
  const sandbox = [
    'const APP_VERSION = "test";',
    'const EVENT_TITLE = { submitted:"New request", approved:"Request approved", rejected:"Request rejected", error:"Request failed" };',
    'const EVENT_COLOR = { submitted:0xf59e0b, approved:0x22c55e, rejected:0xef4444, error:0xef4444 };',
    'const kindWord = k => k === "audio" ? "Audiobook" : k === "author" ? "Author" : "eBook";',
    grab('destOf'),
    grab('isDiscordWebhook'),
    grab('buildWebhookBody'),
    'module.exports = { isDiscordWebhook, buildWebhookBody };'
  ].join('\n');
  const m = { exports: {} };
  new Function('module', 'exports', 'URL', sandbox)(m, m.exports, URL);
  return m.exports;
}

(async () => {
  mock.listen(MOCK_PORT); laMock.listen(MOCK_LA_PORT); hook.listen(HOOK_PORT);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    // cwd is the throwaway data dir, NOT the repo — see the note in test_approvals.js.
    // dotenv resolves ./.env against cwd, so running from the repo root pulled the
    // developer's real .env into every test run.
    cwd: DATA_DIR,
    env: cleanEnv({
      PORT: String(APP_PORT), DATA_DIR,
      CHAPTARR_URL: 'http://127.0.0.1:' + MOCK_PORT, CHAPTARR_API_KEY: 'k',
      LISTENARR_URL: 'http://127.0.0.1:' + MOCK_LA_PORT, LISTENARR_API_KEY: 'la',
      JWT_SECRET: 'security-suite-secret', ADMIN_USER: 'root', ADMIN_PASS: 'rootpass',
      UPSTREAM_TIMEOUT_MS: '1500', LOGIN_MAX_FAILS: '10'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', d => { const s = String(d); if (!/JWT_SECRET|ADMIN_PASS/.test(s)) console.error('[server] ' + s); });
  // Up to 45s: a cold start on a Windows host (Defender scanning node_modules on first
  // load) measured ~12s, well past the old 6s budget, and failed every check with
  // ECONNREFUSED. The loop still exits the moment the server answers.
  for (let i = 0; i < 300; i++) { try { const r = await call('GET', '/healthz'); if (r.status === 200) break; } catch {} await sleep(150); }

  try {
    const rootLogin = await call('POST', '/api/auth/login', { username: 'root', password: 'rootpass' });
    const ADM = { Authorization: 'Bearer ' + rootLogin.data.token };
    check('admin login', rootLogin.status === 200, rootLogin);

    console.log('\n[1] Sessions are revocable — a token is not a 365-day free pass');
    await call('POST', '/api/users', { username: 'victim', password: 'pw123456' }, ADM);
    const vLogin = await call('POST', '/api/auth/login', { username: 'victim', password: 'pw123456' });
    const VIC = { Authorization: 'Bearer ' + vLogin.data.token };
    check('new user can use their token', (await call('GET', '/api/me', null, VIC)).status === 200);
    const vid = (await call('GET', '/api/users', null, ADM)).data.find(u => u.username === 'victim').id;
    await call('DELETE', '/api/users/' + vid, null, ADM);
    check('deleted user\'s token stops working', (await call('GET', '/api/requests', null, VIC)).status === 401);

    await call('POST', '/api/users', { username: 'exadmin', password: 'pw123456', role: 'admin' }, ADM);
    const eLogin = await call('POST', '/api/auth/login', { username: 'exadmin', password: 'pw123456' });
    const EX = { Authorization: 'Bearer ' + eLogin.data.token };
    const eid = (await call('GET', '/api/users', null, ADM)).data.find(u => u.username === 'exadmin').id;
    await call('PATCH', '/api/users/' + eid, { role: 'user' }, ADM);
    check('demoted admin loses admin scope immediately', (await call('GET', '/api/users', null, EX)).status === 401);
    check('demoted admin cannot mint a new admin', (await call('POST', '/api/users', { username: 'backdoor', password: 'pw123456', role: 'admin' }, EX)).status === 401);

    const pw = await call('POST', '/api/account/password', { currentPassword: 'rootpass', newPassword: 'newpass99' }, ADM);
    check('password change returns a replacement token', pw.status === 200 && !!pw.data.token, pw.data);
    check('the pre-change token is revoked', (await call('GET', '/api/me', null, ADM)).status === 401);
    const NEW = { Authorization: 'Bearer ' + pw.data.token };
    check('the replacement token works', (await call('GET', '/api/me', null, NEW)).status === 200);

    const other = await call('POST', '/api/auth/login', { username: 'root', password: 'newpass99' });
    const OTHER = { Authorization: 'Bearer ' + other.data.token };
    const lo = await call('POST', '/api/account/logout-all', {}, NEW);
    check('logout-all returns a fresh token', lo.status === 200 && !!lo.data.token, lo.data);
    check('logout-all signs out other devices', (await call('GET', '/api/me', null, OTHER)).status === 401);
    const CUR = { Authorization: 'Bearer ' + lo.data.token };
    check('logout-all keeps THIS device signed in', (await call('GET', '/api/me', null, CUR)).status === 200);

    console.log('\n[2] Login lockout is per-account, so rotating IPs does not help');
    for (let i = 0; i < 9; i++) await call('POST', '/api/auth/login', { username: 'root', password: 'nope' });
    check('a correct password clears the failure counter',
      (await call('POST', '/api/auth/login', { username: 'root', password: 'newpass99' })).status === 200);
    let blocked = 0;
    for (let i = 0; i < 15; i++) {
      // A different forged client IP on every attempt — this defeated the IP limiter.
      const r = await call('POST', '/api/auth/login', { username: 'root', password: 'nope' }, { 'X-Forwarded-For': '10.9.' + i + '.' + i });
      if (r.status === 429) blocked++;
    }
    check('spoofed X-Forwarded-For cannot outrun the account lockout', blocked > 0, { blocked });
    check('a locked account rejects even the CORRECT password',
      (await call('POST', '/api/auth/login', { username: 'root', password: 'newpass99' })).status === 429);

    console.log('\n[3] Admin safety rails');
    // Re-key the admin session: the lockout above doesn't touch existing tokens.
    const A = CUR;
    const rootId = (await call('GET', '/api/users', null, A)).data.find(u => u.username === 'root').id;
    await call('POST', '/api/users', { username: 'admin2', password: 'pw123456', role: 'admin' }, A);
    const selfDel = await call('DELETE', '/api/users/' + rootId, null, A);
    check('cannot delete your own account', selfDel.status === 400 && /own account/i.test(selfDel.data.error), selfDel.data);
    const a2 = (await call('GET', '/api/users', null, A)).data.find(u => u.username === 'admin2');
    check('a non-last admin CAN be deleted', (await call('DELETE', '/api/users/' + a2.id, null, A)).status === 200);
    check('the last admin is protected', (await call('DELETE', '/api/users/' + rootId, null, A)).status === 400);
    check('admin-created accounts need a real password', (await call('POST', '/api/users', { username: 'weak', password: 'ab' }, A)).status === 400);
    await call('POST', '/api/users', { username: 'alice', password: 'pw123456' }, A);
    await call('POST', '/api/users', { username: 'bob', password: 'pw123456' }, A);
    const bobId = (await call('GET', '/api/users', null, A)).data.find(u => u.username === 'bob').id;
    const dup = await call('PATCH', '/api/users/' + bobId, { username: 'alice' }, A);
    check('cannot rename a user onto an existing username', dup.status === 400, dup.data);
    check('username uniqueness is case-insensitive',
      (await call('POST', '/api/users', { username: 'ALICE', password: 'pw123456' }, A)).status === 400);

    console.log('\n[4] The daily request limit holds under a concurrent burst');
    await call('PUT', '/api/admin/settings/approvals', { autoApproveAll: true }, A);
    await call('POST', '/api/users', { username: 'racer', password: 'pw123456', limit: 3 }, A);
    const rl = await call('POST', '/api/auth/login', { username: 'racer', password: 'pw123456' });
    const RC = { Authorization: 'Bearer ' + rl.data.token };
    const burst = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      call('POST', '/api/request', { kind: 'audio', author: 'Test Author', title: 'T' + i, asin: 'ASIN' + i, qualityProfileId: 2, metadataProfileId: 1, rootFolderPath: '/audiobooks' }, RC)));
    const accepted = burst.filter(x => x.status === 200).length;
    check('10 simultaneous requests against a 3/day limit → exactly 3 accepted', accepted === 3, { accepted });
    check('the rest are refused with 429', burst.filter(x => x.status === 429).length === 7, burst.map(x => x.status));

    console.log('\n[5] Webhook notifications');
    const HOOK_URL = 'http://127.0.0.1:' + HOOK_PORT + '/hook/super-secret-token';
    let n = await call('GET', '/api/admin/settings/notifications', null, A);
    check('notifications are off until configured', n.data.enabled === false && n.data.urlSet === false, n.data);
    const key = await call('POST', '/api/apikeys', { name: 'dash' }, A);
    check('API keys cannot read the webhook settings',
      (await call('GET', '/api/admin/settings/notifications', null, { 'X-Api-Key': key.data.key })).status === 403);
    check('a non-http webhook URL is rejected',
      (await call('PUT', '/api/admin/settings/notifications', { url: 'ftp://evil/x' }, A)).status === 400);

    await call('PUT', '/api/admin/settings/notifications', { url: HOOK_URL, enabled: true }, A);
    n = await call('GET', '/api/admin/settings/notifications', null, A);
    check('the webhook URL is never echoed back in full', !JSON.stringify(n.data).includes('super-secret-token'), n.data);

    await call('POST', '/api/users', { username: 'brad', password: 'pw123456', limit: 20 }, A);
    const bl = await call('POST', '/api/auth/login', { username: 'brad', password: 'pw123456' });
    const BRAD = { Authorization: 'Bearer ' + bl.data.token };
    const ebook = { kind: 'book', title: 'Dune', author: 'Test Author', qualityProfileId: 1, metadataProfileId: 1, rootFolderPath: '/books' };

    hooks = [];
    await call('POST', '/api/request', ebook, BRAD);
    await sleep(700);
    check('submitting a request fires one notification', hooks.length === 1, hooks.length);
    check('generic payload carries app/event/request',
      hooks[0] && hooks[0].app === 'BookSeerr' && hooks[0].event === 'submitted' && hooks[0].request.title === 'Dune' && hooks[0].request.username === 'brad', hooks[0]);

    await call('PUT', '/api/admin/settings/notifications', { events: { submitted: false } }, A);
    hooks = [];
    await call('POST', '/api/request', { kind: 'book', title: 'Neuromancer', author: 'Test Author', qualityProfileId: 1, metadataProfileId: 1, rootFolderPath: '/books' }, BRAD);
    await sleep(700);
    check('turning an event off silences it', hooks.length === 0, hooks);

    await call('PUT', '/api/admin/settings/notifications', { events: { submitted: true } }, A);
    await call('PUT', '/api/admin/settings/approvals', { autoApproveAll: false }, A);
    const pend = await call('POST', '/api/request', { kind: 'audio', author: 'Test Author', title: 'Hail Mary', asin: 'BHAIL1', qualityProfileId: 9 }, BRAD);
    await sleep(500); hooks = [];
    await call('POST', '/api/requests/' + pend.data.id + '/reject', { reason: 'no' }, A);
    await sleep(700);
    check('rejecting fires a "rejected" event', hooks.length === 1 && hooks[0].event === 'rejected', hooks.map(h => h.event));

    await call('PUT', '/api/admin/settings/notifications', { url: 'http://127.0.0.1:1/dead', enabled: true }, A);
    await call('PUT', '/api/admin/settings/approvals', { autoApproveAll: true }, A);
    const stillOk = await call('POST', '/api/request', { kind: 'book', title: 'Snow Crash', author: 'Test Author', qualityProfileId: 1, metadataProfileId: 1, rootFolderPath: '/books' }, BRAD);
    check('an unreachable webhook never breaks a request', stillOk.status === 200 && stillOk.data.status === 'sent', stillOk.data);

    console.log('\n[6] Duplicate-request detection');
    let chk = await call('GET', '/api/library/check?kind=book&title=Dune&author=Test%20Author', null, A);
    check('an existing request is reported with who and when',
      chk.data.alreadyRequested && chk.data.alreadyRequested.username === 'brad' && !!chk.data.alreadyRequested.createdAt, chk.data.alreadyRequested);
    chk = await call('GET', '/api/library/check?kind=book&title=Never%20Asked%20For&author=Nobody', null, A);
    check('an unrequested title reports null', chk.data.alreadyRequested === null, chk.data);
    chk = await call('GET', '/api/library/check?kind=audio&title=Hail%20Mary&asin=BHAIL1', null, A);
    check('a REJECTED request does not block re-requesting', chk.data.alreadyRequested === null, chk.data);
    const batch = await call('POST', '/api/library/check-batch', { items: [
      { kind: 'book', title: 'Dune', author: 'Test Author' },
      { kind: 'book', title: 'Never Asked For', author: 'Nobody' }
    ] }, A);
    check('the batch endpoint reports duplicates per item',
      batch.data.results[0].alreadyRequested && batch.data.results[1].alreadyRequested === null, batch.data.results);

    console.log('\n[7] Discord payload shape');
    const { isDiscordWebhook, buildWebhookBody } = loadPayloadBuilders();
    check('recognises a real Discord webhook host', isDiscordWebhook('https://discord.com/api/webhooks/1/x') === true);
    check('is not fooled by a lookalike host', isDiscordWebhook('https://discord.com.evil.example/x') === false);
    const rec = { id: 7, kind: 'book', title: 'Dune', author: 'Frank Herbert', username: 'brad', status: 'pending', destination: 'chaptarr', message: 'Waiting', image: 'https://covers.example/d.jpg', createdAt: new Date().toISOString() };
    const e = buildWebhookBody('https://discord.com/api/webhooks/1/x', 'submitted', rec, null).embeds[0];
    check('embed obeys Discord field limits',
      e.title.length <= 256 && (!e.description || e.description.length <= 4096) && e.fields.length <= 25 &&
      e.fields.every(f => f.name && f.value && f.value.length <= 1024) && Number.isInteger(e.color), e);
    const huge = buildWebhookBody('https://discord.com/api/webhooks/1/x', 'submitted',
      Object.assign({}, rec, { title: 'X'.repeat(900), message: 'Y'.repeat(9000), author: 'Z'.repeat(9000) }), null).embeds[0];
    check('over-long values are truncated, not sent raw',
      huge.title.length <= 256 && huge.description.length <= 4096 && huge.fields.every(f => f.value.length <= 1024),
      { t: huge.title.length, d: huge.description.length });
    check('an http cover is dropped (Discord renders https only)',
      !buildWebhookBody('https://discord.com/api/webhooks/1/x', 'approved', Object.assign({}, rec, { image: 'http://x/y.jpg' }), null).embeds[0].thumbnail);
    const generic = buildWebhookBody('http://example.invalid/hook', 'approved', rec, null);
    check('a non-Discord URL gets the flat generic payload', !generic.embeds && generic.app === 'BookSeerr', Object.keys(generic));

    console.log('\n[8] Privilege boundaries and information disclosure');
    // Each of these was a live, exploitable defect confirmed against a running
    // instance before it was fixed — they are regression tests, not hypotheticals.

    // (a) Aggregate request data must not leak to a regular user.
    const dashAsUser = await call('GET', '/api/dashboard', null, BRAD);
    check('a non-admin cannot read /api/dashboard', dashAsUser.status === 403, dashAsUser.status);
    check('an admin still can', (await call('GET', '/api/dashboard', null, A)).status === 200);
    const apiKey2 = (await call('POST', '/api/apikeys', { name: 'panel' }, A)).data.key;
    check('an API key still can (dashboards keep working)',
      (await call('GET', '/api/dashboard', null, { 'X-Api-Key': apiKey2 })).status === 200);

    // (b) The internal upstream URL is admin-only.
    const statusAsUser = await call('GET', '/api/chaptarr/status', null, BRAD);
    check('a non-admin does not see the upstream URL', statusAsUser.data.url === null, statusAsUser.data);
    check('an admin does see it', !!(await call('GET', '/api/chaptarr/status', null, A)).data.url);

    // (c) An API key must not be able to manufacture or seize an admin.
    const K2 = { 'X-Api-Key': apiKey2 };
    check('an API key cannot create an admin account',
      (await call('POST', '/api/users', { username: 'pwned', password: 'pw123456', role: 'admin' }, K2)).status === 403);
    const rootId2 = (await call('GET', '/api/users', null, A)).data.find(u => u.username === 'root').id;
    check('an API key cannot modify an existing admin',
      (await call('PATCH', '/api/users/' + rootId2, { password: 'hijacked1' }, K2)).status === 403);
    check('an API key cannot delete an admin',
      (await call('DELETE', '/api/users/' + rootId2, null, K2)).status === 403);
    check('an API key cannot list API keys', (await call('GET', '/api/apikeys', null, K2)).status === 403);
    check('an API key cannot mint another API key',
      (await call('POST', '/api/apikeys', { name: 'more' }, K2)).status === 403);
    check('an API key CAN still submit a request (documented capability preserved)',
      (await call('POST', '/api/request', { kind: 'book', title: 'Via Key', author: 'Test Author', qualityProfileId: 1, metadataProfileId: 1, rootFolderPath: '/books' }, K2)).status === 200);

    // (d) The stored upstream key must never be sent to an address it doesn't belong to.
    let sinkSaw = [];
    const sink = http.createServer((rq, rs) => {
      sinkSaw.push({ url: rq.url, apiKey: rq.headers['x-api-key'] || null });
      rs.writeHead(200, { 'Content-Type': 'application/json' }); rs.end('{"version":"9.9"}');
    });
    await new Promise(r => sink.listen(9974, r));
    const exfil = await call('POST', '/api/admin/settings/integrations/test',
      { service: 'chaptarr', url: 'http://127.0.0.1:9974', apiKey: '' }, A);
    await sleep(250);
    check('testing an UNRELATED url does not send the saved key',
      exfil.data.connected === false && !sinkSaw.some(h => h.apiKey), { resp: exfil.data, sinkSaw });
    sinkSaw = [];
    const sameHost = await call('POST', '/api/admin/settings/integrations/test',
      { service: 'chaptarr', url: 'http://127.0.0.1:' + MOCK_PORT, apiKey: '' }, A);
    check('testing the SAVED url still works with the saved key', sameHost.data.connected === true, sameHost.data);
    const explicitKey = await call('POST', '/api/admin/settings/integrations/test',
      { service: 'chaptarr', url: 'http://127.0.0.1:9974', apiKey: 'a-key-i-typed' }, A);
    await sleep(250);
    check('an explicitly typed key IS sent to the url being tested',
      explicitKey.data.connected === true && sinkSaw.some(h => h.apiKey === 'a-key-i-typed'), sinkSaw);
    sink.close();

    // (e) The last-admin guard must survive any role spelling.
    check('demoting the last admin is refused',
      (await call('PATCH', '/api/users/' + rootId2, { role: 'user' }, A)).status === 400);
    for (const bogus of ['member', 'User', 'ADMIN', 'x', '']) {
      const r = await call('PATCH', '/api/users/' + rootId2, { role: bogus }, A);
      check('role "' + bogus + '" cannot sneak past the last-admin guard', r.status === 400, r.data);
    }
    const adminsLeft = (await call('GET', '/api/users', null, A)).data.filter(u => u.role === 'admin').length;
    check('the instance still has an admin after every bypass attempt', adminsLeft >= 1, { adminsLeft });

    console.log('\n[9] Concurrency, quotas and attribution');
    await call('PUT', '/api/admin/settings/notifications', { clear: true }, A);   // quieten webhooks
    await call('PUT', '/api/admin/settings/approvals', { autoApproveAll: false }, A);

    // (a) Two admins clicking Approve at the same instant must not both send.
    const p1 = await call('POST', '/api/request', { kind: 'audio', author: 'Test Author', title: 'Race A', asin: 'RACE1', qualityProfileId: 9 }, BRAD);
    const bothApprove = await Promise.all([
      call('POST', '/api/requests/' + p1.data.id + '/approve', {}, A),
      call('POST', '/api/requests/' + p1.data.id + '/approve', {}, A)
    ]);
    const okCount = bothApprove.filter(r => r.status === 200).length;
    const conflictCount = bothApprove.filter(r => r.status === 409).length;
    check('simultaneous approves: exactly one sends, the other gets 409',
      okCount === 1 && conflictCount === 1, bothApprove.map(r => r.status));

    // (b) Reject must not slip in while a send is in flight (it would refund a slot
    //     for a request that is at that moment reaching the downloader).
    const p2 = await call('POST', '/api/request', { kind: 'audio', author: 'Test Author', title: 'Race B', asin: 'RACE2', qualityProfileId: 9 }, BRAD);
    const approveP = call('POST', '/api/requests/' + p2.data.id + '/approve', {}, A);
    await sleep(60);   // land inside the 250ms mock send
    const rejectDuring = await call('POST', '/api/requests/' + p2.data.id + '/reject', {}, A);
    const approveRes = await approveP;
    check('reject during an in-flight send is refused with 409', rejectDuring.status === 409, rejectDuring.status);
    check('the in-flight approve still completed', approveRes.status === 200 && approveRes.data.status === 'sent', approveRes.data && approveRes.data.status);

    // (c) A failed request must not permanently consume a daily slot.
    await call('PUT', '/api/admin/settings/approvals', { autoApproveAll: true }, A);
    const beforeFail = (await call('GET', '/api/me', null, BRAD)).data.requests;
    const failed1 = await call('POST', '/api/request', { kind: 'audio', author: 'Test Author', title: 'Doomed', asin: 'FAILME1', qualityProfileId: 9 }, BRAD);
    check('a rejected-by-upstream request is recorded as error', failed1.data.status === 'error', failed1.data && failed1.data.message);
    const afterFail = (await call('GET', '/api/me', null, BRAD)).data.requests;
    check('the failed request did consume a slot while it exists', afterFail === beforeFail + 1, { beforeFail, afterFail });
    await call('DELETE', '/api/requests/' + failed1.data.id, null, BRAD);
    const afterDelete = (await call('GET', '/api/me', null, BRAD)).data.requests;
    check('deleting a failed request refunds the slot', afterDelete === beforeFail, { beforeFail, afterDelete });

    // (d) An API key requests as itself: no human's quota, attributed to the key.
    const humanBefore = (await call('GET', '/api/users', null, A)).data.map(u => u.username + ':' + u.requests).join(',');
    const viaKey = await call('POST', '/api/request', { kind: 'book', title: 'From The Panel', author: 'Test Author', qualityProfileId: 1, metadataProfileId: 1, rootFolderPath: '/books' }, K2);
    check('an API-key request succeeds', viaKey.status === 200, viaKey.data);
    check('it is attributed to the key, not a person', /^apikey:/.test(String(viaKey.data.username)), viaKey.data.username);
    const humanAfter = (await call('GET', '/api/users', null, A)).data.map(u => u.username + ':' + u.requests).join(',');
    check('no human account was charged for it', humanBefore === humanAfter, { humanBefore, humanAfter });
  } catch (e) {
    failed++;
    console.error('HARNESS ERROR:', e);
  }

  srv.kill(); mock.close(); laMock.close(); hook.close();
  await sleep(400);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });

  // ── [10] Storage integrity ────────────────────────────────────────────────
  // Needs its own instance: the point is what happens AT STARTUP when db.json is
  // damaged. The old code answered "return an empty database", and the next write
  // then made that permanent — a truncated file holding real accounts, API keys and
  // request history was replaced by a 457-byte stub, silently.
  console.log('\n[10] A damaged database is never silently replaced');
  try {
    const D2 = path.join(__dirname, 'test-data-storage');
    fs.rmSync(D2, { recursive: true, force: true });
    fs.mkdirSync(D2, { recursive: true });
    const real = {
      users: [{ id: 1, username: 'root', passwordHash: '$2a$10$x', role: 'admin', canRequest: true, limit: 999, requests: 0, tokenVersion: 0 }],
      requests: Array.from({ length: 12 }, (_, i) => ({ id: i + 1, userId: 1, username: 'root', kind: 'book', title: 'Precious ' + (i + 1), status: 'sent', createdAt: '2026-07-01T00:00:00.000Z' })),
      apiKeys: [{ id: 1, name: 'panel', key: 'bsr_irreplaceable', createdAt: '2026-07-01T00:00:00.000Z' }],
      settings: { nextUserId: 2, nextRequestId: 13, nextApiKeyId: 2 }
    };
    const whole = JSON.stringify(real, null, 2);
    const truncated = whole.slice(0, Math.floor(whole.length * 0.9));   // crash mid-write
    const dbFile = path.join(D2, 'db.json');
    fs.writeFileSync(dbFile, truncated);
    fs.writeFileSync(path.join(D2, 'db.json.bak'), '{"users":[');       // backup unusable too

    const doomed = spawn('node', [path.join(__dirname, '..', 'server.js')], {
      cwd: D2,
      env: cleanEnv({ PORT: '9979', DATA_DIR: D2, ADMIN_USER: 'root', ADMIN_PASS: 'rootpass', JWT_SECRET: 'storage-test-secret' }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let said = '';
    doomed.stdout.on('data', d => said += d);
    doomed.stderr.on('data', d => said += d);
    const exitCode = await new Promise(r => { doomed.on('exit', c => r(c)); setTimeout(() => { doomed.kill(); r(null); }, 8000); });

    const after = fs.readFileSync(dbFile, 'utf8');
    check('it refuses to start rather than overwrite a damaged database', exitCode === 1, { exitCode, said: said.slice(0, 160) });
    check('the damaged db.json is left byte-for-byte intact', after === truncated, { before: truncated.length, after: after.length });
    // The tail of the file (apiKeys, settings) is what the truncation removed; the
    // point is that everything the damaged file DID still contain is recoverable.
    check('the surviving records are still readable in the file',
      (after.match(/Precious /g) || []).length === 12 && after.indexOf('"username": "root"') >= 0,
      { titles: (after.match(/Precious /g) || []).length });
    check('it explains what to do instead of failing silently', /REFUSING TO START/.test(said) && /[Rr]estore/.test(said), said.slice(0, 200));
    check('a quarantine copy is kept for recovery', fs.existsSync(dbFile + '.corrupt'));

    // A MISSING db.json is a first run, not a failure — it must still start cleanly.
    fs.rmSync(D2, { recursive: true, force: true });
    fs.mkdirSync(D2, { recursive: true });
    const fresh = spawn('node', [path.join(__dirname, '..', 'server.js')], {
      cwd: D2,
      env: cleanEnv({ PORT: '9978', DATA_DIR: D2, ADMIN_USER: 'root', ADMIN_PASS: 'rootpass', JWT_SECRET: 'storage-test-secret' }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    fresh.stdout.on('data', () => {}); fresh.stderr.on('data', () => {});
    let up = false;
    for (let i = 0; i < 40; i++) {
      await sleep(150);
      try {
        await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: 9978, path: '/healthz' }, r2 => { r2.resume(); up = r2.statusCode === 200; res(); }).on('error', rej));
        if (up) break;
      } catch {}
    }
    check('a first run with no db.json still starts normally', up === true);
    fresh.kill(); await sleep(300);
    fs.rmSync(D2, { recursive: true, force: true });
  } catch (e) {
    failed++;
    console.error('  ✗ storage-integrity harness error:', e.message);
  }

  // ── [11] Every upstream connection closes out ─────────────────────────────
  // The upstream client only listened for errors on the REQUEST. A peer that drops
  // the connection AFTER sending headers reports that on the RESPONSE, so the
  // promise never settled: the caller awaited forever, the browser request that
  // triggered it hung, and because cached() stores the in-flight promise, every
  // later caller joined the same dead fetch — one cut connection while reading the
  // Chaptarr author list stopped every "in library" badge until a restart.
  console.log('\n[11] Every upstream connection settles and frees its socket');
  try {
    const src2 = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const grab2 = (name) => {
      let start = src2.indexOf('function ' + name + '(');
      if (start < 0) throw new Error('cannot find function ' + name);
      if (src2.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
      let i = src2.indexOf('(', src2.indexOf(name, start)), pd = 0;
      for (; i < src2.length; i++) { if (src2[i] === '(') pd++; else if (src2[i] === ')') { pd--; if (pd === 0) { i++; break; } } }
      i = src2.indexOf('{', i);
      let depth = 0;
      for (; i < src2.length; i++) {
        if (src2[i] === '{') depth++;
        else if (src2[i] === '}') { depth--; if (depth === 0) return src2.slice(start, i + 1); }
      }
      throw new Error('unbalanced braces in ' + name);
    };
    const box = [
      'const APP_VERSION="test";',
      'const UPSTREAM_TIMEOUT_MS=1200;',
      'const MAX_UPSTREAM_BYTES=' + (32 * 1024) + ';',
      grab2('requestJsonOnce'),
      'module.exports={requestJsonOnce};'
    ].join('\n');
    const mod = { exports: {} };
    new Function('module', 'exports', 'URL', 'http', 'https', 'Buffer', box)(
      mod, mod.exports, URL, http, require('https'), Buffer);
    const { requestJsonOnce } = mod.exports;

    const CUT_PORT = 9979;
    let cutMode = 'cut';
    const live = new Set();
    const rude = http.createServer((rq, rs) => {
      if (cutMode === 'cut') {                       // headers, part of a body, then gone
        rs.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100000' });
        rs.write('[{"authorName":"Half An A');
        return setTimeout(() => rs.socket.destroy(), 30);
      }
      if (cutMode === 'flood') {                     // never stops sending
        rs.writeHead(200, { 'Content-Type': 'application/json' });
        const big = 'x'.repeat(8192);
        const t = setInterval(() => { try { rs.write(big); } catch { clearInterval(t); } }, 1);
        return rs.on('close', () => clearInterval(t));
      }
      rs.writeHead(200, { 'Content-Type': 'application/json' });   // 'silent' never replies
    });
    rude.on('connection', s => { live.add(s); s.on('close', () => live.delete(s)); });
    await new Promise(r => rude.listen(CUT_PORT, r));

    const settle = async (label) => {
      let how = 'HUNG';
      const p = requestJsonOnce('http://127.0.0.1:' + CUT_PORT + '/x').then(() => { how = 'resolved'; }, () => { how = 'rejected'; });
      await Promise.race([p, sleep(4000)]);
      return how;
    };
    cutMode = 'cut';
    check('a connection cut mid-body settles instead of hanging forever', (await settle()) === 'rejected');
    cutMode = 'silent';
    check('an upstream that never replies settles on the timeout', (await settle()) === 'rejected');
    cutMode = 'flood';
    check('an endless body settles on the size cap', (await settle()) === 'rejected');
    await sleep(300);
    check('no socket is left open afterwards', [...live].filter(s => !s.destroyed).length === 0,
      [...live].filter(s => !s.destroyed).length);
    rude.close();
    await sleep(200);
  } catch (e) {
    failed++;
    console.error('  ✗ close-out harness error:', e.message);
  }

  // ── [12] The server itself shuts down cleanly ─────────────────────────────
  // `docker compose restart / stop / up --build` sends SIGTERM. With no handler Node
  // exits on the spot, cutting off anything in flight — including a send that is at
  // that moment handing a request to Chaptarr or Listenarr, leaving the browser
  // waiting and the outcome unrecorded.
  console.log('\n[12] The server shuts down cleanly on SIGTERM');
  try {
    const srcS = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    check('SIGTERM and SIGINT are both handled', /process\.on\('SIGTERM'/.test(srcS) && /process\.on\('SIGINT'/.test(srcS));
    check('shutdown stops accepting connections rather than exiting immediately', /server\.close\(/.test(srcS));
    check('shutdown has a hard time limit so a held-open tab cannot block a restart',
      /still busy after 10s|forced|setTimeout\([\s\S]{0,120}process\.exit/.test(srcS));

    if (process.platform === 'win32') {
      // Node on Windows implements child.kill('SIGTERM') as TerminateProcess: the
      // handler never runs, so sending one here would prove nothing either way.
      // BookSeerr runs in Docker (Linux), where the signal is real.
      console.log('  ~ live SIGTERM delivery not testable on win32 (TerminateProcess); static checks above cover it');
    } else {
      const D3 = path.join(__dirname, 'test-data-shutdown');
      fs.rmSync(D3, { recursive: true, force: true });
      fs.mkdirSync(D3, { recursive: true });
      const s3 = spawn('node', [path.join(__dirname, '..', 'server.js')], {
        cwd: D3,
        env: cleanEnv({ PORT: '9977', DATA_DIR: D3, JWT_SECRET: 'shutdown-test', ADMIN_USER: 'root', ADMIN_PASS: 'rootpass' }),
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let log = '';
      s3.stdout.on('data', d => { log += d; });
      s3.stderr.on('data', () => {});
      for (let i = 0; i < 40; i++) {
        await sleep(150);
        let up = false;
        try { await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: 9977, path: '/healthz' }, r2 => { r2.resume(); up = r2.statusCode === 200; res(); }).on('error', rej)); } catch {}
        if (up) break;
      }
      const t0 = Date.now();
      const code = await new Promise(res => { s3.once('exit', c => res(c)); s3.kill('SIGTERM'); setTimeout(() => res('TIMEOUT'), 8000); });
      check('SIGTERM exits with code 0, not a kill', code === 0, code);
      check('it shuts down promptly (under 8s)', Date.now() - t0 < 8000, Date.now() - t0);
      check('it says what it is doing', /finishing in-flight|closed cleanly/.test(log), log.slice(-200));
      fs.rmSync(D3, { recursive: true, force: true });
    }
  } catch (e) {
    failed++;
    console.error('  ✗ shutdown harness error:', e.message);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
