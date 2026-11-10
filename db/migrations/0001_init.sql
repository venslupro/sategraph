-- SatGraph D1 schema: search projection, event log, agent analytics, alerts.
-- Graph data lives in Neo4j; D1 never stores relations.
-- Write-side tables are populated by workflows; user requests never write.

CREATE TABLE IF NOT EXISTS satellite_search (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '',
  cospar_id TEXT,
  norad_id TEXT NOT NULL,
  layer_id TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  constellation_name TEXT,
  orbit_class TEXT NOT NULL,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_satellite_search_name ON satellite_search (name);
CREATE INDEX IF NOT EXISTS idx_satellite_search_norad ON satellite_search (norad_id);
CREATE INDEX IF NOT EXISTS idx_satellite_search_layer ON satellite_search (layer_id);
CREATE INDEX IF NOT EXISTS idx_satellite_search_status ON satellite_search (status);

CREATE TABLE IF NOT EXISTS domain_event (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  graph_version TEXT NOT NULL,
  data_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_domain_event_time ON domain_event (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_domain_event_aggregate ON domain_event (aggregate_id);

CREATE TABLE IF NOT EXISTS agent_run (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  steps INTEGER NOT NULL DEFAULT 0,
  provider TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_run_time ON agent_run (created_at DESC);

CREATE TABLE IF NOT EXISTS alert (
  id TEXT PRIMARY KEY,
  severity TEXT NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_alert_open ON alert (resolved_at, created_at DESC);
