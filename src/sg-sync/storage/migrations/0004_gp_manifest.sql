CREATE TABLE gp_manifest (
  run_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  file_id TEXT NOT NULL,
  parser TEXT NOT NULL,
  spans TEXT NOT NULL CHECK (json_valid(spans) AND json_array_length(spans) > 0),
  PRIMARY KEY (run_id, source_id),
  FOREIGN KEY (run_id, source_id) REFERENCES source_input (run_id, source_id)
);

CREATE TABLE gp_checkpoint (
  run_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  next_chunk INTEGER NOT NULL DEFAULT 0 CHECK (next_chunk >= 0),
  next_row INTEGER NOT NULL DEFAULT 0 CHECK (next_row >= 0),
  PRIMARY KEY (run_id, source_id),
  FOREIGN KEY (run_id, source_id) REFERENCES gp_manifest (run_id, source_id)
);
