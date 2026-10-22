# Deploy Passageworks

## What was not run here

Docker is not installed in the build environment, and this session is not authenticated to GitHub. The commands below are the deploy path. They are not a claim that a container or a Pages site was published from this session.

## GitHub Pages preview

Pages serves only the static demo. After the repository exists and Pages is allowed to deploy from GitHub Actions:

1. Push `main` or `cursor/passageworks-33e2`.
2. Workflow `.github/workflows/pages.yml` runs `npm test`, builds the web app with `VITE_DEMO_MODE=true`, runs `node scripts/preflight.mjs`, and deploys `apps/web/dist`.
3. The site path is `/<repository-name>/`. For a repo named `passageworks`, open `https://<user>.github.io/passageworks/`.
4. Sign in with email `archivist@northglass.example` and password `northglass-demo-pass`.

The preview password is public because the preview has no server. Do not reuse it for a deployed API.

## Docker Compose

From a machine with Docker:

```bash
npm ci
npm run fixtures
docker compose up --build
```

The API and worker share a private volume at `/data/storage`. Postgres is bound to `127.0.0.1:5432` and the API to `127.0.0.1:8787`. Compose sets `SEED_DEMO=true` and the local password `northglass-demo-pass`. The process logs a warning. Do not publish port 8787 on a public interface while that seed is on.

Open `http://127.0.0.1:8787`. This build is `VITE_DEMO_MODE=false`, so the UI talks to the API.

To run without the seed, remove `SEED_DEMO` and create an account in the UI.

## Optional model

Set all of `AI_BASE_URL`, `AI_API_KEY`, and `AI_MODEL`, or leave all three empty. `AI_BASE_URL` must be `https`, except `http` on `localhost` or `127.0.0.1`. Generation sends selected passages to that provider. If the variables are missing, `POST /api/documents/:id/generate` returns `ai_unavailable` and does not change the brief.

## Worker

The API enqueues jobs. The worker is a second process:

```bash
npm run dev:worker
```

Jobs move through `queued`, `processing`, `completed`, `failed`, and `cancelled`. Transient fetch failures retry up to three times. Password-protected PDFs, MIME mismatches, SSRF blocks, and page-limit failures are not retried.

## Production notes

- `DATABASE_URL` is required when `NODE_ENV=production`.
- `STORAGE_ROOT` must be outside the web root. Downloads go through `GET /api/sources/:id/file` for owners and editors, as `application/octet-stream`.
- Set `COOKIE_SECURE=true` behind HTTPS.
- There is no S3 adapter in this build.
