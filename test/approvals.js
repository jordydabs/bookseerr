'use strict';
/* Headless test harness for the BookSeerr approval system.
   Boots mock Chaptarr + Listenarr upstreams and the real server, then walks the
   whole flow: auto-approve on/off, per-user overrides, admin bypass, approve
   (sends upstream), reject (refunds daily slot), retry-on-error, filters,
   notifications, and settings endpoints. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MOCK_PORT = 9911, APP_PORT = 9912, MOCK_LA_PORT = 9913, MOCK_GB_PORT = 9914, MOCK_AU_PORT = 9915, MOCK_OL_PORT = 9916;
const DATA_DIR = path.join(__dirname, 'test-data');
fs.rmSync(DATA_DIR, { recursive: true, force: true });

// An author already in the Chaptarr library, monitored for eBooks. Chaptarr's author
// records are format-prefixed because it serves both formats; BookSeerr only ever
// writes the ebook* half, so this is the shape the eBook checks match against.
const LIBRARY_AUTHOR = {
  id: 1, authorName: 'Library Author', foreignAuthorId: 'fa-lib',
  monitored: true,
  ebookQualityProfileId: 1, ebookMetadataProfileId: 2, ebookRootFolderPath: '/books',
  ebookMonitorExisting: 1, ebookMonitorFuture: true
};
// An author Chaptarr holds for AUDIOBOOKS only — no eBook profile or root folder.
// A plain POST for them comes back "already added" and monitors nothing, so an eBook
// request has to UPDATE the record instead. This is the case that bites in real life.
const AUDIO_ONLY_AUTHOR = {
  id: 2, authorName: 'Audio Only Author', foreignAuthorId: 'fa-audio',
  monitored: true,
  audiobookQualityProfileId: 2, audiobookMetadataProfileId: 1, audiobookRootFolderPath: '/audiobooks'
};
// In the library under a Hardcover id, while Chaptarr's metadata search for the name
// returns NOTHING — exactly what Stephen King looked like live (stored as hc:1126820,
// and "author/lookup?term=Stephen King" broken by a corrupted lookup cache).
const POPULAR_AUTHOR = {
  id: 3, authorName: 'Popular Author', foreignAuthorId: 'hc:3333',
  monitored: true, ebookMonitored: true,
  ebookQualityProfileId: 1, ebookMetadataProfileId: 2, ebookRootFolderPath: '/books'
};
// In Chaptarr, but missing from the author list BookSeerr first reads (a stale
// snapshot): the add comes back "This author has already been added".
const SNEAKY_AUTHOR = {
  id: 4, authorName: 'Sneaky Author', foreignAuthorId: 'gr:999',
  monitored: true, ebookQualityProfileId: 1, ebookMetadataProfileId: 2, ebookRootFolderPath: '/books'
};
// A second audiobook-only author, for an eBook (not author) request.
const SECOND_AUDIO_AUTHOR = {
  id: 5, authorName: 'Second Audio Author', foreignAuthorId: 'fa-audio2',
  monitored: true,
  audiobookQualityProfileId: 2, audiobookMetadataProfileId: 1, audiobookRootFolderPath: '/audiobooks'
};
const AUTHORS = new Map([[1, LIBRARY_AUTHOR], [2, AUDIO_ONLY_AUTHOR], [3, POPULAR_AUTHOR], [4, SNEAKY_AUTHOR], [5, SECOND_AUDIO_AUTHOR]]);
let sneakyVisible = false;        // SNEAKY_AUTHOR shows up in the list once "already added" has been said
let nextAuthorId = 77;            // ids for authors the tests add
// Book rows as GET /api/v1/book?authorId= returns them (Chaptarr 0.9.965): every row is
// typed ebook/audiobook, carries monitored + hasFiles, and Chaptarr keeps duplicates.
const ebook = (id, authorId, title, extra) => Object.assign({ id, authorId, title, mediaType: 'ebook', monitored: true, ebookMonitored: true, hasFiles: false, statistics: { bookFileCount: 0 } }, extra);
const BOOKS = {
  1: [
    ebook(101, 1, 'Owned Ebook', { hasFiles: true, statistics: { bookFileCount: 1 } }),
    ebook(102, 1, 'Missing Ebook'),
    ebook(103, 1, 'Unmonitored Ebook', { monitored: false, ebookMonitored: false }),
    // The AUDIOBOOK of a title must never answer for the eBook.
    ebook(104, 1, 'Missing Ebook', { mediaType: 'audiobook', hasFiles: true, statistics: { bookFileCount: 9 } }),
    ebook(105, 1, 'Series Book: A Novel')
  ],
  2: [ebook(201, 2, 'Some Book', { mediaType: 'audiobook', hasFiles: true, statistics: { bookFileCount: 4 } })],
  3: [ebook(301, 3, 'Popular Novel'), ebook(307, 3, 'Dune: House One'), ebook(308, 3, 'Dune: House Two')],
  4: [ebook(401, 4, 'Sneaky Book')],
  5: [ebook(501, 5, 'Narrated Novel', { mediaType: 'audiobook', hasFiles: true, statistics: { bookFileCount: 7 } })]
};
// What a RefreshAuthor turns up: a new release, and the eBook records of an author who
// has just been given an eBook side.
const AFTER_REFRESH = {
  1: [ebook(106, 1, 'Brand New Release')],
  5: [ebook(502, 5, 'Narrated Novel')]
};
const refreshed = new Set();
const booksFor = id => (BOOKS[id] || []).concat(refreshed.has(id) ? (AFTER_REFRESH[id] || []) : []);
let cmdSeq = 500;
// What Listenarr already has (1.3.4 /api/v1/library rows: status + fileCount/filePath).
// The first row keeps the older shape with no file information at all.
const LA_LIBRARY = [
  { id: 1, title: 'Owned Audiobook', authors: ['Library Author'], narrators: ['A Narrator'], asin: 'B00OWNED', monitored: true },
  { id: 2, title: 'Wanted Audiobook', authors: ['Library Author'], asin: 'B00WANTED', monitored: true, wanted: true, status: 'wanted', fileCount: 0, filePath: null },
  { id: 3, title: 'Downloading Audiobook', authors: ['Library Author'], asin: 'B00DLING', monitored: true, wanted: true, status: 'downloading', fileCount: 0, filePath: null },
  { id: 4, title: 'Downloaded Audiobook', authors: ['Library Author'], asin: 'B00HAVE', monitored: false, wanted: false, status: 'quality-match', fileCount: 12, filePath: '/audiobooks/Library Author/Downloaded Audiobook' },
  { id: 5, title: 'Unmonitored Wanted', authors: ['Library Author'], asin: 'B00UNMON', monitored: false, wanted: false, status: 'missing', fileCount: 0, filePath: null }
];
let upstreamCalls = [];           // records every write that hits the mock downloaders
let upstreamDown = false;         // simulate the downloader being offline
let getCounts = {};               // per-path GET counters (proves caching works)
let authorListDelayMs = 0;        // live Chaptarr took 21-44s to list its authors
let slowWritesMs = 0;             // hold writes open, so a double-click has something to race

// ── Mock Chaptarr (serves eBooks AND audiobooks, like the real thing) ──
const mock = http.createServer((req, res) => {
  if (upstreamDown) { req.socket.destroy(); return; }
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const later = (fn) => (slowWritesMs ? setTimeout(fn, slowWritesMs) : fn());
    const u = req.url.split('?')[0];
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    if (req.method === 'GET') getCounts[u] = (getCounts[u] || 0) + 1;
    if (u === '/api/v1/author/lookup') {
      // Real Chaptarr matches on ?term=. The mock has to as well, or a request for
      // one author comes back as a different one and the tests below prove nothing.
      const t = String(qs.get('term') || '').toLowerCase();
      getCounts['lookup:' + t] = (getCounts['lookup:' + t] || 0) + 1;
      if (t.includes('audio only')) return send(200, [{ authorName: 'Audio Only Author', foreignAuthorId: 'fa-audio' }]);
      if (t.includes('library author')) return send(200, [{ authorName: 'Library Author', foreignAuthorId: 'fa-lib' }]);
      if (t.includes('popular author')) return send(200, []);   // broken, like "stephen king" live
      if (t.includes('sneaky author')) return send(200, [{ authorName: 'Sneaky Author', foreignAuthorId: 'gr:999' }]);
      if (t.includes('fresh author')) return send(200, [{ authorName: 'Fresh Author', foreignAuthorId: 'fa-fresh' }]);
      return send(200, [{ authorName: 'Test Author', foreignAuthorId: 'fa-123' }]);
    }
    if (u === '/api/v1/author' && req.method === 'POST') {
      const b = JSON.parse(body);
      upstreamCalls.push({ kind: 'chaptarr-add', body: b });
      const dupe = { propertyName: 'ForeignAuthorId', errorMessage: 'This author has already been added' };
      if (b.foreignAuthorId === SNEAKY_AUTHOR.foreignAuthorId) { sneakyVisible = true; return send(400, [dupe]); }
      if ([...AUTHORS.values()].some(a => a.foreignAuthorId === b.foreignAuthorId)) return send(400, [dupe]);
      // Added for real: in the list from now on, with a catalogue holding the title
      // the approval tests keep asking for.
      const id = nextAuthorId++;
      const rec = Object.assign({}, b, { id });
      AUTHORS.set(id, rec);
      BOOKS[id] = [ebook(id * 100 + 1, id, 'A Book')];
      return send(201, rec);
    }
    if (u === '/api/v1/command' && req.method === 'POST') {
      const b = JSON.parse(body);
      upstreamCalls.push({ kind: 'chaptarr-command', body: b });
      if (b.name === 'RefreshAuthor') refreshed.add(b.authorId);
      return later(() => send(201, { id: ++cmdSeq, name: b.name, status: 'queued' }));
    }
    if (u.startsWith('/api/v1/command/')) return send(200, { id: Number(u.split('/').pop()), status: 'completed' });
    if (u === '/api/v1/book/monitor' && req.method === 'PUT') {
      const b = JSON.parse(body);
      upstreamCalls.push({ kind: 'chaptarr-monitor', body: b });
      const rows = Object.values(BOOKS).flat().filter(x => (b.bookIds || []).includes(x.id));
      rows.forEach(x => { x.monitored = b.monitored; x.ebookMonitored = b.monitored; });
      return send(202, rows);
    }
    const one = u.match(/^\/api\/v1\/author\/(\d+)$/);
    if (one) {
      const a = AUTHORS.get(Number(one[1]));
      if (!a) return send(404, { message: 'NotFound' });
      if (req.method === 'PUT') { upstreamCalls.push({ kind: 'chaptarr-update', body: JSON.parse(body) }); return send(202, a); }
      return send(200, a);
    }
    if (u === '/api/v1/author') {
      const list = [...AUTHORS.values()].filter(a => a !== SNEAKY_AUTHOR || sneakyVisible);
      return authorListDelayMs ? setTimeout(() => send(200, list), authorListDelayMs) : send(200, list);
    }
    if (u === '/api/v1/book') return send(200, qs.get('authorId') ? booksFor(Number(qs.get('authorId'))) : []);
    if (u === '/api/v1/system/status') return send(200, { version: '1.2.3', appName: 'Chaptarr' });
    if (u === '/api/v1/system/info') return send(200, { version: '2.0.0' });
    // Chaptarr types these because it serves eBooks AND audiobooks. Both kinds are
    // returned here so the tests can prove BookSeerr only ever offers the eBook ones.
    if (u === '/api/v1/qualityprofile') return send(200, [
      { id: 1, name: 'E-Book', profileType: 'ebook' },
      { id: 2, name: 'Audiobook', profileType: 'audiobook' }
    ]);
    if (u === '/api/v1/metadataprofile') return send(200, [
      { id: 1, name: 'Audiobook Default', profileType: 1 },
      { id: 2, name: 'Ebook Default', profileType: 2 }
    ]);
    if (u === '/api/v1/rootfolder' || u === '/api/v1/rootfolders') return send(200, [
      { id: 1, name: 'eBooks', path: '/books', folderType: 2, ebook: { qualityProfileId: 1, metadataProfileId: 2 } },
      { id: 2, name: 'Audiobooks', path: '/audiobooks', folderType: 1, audiobook: { qualityProfileId: 2, metadataProfileId: 1 } }
    ]);
    return send(200, {});
  });
});

// ── Mock Listenarr (audiobooks) ──
// Deliberately mirrors one real-world quirk: Listenarr serves its web UI from the
// same host, so ANY /api path it doesn't know comes back 200 with the SPA's HTML
// rather than a 404. Code that only checks the status code is fooled by that.
const laMock = http.createServer((req, res) => {
  if (upstreamDown) { req.socket.destroy(); return; }
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const later = (fn) => (slowWritesMs ? setTimeout(fn, slowWritesMs) : fn());
    const u = req.url.split('?')[0];
    if (req.method === 'GET') getCounts['LA' + u] = (getCounts['LA' + u] || 0) + 1;
    if (u === '/api/v1/library/add' && req.method === 'POST') {
      const b = JSON.parse(body || '{}');
      upstreamCalls.push({ kind: 'listenarr-add', body: b });
      // A deliberate failure hook so the "downloader rejected it" path can be tested.
      if (((b.metadata || {}).asin) === 'FAILME1') return send(400, { errors: { '$.metadata.asin': ['not a real ASIN'] } });
      // Already there → 409 carrying the record it has, as Listenarr 1.3 does.
      const have = LA_LIBRARY.find(x => x.asin === (b.metadata || {}).asin);
      if (have) return later(() => send(409, { message: 'Audiobook already exists in library', audiobook: have }));
      return later(() => send(201, { audiobook: { id: 9, asin: (b.metadata || {}).asin, title: (b.metadata || {}).title } }));
    }
    if (u === '/api/v1/download/search-and-download' && req.method === 'POST') {
      upstreamCalls.push({ kind: 'listenarr-search', body: JSON.parse(body || '{}') });
      return send(200, { success: true, indexerUsed: 'MockIndexer', message: 'Found' });
    }
    const one = u.match(/^\/api\/v1\/library\/(\d+)$/);
    if (one) {
      const row = LA_LIBRARY.find(x => x.id === Number(one[1]));
      if (!row) return send(404, { message: 'Not found' });
      if (req.method === 'PUT') { const b = JSON.parse(body || '{}'); upstreamCalls.push({ kind: 'listenarr-update', id: row.id, body: b }); Object.assign(row, b); return send(200, row); }
      // Like 1.3.4: the single-item read has the files but NOT the list's status or
      // fileCount — so on its own it can't tell "downloading" from "missing".
      const { status, fileCount, ...detail } = row;
      return send(200, Object.assign({ files: fileCount ? [{ path: row.filePath }] : [] }, detail));
    }
    if (u === '/api/v1/library') return send(200, LA_LIBRARY);
    if (u === '/api/v1/system/info') return send(200, { version: '1.0.11' });
    if (u === '/api/v1/qualityprofile') return send(200, [{ id: 9, name: 'Audio Default' }]);
    if (u === '/api/v1/rootfolders') return send(200, [{ id: 3, name: 'Audiobooks', path: '/audiobooks' }]);
    if (u === '/api/v1/search/audible') return send(200, { results: [], totalResults: 0 });
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!DOCTYPE html><html><body>Listenarr</body></html>');
  });
});

// ── Mock Google Books + Audible, so Discover can be tested without the internet ──
// Both mocks reproduce the exact behaviour that made the real rows wrong:
//   * Google Books IGNORES orderBy=newest — it returns the same relevance-ordered
//     list every time, mostly old books. Only naming the year in the query surfaces
//     recent ones. (Verified against the live API.)
//   * Audible sorted by -ReleaseDate hands back the FURTHEST-FUTURE titles first, so
//     page 0 is entirely pre-orders and released titles only start a couple of pages
//     in. (Live: page 0 = 50 future / 0 past, page 1 = 42/8, page 2 = 0/50.)
const THIS_YEAR = new Date().getFullYear();
const gbVolume = (title, date) => ({
  id: 'gb-' + title.replace(/\W+/g, '-').toLowerCase(),
  volumeInfo: {
    title, authors: ['An Author'], publishedDate: date,
    description: 'A description long enough to look like a real blurb rather than a stub entry.',
    imageLinks: { thumbnail: 'https://example.test/' + encodeURIComponent(title) + '.jpg' }
  }
});
const OLD_BOOKS = ['Hemingway', 'An Old Anthology', 'A Reissued Classic', 'Collected Letters']
  .map((t, i) => gbVolume(t, String(1992 + i * 6)));
const gbMock = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const q = url.searchParams.get('q') || '';
  getCounts['GB'] = (getCounts['GB'] || 0) + 1;
  // What Google Books did for days on end, live: 503 "backendFailed" on every keyed query.
  if (/gbdown/.test(q)) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { code: 503, message: 'Service temporarily unavailable.', errors: [{ reason: 'backendFailed' }] } }));
  }
  // A single-title lookup (Top eBooks / search) — always answerable.
  if (/intitle:/.test(q)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ items: [gbVolume(q.replace(/.*intitle:/, '').split('+')[0] || 'A Title', String(THIS_YEAR - 5))] }));
  }
  // Subject browse. orderBy is ignored on purpose; the YEAR in the query is what
  // decides whether anything recent comes back.
  const m = q.match(/\b(\d{4})\b/);
  const items = OLD_BOOKS.slice();
  if (m) {
    const y = m[1];
    for (let i = 0; i < 6; i++) items.unshift(gbVolume('New Book ' + y + '-' + i + '-' + q.slice(8, 14), y + '-0' + ((i % 9) + 1) + '-15'));
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ items }));
});
const auProduct = (asin, date) => ({
  asin, title: 'Audiobook ' + asin, release_date: date,
  authors: [{ name: 'An Author' }], narrators: [{ name: 'A Narrator' }],
  product_images: { 500: 'https://example.test/' + asin + '.jpg' },
  merchandising_summary: 'Blurb.'
});
// A full catalogue record, as the "for you" rows read them: language, adult flag and
// genre ladders included.
const HORROR = [{ ladder: [{ id: '100', name: 'Literature & Fiction' }, { id: '110', name: 'Horror' }] }];
const auRec = (asin, title, author, extra) => Object.assign({
  asin, title, authors: [{ name: author }], narrators: [{ name: 'A Narrator' }], language: 'english',
  release_date: '2020-01-01', product_images: { 500: 'https://example.test/' + asin + '.jpg' },
  merchandising_summary: 'Blurb.', content_type: 'Product', category_ladders: HORROR
}, extra);
const auMock = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const page = parseInt(url.searchParams.get('page') || '0', 10);
  const now = new Date();
  const day = (offset) => new Date(now.getTime() + offset * 86400000).toLocaleDateString('en-CA');
  const json = obj => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  // "Listeners also enjoyed": one good pick per kind of thing that must be left out.
  if (url.pathname.endsWith('/sims')) {
    getCounts['AU:sims'] = (getCounts['AU:sims'] || 0) + 1;
    return json({ similar_products: [
      auRec('B00HAVE', 'Downloaded Audiobook', 'Library Author'),                    // already on the shelf
      auRec('BSPANISH', 'Libro Traducido', 'Fresh Author', { language: 'spanish' }),  // a translation
      auRec('BADULT', 'Not For Everyone', 'Fresh Author', { is_adult_product: true }),
      auRec('BFUTURE1', 'Not Out Yet', 'Fresh Author', { release_date: day(30) }),    // a pre-order
      auRec('BREC1', 'Fresh Pick', 'Fresh Author'),
      auRec('BREC2', 'Another Pick', 'Other New Author', { category_ladders: [{ ladder: [{ id: '200', name: 'Science Fiction & Fantasy' }, { id: '210', name: 'Fantasy' }] }] }),
      auRec('BREC3', 'Library Author Extra', 'Library Author'),
      auRec('BREC4', 'Downloaded Audiobook: The Complete Edition', 'Library Author')  // the shelf's book again
    ] });
  }
  // Bulk details for the shelf's own titles (genres).
  if (url.searchParams.get('asins')) {
    getCounts['AU:asins'] = (getCounts['AU:asins'] || 0) + 1;
    return json({ products: url.searchParams.get('asins').split(',').map(a => auRec(a, 'Shelf ' + a, 'Library Author')) });
  }
  // By author: newest first, with the noise a keyword match brings along.
  if (url.searchParams.get('author')) {
    const name = url.searchParams.get('author'), tag = name.replace(/\W/g, '').slice(0, 8).toUpperCase();
    return json({ products: [
      auRec('BN1' + tag, 'Recent One ' + name, name, { release_date: day(-10) }),
      auRec('BN2' + tag, 'Soon One ' + name, name, { release_date: day(20) }),
      auRec('BN3' + tag, 'Far Future ' + name, name, { release_date: day(400) }),
      auRec('BN4' + tag, 'Someone Else ' + name, 'Stephen R. ' + name, { release_date: day(-5) })
    ] });
  }
  if (url.searchParams.get('category_id')) return json({ products: [auRec('BBEST1', 'Genre Bestseller', 'Best Seller Author')] });
  getCounts['AU:page' + page] = (getCounts['AU:page' + page] || 0) + 1;
  let products;
  if (url.searchParams.get('keywords')) products = [auProduct('BKEYWORD', day(-30))];   // audibleLookupOne
  else if (page === 0) products = Array.from({ length: 8 }, (_, i) => auProduct('BFUT0' + i, day(300 - i * 10)));
  else if (page === 1) products = Array.from({ length: 8 }, (_, i) => auProduct('BMIX1' + i, day(20 - i * 6)));
  else products = Array.from({ length: 8 }, (_, i) => auProduct('BPAST' + page + i, day(-2 - i * 3)));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ products }));
});

// Open Library: the keyless fallback when Google Books is down.
const olMock = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  getCounts['OL'] = (getCounts['OL'] || 0) + 1;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ docs: [
    { key: '/works/OL1W', title: 'Fallback Book ' + (url.searchParams.get('q') || url.searchParams.get('title') || ''), author_name: ['Fallback Author'], first_publish_year: 2019, cover_i: 12345 },
    { key: '/works/OL2W', title: 'No Cover Book', author_name: ['Fallback Author'], first_publish_year: 2001 }
  ] }));
});

// ── Tiny HTTP client ──
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

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra !== undefined ? ' — got: ' + JSON.stringify(extra) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Poll until cond() holds. Some work finishes after the response that started it:
// follow-ups, and stale-while-revalidate refreshes.
async function waitFor(cond, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await cond()) return true; await sleep(50); }
  return !!(await cond());
}

// Every environment variable server.js reads. Stripped from the inherited environment
// so a value exported in the developer's shell can't change what the tests exercise
// (or point them at a real Chaptarr).
const BOOKSEERR_ENV_VARS = [
  'PORT', 'DATA_DIR', 'CHAPTARR_URL', 'CHAPTARR_API_KEY', 'BOOKSHELF_URL', 'BOOKSHELF_API_KEY', 'READARR_URL', 'READARR_API_KEY',
  'LISTENARR_URL', 'LISTENARR_API_KEY',
  'AUDIBLE_BASE', 'AUDIBLE_REGION', 'AUDIBLE_CATEGORY_ID', 'GOOGLE_BOOKS_BASE',
  'OPENLIBRARY_BASE', 'OPENLIBRARY_COVERS',
  'GOOGLE_BOOKS_API_KEY', 'CORS_ORIGINS', 'FRAME_ANCESTORS', 'JWT_SECRET', 'JWT_TTL',
  'ADMIN_USER', 'ADMIN_PASS', 'UPSTREAM_TIMEOUT_MS', 'UPSTREAM_RETRIES', 'MAX_UPSTREAM_BYTES',
  'DISCOVER_TTL_MINUTES', 'LOGIN_MAX_FAILS', 'LOGIN_LOCK_MINUTES', 'TRUST_PROXY',
  'SEND_TIMEOUT_MS', 'LIBRARY_TIMEOUT_MS'
];
function cleanEnv(overrides) {
  const env = Object.assign({}, process.env);
  for (const k of BOOKSEERR_ENV_VARS) delete env[k];
  return Object.assign(env, overrides);
}

(async () => {
  mock.listen(MOCK_PORT);
  laMock.listen(MOCK_LA_PORT);
  gbMock.listen(MOCK_GB_PORT);
  auMock.listen(MOCK_AU_PORT);
  olMock.listen(MOCK_OL_PORT);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    // cwd is the throwaway data dir, NOT the repo: dotenv reads ./.env relative to
    // cwd, so running from the repo root silently pulled in the developer's real
    // .env. Any knob the test didn't explicitly override (LOGIN_LOCK_MINUTES,
    // UPSTREAM_RETRIES, DISCOVER_TTL_MINUTES, real upstream URLs and API keys…)
    // leaked into the run, so the suite could pass or fail depending on whose
    // machine it ran on — and could talk to real services.
    cwd: DATA_DIR,
    env: cleanEnv({
      PORT: String(APP_PORT), DATA_DIR,
      CHAPTARR_URL: 'http://127.0.0.1:' + MOCK_PORT, CHAPTARR_API_KEY: 'k',
      LISTENARR_URL: 'http://127.0.0.1:' + MOCK_LA_PORT, LISTENARR_API_KEY: 'la',
      GOOGLE_BOOKS_BASE: 'http://127.0.0.1:' + MOCK_GB_PORT + '/books/v1',
      AUDIBLE_BASE: 'http://127.0.0.1:' + MOCK_AU_PORT,
      OPENLIBRARY_BASE: 'http://127.0.0.1:' + MOCK_OL_PORT,
      JWT_SECRET: 'test-secret', ADMIN_USER: 'admin', ADMIN_PASS: 'adminpass',
      UPSTREAM_TIMEOUT_MS: '1500'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', d => console.error('[server] ' + d));
  // Up to 45s: a cold start on a Windows host (Defender scanning node_modules on first
  // load) measured ~12s, well past the old 6s budget, and failed every check with
  // ECONNREFUSED. The loop still exits the moment the server answers.
  for (let i = 0; i < 300; i++) { try { const r = await call('GET', '/healthz'); if (r.status === 200) break; } catch {} await sleep(150); }

  try {
    // ── Login as admin, create a normal user ──
    const admLogin = await call('POST', '/api/auth/login', { username: 'admin', password: 'adminpass' });
    const ADM = { Authorization: 'Bearer ' + admLogin.data.token };
    check('admin login', admLogin.status === 200, admLogin);

    const mk = await call('POST', '/api/users', { username: 'brad', password: 'secret1', role: 'user', limit: 10 }, ADM);
    check('create user includes autoApprove=default', mk.data.autoApprove === 'default', mk.data);
    const bradLogin = await call('POST', '/api/auth/login', { username: 'brad', password: 'secret1' });
    const BRAD = { Authorization: 'Bearer ' + bradLogin.data.token };

    const ebook = { kind: 'book', title: 'A Book', author: 'Test Author', qualityProfileId: 1, metadataProfileId: 1, rootFolderPath: '/books' };
    // Audiobooks go to Listenarr, which identifies a title by its ASIN and files it
    // under its own root folder — so a quality profile is all it asks for.
    const audio = { kind: 'audio', title: 'An Audiobook', author: 'Test Author', asin: 'B000TEST', qualityProfileId: 9 };

    console.log('\n[1] Global auto-approve ON (default) — behaves exactly like before');
    let s = await call('GET', '/api/admin/settings/approvals', null, ADM);
    check('GET approvals defaults to autoApproveAll=true', s.data.autoApproveAll === true, s.data);
    let r = await call('POST', '/api/request', ebook, BRAD);
    check('user ebook request auto-sent', r.data.status === 'sent' && r.data.approval === 'auto', r.data);
    check('upstream received chaptarr add', upstreamCalls.some(c => c.kind === 'chaptarr-add'));
    const addBody = (upstreamCalls.find(c => c.kind === 'chaptarr-add') || {}).body || {};
    check('add uses Chaptarr eBook-prefixed fields (not Readarr flat ones)',
      addBody.ebookQualityProfileId === 1 && addBody.ebookMetadataProfileId === 1 && addBody.ebookRootFolderPath === '/books'
      && addBody.qualityProfileId === undefined && addBody.rootFolderPath === undefined, addBody);
    check('a search is triggered for the newly added author',
      upstreamCalls.some(c => c.kind === 'chaptarr-command' && c.body && c.body.name === 'AuthorSearch' && c.body.authorId === 77),
      upstreamCalls.filter(c => c.kind === 'chaptarr-command').map(c => c.body));
    let meB = await call('GET', '/api/me', null, BRAD);
    check('/api/me autoApproved=true under global ON', meB.data.autoApproved === true, meB.data);

    console.log('\n[2] Turn global auto-approve OFF — user requests are held pending');
    await call('PUT', '/api/admin/settings/approvals', { autoApproveAll: false }, ADM);
    s = await call('GET', '/api/admin/settings/approvals', null, ADM);
    check('toggle persisted', s.data.autoApproveAll === false, s.data);
    meB = await call('GET', '/api/me', null, BRAD);
    check('/api/me autoApproved flips to false', meB.data.autoApproved === false, meB.data);

    upstreamCalls = [];
    r = await call('POST', '/api/request', audio, BRAD);
    const pendingId = r.data.id;
    check('user audio request held as pending', r.data.status === 'pending' && r.data.approval === 'required', r.data);
    check('NOTHING sent upstream while pending', upstreamCalls.length === 0, upstreamCalls);
    // The stored replay payload is what gets sent verbatim on approval, so it has to
    // carry the ASIN Listenarr identifies the title by.
    check('pending record stores the exact replay payload',
      !!r.data.payload && r.data.payload.kind === 'audio' && r.data.payload.asin === 'B000TEST'
      && r.data.payload.qualityProfileId === 9, r.data.payload);

    let adm = await call('POST', '/api/request', ebook, ADM);
    check('admin request bypasses approval (always auto)', adm.data.status === 'sent' && adm.data.approval === 'auto', adm.data);

    let notif = await call('GET', '/api/notifications', null, ADM);
    check('notifications report pending count', notif.data.pending === 1, notif.data);
    let flt = await call('GET', '/api/requests?status=pending', null, ADM);
    check('?status=pending filter works', Array.isArray(flt.data) && flt.data.length === 1 && flt.data[0].id === pendingId, flt.data);

    console.log('\n[3] Approve the pending request — NOW it goes upstream');
    upstreamCalls = [];
    r = await call('POST', '/api/requests/' + pendingId + '/approve', {}, ADM);
    check('approve → sent', r.data.status === 'sent', r.data);
    check('approve stamped (manual, by admin)', r.data.approval === 'manual' && r.data.approvedBy === 'admin', r.data);
    const audioAdd = (upstreamCalls.find(c => c.kind === 'listenarr-add') || {}).body || {};
    check('approved audiobook went to LISTENARR, not Chaptarr',
      upstreamCalls.some(c => c.kind === 'listenarr-add') && !upstreamCalls.some(c => c.kind === 'chaptarr-add'),
      upstreamCalls.map(c => c.kind));
    check('Listenarr add carries the ASIN inside metadata/searchResult + quality profile',
      audioAdd.metadata && audioAdd.metadata.asin === 'B000TEST' && audioAdd.searchResult && audioAdd.searchResult.asin === 'B000TEST'
      && audioAdd.qualityProfileId === 9 && audioAdd.monitored === true && audioAdd.autoSearch === true, audioAdd);
    check('Listenarr add sends only string/array metadata (typed API rejects empty dates/numbers)',
      Object.values(audioAdd.metadata || {}).every(v => typeof v === 'string' || Array.isArray(v)), audioAdd.metadata);
    check('payload cleaned off the record after send', r.data.payload === undefined, r.data.payload);
    r = await call('POST', '/api/requests/' + pendingId + '/approve', {}, ADM);
    check('re-approving a sent request → 400', r.status === 400, r);
    r = await call('POST', '/api/requests/' + pendingId + '/approve', {}, BRAD);
    check('non-admin cannot approve → 403', r.status === 403, r);

    console.log('\n[4] Reject a pending request — nothing sent, daily slot refunded');
    let meBefore = await call('GET', '/api/me', null, BRAD);
    r = await call('POST', '/api/request', ebook, BRAD);
    const rejId = r.data.id;
    check('second request pending', r.data.status === 'pending', r.data);
    upstreamCalls = [];
    r = await call('POST', '/api/requests/' + rejId + '/reject', { reason: 'not this one' }, ADM);
    check('reject → rejected + who/why recorded', r.data.status === 'rejected' && r.data.rejectedBy === 'admin' && /not this one/.test(r.data.message), r.data);
    check('reject sends NOTHING upstream', upstreamCalls.length === 0, upstreamCalls);
    let meAfter = await call('GET', '/api/me', null, BRAD);
    check('daily slot refunded after reject', meAfter.data.requests === meBefore.data.requests, { before: meBefore.data.requests, after: meAfter.data.requests });
    r = await call('POST', '/api/requests/' + rejId + '/reject', {}, ADM);
    check('rejecting a non-pending request → 400', r.status === 400, r);

    console.log('\n[5] Per-user overrides beat the global toggle');
    const bradId = mk.data.id;
    await call('PATCH', '/api/users/' + bradId, { autoApprove: 'on' }, ADM);
    r = await call('POST', '/api/request', audio, BRAD);
    check('override=on → auto-sent even though global is OFF', r.data.status === 'sent' && r.data.approval === 'auto', r.data);
    await call('PUT', '/api/admin/settings/approvals', { autoApproveAll: true }, ADM);
    await call('PATCH', '/api/users/' + bradId, { autoApprove: 'off' }, ADM);
    r = await call('POST', '/api/request', ebook, BRAD);
    const p2 = r.data.id;
    check('override=off → pending even though global is ON', r.data.status === 'pending', r.data);
    let ul = await call('GET', '/api/users', null, ADM);
    check('users list exposes autoApprove', ul.data.find(x => x.id === bradId).autoApprove === 'off', ul.data);

    console.log('\n[6] Approve while the downloader is DOWN → error, then Retry works');
    upstreamDown = true;
    r = await call('POST', '/api/requests/' + p2 + '/approve', {}, ADM);
    check('approve with upstream down → error status recorded', r.data.status === 'error', r.data);
    upstreamDown = false;
    upstreamCalls = [];
    r = await call('POST', '/api/requests/' + p2 + '/approve', {}, ADM);
    check('retry (approve again) → sent', r.data.status === 'sent', r.data);
    // Test Author has been in Chaptarr since [1], so the retry searches for the one
    // book instead of trying to add the author all over again.
    check('retry reconstructed the payload and hit upstream (a search for that book)',
      upstreamCalls.some(c => c.kind === 'chaptarr-command' && c.body.name === 'BookSearch' && String(c.body.bookIds) === '7701')
      && !upstreamCalls.some(c => c.kind === 'chaptarr-add'), upstreamCalls);

    console.log('\n[6b] An author Chaptarr holds for AUDIOBOOKS still gets the eBook side');
    upstreamCalls = [];
    r = await call('POST', '/api/request', { kind: 'author', author: 'Audio Only Author', qualityProfileId: 1, metadataProfileId: 2, rootFolderPath: '/books' }, ADM);
    check('audiobook-only author → sent', r.data.status === 'sent', r.data);
    const upd = (upstreamCalls.find(c => c.kind === 'chaptarr-update') || {}).body || {};
    check('existing author is UPDATED (PUT), never POSTed again',
      upstreamCalls.some(c => c.kind === 'chaptarr-update') && !upstreamCalls.some(c => c.kind === 'chaptarr-add'),
      upstreamCalls.map(c => c.kind));
    check('the update adds the eBook side and leaves the audiobook side alone',
      upd.ebookQualityProfileId === 1 && upd.ebookRootFolderPath === '/books'
      && upd.audiobookQualityProfileId === 2 && upd.audiobookRootFolderPath === '/audiobooks', upd);
    check('a search is fired for the updated author',
      upstreamCalls.some(c => c.kind === 'chaptarr-command' && c.body.name === 'AuthorSearch' && c.body.authorId === 2),
      upstreamCalls.filter(c => c.kind === 'chaptarr-command').map(c => c.body));
    r = await call('GET', '/api/library/check?kind=book&title=Anything&author=' + encodeURIComponent('Audio Only Author'), null, ADM);
    check('an audiobook-only author does NOT count as an eBook library hit', r.data.inLibrary === false, r.data);

    console.log('\n[7] User cancelling their own pending request refunds the slot');
    await call('PUT', '/api/admin/settings/approvals', { autoApproveAll: false }, ADM);
    await call('PATCH', '/api/users/' + bradId, { autoApprove: 'default' }, ADM);
    meBefore = await call('GET', '/api/me', null, BRAD);
    r = await call('POST', '/api/request', audio, BRAD);
    await call('DELETE', '/api/requests/' + r.data.id, null, BRAD);
    meAfter = await call('GET', '/api/me', null, BRAD);
    check('cancel refunds the daily slot', meAfter.data.requests === meBefore.data.requests, { before: meBefore.data.requests, after: meAfter.data.requests });

    console.log('\n[8] Dashboard + validation');
    let d = await call('GET', '/api/dashboard', null, ADM);
    check('dashboard exposes approvals + rejected count + rejected filter',
      d.data.approvals && d.data.approvals.autoApproveAll === false && d.data.requests.rejected === 1 && d.data.filters.statuses.includes('rejected'), { approvals: d.data.approvals, rejected: d.data.requests.rejected, statuses: d.data.filters.statuses });
    check('dashboard "approved" alias matches sent', d.data.requests.approved === d.data.requests.sent, d.data.requests);
    check('dashboard counts are internally consistent (sent+pending+rejected+error = total)',
      d.data.requests.sent + d.data.requests.pending + d.data.requests.rejected + d.data.requests.error === d.data.requests.total, d.data.requests);
    const bu = (d.data.byUser || []).find(x => x.username === 'brad');
    check('byUser carries a per-user status breakdown',
      bu && bu.total === bu.sent + bu.pending + bu.rejected + bu.error && bu.rejected === 1, bu);
    check('dashboard recent items include status', (d.data.recent || []).every(x => typeof x.status === 'string'), d.data.recent && d.data.recent[0]);
    r = await call('PUT', '/api/admin/settings/approvals', { autoApproveAll: 'yes' }, ADM);
    check('non-boolean toggle rejected → 400', r.status === 400, r);
    r = await call('GET', '/api/admin/settings/approvals', null, BRAD);
    check('non-admin cannot read approvals → 403', r.status === 403, r);

    console.log('\n[9] Upstream-usage guard — caching, dedupe, and cache busting');
    getCounts = {};
    // Three library checks back to back (two batch + one single) → ONE author fetch.
    const item = { items: [{ kind: 'book', title: 'A Book', author: 'Library Author' }] };
    await call('POST', '/api/library/check-batch', item, ADM);
    await call('POST', '/api/library/check-batch', item, ADM);
    r = await call('GET', '/api/library/check?kind=author&author=' + encodeURIComponent('Library Author'), null, ADM);
    check('3 library checks → author list fetched AT MOST ONCE (shared 90s cache)', (getCounts['/api/v1/author'] || 0) <= 1, getCounts);
    check('single + batch checks share the same cache and still match', r.data.inLibrary === true, r.data);

    // Dashboard polled twice + both status widgets → AT MOST one ping per service
    // (zero here, since the health cache is still warm from section [8]'s dashboard
    // call — polls never scale upstream traffic).
    const d9 = await call('GET', '/api/dashboard', null, ADM);
    await call('GET', '/api/dashboard', null, ADM);
    await call('GET', '/api/chaptarr/status', null, ADM);
    const w9 = await call('GET', '/api/chaptarr/status', null, ADM);
    const l9 = await call('GET', '/api/listenarr/status', null, ADM);
    check('4 health polls → ≤1 ping per service (60s shared cache)',
      (getCounts['/api/v1/system/status'] || 0) <= 1 && (getCounts['LA/api/v1/system/info'] || 0) <= 1, getCounts);
    check('Listenarr status widget reports connected + version', l9.data.connected === true && l9.data.version === '1.0.11', l9.data);
    check('cached health still reports connected + version',
      d9.data.upstreams && d9.data.upstreams.chaptarr ? (d9.data.upstreams.chaptarr.connected === true && w9.data.connected === true)
        : (d9.data.chaptarr ? d9.data.chaptarr.connected === true : w9.data.connected === true), { dash: d9.data.upstreams || d9.data.chaptarr, widget: w9.data });

    // Request modal opened twice → profiles fetched once.
    const optL = await call('GET', '/api/listenarr/options', null, ADM);
    check('Listenarr options expose its quality profiles + root folders',
      optL.data.qualityProfiles.length === 1 && optL.data.qualityProfiles[0].id === 9
      && optL.data.rootFolders.length === 1 && optL.data.rootFolders[0].path === '/audiobooks', optL.data);
    const optA = await call('GET', '/api/chaptarr/options', null, ADM);
    await call('GET', '/api/chaptarr/options', null, ADM);
    check('only eBook quality profiles are offered',
      optA.data.qualityProfiles.length === 1 && optA.data.qualityProfiles[0].id === 1, optA.data.qualityProfiles);
    check('only eBook metadata profiles are offered',
      optA.data.metadataProfiles.length === 1 && optA.data.metadataProfiles[0].id === 2, optA.data.metadataProfiles);
    check('only eBook root folders are offered',
      optA.data.rootFolders.length === 1 && optA.data.rootFolders[0].path === '/books', optA.data.rootFolders);
    check('2 modal opens → profiles fetched ONCE (5-min cache)', (getCounts['/api/v1/qualityprofile'] || 0) === 1, getCounts);

    // A successful send marks what it changed as stale so "in library" badges refresh.
    // Here that's a search for one of Test Author's books (in Chaptarr since [1]), so the
    // next check re-reads THAT author's book list — in the background, answering from
    // the previous copy meanwhile (stale-while-revalidate).
    await call('PUT', '/api/admin/settings/approvals', { autoApproveAll: true }, ADM);
    r = await call('POST', '/api/request', ebook, BRAD);
    check('setup: request auto-sent', r.data.status === 'sent', r.data);
    // Counted AFTER the send (the send reads the book list itself), so this
    // measures exactly one thing: the next check had to go upstream again.
    const bookFetchesAfterSend = getCounts['/api/v1/book'] || 0;
    await call('POST', '/api/library/check-batch', { items: [{ kind: 'book', title: 'A Book', author: 'Test Author' }] }, ADM);
    await waitFor(() => (getCounts['/api/v1/book'] || 0) > bookFetchesAfterSend);
    check('send marks the library cache stale → next check refetches',
      (getCounts['/api/v1/book'] || 0) === bookFetchesAfterSend + 1, getCounts);

    console.log('\n[9b] Discover shows CURRENT content in every row');
    const disc = await call('GET', '/api/discover', null, ADM);
    const today9 = new Date().toLocaleDateString('en-CA');
    check('every Discover row is populated',
      (disc.data.ebooks || []).length > 0 && (disc.data.authors || []).length > 0 &&
      (disc.data.topEbooks || []).length > 0 && (disc.data.audioRecent || []).length > 0 &&
      (disc.data.audioUpcoming || []).length > 0 && (disc.data.topAudio || []).length > 0,
      Object.fromEntries(Object.entries(disc.data).map(([k, v]) => [k, (v || []).length])));
    // Google Books ignores orderBy=newest, so the row used to fill with decades-old
    // books and the "row looks thin, use whatever we got" fallback hid it completely.
    const ebYears = (disc.data.ebooks || []).map(b => parseInt(b.year, 10)).filter(Boolean);
    check('"New & Trending eBooks" contains nothing older than last year',
      ebYears.length > 0 && ebYears.every(y => y >= THIS_YEAR - 1),
      ebYears.filter(y => y < THIS_YEAR - 1));
    check('the newest eBook really is the first card',
      (disc.data.ebooks || []).every((b, i, a) => i === 0 || String(a[i - 1].pubDate || a[i - 1].year) >= String(b.pubDate || b.year)),
      (disc.data.ebooks || []).slice(0, 4).map(b => b.year));
    check('every eBook card has a cover and an author (it is requested BY author)',
      (disc.data.ebooks || []).every(b => b.image && b.author),
      (disc.data.ebooks || []).filter(b => !b.image || !b.author).slice(0, 3));
    // Audible returns the furthest-future titles first, so one page of results was
    // all pre-orders: "Recently Released" was permanently empty.
    check('"Recently Released Audiobooks" is not empty', (disc.data.audioRecent || []).length > 0, disc.data.audioRecent);
    check('nothing in "Recently Released" is actually in the future',
      (disc.data.audioRecent || []).every(b => b.year <= today9),
      (disc.data.audioRecent || []).filter(b => b.year > today9).map(b => b.title + ' ' + b.year));
    check('nothing in "Upcoming" has already been released',
      (disc.data.audioUpcoming || []).every(b => b.year > today9),
      (disc.data.audioUpcoming || []).filter(b => b.year <= today9).map(b => b.title + ' ' + b.year));
    check('Audible was paged past the pre-orders, not just page 0',
      (getCounts['AU:page0'] || 0) >= 1 && (getCounts['AU:page2'] || 0) >= 1, getCounts);
    check('every audiobook card carries the ASIN Listenarr needs',
      [...(disc.data.audioRecent || []), ...(disc.data.audioUpcoming || [])].every(b => b.asin),
      'missing asin');
    const gbBefore = getCounts['GB'] || 0;
    await call('GET', '/api/discover', null, ADM);
    check('a second Discover load is served from cache', (getCounts['GB'] || 0) === gbBefore, { before: gbBefore, after: getCounts['GB'] });

    console.log('\n[9c] Discover "for you" rows are built from the library');
    const fy = await call('GET', '/api/discover/for-you', null, BRAD);
    const fyRow = id => ((fy.data.rows || []).find(r => r.id === id) || { items: [] }).items;
    check('for-you answers with rows', fy.status === 200 && (fy.data.rows || []).length > 0, fy.data);
    const recAsins = fyRow('for-you-audio').map(i => i.asin);
    check('recommended audiobooks come from "listeners also enjoyed"', recAsins.includes('BREC1'), recAsins);
    check('…without anything already on the shelf (by ASIN or as another edition)',
      !recAsins.includes('B00HAVE') && !recAsins.includes('BREC4'), recAsins);
    check('…without translations, adult titles or pre-orders',
      !recAsins.includes('BSPANISH') && !recAsins.includes('BADULT') && !recAsins.includes('BFUTURE1'), recAsins);
    const allCards = (fy.data.rows || []).flatMap(r => r.items.map(i => Object.assign({ rowKind: r.kind }, i)));
    check('every audiobook card carries its ASIN and a reason',
      allCards.filter(c => c.rowKind === 'audio').every(c => c.asin && c.audio && c.why), allCards.filter(c => c.rowKind === 'audio' && (!c.asin || !c.why)));
    check('cards carry only what a card needs (no genre ladders in the payload)', allCards.every(c => !('ladders' in c) && !('authors' in c)));
    check('each title appears on one row only',
      allCards.filter(c => c.asin).length === new Set(allCards.filter(c => c.asin).map(c => c.asin)).size);
    const newAuthorNames = fyRow('new-authors').map(a => a.name);
    check('"Authors You Might Like" names authors who are NOT in the library',
      newAuthorNames.includes('Fresh Author') && newAuthorNames.includes('Other New Author') && !newAuthorNames.includes('Library Author'), newAuthorNames);
    check('eBook recommendations are eBook cards (they go to Chaptarr, not Listenarr)',
      fyRow('for-you-ebooks').length > 0 && fyRow('for-you-ebooks').every(b => !b.audio && b.title && b.author), fyRow('for-you-ebooks'));
    const fresh = fyRow('new-from-authors').map(i => i.title);
    check('"New From Your Authors" has recent and upcoming releases by shelf authors',
      fresh.some(t => /^Recent One Library Author/.test(t)) && fresh.some(t => /^Soon One Library Author/.test(t)), fresh);
    check('…but not a re-issue a year out, nor a different author with a similar name',
      !fresh.some(t => /Far Future|Someone Else/.test(t)), fresh);
    check('…released titles first, then what is coming',
      fresh.findIndex(t => /^Recent One/.test(t)) < fresh.findIndex(t => /^Soon One/.test(t)), fresh);
    check('a genre row follows the shelf\'s favourite genre', (fy.data.rows || []).some(r => r.title === 'Because You Like Horror'), (fy.data.rows || []).map(r => r.title));
    const simsBefore = getCounts['AU:sims'] || 0;
    await call('GET', '/api/discover/for-you', null, BRAD);
    check('a second load is served from cache (no new Audible lookups)', (getCounts['AU:sims'] || 0) === simsBefore, { before: simsBefore, after: getCounts['AU:sims'] });

    console.log('\n[9d] eBook search survives Google Books being down');
    r = await call('GET', '/api/search?q=gbdown&type=books', null, BRAD);
    check('a Google 503 falls back to Open Library instead of an error',
      r.status === 200 && (r.data.books || []).length > 0 && r.data.books.every(b => b.source === 'Open Library'), r.data);
    check('Open Library results get covers from its cover service',
      (r.data.books || []).some(b => /\/b\/id\/12345-L\.jpg$/.test(b.image)), (r.data.books || []).map(b => b.image));

    console.log('\n[10] Audiobook library checks resolve against Listenarr');
    r = await call('GET', '/api/library/check?kind=audio&asin=B00OWNED&title=' + encodeURIComponent('Owned Audiobook'), null, ADM);
    check('audiobook already in Listenarr is flagged', r.data.inLibrary === true && r.data.where === 'listenarr', r.data);
    r = await call('GET', '/api/library/check?kind=audio&asin=B00NOPE&title=' + encodeURIComponent('Not Owned'), null, ADM);
    check('an audiobook Listenarr does not have is not flagged', r.data.inLibrary === false, r.data);
    // Titles are not unique. Matching on title alone used to badge a different
    // author's identically named audiobook as "already in your library".
    r = await call('GET', '/api/library/check?kind=audio&title=' + encodeURIComponent('Owned Audiobook') + '&author=' + encodeURIComponent('Someone Else'), null, ADM);
    check('same title by a DIFFERENT author is not a library hit', r.data.inLibrary === false, r.data);
    r = await call('GET', '/api/library/check?kind=audio&title=' + encodeURIComponent('Owned Audiobook') + '&author=' + encodeURIComponent('Library Author'), null, ADM);
    check('same title by the SAME author is a library hit', r.data.inLibrary === true, r.data);
    const bat = await call('POST', '/api/library/check-batch', { items: [
      { kind: 'audio', title: 'Owned Audiobook', author: 'Library Author', asin: 'B00OWNED' },
      { kind: 'audio', title: 'Owned Audiobook', author: 'Someone Else' },
      { kind: 'book', title: 'A Book', author: 'Library Author' }
    ] }, ADM);
    // Row 3: Library Author is in Chaptarr but has no "A Book". That is NOT in the
    // library — it used to be reported as if it were, which talked people out of a
    // request that would have worked.
    check('batch check agrees with the single-item check on all three rows',
      bat.data.results[0].inLibrary === true && bat.data.results[1].inLibrary === false
      && bat.data.results[2].inLibrary === false && bat.data.results[2].authorInLibrary === true,
      bat.data.results);
    // Listenarr answers 200 + its web UI for any /api path it doesn't know. Anything
    // that isn't a JSON array must read as "no library", and the health probe must
    // not report a green pill for a page of HTML.
    check('Listenarr library came from /api/v1/library only (no phantom /api/v1/book call)',
      (getCounts['LA/api/v1/book'] || 0) === 0 && (getCounts['LA/api/v1/library'] || 0) >= 1, getCounts);

    // ── Shared helpers for [11] / [12] ──
    const enc = encodeURIComponent;
    const commands = name => upstreamCalls.filter(x => x.kind === 'chaptarr-command' && x.body.name === name).map(x => x.body);
    const searchedIds = () => commands('BookSearch').map(b => String(b.bookIds));
    const ebookReq = (title, author) => ({ kind: 'book', title, author, qualityProfileId: 1, metadataProfileId: 2, rootFolderPath: '/books' });
    const recordOf = async id => ((await call('GET', '/api/requests', null, ADM)).data || []).find(x => x.id === id);
    // A request whose follow-up has finished (it carries `followUp` until then).
    const settled = async id => { let rec; await waitFor(async () => { rec = await recordOf(id); return !!rec && !rec.followUp; }); return rec; };
    let fu;

    console.log('\n[11] An eBook by an author ALREADY in Chaptarr → search for that one book');
    let c11 = await call('GET', '/api/library/check?kind=book&title=' + enc('Owned Ebook') + '&author=' + enc('Library Author'), null, ADM);
    check('a downloaded eBook is "in library"', c11.data.inLibrary === true && c11.data.where === 'chaptarr', c11.data);
    c11 = await call('GET', '/api/library/check?kind=book&title=' + enc('Missing Ebook') + '&author=' + enc('Library Author'), null, ADM);
    check('one Chaptarr lists but never downloaded is NOT — requesting it starts a search',
      c11.data.inLibrary === false && c11.data.missing === true && c11.data.authorInLibrary === true, c11.data);
    c11 = await call('GET', '/api/library/check?kind=book&title=' + enc('Not In The List') + '&author=' + enc('Library Author'), null, ADM);
    check('a title the author has no record of is NOT "in library" either',
      c11.data.inLibrary === false && c11.data.authorInLibrary === true && !c11.data.missing, c11.data);
    const b11 = await call('POST', '/api/library/check-batch', { items: [
      { kind: 'book', title: 'Owned Ebook', author: 'Library Author' },
      { kind: 'book', title: 'Missing Ebook', author: 'Library Author' },
      { kind: 'book', title: 'Popular Novel', author: 'Popular Author' }
    ] }, ADM);
    check('the batch check gives the same answers',
      b11.data.results[0].inLibrary === true && b11.data.results[1].missing === true
      && b11.data.results[2].missing === true && b11.data.results[2].inLibrary === false, b11.data.results);

    upstreamCalls = [];
    r = await call('POST', '/api/request', ebookReq('Missing Ebook', 'Library Author'), ADM);
    check('a missing book by a library author → sent', r.data.status === 'sent', r.data);
    check('…which searches for THAT book (BookSearch 102)', searchedIds().join() === '102', commands('BookSearch'));
    check('…without re-adding the author or searching the whole author',
      !upstreamCalls.some(x => x.kind === 'chaptarr-add') && !commands('AuthorSearch').length, upstreamCalls);
    check('…and the record keeps Chaptarr\'s book id', r.data.chaptarrBookId === 102, r.data);

    upstreamCalls = [];
    r = await call('POST', '/api/request', ebookReq('Unmonitored Ebook', 'Library Author'), ADM);
    const order11 = upstreamCalls.map(x => x.kind === 'chaptarr-command' ? x.body.name : x.kind);
    check('an unmonitored book is monitored first, then searched',
      order11.join() === 'chaptarr-monitor,BookSearch' && String(upstreamCalls[0].body.bookIds) === '103' && upstreamCalls[0].body.monitored === true, order11);

    upstreamCalls = [];
    r = await call('POST', '/api/request', ebookReq('Owned Ebook', 'Library Author'), ADM);
    check('a book that is already downloaded sends nothing upstream',
      r.data.status === 'sent' && upstreamCalls.length === 0 && /downloaded/.test(r.data.message), { msg: r.data.message, calls: upstreamCalls });

    upstreamCalls = [];
    for (const t of ['Missing Ebook (Library Saga, #2)', 'Missing Ebook: A Novel', 'Series Book']) {
      await call('POST', '/api/request', ebookReq(t, 'Library Author'), ADM);
    }
    check('catalogue title variants still find the book (series tag, subtitle on either side)',
      searchedIds().join() === '102,102,105', searchedIds());
    upstreamCalls = [];
    r = await call('POST', '/api/request', ebookReq('Dune', 'Popular Author'), ADM);
    check('…but an ambiguous loose match is never guessed ("Dune" vs "Dune: House One/Two")',
      !commands('BookSearch').length && commands('RefreshAuthor').length === 1, upstreamCalls);
    await settled(r.data.id);

    upstreamCalls = [];
    r = await call('POST', '/api/request', ebookReq('Missing Ebook', 'Somebody Else, Library Author'), ADM);
    check('a co-written book is found under whichever of its authors Chaptarr has', searchedIds().join() === '102', upstreamCalls);

    // Chaptarr's metadata search returns nothing for this author (its lookup cache broke
    // live for "stephen king") — but the library has them, so it never needs asking.
    upstreamCalls = [];
    const lookupsBefore = getCounts['lookup:popular author'] || 0;
    r = await call('POST', '/api/request', ebookReq('Popular Novel', 'Popular Author'), ADM);
    check('an author whose metadata lookup is broken still gets their book searched',
      r.data.status === 'sent' && searchedIds().join() === '301', r.data);
    check('…without consulting that lookup at all', (getCounts['lookup:popular author'] || 0) === lookupsBefore, getCounts);

    // Not in the author's list yet → refresh them, then search once it shows up.
    upstreamCalls = [];
    r = await call('POST', '/api/request', ebookReq('Brand New Release', 'Library Author'), ADM);
    check('a title missing from the author\'s list → RefreshAuthor, request kept open',
      r.data.status === 'sent' && !!r.data.followUp && commands('RefreshAuthor').some(b => b.authorId === 1) && !commands('BookSearch').length, r.data);
    fu = await settled(r.data.id);
    check('…and once the refresh is done the new book is searched for',
      !!fu && !fu.followUp && fu.status === 'sent' && fu.chaptarrBookId === 106 && searchedIds().join() === '106', fu);

    upstreamCalls = [];
    r = await call('POST', '/api/request', ebookReq('Never Published', 'Library Author'), ADM);
    fu = await settled(r.data.id);
    check('a title that never appears ends as an error an admin can Retry',
      !!fu && fu.status === 'error' && /even after a refresh/.test(fu.message) && !commands('BookSearch').length, fu);

    // An author Chaptarr has for audiobooks only: give them the eBook side, refresh,
    // then search for the eBook — never a whole-author AuthorSearch.
    upstreamCalls = [];
    r = await call('POST', '/api/request', ebookReq('Narrated Novel', 'Second Audio Author'), ADM);
    const upd5 = (upstreamCalls.find(x => x.kind === 'chaptarr-update') || {}).body || {};
    check('audiobook-only author: the eBook side is added, then the author refreshed',
      r.data.status === 'sent' && upd5.ebookRootFolderPath === '/books' && upd5.audiobookRootFolderPath === '/audiobooks'
      && commands('RefreshAuthor').some(b => b.authorId === 5) && !commands('AuthorSearch').length, { msg: r.data.message, calls: upstreamCalls });
    fu = await settled(r.data.id);
    check('…and the follow-up searches the new eBook record, not the audiobook',
      !!fu && fu.status === 'sent' && fu.chaptarrBookId === 502 && searchedIds().join() === '502', fu);

    // Chaptarr says "already added" for an author the snapshot didn't have.
    upstreamCalls = [];
    r = await call('POST', '/api/request', ebookReq('Sneaky Book', 'Sneaky Author'), ADM);
    check('"This author has already been added" → re-read the library and search the book, not a fake success',
      r.data.status === 'sent' && searchedIds().join() === '401', { msg: r.data.message, calls: upstreamCalls });

    // A double-click: the second identical submit is turned away while the first runs.
    upstreamCalls = []; slowWritesMs = 300;
    const dbl = await Promise.all([1, 2].map(() => call('POST', '/api/request', ebookReq('Missing Ebook', 'Library Author'), ADM)));
    slowWritesMs = 0;
    check('a double-click sends ONE request; the other is refused with 409',
      dbl.map(x => x.status).sort().join() === '200,409', dbl.map(x => x.status));
    check('…so Chaptarr gets a single search', commands('BookSearch').length === 1, commands('BookSearch'));

    // An author list slower than the upstream timeout (1.5s here, 8s by default, while
    // Chaptarr took 21-44s live) no longer turns a library author into "not found".
    // Re-saving the connection drops every cached answer, so the list is read cold.
    await call('PUT', '/api/admin/settings/integrations', { service: 'chaptarr', url: 'http://127.0.0.1:' + MOCK_PORT, apiKey: 'k' }, ADM);
    upstreamCalls = []; authorListDelayMs = 2500;
    r = await call('POST', '/api/request', ebookReq('Missing Ebook', 'Library Author'), ADM);
    authorListDelayMs = 0;
    check('a slow Chaptarr author list is waited for, not mistaken for "not in library"',
      r.data.status === 'sent' && searchedIds().join() === '102' && !upstreamCalls.some(x => x.kind === 'chaptarr-add'), { msg: r.data.message, calls: upstreamCalls });

    // A NEW author still goes the whole-author route — and is known straight away.
    upstreamCalls = [];
    r = await call('POST', '/api/request', ebookReq('Fresh Book', 'Fresh Author'), ADM);
    check('a new author is still added whole (author add + AuthorSearch)',
      r.data.status === 'sent' && upstreamCalls.some(x => x.kind === 'chaptarr-add' && x.body.authorName === 'Fresh Author')
      && commands('AuthorSearch').length === 1, upstreamCalls);
    const authorReads = getCounts['/api/v1/author'] || 0;
    c11 = await call('GET', '/api/library/check?kind=author&author=' + enc('Fresh Author'), null, ADM);
    check('…the author just added counts as "in library" at once', c11.data.inLibrary === true, c11.data);
    await waitFor(() => (getCounts['/api/v1/author'] || 0) > authorReads);
    check('…while the author list is re-read in the background', (getCounts['/api/v1/author'] || 0) > authorReads, getCounts);
    upstreamCalls = [];
    r = await call('POST', '/api/request', ebookReq('A Book', 'Fresh Author'), ADM);
    check('…so a second book by them is searched for, not added twice',
      !upstreamCalls.some(x => x.kind === 'chaptarr-add') && commands('BookSearch').length === 1, upstreamCalls);

    console.log('\n[12] An audiobook Listenarr already has → search for it if it never downloaded');
    const audioReq = (title, asin) => ({ kind: 'audio', title, author: 'Library Author', asin, qualityProfileId: 9 });
    let c12 = await call('GET', '/api/library/check?kind=audio&asin=B00WANTED&title=' + enc('Wanted Audiobook'), null, ADM);
    check('an audiobook Listenarr has but never downloaded is NOT "in library"',
      c12.data.inLibrary === false && c12.data.missing === true && c12.data.where === 'listenarr', c12.data);
    c12 = await call('GET', '/api/library/check?kind=audio&asin=B00DLING&title=' + enc('Downloading Audiobook'), null, ADM);
    check('one that is downloading right now is', c12.data.inLibrary === true && /downloading/i.test(c12.data.label), c12.data);
    c12 = await call('GET', '/api/library/check?kind=audio&asin=B00HAVE&title=' + enc('Downloaded Audiobook'), null, ADM);
    check('one with files is', c12.data.inLibrary === true, c12.data);
    const b12 = await call('POST', '/api/library/check-batch', { items: [
      { kind: 'audio', title: 'Wanted Audiobook', asin: 'B00WANTED' },
      { kind: 'audio', title: 'Downloaded Audiobook', asin: 'B00HAVE' },
      { kind: 'audio', title: 'Owned Audiobook', asin: 'B00OWNED' }
    ] }, ADM);
    check('the batch check agrees (and a row with no file info at all still counts as owned)',
      b12.data.results[0].missing === true && b12.data.results[0].inLibrary === false
      && b12.data.results[1].inLibrary === true && b12.data.results[2].inLibrary === true, b12.data.results);

    upstreamCalls = [];
    r = await call('POST', '/api/request', audioReq('Wanted Audiobook', 'B00WANTED'), ADM);
    check('requesting it → sent, with a search on its way', r.data.status === 'sent' && /not downloaded yet/.test(r.data.message) && !!r.data.followUp, r.data);
    fu = await settled(r.data.id);
    check('…Listenarr\'s own search runs for that audiobook',
      upstreamCalls.some(x => x.kind === 'listenarr-search' && x.body.audiobookId === 2), upstreamCalls);
    check('…and the request reports what it found', !!fu && fu.status === 'sent' && /found a release on MockIndexer/.test(fu.message) && fu.listenarrId === 2, fu);

    upstreamCalls = [];
    r = await call('POST', '/api/request', audioReq('Unmonitored Wanted', 'B00UNMON'), ADM);
    fu = await settled(r.data.id);
    const order12 = upstreamCalls.map(x => x.kind);
    check('an unmonitored one is monitored again first, then searched',
      order12.join() === 'listenarr-add,listenarr-update,listenarr-search'
      && upstreamCalls[1].body.monitored === true && upstreamCalls[2].body.audiobookId === 5, order12);

    upstreamCalls = [];
    r = await call('POST', '/api/request', audioReq('Downloaded Audiobook', 'B00HAVE'), ADM);
    check('one it has the files for → "already in your library", no search',
      r.data.status === 'sent' && /Already in your Listenarr library/.test(r.data.message) && !r.data.followUp
      && !upstreamCalls.some(x => x.kind === 'listenarr-search'), r.data);
    r = await call('POST', '/api/request', audioReq('Downloading Audiobook', 'B00DLING'), ADM);
    check('one it is downloading → left alone', /downloading/i.test(r.data.message) && !upstreamCalls.some(x => x.kind === 'listenarr-search'), r.data);

    upstreamCalls = [];
    r = await call('POST', '/api/request', audioReq('A New Audiobook', 'B00NEWONE'), ADM);
    check('a NEW audiobook by an author Listenarr already has goes straight in (add + autoSearch)',
      r.data.status === 'sent' && upstreamCalls.some(x => x.kind === 'listenarr-add' && x.body.autoSearch === true)
      && !upstreamCalls.some(x => x.kind === 'listenarr-search') && r.data.listenarrId === 9, r.data);

    upstreamCalls = []; slowWritesMs = 300;
    const dblA = await Promise.all([1, 2].map(() => call('POST', '/api/request', audioReq('Another New One', 'B00NEWTWO'), ADM)));
    slowWritesMs = 0;
    check('an audiobook double-click sends ONE request',
      dblA.map(x => x.status).sort().join() === '200,409' && upstreamCalls.filter(x => x.kind === 'listenarr-add').length === 1, dblA.map(x => x.status));
  } catch (e) {
    failed++;
    console.error('HARNESS ERROR:', e);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  // Wait for the server child to actually exit before leaving. Killing it and
  // calling process.exit() in the same tick left it holding port 9912, so running
  // this suite twice in a row (or right after another) failed with ECONNREFUSED on
  // the next boot — a harness artefact that looked like a product bug.
  await new Promise(res => { const t = setTimeout(res, 3000); srv.once('exit', () => { clearTimeout(t); res(); }); srv.kill(); });
  mock.close(); laMock.close(); gbMock.close(); auMock.close(); olMock.close();
  process.exit(failed ? 1 : 0);
})();
