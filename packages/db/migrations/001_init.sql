CREATE TABLE schema_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'editor', 'commenter', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('file', 'url', 'note')),
  title text NOT NULL,
  original_filename text,
  declared_mime text,
  detected_mime text,
  byte_size integer,
  storage_key text,
  origin_url text,
  outcome text,
  outcome_detail text,
  current_version_id uuid,
  raw_sha256 text,
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz,
  deleted_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE source_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  job_id uuid UNIQUE,
  version_number integer NOT NULL,
  extraction_method text NOT NULL,
  outcome text NOT NULL,
  content_text text NOT NULL DEFAULT '',
  content_html text,
  page_count integer,
  ocr_required boolean NOT NULL DEFAULT false,
  password_protected boolean NOT NULL DEFAULT false,
  detail text,
  content_sha256 text NOT NULL,
  extractor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, version_number)
);

CREATE TABLE pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_version_id uuid NOT NULL REFERENCES source_versions (id) ON DELETE CASCADE,
  page_number integer NOT NULL,
  char_start integer NOT NULL,
  char_end integer NOT NULL,
  text_chars integer NOT NULL,
  UNIQUE (source_version_id, page_number)
);

CREATE TABLE chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  source_id uuid NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  source_version_id uuid NOT NULL REFERENCES source_versions (id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  passage_id text NOT NULL UNIQUE,
  text text NOT NULL,
  char_start integer NOT NULL,
  char_end integer NOT NULL,
  page_number integer,
  UNIQUE (source_version_id, ordinal)
);

CREATE TABLE annotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  source_id uuid NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  source_version_id uuid NOT NULL REFERENCES source_versions (id) ON DELETE CASCADE,
  chunk_id uuid REFERENCES chunks (id) ON DELETE SET NULL,
  passage_id text NOT NULL,
  quote text NOT NULL,
  note text NOT NULL DEFAULT '',
  char_start integer,
  char_end integer,
  page_number integer,
  author_id uuid NOT NULL REFERENCES users (id),
  needs_review boolean NOT NULL DEFAULT false,
  review_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE collection_items (
  collection_id uuid NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, source_id)
);

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('note', 'brief')),
  title text NOT NULL,
  body_html text NOT NULL DEFAULT '',
  body_text text NOT NULL DEFAULT '',
  revision integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES users (id),
  updated_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE document_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  revision integer NOT NULL,
  title text NOT NULL,
  body_html text NOT NULL,
  body_text text NOT NULL,
  author_id uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, revision)
);

CREATE TABLE citations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  passage_id text NOT NULL,
  source_id uuid REFERENCES sources (id) ON DELETE SET NULL,
  source_version_id uuid REFERENCES source_versions (id) ON DELETE SET NULL,
  quote_snapshot text NOT NULL,
  source_title_snapshot text NOT NULL,
  page_number integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, passage_id)
);

CREATE TABLE comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  body text NOT NULL,
  author_id uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE generations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  requested_by uuid REFERENCES users (id),
  status text NOT NULL,
  provider text,
  model text,
  prompt_sha256 text,
  source_version_ids uuid[] NOT NULL DEFAULT '{}',
  passage_ids text[] NOT NULL DEFAULT '{}',
  usage jsonb,
  flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  disclaimer text NOT NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  source_id uuid REFERENCES sources (id) ON DELETE CASCADE,
  type text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  retryable boolean NOT NULL DEFAULT true,
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  error_code text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  cancel_requested boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE UNIQUE INDEX jobs_one_active_per_source
  ON jobs (source_id)
  WHERE status IN ('queued', 'processing');

CREATE TABLE share_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  document_id uuid NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_by uuid REFERENCES users (id),
  expose_cited_passages boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE chunks
  ADD COLUMN tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED;

ALTER TABLE documents
  ADD COLUMN tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body_text, ''))
  ) STORED;

ALTER TABLE sources
  ADD COLUMN title_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, ''))) STORED;

ALTER TABLE annotations
  ADD COLUMN tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(quote, '') || ' ' || coalesce(note, ''))
  ) STORED;

CREATE INDEX chunks_tsv_idx ON chunks USING GIN (tsv);
CREATE INDEX documents_tsv_idx ON documents USING GIN (tsv);
CREATE INDEX sources_title_tsv_idx ON sources USING GIN (title_tsv);
CREATE INDEX annotations_tsv_idx ON annotations USING GIN (tsv);
CREATE INDEX sources_project_idx ON sources (project_id) WHERE deleted_at IS NULL;
CREATE INDEX memberships_user_idx ON memberships (user_id);
CREATE INDEX projects_workspace_idx ON projects (workspace_id) WHERE deleted_at IS NULL;
CREATE INDEX jobs_queue_idx ON jobs (status, run_after, created_at);
CREATE INDEX annotations_source_idx ON annotations (source_id) WHERE deleted_at IS NULL;
