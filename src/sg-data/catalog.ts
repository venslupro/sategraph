import {displaySources} from './policy.ts';

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const allowed = 'IN (SELECT value FROM json_each(?1))';
const source = "json_extract(o.payload, '$.source_id')";
const fields = `o.entity_id, o.revision, o.epoch_us, p.display_name, p.cospar,
    ${source} AS source_id, json_extract(o.payload, '$.evidence_id') AS evidence_id`;
const profiles = `FROM orbit_current o LEFT JOIN catalog_profile p
    ON p.entity_id = o.entity_id AND p.source_id = ${source} AND p.epoch_us = o.epoch_us`;

function notFound() {
  return Response.json({status: 'NOT_FOUND'}, {status: 404});
}

function invalid() {
  return Response.json({error: 'INVALID_QUERY'}, {status: 422});
}

export async function catalog(db: D1Database, policy: string|undefined, url: URL) {
  const sources = JSON.stringify(displaySources(policy));
  const params = url.searchParams;
  if (url.pathname === '/api/v1/catalog/search') {
    for (const key of params.keys()) {
      if (!['q', 'after', 'limit'].includes(key) || params.getAll(key).length !== 1)
        return invalid();
    }
    const q = (params.get('q') ?? '').trim();
    const after = params.get('after') ?? '';
    const rawLimit = params.get('limit') ?? '25';
    const limit = Number(rawLimit);
    if (q.length > 128 || (after && !ID.test(after)) ||
        !/^[1-9][0-9]{0,2}$/.test(rawLimit) || limit > 100) return invalid();
    const rows = (await db.prepare(`SELECT ${fields} ${profiles}
        WHERE ${source} ${allowed} AND o.entity_id > ?2 AND
          (?3 = '' OR o.entity_id = ?3 OR o.entity_id = 'norad:' || ?3 OR
           p.cospar = ?3 OR instr(lower(p.display_name), lower(?3)) > 0)
        ORDER BY o.entity_id LIMIT ?4`).bind(sources, after, q, limit + 1)
                      .all<{entity_id: string}>()).results;
    return Response.json({
      items: rows.slice(0, limit),
      next_cursor: rows.length > limit ? rows[limit - 1]!.entity_id : null,
      snapshot_guaranteed: false,
    });
  }
  if ([...params.keys()].length) return invalid();
  if (url.pathname === '/api/v1/catalog/statistics') {
    const stats = await db.prepare(`SELECT count(*) AS objects_with_orbit
        FROM orbit_current o WHERE ${source} ${allowed}`).bind(sources).first();
    return Response.json(stats);
  }
  const match = /^[/]api[/]v1[/](satellites|evidence|datasets)[/]([^/]+)$/.exec(url.pathname);
  if (!match) return notFound();
  let id: string;
  try {
    id = decodeURIComponent(match[2]!);
  } catch {
    return invalid();
  }
  if (!ID.test(id)) return invalid();
  if (match[1] === 'satellites') {
    const row = await db.prepare(`SELECT ${fields}, p.omm ${profiles}
        WHERE ${source} ${allowed} AND o.entity_id = ?2`).bind(sources, id).first();
    return row ? Response.json({...row, omm: row.omm ? JSON.parse(String(row.omm)) : null}) : notFound();
  }
  if (match[1] === 'evidence') {
    const row = await db.prepare(`SELECT entity_id, revision,
        payload ->> '$.evidence_id' AS evidence_id,
        payload ->> '$.source_id' AS source_id, payload ->> '$.epoch_us' AS epoch_us,
        payload ->> '$.object_id' AS object_ref FROM projection_outbox
        WHERE json_extract(payload, '$.evidence_id') = ?2
          AND json_extract(payload, '$.source_id') ${allowed} ORDER BY event_seq LIMIT 1`)
                    .bind(sources, id).first();
    return row ? Response.json(row) : notFound();
  }
  // 输入清单只在末块提交后可见；它不是图发布凭据。指定摘要不回退到 current。
  const row = await db.prepare(`SELECT m.input_hash AS manifest_id, m.source_id,
      m.parser, i.row_count AS expected, p.next_row AS applied, 1 AS ingest_complete
      FROM gp_manifest m JOIN gp_checkpoint p USING (run_id, source_id)
      JOIN source_input i USING (run_id, source_id)
      JOIN archive_object a ON a.bucket_id = i.bucket_id AND a.sha256 = m.input_hash
      WHERE m.source_id ${allowed} AND (?2 = 'current' OR m.input_hash = ?2)
        AND i.sha256 = m.input_hash AND a.phase = 'CONFIRMED' AND a.file_id = m.file_id
        AND p.next_row = i.row_count AND p.next_chunk = json_array_length(m.spans)
      ORDER BY i.writer_epoch DESC, m.run_id, m.source_id LIMIT 1`)
                  .bind(sources, id).first();
  return row ? Response.json(row) : notFound();
}
