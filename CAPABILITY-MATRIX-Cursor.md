# Capability matrix

The running process reports the same list from `GET /api/capabilities`. A row is `implemented` only when the behavior is present and tested or exercised. An interface that throws, or a button that explains it is off, is not support.

| Area | Capability | Status | Meaning |
| --- | --- | --- | --- |
| File formats | Plain text UTF-8 | implemented | NUL bytes and invalid UTF-8 are rejected. The extension is not trusted. |
| File formats | Text-based PDF | implemented | PDF.js via unpdf, one passage page number only when the chunk stays on one extracted page. |
| File formats | User-entered notes | implemented | Notes enter the job queue and become a source version. |
| File formats | HTML file upload | unavailable | HTML is accepted only from a fetched public page. |
| File formats | Office, images, email | unavailable | Rejected. No converter is installed. |
| Text extraction | Versioned extraction | implemented | New attempts append a version. They do not overwrite older text. |
| Text extraction | Password-protected PDF | implemented | Recorded as `password_protected`. No password is collected. |
| Web ingestion | Public HTTP(S) HTML | implemented | Manual redirects, DNS checks, pinned connect, size and time caps, sanitizer. Ports other than 80 and 443 are refused. |
| Web ingestion | Logged-in or JS-rendered pages | unavailable | No browser session and no headless renderer. |
| OCR | Optical character recognition | unavailable | Image-only PDFs finish as `ocr_required` with empty text. |
| Full-text search | Permission-aware lexical search | implemented | Postgres `tsvector` on passages, titles, annotations, notes, and briefs. |
| Semantic retrieval | Embedding similarity | unavailable | No vector index. `semanticSearch()` throws. |
| AI generation | Manual brief editing | implemented | Works with no provider configured. |
| AI generation | Server-side cited generation | partial | Adapter runs only when all three AI env vars are set. This build did not call a live provider. |
| Collaboration | Optimistic concurrency and history | implemented | Stale `baseRevision` returns 409 and the current body. |
| Collaboration | Simultaneous real-time editing | unavailable | No CRDT, operational transform, or presence channel. |
| Collaboration | Workspace roles | implemented | Owner, editor, commenter, viewer, checked on the server. |
| Collaboration | Expiring revocable share links | implemented | Raw token shown once, stored as SHA-256. Default links omit passage text. |
| Storage | Private local objects | implemented | UUID keys under `STORAGE_ROOT`. |
| Storage | S3-compatible buckets | unavailable | No client is implemented. |
| Jobs | Durable queue | implemented | `FOR UPDATE SKIP LOCKED`, retry, and cancel-before-commit. |

Preview search is a browser substring scan. It is not the Postgres index. The preview says so on the search page.

Deletion:

- Soft delete hides the source, removes the stored file bytes, keeps extracted versions, and marks annotations `needs_review` with reason `source_deleted`. Brief citations keep their snapshots.
- Purge is owner-only. It deletes the source, versions, passages, and annotations. Citation snapshots remain, with the source link cleared.

The reading room uses one desk theme. The capability page has the seven dashboard themes in light and dark, stored in `localStorage`. That split is intentional: a document surface should not restyle itself every time the matrix does.
