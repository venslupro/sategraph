CREATE TABLE catalog_profile (
  entity_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  display_name TEXT,
  cospar TEXT,
  epoch_us INTEGER NOT NULL,
  omm TEXT NOT NULL CHECK(json_valid(omm)),
  PRIMARY KEY(entity_id, source_id)
);
CREATE INDEX catalog_name ON catalog_profile(source_id, display_name COLLATE NOCASE, entity_id);
CREATE INDEX orbit_evidence ON projection_outbox(json_extract(payload,'$.evidence_id'), event_seq);
