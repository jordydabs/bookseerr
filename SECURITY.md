# Security policy

## Supported versions

Security fixes go into the [latest release](https://github.com/jordydabs/bookseerr/releases/latest). Please check that a problem still exists there before reporting it.

## Reporting a vulnerability

**Please don't open a public issue for a security problem.**

Report it privately through GitHub: [**Report a vulnerability**](https://github.com/jordydabs/bookseerr/security/advisories/new) (Security tab → *Report a vulnerability*). The details stay between you and the maintainer until a fix is out.

If that option isn't available, open an issue that says only that you'd like to report a security problem privately — no technical details — and the maintainer will arrange a private channel.

It helps to include:

- the BookSeerr version (bottom of the sidebar, or `/healthz`) and how you run it: Docker or bare metal, which reverse proxy, your `TRUST_PROXY` value;
- what an attacker would need — an account, an API key, or just network access;
- steps to reproduce.

Replies are best-effort.

## Scope

**In scope:** BookSeerr itself and the container as shipped in this repository — sign-in and sessions, API keys, the approval workflow, how the stored Chaptarr / Listenarr / webhook credentials are handled, request validation, and the like.

**Out of scope:** bugs in Chaptarr, Listenarr, Audible, Google Books or Open Library themselves; exposing BookSeerr straight to the internet without a TLS reverse proxy (the [Security section of the README](README.md#security) describes the recommended setup); and a `TRUST_PROXY` value that doesn't match your real number of proxies.
