# Security notes

This is an engineering record of the controls in this repository. It is not a penetration-test report.

## Trust boundaries

Uploaded files, fetched HTML, PDF text, titles, and model output are untrusted data. Source text is never treated as application instructions. The model prompt says passage blocks are data. Model output is escaped, and only known `psg_` markers become `<cite>` elements.

Authorization is checked on the server for every project route. A missing membership is a 404. Share tokens do not call search, file download, or the passage API.

## Storage

Objects use UUID keys. The disk store rejects keys that are not UUIDs and refuses paths outside `STORAGE_ROOT`. Downloads are attachments with `nosniff`. HTML from the web is stored as bytes and is not served as an active page. The reader renders sanitized HTML.

## Web fetch

`safeFetch` allows only `http` and `https`, rejects credentials and ports other than 80 and 443, blocks loopback, private, link-local, metadata, and documentation ranges, checks every DNS answer, and pins the connection to a checked address. Redirects are manual and rechecked. Response size and time are capped. Tests cover `127.0.0.1`, decimal and shorthand loopback forms, a redirect onto loopback, and an oversized body. The loopback case does not call `fetch`.

## Documents and citations

Saves require `baseRevision`. A stale save returns 409 and does not write. Citation ids in a brief must belong to chunks in the same workspace. Unknown ids are rejected on manual save. Generated drafts strip unknown ids and flag sentences that lack a marker. That flag is structural. It does not prove the sentence follows from the passage.

Share links store `sha256(token)`. The raw token is returned once. Revocation and expiry are checked before the brief is rendered. With `exposeCitedPassages` false, cite tags and passage ids are removed. With it true, the response includes stored passage snapshots, not the rest of the source and not the original file.

## Accounts

Passwords are scrypt hashes. Session tokens are random and stored hashed. The cookie is `HttpOnly` and `SameSite=Lax`. A present `Origin` that does not match `Host` is rejected on mutating requests.

## What this build does not do

- No OCR, no password bypass, no local-file URL scheme, no S3, no real-time co-editing, no semantic index.
- No third-party analytics.
- Email verification is not implemented. Accounts are local.
- Docker Compose in this repo binds the demo seed to localhost. The demo password is in the compose file for that local seed only.

## Review limits

The automated tests cover the controls above against PGlite and mocked fetch. They do not include a live provider call, a public deployment, or a review of the PDF.js parser itself.
