-- Durable Object schema is authoritative for coordination. This D1 schema is
-- a rebuildable projection and intentionally contains no secrets.
CREATE TABLE IF NOT EXISTS workspace_projection (
  workspace_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS run_projection (
  run_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_projection_workspace_idx ON run_projection(workspace_id, updated_at DESC);
