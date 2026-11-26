-- 来源登记不授予对外展示许可；许可仍由 DISPLAY_SOURCES 控制。
CREATE TABLE source_registry (
  source_id TEXT PRIMARY KEY NOT NULL,
  source_url TEXT NOT NULL,
  parser_version TEXT NOT NULL
);

INSERT INTO source_registry (source_id, source_url, parser_version) VALUES
  ('celestrak-active-gp', 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=JSON', 'gp-range-v1');
