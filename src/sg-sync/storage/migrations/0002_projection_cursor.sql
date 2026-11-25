CREATE TABLE projection_cursor (
  stream TEXT PRIMARY KEY NOT NULL CHECK (stream = 'orbit'),
  instance_id TEXT NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged >= 0),
  last_hash TEXT NOT NULL DEFAULT '',
  pending_end INTEGER,
  pending_hash TEXT,
  pending_run TEXT,
  pending_epoch INTEGER,
  CHECK ((pending_end IS NULL AND pending_hash IS NULL AND pending_run IS NULL AND pending_epoch IS NULL)
      OR (pending_end IS NOT NULL AND pending_end > acknowledged AND pending_hash IS NOT NULL
      AND pending_run IS NOT NULL AND pending_epoch IS NOT NULL))
);
