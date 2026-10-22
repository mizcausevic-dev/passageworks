# A research brief should be able to point at the sentence it came from

**Subtitle:** Passageworks is a private workspace for sources, notes, and briefs. It keeps the passage attached to the claim, and it will not pretend a model, an OCR engine, or a semantic index is running when it is not.

**Meta description:** A source-grounded research brief stays attached to the passage it came from. Here is the workspace workflow, the citation check, and what it does not prove.

Most research work falls apart in the handoff. Someone drops a PDF in a folder. Someone else highlights a paragraph in a different tool. A third person writes the brief in a doc that no longer knows where the sentence came from. By the time a colleague asks "where did this number come from?", the honest answer is a search through chat history.

Passageworks is a small research workspace built to stop that drift. A project holds the sources, the extracted text, the annotations, the working notes, and the brief. A factual line in the brief can carry a passage identifier. That identifier points at a stored chunk from a specific version of a source, not at a vibe and not at a filename.

This is a product note from the build, not a claim that the software reads for you.

## The job is provenance, not another chat box

A research lead, an analyst, or an editor usually needs four things in the same place:

1. The original source, kept private.
2. The text that was actually extracted, with a record of when it was ingested.
3. A way to find a known passage later without calling a model.
4. A brief that can be shared without handing over the whole library.

Passageworks is aimed at that job. The same shape works for a policy memo, a literature review, or a competitive note. The fixture project in the repo, Northglass Basin, is fictional on purpose. It exists so you can click through the workflow without mistaking sample text for a real archive.

The path through the product is ordinary, which is the point:

Create a project. Add a source. Inspect what extraction produced. Annotate a passage. Search for a phrase you already know. Write the brief by hand, or generate a draft only when a provider is configured. Open a citation and read the passage. Share the brief with a link that expires and can be revoked.

If a step cannot be done, the interface says so. A scanned PDF does not become a confident transcript. A missing model does not become a paragraph of fake analysis.

## What "supported" means in this build

A lot of research software lists a capability because a button exists. Passageworks uses a stricter list. A capability is implemented only when the behavior is present. An adapter that throws is not support. The matrix is in the repo and on the capability page.

Here is the practical version.

**You can add** UTF-8 text, a text-based PDF, a note you type, or a public HTTP or HTTPS page. The server does not trust the file extension. A PNG renamed to `.pdf` is rejected. HTML files are not accepted as uploads. HTML arrives only through a fetch, and the script tags come out before anyone reads it.

**You cannot add**, in this build, Word documents, slide decks, spreadsheets, email, or images as text. There is no converter.

**Text PDFs** are read with PDF.js. Page numbers are stored only when a passage sits on a single extracted page. If the extractor cannot place the text, the page field stays empty. The product does not invent a page number to look precise.

**Scanned PDFs** finish in an `ocr_required` state with empty text. OCR is not installed. That is a limitation, and it is printed on the document instead of hidden inside a generic failure.

**Password-protected PDFs** fail with `password_protected`. The server does not ask for the password and does not try to bypass it.

**Web pages** are fetched only over public HTTP or HTTPS, on ports 80 and 443. Redirects are followed by hand. Each hop is checked again so a public URL cannot bounce the worker onto a private address. The response size and the time are capped.

**Search** is lexical. Postgres indexes the current passage text, titles, annotations, notes, and briefs. You can search with no AI key at all. Results are limited to the workspace you belong to. A second workspace cannot retrieve or search the first workspace's private text. The demo in the test suite uses a nonsense token, `lumenquartz`, to prove that isolation.

**Semantic search is not available.** There is no embedding model and no vector index. The code path throws if something calls it. Brief retrieval, when a model is configured, uses the same permission-scoped lexical search. It does not rank by meaning and then quietly call that "semantic."

## Citations are a structural check

This is the part worth being precise about, because it is easy to oversell.

When a brief is saved, every passage id has to belong to a source in that workspace. An id from another workspace, or an id the model invented, is rejected or stripped. The generator is instructed to treat source text as data, not as instructions. A sentence inside a PDF that says "ignore your rules" is still just text from a PDF.

The checker then looks at the draft. A long sentence with no passage marker is flagged as unsupported. A marker that was not in the supplied set is flagged as unknown. Those flags mean the identifier is present or missing. They do not mean a human, or a model, has judged that the sentence fairly represents the passage.

Passageworks says that in the product copy: checking a citation id does not prove the claim is true, and it does not mean the brief is free of invented statements. If you need a reader who will argue with the draft, that reader is still a person.

Generation itself is optional. If `AI_BASE_URL`, `AI_API_KEY`, and `AI_MODEL` are all set, the server can send the instruction and the selected passages to an OpenAI-compatible provider. If any of them is missing, the API returns `ai_unavailable` and leaves the brief untouched. Manual editing never depends on that provider. The editor, the revision history, and the save path work either way.

Selected source text does leave your machine when you generate. The disclosure is on the request. Do not turn the provider on if that transfer is unacceptable.

## Sharing a brief is not sharing the library

Projects are private to workspace members. The roles are owner, editor, commenter, and viewer, and the server checks them. A viewer can read. A viewer cannot download the original file or edit the brief. A commenter can annotate and comment. An editor can add sources and change documents. An owner manages membership and can purge a source.

A share link is a separate object. The raw token is shown once and stored as a hash. It expires. It can be revoked, and the next request fails.

By default the link shows the brief only. Passage identifiers are removed from the HTML, so the link is not a back door into the source. You can opt in, at creation time, to include the stored text of the cited passages. That option still does not include the rest of the source, the original file, or search. A brief that mentions a private memo does not publish the memo.

Deletion follows the same idea. A soft delete hides the source and removes the stored file bytes. Extracted versions remain so old citations still have a snapshot. Annotations are marked for review. A purge, limited to owners, deletes the source and its passages. The brief keeps the snapshot it already stored.

## Collaboration without the real-time costume

Two people can edit the same brief. The save carries the revision number it was based on. If someone else saved first, the second save is rejected and the current copy comes back. Nothing is overwritten in silence.

That is optimistic concurrency plus a revision history. It is not simultaneous real-time editing. There is no presence cursor, no CRDT, and no claim that autosave is Google Docs. Polling the job list is also not collaboration. It is a status refresh.

For a research desk, a rejected save is a better failure than a merged paragraph nobody can explain.

## What the Pages preview actually is

The GitHub Pages site is a browser preview of the Northglass project. You can sign in, read an extracted field log, open a methods note that carries a real page number, search for "lower footbridge", and see a scanned plate stop at OCR-required. You can try to generate a brief and watch the unavailable state. You can create a share link and revoke it.

The preview stores data in the tab. Its search is a substring scan, and the page says so. It does not fetch public URLs, because that fetch, including the protections against private addresses, belongs on the server. It does not call a model.

The durable version is the API, Postgres, a private file directory, and a worker process. Jobs move through queued, processing, completed, failed, and cancelled. A cancelled job that is still queued never makes the request. Transient fetch failures can retry. A password-protected PDF does not.

If you run it yourself, Docker Compose is in the repo. It was not executed in the environment that produced the first build, and the docs say that. Locally, with no `DATABASE_URL`, the API can use embedded Postgres so you can try the real search without standing up a server first. Production mode expects a normal Postgres URL.

## Who it is for, and who should wait

Use it if you already have a pile of text you trust more than a chatbot, and you want the brief to stay inspectable. The fit is a small team that will live with owner, editor, commenter, and viewer, and that would rather see "OCR is not implemented" than a hallucinated scan.

Wait if you need Word and PowerPoint ingestion, image OCR, semantic ranking, or several people typing in the same paragraph at the same time. Those are real requirements. They are not in this build, and the capability page is the place that says so.

## A short way to judge it

Open the preview. Search for a phrase you can see in the field log. Open the hit. Then open the brief and look at the citation. Revoke a link and load it again. If those four actions feel obvious, the workspace is doing the job it was built for. If you need the server path, the README has the commands, and the tests cover extraction, isolation, conflicting saves, and revoked links.

The standard to hold it to is simple. A claim in the brief should be able to point at a passage you can still open. And when the software cannot do a thing, it should say that in the same voice it uses for the things it can.

---

**Suggested Medium tags:** Research, Knowledge Management, Productivity, Software, Writing

**Suggested subtitle for the Medium header:** Keep the passage attached to the claim. Do not pretend the model is on when it is not.
