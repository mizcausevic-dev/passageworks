# Passageworks

Passageworks is a private research workspace. A project holds sources, versioned extracts, annotations, working notes, and briefs. Full-text search and manual editing work without an AI provider. Cited generation runs only when a server-side provider is configured, and it refuses to invent a draft when one is not.

GitHub Pages can host the browser preview. It cannot host Postgres, private object storage, or the worker. The preview is labeled and keeps AI unavailable.

## Verified in this environment

- `npm test`: 12 tests passed on Node 22 using embedded Postgres (PGlite), including text PDF extraction, scanned-PDF `ocr_required`, password-protected PDF refusal, SSRF blocking, workspace isolation, optimistic concurrency, share revocation, citation checks, and queued-job cancellation.
- `tsc` passed for the domain, server, and web packages.
- The demo bundle was built and exercised in a browser: sign-in, extracted field log, page number on the methods note, search hit for "lower footbridge", OCR-required plate, unavailable generation, and a revoked share link.
- Docker Compose was not run here. Docker is not installed in this environment.

## Two runtimes

| Runtime | What it actually does |
| --- | --- |
| Preview (`VITE_DEMO_MODE=true`) | React UI, in-memory Northglass fixtures, browser PDF text extraction when you upload a PDF, substring search. No durable queue, no private disk, no URL fetch, no model call. |
| Server | Hono API, Postgres full-text search, local private object storage, `SKIP LOCKED` worker, SSRF-checked public fetch, optional OpenAI-compatible generation. |

Lexical search on the server does not require a model. Semantic retrieval is unavailable: there is no embedding index, and the semantic entry point throws.

## Local server

```bash
npm ci
npm test
npm run dev:server
```

With `DATABASE_URL` unset and `NODE_ENV` not `production`, the API uses embedded Postgres in `.data/pglite` and files in `.data/storage`. In another terminal:

```bash
npm run dev:web
```

The Vite dev server proxies `/api` to `127.0.0.1:8787`.

For Postgres 16 instead of the embedded database, set `DATABASE_URL` and run `npm run dev:worker` beside the API. See [DEPLOY-Cursor.md](DEPLOY-Cursor.md).

## GitHub

About: Collaborative research workspace for source ingestion, annotation, lexical search, and cited briefs.

Topics: `research`, `annotations`, `full-text-search`, `typescript`, `postgres`, `provenance`, `citations`, `knowledge-management`, `pdf`, `collaboration`

Handle: `mizcausevic-dev`

This repository has no license file. All rights reserved by the repository owner.

The Northglass Basin notes are fictional. They are not a real archive.
