import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { AI_DISCLOSURE, STATIC_CAPABILITIES } from "@passageworks/domain";
import { ApiError, createClient, type Annotation, type Client, type Doc, type Job, type SearchResult, type Source, type User, type Version } from "./client.ts";

type Route =
  | { name: "login" }
  | { name: "library"; workspaceId: string; projectId: string }
  | { name: "reader"; workspaceId: string; projectId: string; sourceId: string }
  | { name: "search"; workspaceId: string; projectId: string; q: string }
  | { name: "doc"; workspaceId: string; projectId: string; documentId: string }
  | { name: "admin"; workspaceId: string; projectId: string }
  | { name: "capabilities" }
  | { name: "shared"; token: string };

function parseRoute(): Route {
  const parts = window.location.hash.replace(/^#/, "").split("/").filter(Boolean);
  if (parts[0] === "capabilities") return { name: "capabilities" };
  if (parts[0] === "shared" && parts[1]) return { name: "shared", token: decodeURIComponent(parts[1]) };
  if (parts[0] === "w" && parts[2] === "p" && parts[1] && parts[3]) {
    const workspaceId = parts[1];
    const projectId = parts[3];
    if (parts[4] === "s" && parts[5]) return { name: "reader", workspaceId, projectId, sourceId: parts[5] };
    if (parts[4] === "search") return { name: "search", workspaceId, projectId, q: decodeURIComponent(parts[5] ?? "") };
    if (parts[4] === "d" && parts[5]) return { name: "doc", workspaceId, projectId, documentId: parts[5] };
    if (parts[4] === "admin") return { name: "admin", workspaceId, projectId };
    return { name: "library", workspaceId, projectId };
  }
  return { name: "login" };
}

function go(path: string) {
  window.location.hash = path;
}

function browserSanitize(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const allowed = new Set(["P", "BR", "STRONG", "EM", "H2", "H3", "UL", "OL", "LI", "A", "BLOCKQUOTE", "CITE"]);
  const walk = (node: Element) => {
    for (const child of [...node.children]) {
      walk(child);
      if (!allowed.has(child.tagName)) {
        child.replaceWith(...child.childNodes);
        continue;
      }
      for (const attr of [...child.attributes]) {
        const keepLink = child.tagName === "A" && attr.name === "href" && /^https?:\/\//i.test(attr.value);
        const keepCite = child.tagName === "CITE" && attr.name === "data-passage-id" && /^psg_[a-f0-9]{16}$/.test(attr.value);
        if (!keepLink && !keepCite) child.removeAttribute(attr.name);
      }
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

export function App() {
  const client = useMemo(() => createClient(), []);
  const [route, setRoute] = useState<Route>(parseRoute);
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [help, setHelp] = useState(false);
  const [nav, setNav] = useState(272);
  const [inspect, setInspect] = useState(320);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);

  useEffect(() => {
    const sync = () => setRoute(parseRoute());
    window.addEventListener("hashchange", sync);
    client.me().then((person) => {
      setUser(person);
      setReady(true);
    }).catch(() => setReady(true));
    return () => window.removeEventListener("hashchange", sync);
  }, [client]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (event.key === "?" && !typing) setHelp((open) => !open);
      if (event.key === "/" && !typing) {
        event.preventDefault();
        document.getElementById("search-q")?.focus();
      }
      if (event.key === "Escape") setHelp(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!ready) return <p className="auth">Loading the reading room.</p>;
  if (!user && route.name !== "shared" && route.name !== "capabilities") {
    return <Auth client={client} onUser={setUser} />;
  }

  if (route.name === "shared") return <Shared token={route.token} client={client} />;
  if (route.name === "capabilities" || route.name === "login") {
    return (
      <>
        <Top onHelp={() => setHelp(true)} user={user} client={client} onUser={setUser} />
        {route.name === "capabilities" ? <Capabilities client={client} /> : <Home client={client} />}
        {help ? <Help onClose={() => setHelp(false)} /> : null}
      </>
    );
  }

  return (
    <div className="shell">
      <a className="skip" href="#stage">Skip to document</a>
      <Top onHelp={() => setHelp(true)} user={user} client={client} onUser={setUser} menu={() => setSidebarOpen((open) => !open)} inspect={() => setInspectorOpen((open) => !open)} />
      <div className="workspace" style={{ ["--nav" as string]: `${nav}px`, ["--inspect" as string]: `${inspect}px` }}>
        <aside className={sidebarOpen ? "sidebar open" : "sidebar"}>
          <Sidebar route={route} client={client} />
        </aside>
        <div
          className="separator"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize source list"
          tabIndex={0}
          onPointerDown={(event) => drag(event, nav, setNav, 200, 420)}
          onKeyDown={(event) => nudge(event, nav, setNav, 200, 420)}
        />
        <main className="stage" id="stage">
          {route.name === "library" ? <Library client={client} projectId={route.projectId} workspaceId={route.workspaceId} /> : null}
          {route.name === "reader" ? <Reader client={client} sourceId={route.sourceId} /> : null}
          {route.name === "search" ? <Search client={client} projectId={route.projectId} workspaceId={route.workspaceId} initial={route.q} /> : null}
          {route.name === "doc" ? <Editor client={client} documentId={route.documentId} projectId={route.projectId} /> : null}
          {route.name === "admin" ? <Admin client={client} workspaceId={route.workspaceId} projectId={route.projectId} /> : null}
        </main>
        <div
          className="separator"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize inspector"
          tabIndex={0}
          onPointerDown={(event) => drag(event, inspect, setInspect, 240, 460, true)}
          onKeyDown={(event) => nudge(event, inspect, setInspect, 240, 460, true)}
        />
        <aside className={inspectorOpen ? "inspector open" : "inspector"}>
          <Inspector route={route} client={client} />
        </aside>
      </div>
      {route.name !== "admin" ? <Jobs client={client} projectId={route.projectId} /> : null}
      {help ? <Help onClose={() => setHelp(false)} /> : null}
    </div>
  );
}

function drag(event: ReactPointerEvent, start: number, set: (value: number) => void, min: number, max: number, invert = false) {
  const origin = event.clientX;
  const move = (ev: PointerEvent) => {
    const delta = invert ? origin - ev.clientX : ev.clientX - origin;
    set(Math.min(max, Math.max(min, start + delta)));
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function nudge(event: ReactKeyboardEvent, value: number, set: (n: number) => void, min: number, max: number, invert = false) {
  const step = event.key === "ArrowRight" ? 16 : event.key === "ArrowLeft" ? -16 : 0;
  if (!step) return;
  event.preventDefault();
  const delta = invert ? -step : step;
  set(Math.min(max, Math.max(min, value + delta)));
}

function Top({ user, client, onUser, onHelp, menu, inspect }: { user: User | null; client: Client; onUser: (user: User | null) => void; onHelp: () => void; menu?: () => void; inspect?: () => void }) {
  return (
    <header className="topbar">
      <button className="btn tiny mobile-only" type="button" onClick={menu}>Sources</button>
      <h1>Passageworks</h1>
      <span className="badge">{client.mode === "demo" ? "Preview runtime" : "Server runtime"}</span>
      <span className="spacer" />
      <button className="btn tiny secondary" type="button" onClick={() => go("#/capabilities")}>Capability matrix</button>
      <button className="btn tiny secondary mobile-only" type="button" onClick={inspect}>Inspector</button>
      <button className="btn tiny secondary" type="button" onClick={onHelp}>Keys</button>
      {user ? (
        <button className="btn tiny secondary" type="button" onClick={() => { void client.logout().then(() => { onUser(null); go("#/"); }); }}>
          Sign out
        </button>
      ) : null}
    </header>
  );
}

function Auth({ client, onUser }: { client: Client; onUser: (user: User) => void }) {
  const [email, setEmail] = useState(client.mode === "demo" ? "archivist@northglass.example" : "");
  const [name, setName] = useState("Northglass Archivist");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const submit = async (register: boolean) => {
    setError("");
    try {
      const user = register
        ? await client.register({ email, name, password })
        : await client.login({ email, password });
      onUser(user);
      if (client.mode === "demo") go("#/w/ws_northglass/p/pr_basin");
      else go("#/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    }
  };
  return (
    <main className="auth">
      <form className="auth-card" onSubmit={(event) => { event.preventDefault(); void submit(false); }}>
        <p className="wordmark">Passageworks</p>
        <p className="lede">A private room for sources, notes, and briefs that can point back at the passage they came from.</p>
        {client.mode === "demo" ? (
          <p className="note">Preview password: <code>northglass-demo-pass</code>. Data stays in this tab. AI generation stays unavailable. The Docker deployment runs Postgres and the worker.</p>
        ) : null}
        <label>Email<input value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" /></label>
        <label>Name<input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></label>
        {error ? <p className="error">{error}</p> : null}
        <div className="row">
          <button className="btn" type="submit">Sign in</button>
          <button className="btn secondary" type="button" onClick={() => void submit(true)}>Create account</button>
        </div>
      </form>
    </main>
  );
}

function Home({ client }: { client: Client }) {
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>([]);
  const [name, setName] = useState("Reading room");
  useEffect(() => { void client.workspaces().then(setWorkspaces); }, [client]);
  return (
    <main className="stage">
      <div className="paper">
        <h2>Workspaces</h2>
        {workspaces.map((workspace) => (
          <WorkspaceProjects key={workspace.id} client={client} workspace={workspace} />
        ))}
        {client.mode === "server" ? (
          <form onSubmit={(event) => {
            event.preventDefault();
            void client.workspaces().then(async (rows) => {
              if (rows[0]) return;
              const response = await fetch("/api/workspaces", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
              const body = await response.json() as { workspace: { id: string } };
              const project = await client.createProject(body.workspace.id, "First project");
              go(`#/w/${body.workspace.id}/p/${project.id}`);
            });
          }}>
            <label>New workspace name<input value={name} onChange={(event) => setName(event.target.value)} /></label>
            <button className="btn" type="submit">Create workspace</button>
          </form>
        ) : (
          <button className="btn" type="button" onClick={() => go("#/w/ws_northglass/p/pr_basin")}>Open Northglass Basin</button>
        )}
      </div>
    </main>
  );
}

function WorkspaceProjects({ client, workspace }: { client: Client; workspace: { id: string; name: string } }) {
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => { void client.projects(workspace.id).then(setProjects); }, [client, workspace.id]);
  return (
    <section>
      <h3>{workspace.name}</h3>
      {projects.map((project) => (
        <button key={project.id} className="btn secondary" type="button" onClick={() => go(`#/w/${workspace.id}/p/${project.id}`)}>{project.name}</button>
      ))}
    </section>
  );
}

function Sidebar({ route, client }: { route: Exclude<Route, { name: "login" | "shared" | "capabilities" }>; client: Client }) {
  const projectId = "projectId" in route ? route.projectId : "";
  const workspaceId = "workspaceId" in route ? route.workspaceId : "";
  const [sources, setSources] = useState<Source[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [index, setIndex] = useState(0);
  useEffect(() => {
    void client.sources(projectId).then(setSources);
    void client.documents(projectId).then(setDocs);
  }, [client, projectId, route]);
  return (
    <nav aria-label="Project">
      <button className="nav-link" type="button" onClick={() => go(`#/w/${workspaceId}/p/${projectId}`)} aria-current={route.name === "library" ? "page" : undefined}>Library</button>
      <button className="nav-link" type="button" onClick={() => go(`#/w/${workspaceId}/p/${projectId}/search`)}>Search</button>
      <button className="nav-link" type="button" onClick={() => go(`#/w/${workspaceId}/p/${projectId}/admin`)} aria-current={route.name === "admin" ? "page" : undefined}>Access</button>
      <p className="section-label">Sources</p>
      <div
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "j" || event.key === "ArrowDown") setIndex((value) => Math.min(sources.length - 1, value + 1));
          if (event.key === "k" || event.key === "ArrowUp") setIndex((value) => Math.max(0, value - 1));
          if (event.key === "Enter" && sources[index]) go(`#/w/${workspaceId}/p/${projectId}/s/${sources[index]?.id}`);
        }}
      >
        {sources.map((source, item) => (
          <button key={source.id} className="source-link" type="button" aria-current={route.name === "reader" && route.sourceId === source.id ? "page" : undefined} onClick={() => go(`#/w/${workspaceId}/p/${projectId}/s/${source.id}`)}>
            {source.title}
            <small>{source.kind} · {source.outcome ?? "pending"}{item === index ? " · focused" : ""}</small>
          </button>
        ))}
      </div>
      <p className="section-label">Notes and briefs</p>
      {docs.map((doc) => (
        <button key={doc.id} className="source-link" type="button" onClick={() => go(`#/w/${workspaceId}/p/${projectId}/d/${doc.id}`)}>
          {doc.title}
          <small>{doc.kind} · rev {doc.revision}</small>
        </button>
      ))}
      <div className="row">
        <button className="btn tiny secondary" type="button" onClick={() => void client.createDocument(projectId, "note", "Working note").then((doc) => go(`#/w/${workspaceId}/p/${projectId}/d/${doc.id}`))}>New note</button>
        <button className="btn tiny secondary" type="button" onClick={() => void client.createDocument(projectId, "brief", "Untitled brief").then((doc) => go(`#/w/${workspaceId}/p/${projectId}/d/${doc.id}`))}>New brief</button>
      </div>
    </nav>
  );
}

function Library({ client, projectId, workspaceId }: { client: Client; projectId: string; workspaceId: string }) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const reload = () => { void client.sources(projectId).then(setSources); };
  useEffect(reload, [client, projectId]);
  return (
    <>
      <div className="paper">
        <h2>Source library</h2>
        <p>Add a note, a text file, or a text-based PDF. Scanned pages stop at an OCR-required state. Nothing here treats a filename as proof of format.</p>
        {error ? <p className="error">{error}</p> : null}
        <form onSubmit={(event) => { event.preventDefault(); void client.uploadNote(projectId, title, text).then(reload).catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not add the note")); }}>
          <label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <label>Note<textarea value={text} onChange={(event) => setText(event.target.value)} /></label>
          <button className="btn" type="submit">Capture note</button>
        </form>
        <form onSubmit={(event) => { event.preventDefault(); void client.uploadUrl(projectId, url, title).then(reload).catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not queue the URL")); }}>
          <label>Public page URL<input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://" /></label>
          <button className="btn secondary" type="submit">Fetch page</button>
        </form>
        <label>File
          <input type="file" onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            void client.uploadFile(projectId, file, file.name).then(reload).catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not accept the file"));
          }} />
        </label>
      </div>
      <div className="toolbar">
        {sources.map((source) => (
          <button key={source.id} className="btn secondary" type="button" onClick={() => go(`#/w/${workspaceId}/p/${projectId}/s/${source.id}`)}>
            {source.title}
          </button>
        ))}
      </div>
    </>
  );
}

function Reader({ client, sourceId }: { client: Client; sourceId: string }) {
  const [version, setVersion] = useState<Version | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [popover, setPopover] = useState<{ x: number; y: number; passageId: string; quote: string; charStart: number; charEnd: number; pageNumber: number | null } | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const load = () => {
    void client.source(sourceId).then((detail) => {
      setSource(detail.source);
      setVersion(detail.version);
    });
    void client.annotations(sourceId).then(setAnnotations);
  };
  useEffect(load, [client, sourceId]);
  const outcome = version?.outcome ?? source?.outcome;
  return (
    <>
      {outcome === "ocr_required" ? <div className="banner">This document has no usable text layer. OCR is not implemented, so no text was invented. Open the job inspector for the recorded outcome.</div> : null}
      {outcome === "password_protected" ? <div className="banner bad">This PDF asks for a password. Passageworks does not collect PDF passwords and does not bypass protection.</div> : null}
      {outcome === "failed" ? <div className="banner bad">{source?.outcomeDetail ?? "Ingestion failed."}</div> : null}
      {error ? <p className="error">{error}</p> : null}
      <article className="paper reader-sheet" onMouseUp={() => {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        const passage = (range.startContainer.parentElement?.closest("[data-passage]") ?? null) as HTMLElement | null;
        if (!passage || !passage.contains(range.endContainer)) return;
        const textNode = passage.querySelector(".passage-text")?.firstChild;
        if (!textNode || range.startContainer !== textNode || range.endContainer !== textNode) return;
        const base = Number(passage.dataset.start ?? "0");
        const rect = range.getBoundingClientRect();
        setPopover({
          x: rect.left,
          y: rect.bottom + 8,
          passageId: passage.dataset.passage ?? "",
          quote: range.toString(),
          charStart: base + range.startOffset,
          charEnd: base + range.endOffset,
          pageNumber: passage.dataset.page ? Number(passage.dataset.page) : null,
        });
      }}>
        <h2>{source?.title ?? "Source"}</h2>
        {version?.chunks.length ? version.chunks.map((chunk) => (
          <section key={chunk.passageId} id={chunk.passageId} className="passage" data-passage={chunk.passageId} data-start={chunk.charStart} data-page={chunk.pageNumber ?? ""}>
            <div className="page-tag">{chunk.pageNumber == null ? "No page number" : `p. ${chunk.pageNumber}`}</div>
            <p className="passage-text">{chunk.text}</p>
          </section>
        )) : <p>{version?.detail ?? "No extracted text yet."}</p>}
      </article>
      {popover ? (
        <div className="popover" style={{ left: popover.x, top: popover.y }}>
          <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Annotation" aria-label="Annotation" />
          <button className="btn tiny" type="button" onClick={() => {
            void client.annotate(sourceId, { ...popover, note }).then(() => {
              setPopover(null);
              setNote("");
              load();
            }).catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not save"));
          }}>Save</button>
        </div>
      ) : null}
      <div className="toolbar">
        {annotations.map((item) => (
          <a key={item.id} href={`#${item.passageId}`} onClick={() => document.getElementById(item.passageId)?.classList.add("is-target")}>
            {item.quote.slice(0, 48)}{item.needsReview ? " · needs review" : ""}
          </a>
        ))}
      </div>
    </>
  );
}

function Search({ client, projectId, workspaceId, initial }: { client: Client; projectId: string; workspaceId: string; initial: string }) {
  const [q, setQ] = useState(initial);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState("");
  const run = (query: string) => {
    setError("");
    void client.search(projectId, query).then(setResult).catch((err: unknown) => setError(err instanceof Error ? err.message : "Search failed"));
  };
  useEffect(() => { if (initial) run(initial); }, [initial, projectId]);
  return (
    <>
      <form className="toolbar" onSubmit={(event) => { event.preventDefault(); go(`#/w/${workspaceId}/p/${projectId}/search/${encodeURIComponent(q)}`); run(q); }}>
        <input id="search-q" value={q} onChange={(event) => setQ(event.target.value)} aria-label="Search" placeholder="Search sources and notes" />
        <button className="btn" type="submit">Search</button>
      </form>
      {error ? <p className="error">{error}</p> : null}
      {result ? <p className="note" style={{ width: "min(760px, 100%)", margin: "0 auto 12px" }}>{result.indexDelay} Semantic retrieval: {result.semantic.status}.</p> : null}
      {result?.results.map((hit, index) => (
        <article key={`${hit.passageId ?? hit.documentId}-${index}`} className="result">
          <button className="linkish" type="button" onClick={() => {
            if (hit.sourceId) go(`#/w/${workspaceId}/p/${projectId}/s/${hit.sourceId}`);
            else if (hit.documentId) go(`#/w/${workspaceId}/p/${projectId}/d/${hit.documentId}`);
          }}>{hit.title}</button>
          <p dangerouslySetInnerHTML={{ __html: hit.snippet }} />
          <small>{hit.pageNumber == null ? "Page not available from extraction" : `p. ${hit.pageNumber}`}</small>
        </article>
      ))}
    </>
  );
}

function Editor({ client, documentId, projectId }: { client: Client; documentId: string; projectId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [title, setTitle] = useState("");
  const [conflict, setConflict] = useState("");
  const [draft, setDraft] = useState("");
  const [flags, setFlags] = useState<{ type: string; text: string }[]>([]);
  const [passages, setPassages] = useState<{ passageId: string; label: string }[]>([]);
  const [status, setStatus] = useState("");
  const base = useRef(0);
  useEffect(() => {
    void client.document(documentId).then((loaded) => {
      setDoc(loaded);
      setTitle(loaded.title);
      base.current = loaded.revision;
      if (ref.current) ref.current.innerHTML = browserSanitize(loaded.bodyHtml);
    });
    void client.passages(projectId).then(setPassages);
  }, [client, documentId, projectId]);
  const save = async (html: string) => {
    if (!doc) return;
    try {
      const saved = await client.saveDocument(doc.id, { baseRevision: base.current, title, bodyHtml: browserSanitize(html) });
      base.current = saved.revision;
      setDoc(saved);
      setConflict("");
      setStatus(`Saved revision ${saved.revision}. Autosave uses the same revision check. This is not simultaneous real-time editing.`);
    } catch (error) {
      if (error instanceof ApiError && error.code === "revision_conflict") {
        setConflict(error.message);
        return;
      }
      setStatus(error instanceof Error ? error.message : "Save failed");
    }
  };
  return (
    <>
      <div className="toolbar">
        <button className="btn tiny secondary" type="button" onClick={() => document.execCommand("bold")}>Bold</button>
        <button className="btn tiny secondary" type="button" onClick={() => document.execCommand("italic")}>Italic</button>
        <button className="btn tiny secondary" type="button" onClick={() => document.execCommand("formatBlock", false, "h2")}>Heading</button>
        <button className="btn" type="button" onClick={() => void save(ref.current?.innerHTML ?? "")}>Save</button>
        {doc?.kind === "brief" ? (
          <button className="btn secondary" type="button" onClick={() => {
            void client.generate(doc.id, { instruction: title || "Summarize the cited sources", baseRevision: base.current }).then((body) => {
              setDraft(String(body.draftHtml ?? ""));
              setFlags((body.flags as { type: string; text: string }[]) ?? []);
              setStatus(String(body.disclosure ?? AI_DISCLOSURE));
            }).catch((error: unknown) => {
              if (error instanceof ApiError) {
                const details = error.details as { disclosure?: string } | undefined;
                setDraft("");
                setFlags([]);
                setStatus(`${error.message} ${details?.disclosure ?? AI_DISCLOSURE}`);
                return;
              }
              setStatus(error instanceof Error ? error.message : "Generation failed");
            });
          }}>Generate cited draft</button>
        ) : null}
      </div>
      {conflict ? <div className="banner bad">{conflict} Reload the document before editing again. The other copy was kept.</div> : null}
      {status ? <p className="note" style={{ width: "min(760px, 100%)", margin: "0 auto 8px" }}>{status}</p> : null}
      <div className="paper">
        <label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <div
          ref={ref}
          className="editor"
          contentEditable
          role="textbox"
          aria-label="Document body"
          onInput={() => {
            window.setTimeout(() => { void save(ref.current?.innerHTML ?? ""); }, 900);
          }}
        />
        {doc?.kind === "brief" ? (
          <label>Insert passage
            <select onChange={(event) => {
              const id = event.target.value;
              if (!id || !ref.current) return;
              const cite = document.createElement("cite");
              cite.dataset.passageId = id;
              cite.textContent = id;
              ref.current.appendChild(document.createTextNode(" "));
              ref.current.appendChild(cite);
            }}>
              <option value="">Choose a passage</option>
              {passages.map((passage) => <option key={passage.passageId} value={passage.passageId}>{passage.label}</option>)}
            </select>
          </label>
        ) : null}
      </div>
      {draft ? (
        <div className="paper">
          <h2>Draft</h2>
          <div dangerouslySetInnerHTML={{ __html: browserSanitize(draft) }} />
          {flags.map((flag, index) => <p key={index} className="note">{flag.type}: {flag.text}</p>)}
          <button className="btn" type="button" onClick={() => void save(draft)}>Use this draft</button>
        </div>
      ) : null}
    </>
  );
}

function Admin({ client, workspaceId, projectId }: { client: Client; workspaceId: string; projectId: string }) {
  const [members, setMembers] = useState<{ id: string; email: string; name: string; role: string }[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("viewer");
  const [probe, setProbe] = useState("");
  useEffect(() => { void client.members(workspaceId).then(setMembers); }, [client, workspaceId]);
  return (
    <div className="paper">
      <h2>Access</h2>
      <p>Projects are private to workspace members. Owner, editor, commenter, and viewer are enforced on the server. A share link is created from a brief and does not open the library.</p>
      <ul>
        {members.map((member) => <li key={member.id}>{member.name} · {member.email} · {member.role}</li>)}
      </ul>
      <form onSubmit={(event) => { event.preventDefault(); void client.addMember(workspaceId, email, role).then(() => client.members(workspaceId).then(setMembers)); }}>
        <label>Email<input value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label>Role
          <select value={role} onChange={(event) => setRole(event.target.value)}>
            <option>viewer</option>
            <option>commenter</option>
            <option>editor</option>
            <option>owner</option>
          </select>
        </label>
        <button className="btn" type="submit">Add member</button>
      </form>
      <button className="btn secondary" type="button" onClick={() => void client.isolationProbe(projectId).then((result) => setProbe(`${result.query}: ${result.hits} hit(s). ${result.note}`))}>Check private-token search</button>
      {probe ? <p>{probe}</p> : null}
    </div>
  );
}

function Inspector({ route, client }: { route: Route; client: Client }) {
  const [rows, setRows] = useState<{ revision: number; title: string }[]>([]);
  const [shares, setShares] = useState<{ id: string; token?: string; exposeCitedPassages: boolean; revokedAt: string | null }[]>([]);
  const [token, setToken] = useState("");
  const documentId = route.name === "doc" ? route.documentId : "";
  useEffect(() => {
    if (!documentId) return;
    void client.revisions(documentId).then(setRows);
    void client.shares(documentId).then(setShares);
  }, [client, documentId]);
  if (route.name !== "doc") {
    return <p className="note">Select a note or brief to see revisions and share links. Citation checks do not prove a sentence is a fair reading of a passage.</p>;
  }
  return (
    <div>
      <p className="section-label">Revisions</p>
      {rows.map((row) => <p key={row.revision}>r{row.revision} {row.title}</p>)}
      <p className="section-label">Share link</p>
      <p className="note">Off by default: the link shows the brief and strips passage identifiers. It never grants search or file download.</p>
      <button className="btn tiny" type="button" onClick={() => void client.createShare(documentId, false).then((share) => { setToken(share.token); void client.shares(documentId).then(setShares); })}>Create brief-only link</button>
      <button className="btn tiny secondary" type="button" onClick={() => void client.createShare(documentId, true).then((share) => { setToken(share.token); void client.shares(documentId).then(setShares); })}>Include cited passages</button>
      {token ? <p>Token shown once: <a href={`#/shared/${encodeURIComponent(token)}`}>{token}</a></p> : null}
      {shares.map((share) => (
        <p key={share.id}>
          {share.exposeCitedPassages ? "Passages included" : "Brief only"} {share.revokedAt ? "· revoked" : ""}
          {!share.revokedAt ? <button className="btn tiny secondary" type="button" onClick={() => void client.revokeShare(share.id).then(() => client.shares(documentId).then(setShares))}>Revoke</button> : null}
        </p>
      ))}
    </div>
  );
}

function Jobs({ client, projectId }: { client: Client; projectId: string }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const load = () => { void client.jobs(projectId).then(setJobs); };
  useEffect(() => {
    load();
    const timer = window.setInterval(load, 2000);
    return () => window.clearInterval(timer);
  }, [client, projectId]);
  if (!jobs.length) return null;
  return (
    <div className="jobs" aria-live="polite">
      <span className="note">Job status polls every few seconds. Polling is not collaborative editing.</span>
      {jobs.slice(0, 6).map((job) => (
        <span key={job.id} className={`job ${job.status}`}>
          <i />
          {job.status}{job.errorCode || job.error_code ? ` · ${job.errorCode || job.error_code}` : ""}
          {job.status === "queued" || job.status === "processing" ? <button className="btn tiny secondary" type="button" onClick={() => void client.cancelJob(job.id).then(load)}>Cancel</button> : null}
        </span>
      ))}
    </div>
  );
}

function Shared({ token, client }: { token: string; client: Client }) {
  const [body, setBody] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void client.readShared(token).then(setBody).catch((err: unknown) => setError(err instanceof Error ? err.message : "Unavailable"));
  }, [client, token]);
  if (error) return <main className="auth"><div className="auth-card"><h1>Link unavailable</h1><p>{error}</p></div></main>;
  if (!body) return <main className="auth">Loading the shared brief.</main>;
  const citations = (body.citations as { quote?: string; sourceTitle?: string; pageNumber?: number | null }[]) ?? [];
  return (
    <main className="stage">
      <article className="paper reader-sheet">
        <h2>{String(body.title ?? "Shared brief")}</h2>
        <p className="note">{String(body.notice ?? "")}</p>
        <div dangerouslySetInnerHTML={{ __html: browserSanitize(String(body.bodyHtml ?? "")) }} />
        {citations.map((citation, index) => (
          <blockquote key={index}>
            <p>{citation.quote}</p>
            <small>{citation.sourceTitle}{citation.pageNumber == null ? "" : ` · p. ${citation.pageNumber}`}</small>
          </blockquote>
        ))}
      </article>
    </main>
  );
}

const THEMES = ["bento", "cosmic", "swiss", "aqua", "brutal", "steel", "parchment"] as const;

function Capabilities({ client }: { client: Client }) {
  const [theme, setTheme] = useState<(typeof THEMES)[number]>(() => (localStorage.getItem("pw-dash-theme") as (typeof THEMES)[number]) || "parchment");
  const [mode, setMode] = useState(localStorage.getItem("pw-dash-mode") || "dark");
  const [runtime, setRuntime] = useState<Record<string, unknown> | null>(null);
  useEffect(() => { void client.capabilities().then(setRuntime); }, [client]);
  useEffect(() => { localStorage.setItem("pw-dash-theme", theme); localStorage.setItem("pw-dash-mode", mode); }, [theme, mode]);
  return (
    <main className="stage">
      <div className="dash" data-theme={theme} data-mode={mode}>
        <div className="paperish">
          <h2>What Passageworks is</h2>
          <p>Passageworks is a research workspace for collecting sources, keeping extracted text versioned, annotating passages, and writing briefs that cite those passages.</p>
          <p>It is for an analyst, researcher, or editor who needs a private project rather than a public comment thread.</p>
          <p>The useful constraint is provenance: a claim in a brief can point at a passage id, and a missing or inaccessible id is rejected. That check does not prove the sentence is semantically correct.</p>
          <div className="pipeline">
            {["Create project", "Add source", "Inspect extraction", "Annotate", "Search", "Write brief", "Check citations", "Share"].map((step) => <span key={step}>{step}</span>)}
          </div>
          <p>People discover a project from a workspace they were added to, or from an expiring link that shows one brief. They engage by reading, highlighting, and searching. Conversion, in this build, is a colleague opening a shared brief. Money is not collected here. Launch with Docker for the real stack, or this static preview to click through fictional Northglass notes. After launch, the first improvement is a real embedding index, which is currently unavailable on purpose.</p>
          <p>The reading room keeps one desk theme so documents stay readable. This matrix uses the seven-theme switcher.</p>
          <div className="themes">
            {THEMES.map((item) => <button key={item} className="btn tiny secondary" type="button" onClick={() => setTheme(item)}>{item}</button>)}
            <button className="btn tiny" type="button" onClick={() => setMode(mode === "dark" ? "light" : "dark")}>{mode}</button>
          </div>
        </div>
        <div className="matrix">
          <table>
            <thead><tr><th>Area</th><th>Capability</th><th>Status</th><th>What that means</th></tr></thead>
            <tbody>
              {STATIC_CAPABILITIES.map((item) => (
                <tr key={item.id}>
                  <td>{item.area}</td>
                  <td>{item.label}</td>
                  <td className={`status ${item.status}`}>{item.status}</td>
                  <td>{item.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {runtime ? <pre className="paperish">{JSON.stringify(runtime.runtime ?? runtime, null, 2)}</pre> : null}
      </div>
    </main>
  );
}

function Help({ onClose }: { onClose: () => void }) {
  return (
    <div className="help" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <div>
        <p><kbd>/</kbd> search · <kbd>?</kbd> this card · <kbd>j</kbd>/<kbd>k</kbd> move the source list · <kbd>Esc</kbd> close</p>
        <button className="btn" type="button" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
