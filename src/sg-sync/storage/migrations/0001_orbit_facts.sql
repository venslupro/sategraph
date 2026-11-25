CREATE TABLE command_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  run_id TEXT NOT NULL,
  writer_epoch INTEGER NOT NULL CHECK (writer_epoch > 0),
  active INTEGER NOT NULL CHECK (active IN (0, 1))
);

CREATE TABLE orbit_current (
  entity_id TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  epoch_us INTEGER NOT NULL,
  payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL
);

CREATE TABLE projection_outbox (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL UNIQUE,
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  UNIQUE (entity_id, revision)
);

CREATE TABLE command_receipt (
  operation_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  writer_epoch INTEGER NOT NULL,
  entity_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL,
  epoch_us INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('APPLIED', 'UNCHANGED', 'OLDER')),
  revision INTEGER NOT NULL
);
