# Contributing to BookSeerr

Thanks for helping out — bug reports, ideas, docs fixes and pull requests are all welcome.

## Reporting a bug or suggesting a feature

[Open an issue](https://github.com/jordydabs/bookseerr/issues/new/choose) and pick a template; it asks for the few things that make a problem reproducible (version, how you run it, logs). Please blank out API keys, passwords and webhook URLs first.

A security problem? Don't file a public issue — see [SECURITY.md](SECURITY.md).

For anything bigger than a small fix, please open an issue first so the approach can be agreed before you spend time on it.

## Running it locally

```bash
git clone https://github.com/jordydabs/bookseerr.git
cd bookseerr
npm ci
cp .env.example .env     # set ADMIN_PASS, and change DATA_DIR=/app/data to DATA_DIR=./data
npm start                # http://localhost:8099
```

You don't need Chaptarr or Listenarr running to work on most of BookSeerr — the test suites use mock servers for both.

## Tests

```bash
npm test
```

Two headless suites ([`test/approvals.js`](test/approvals.js) and [`test/security.js`](test/security.js)) boot the real server against mock Chaptarr, Listenarr, Audible, Google Books and Open Library servers. No Docker and no live services are needed, and they never touch your `data/` directory. Run one on its own with `npm run test:approvals` or `npm run test:security`.

A change that fixes a bug or adds behaviour should come with a check in the suite it belongs to. CI runs both suites on Node 20 (what the Docker image uses) and Node 22 for every pull request.

## Code style

- Plain Node/Express on the backend (`server.js`) and plain JS/HTML/CSS in `public/`. There is no build step, and the project aims to keep it that way.
- Match the surrounding code — naming, formatting, comment density.
- Think twice before adding a dependency. The image installs from `package-lock.json` and is deliberately small.

## Pull requests

1. Fork the repo and branch from `main`.
2. Keep the change focused — one thing per pull request.
3. Make sure `npm test` passes.
4. Add a line to [`CHANGELOG.md`](CHANGELOG.md) under a `## Unreleased` heading at the top — user-visible changes only.
5. Update `README.md` and `.env.example` if behaviour or settings change.

Contributions are accepted under the project's license, [PolyForm Noncommercial 1.0.0](LICENSE).

## Releasing (maintainers)

1. **Bump the version everywhere it lives:** `npm version X.Y.Z --no-git-tag-version` (updates `package.json` and `package-lock.json`), `APP_VERSION` in `server.js`, and the image tag in `docker-compose.yml`.
2. **Rename `## Unreleased` to `## X.Y.Z`** in `CHANGELOG.md`. The release notes are taken from that section, so keep the heading in that form (` — date` after the number is fine).
3. **Run `npm test` and merge to `main`.**
4. **Tag the merge commit and push the tag:**

   ```bash
   git tag -a vX.Y.Z -m "BookSeerr vX.Y.Z" && git push origin vX.Y.Z
   ```

The [Release workflow](.github/workflows/release.yml) does the rest: it checks that the tag, `package.json`, `package-lock.json`, `server.js` and `docker-compose.yml` all agree, runs the tests, and publishes a release titled **BookSeerr vX.Y.Z** whose notes are that CHANGELOG section plus install and upgrade steps. A version with a hyphen (`v4.11.0-rc.1`) is published as a pre-release.

You can also run it by hand from **Actions → Release → Run workflow**; if the tag doesn't exist yet it is created on the branch you pick. If an earlier release was tagged with something other than a version, put that tag in **Replace**: once the new release is published, the old one is deleted, tag included.
