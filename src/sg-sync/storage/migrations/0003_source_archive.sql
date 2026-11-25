CREATE TABLE archive_object (
  bucket_id TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  sha1 TEXT NOT NULL CHECK (length(sha1) = 40),
  byte_length INTEGER NOT NULL CHECK (byte_length > 0),
  phase TEXT NOT NULL CHECK (phase IN ('READY', 'SENDING', 'CONFIRMED')),
  sender_run TEXT,
  sender_epoch INTEGER,
  file_id TEXT,
  PRIMARY KEY (bucket_id, sha256),
  CHECK ((phase = 'CONFIRMED') = (file_id IS NOT NULL)),
  CHECK (phase <> 'SENDING' OR (sender_run IS NOT NULL AND sender_epoch IS NOT NULL))
);

CREATE TABLE source_input (
  run_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  writer_epoch INTEGER NOT NULL CHECK (writer_epoch > 0),
  bucket_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  row_count INTEGER NOT NULL CHECK (row_count > 0),
  etag TEXT,
  PRIMARY KEY (run_id, source_id),
  FOREIGN KEY (bucket_id, sha256) REFERENCES archive_object (bucket_id, sha256)
);
