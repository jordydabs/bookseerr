#!/usr/bin/env node
// Prints the GitHub release notes for one version: that version's section of
// CHANGELOG.md, followed by install/upgrade steps.
//
//   node .github/scripts/release-notes.js 4.10.0 > notes.md
//
// CHANGELOG.md is hard-wrapped for reading in an editor, but GitHub renders a single
// newline in release notes as a line break, so wrapped paragraphs would come out
// ragged. The section is unwrapped before it is printed.
'use strict';
const fs = require('fs');
const path = require('path');

const version = (process.argv[2] || '').replace(/^v/, '');
if (!version) {
  console.error('usage: release-notes.js <version>   e.g. 4.10.0');
  process.exit(2);
}
const tag = `v${version}`;
const repo = 'https://github.com/jordydabs/bookseerr';

const lines = fs.readFileSync(path.join(__dirname, '..', '..', 'CHANGELOG.md'), 'utf8').split(/\r?\n/);

// The section runs from "## <version>" (an optional " — date" after it is fine) to the
// next "## " heading. "### Added" and friends belong to it.
const isVersionHeading = (l) => /^##\s/.test(l);
const start = lines.findIndex((l) => isVersionHeading(l) && l.split(/\s+/)[1] === version);
if (start < 0) {
  console.error(`CHANGELOG.md has no "## ${version}" section`);
  process.exit(1);
}
let end = lines.findIndex((l, i) => i > start && isVersionHeading(l));
if (end < 0) end = lines.length;

const out = [];
let fenced = false;
for (const raw of lines.slice(start + 1, end)) {
  const line = raw.trimEnd();
  if (/^\s*(```|~~~)/.test(line)) {
    fenced = !fenced;
    out.push(line);
    continue;
  }
  const prev = out[out.length - 1];
  const startsBlock = line === '' || /^\s*([-*+]|\d+[.)])\s/.test(line) || /^\s*[#>|]/.test(line);
  const prevIsText = prev !== undefined && prev !== '' && !/^\s*(#|\||```|~~~)/.test(prev);
  if (!fenced && !startsBlock && prevIsText) out[out.length - 1] = `${prev} ${line.trim()}`;
  else out.push(line);
}
while (out.length && out[0] === '') out.shift();
while (out.length && out[out.length - 1] === '') out.pop();
if (!out.length) {
  console.error(`The "## ${version}" section of CHANGELOG.md is empty`);
  process.exit(1);
}

const footer = `
---

### Install or upgrade

\`\`\`bash
# New install (then open http://localhost:8099)
git clone --branch ${tag} ${repo}.git && cd bookseerr
cp .env.example .env     # set ADMIN_PASS; Chaptarr and Listenarr can be linked later in Settings
docker compose up -d --build

# Already running? Switch to this release and rebuild
git fetch --tags && git checkout ${tag} && docker compose up -d --build
\`\`\`

Full history in [CHANGELOG.md](${repo}/blob/${tag}/CHANGELOG.md) · setup and configuration in the [README](${repo}/blob/${tag}/README.md).
`;

process.stdout.write(`${out.join('\n')}\n${footer}`);
