CREATE TABLE IF NOT EXISTS team_users (
  id uuid PRIMARY KEY, name text NOT NULL UNIQUE, salt text NOT NULL, hash text NOT NULL,
  roles text[] NOT NULL, admin boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true, must_change boolean NOT NULL DEFAULT true,
  auth_provider text NOT NULL DEFAULT 'local', display_name text NOT NULL DEFAULT ''
);
ALTER TABLE team_users ADD COLUMN IF NOT EXISTS auth_provider text NOT NULL DEFAULT 'local';
ALTER TABLE team_users ADD COLUMN IF NOT EXISTS display_name text NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS team_sso_identities (
  provider text NOT NULL, subject text NOT NULL,
  user_id uuid NOT NULL REFERENCES team_users(id) ON DELETE CASCADE,
  username text NOT NULL, display_name text NOT NULL DEFAULT '', sso_role text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(provider, subject), UNIQUE(provider, user_id)
);
CREATE INDEX IF NOT EXISTS team_sso_user ON team_sso_identities(user_id);
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
CREATE TABLE IF NOT EXISTS team_settings (
  key text PRIMARY KEY, value jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS team_shared_sessions (
  id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES team_projects(id),
  user_id uuid NOT NULL REFERENCES team_users(id), device text NOT NULL,
  profile text NOT NULL, session text NOT NULL, title text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,device,profile,session)
);
CREATE TABLE IF NOT EXISTS team_session_messages (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES team_shared_sessions(id),
  source_id text NOT NULL, role text NOT NULL, content text NOT NULL,
  UNIQUE(session_id,source_id)
);
CREATE INDEX IF NOT EXISTS team_shared_project ON team_shared_sessions(project_id,updated_at);
ALTER TABLE team_shared_sessions ADD COLUMN IF NOT EXISTS merged_into uuid REFERENCES team_shared_sessions(id);
ALTER TABLE team_jobs ADD COLUMN IF NOT EXISTS through_seq bigint;
ALTER TABLE team_projects ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
DO $$
BEGIN
IF NOT EXISTS (SELECT 1 FROM team_settings WHERE key='session-identity-v3') THEN
INSERT INTO team_shared_sessions(id,project_id,user_id,device,profile,session,title,updated_at)
SELECT gen_random_uuid(),b.project_id,b.user_id,b.device,b.profile,b.session,left(b.entries->0->>'text',120),b.created_at
FROM (SELECT DISTINCT ON(user_id,device,profile,session) * FROM team_batches
  ORDER BY user_id,device,profile,session,created_at) b
ON CONFLICT(user_id,device,profile,session) DO NOTHING;
INSERT INTO team_session_messages(session_id,source_id,role,content)
SELECT s.id,e.value->>'id',e.value->>'role',e.value->>'text'
FROM team_batches b JOIN team_shared_sessions s
  ON s.user_id=b.user_id AND s.device=b.device AND s.profile=b.profile AND s.session=b.session
CROSS JOIN LATERAL jsonb_array_elements(b.entries) WITH ORDINALITY e(value,ordinal)
ORDER BY b.created_at,b.id,e.ordinal
ON CONFLICT(session_id,source_id) DO NOTHING;
WITH ranked AS (
  SELECT id,first_value(id) OVER (PARTITION BY project_id,device,profile,session ORDER BY updated_at,id) AS canonical
  FROM team_shared_sessions WHERE merged_into IS NULL
)
UPDATE team_shared_sessions s SET merged_into=r.canonical FROM ranked r WHERE s.id=r.id AND r.id<>r.canonical;
INSERT INTO team_session_messages(session_id,source_id,role,content)
SELECT s.merged_into,
  CASE WHEN existing.seq IS NOT NULL AND (existing.role<>m.role OR existing.content<>m.content)
    THEN m.source_id || ':legacy:' || s.id::text ELSE m.source_id END,
  m.role,m.content
FROM team_session_messages m JOIN team_shared_sessions s ON s.id=m.session_id
LEFT JOIN team_session_messages existing ON existing.session_id=s.merged_into AND existing.source_id=m.source_id
WHERE s.merged_into IS NOT NULL ORDER BY m.seq
ON CONFLICT(session_id,source_id) DO NOTHING;
INSERT INTO team_settings VALUES('session-identity-v3','true');
END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS team_shared_identity ON team_shared_sessions(project_id,device,profile,session) WHERE merged_into IS NULL;
CREATE TABLE IF NOT EXISTS team_repositories (
  id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES team_projects(id),
  name text NOT NULL, url text NOT NULL, branch text NOT NULL, credential jsonb,
  UNIQUE(project_id,name), UNIQUE(project_id,url)
);
CREATE TABLE IF NOT EXISTS team_agent_members (
  id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES team_projects(id),
  name text NOT NULL, role text NOT NULL, instructions text NOT NULL, UNIQUE(project_id,name)
);
CREATE TABLE IF NOT EXISTS team_agent_runs (
  id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES team_projects(id),
  created_by uuid NOT NULL REFERENCES team_users(id), operation_id uuid NOT NULL,
  title text NOT NULL, goal text NOT NULL, definition jsonb NOT NULL,
  state text NOT NULL DEFAULT 'queued', summary jsonb NOT NULL DEFAULT '{}', error text,
  command text, command_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id,created_by,operation_id)
);
CREATE INDEX IF NOT EXISTS team_agent_runs_pending ON team_agent_runs(state);
CREATE TABLE IF NOT EXISTS team_project_config (
  project_id uuid PRIMARY KEY REFERENCES team_projects(id), instructions text NOT NULL DEFAULT '',
  skills jsonb NOT NULL DEFAULT '[]', version integer NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS team_work_items (
  id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES team_projects(id), created_by uuid NOT NULL REFERENCES team_users(id),
  title text NOT NULL, description text NOT NULL DEFAULT '', state text NOT NULL DEFAULT 'todo',
  visibility text NOT NULL DEFAULT 'shared', assignee uuid REFERENCES team_users(id), due_at timestamptz,
  run_id uuid REFERENCES team_agent_runs(id), version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS team_assets (
  id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES team_projects(id), parent_id uuid REFERENCES team_assets(id),
  name text NOT NULL, folder boolean NOT NULL DEFAULT false, content bytea,
  created_by uuid NOT NULL REFERENCES team_users(id), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS team_run_assets (
  run_id uuid NOT NULL REFERENCES team_agent_runs(id), asset_id uuid NOT NULL, name text NOT NULL, content bytea NOT NULL,
  PRIMARY KEY(run_id,asset_id)
);
CREATE TABLE IF NOT EXISTS team_automations (
  id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES team_projects(id), created_by uuid NOT NULL REFERENCES team_users(id),
  title text NOT NULL, goal text NOT NULL, agent_ids jsonb NOT NULL, repository_ids jsonb NOT NULL,
  interval_minutes integer NOT NULL, next_at timestamptz NOT NULL, enabled boolean NOT NULL DEFAULT true,
  last_run uuid REFERENCES team_agent_runs(id), error text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS team_work_project ON team_work_items(project_id,updated_at);
CREATE INDEX IF NOT EXISTS team_assets_project ON team_assets(project_id);
