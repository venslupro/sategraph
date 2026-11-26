SELECT r.source_id, r.source_url, r.parser_version,
       p.instance_id, p.acknowledged, p.last_hash, p.pending_end, p.pending_hash,
       (p.stream IS NULL AND NOT EXISTS (SELECT 1 FROM command_control)
        AND NOT EXISTS (SELECT 1 FROM projection_outbox)
        AND NOT EXISTS (SELECT 1 FROM orbit_current)
        AND NOT EXISTS (SELECT 1 FROM source_input)) AS pristine
FROM source_registry AS r LEFT JOIN projection_cursor AS p ON p.stream = 'orbit'
WHERE r.source_id = 'celestrak-active-gp';
