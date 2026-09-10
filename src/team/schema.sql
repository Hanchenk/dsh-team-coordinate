CREATE TABLE IF NOT EXISTS team_users (
  id uuid PRIMARY KEY, name text NOT NULL UNIQUE, salt text NOT NULL, hash text NOT NULL,
  roles text[] NOT NULL, admin boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true, must_change boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS team_tokens (
  hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES team_users(id),
  device text NOT NULL, expires bigint NOT NULL, kind text NOT NULL,
  family uuid NOT NULL, revoked boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS team_projects (
  id uuid PRIMARY KEY, name text NOT NULL, owner_id uuid NOT NULL REFERENCES team_users(id),
  seq integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS team_members (
  project_id uuid NOT NULL REFERENCES team_projects(id), user_id uuid NOT NULL REFERENCES team_users(id),
  role text NOT NULL, PRIMARY KEY(project_id,user_id)
);
CREATE TABLE IF NOT EXISTS team_invites (
  hash text PRIMARY KEY, project_id uuid NOT NULL REFERENCES team_projects(id),
  target_id uuid NOT NULL REFERENCES team_users(id), role text NOT NULL,
  expires bigint NOT NULL, used boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL REFERENCES team_users(id)
);
CREATE TABLE IF NOT EXISTS team_batches (
  id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES team_projects(id),
  user_id uuid NOT NULL REFERENCES team_users(id), device text NOT NULL,
  profile text NOT NULL, session text NOT NULL, operation_id uuid NOT NULL,
  input_hash text NOT NULL, entries jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,device,operation_id)
);
CREATE TABLE IF NOT EXISTS team_sources (
  user_id uuid NOT NULL REFERENCES team_users(id), device text NOT NULL,
  profile text NOT NULL, session text NOT NULL, project_id uuid NOT NULL REFERENCES team_projects(id),
  PRIMARY KEY(user_id,device,profile,session)
);
CREATE TABLE IF NOT EXISTS team_jobs (
  id uuid PRIMARY KEY, batch_id uuid NOT NULL UNIQUE REFERENCES team_batches(id),
  state text NOT NULL DEFAULT 'queued', attempts integer NOT NULL DEFAULT 0,
  available_at bigint NOT NULL DEFAULT 0, lease_until bigint NOT NULL DEFAULT 0,
  lease_id uuid, error text, model text, prompt_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS team_memories (
  id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES team_projects(id),
  batch_id uuid NOT NULL REFERENCES team_batches(id), title text NOT NULL, content text NOT NULL,
  category text NOT NULL, evidence text NOT NULL, source_ids jsonb NOT NULL,
  content_hash text NOT NULL, version integer NOT NULL DEFAULT 1, withdrawn boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id,content_hash)
);
CREATE TABLE IF NOT EXISTS team_summaries (
  batch_id uuid PRIMARY KEY REFERENCES team_batches(id), project_id uuid NOT NULL REFERENCES team_projects(id),
  content text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS team_changes (
  project_id uuid NOT NULL REFERENCES team_projects(id), seq integer NOT NULL,
  kind text NOT NULL, resource_id uuid NOT NULL, payload jsonb NOT NULL,
  PRIMARY KEY(project_id,seq)
);
CREATE TABLE IF NOT EXISTS team_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id uuid,
  project_id uuid, action text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS team_jobs_pending ON team_jobs(state,available_at);
CREATE INDEX IF NOT EXISTS team_memory_project ON team_memories(project_id);
