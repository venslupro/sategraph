import {MAX_INPUT_BYTES} from './source_snapshot.ts';

export const GP_PARSER = 'gp-range-v1';
const MAX_ROWS = 100;
const MAX_BYTES = 256 * 1024;
const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
const encoder = new TextEncoder();
type Bytes = Uint8Array<ArrayBuffer>;
export interface Span {
  start: number;
  end: number;
  first: number;
  count: number;
  hash: string
}

export async function sha256(bytes: Uint8Array) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0'))
      .join('');
}

function epochUs(value: unknown) {
  const m = typeof value === 'string' &&
      /^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(?:[.]([0-9]{1,6}))?(?:Z|[+]00:00)?$/
          .exec(value);
  if (!m) throw new Error('INVALID_GP_EPOCH');
  const ms = Date.parse(m[1] + 'Z');
  const us = ms * 1000 + Number((m[2] ?? '').padEnd(6, '0'));
  if (!Number.isSafeInteger(us) ||
      new Date(ms).toISOString().slice(0, 19) !== m[1])
    throw new Error('INVALID_GP_EPOCH');
  return us;
}

function orbit(row: Record<string, unknown>) {
  if (!row || typeof row !== 'object' || Array.isArray(row))
    throw new Error('INVALID_GP_ROW');
  const id = row.NORAD_CAT_ID;
  if ((typeof id !== 'number' && typeof id !== 'string') ||
      !/^[1-9][0-9]{0,8}$/.test(String(id)))
    throw new Error('INVALID_GP_ID');
  for (const [k, v] of Object.entries({
         REF_FRAME: 'TEME',
         TIME_SYSTEM: 'UTC',
         CENTER_NAME: 'EARTH',
         MEAN_ELEMENT_THEORY: 'SGP4'
       })) {
    if (row[k] !== undefined && row[k] !== v)
      throw new Error('UNSUPPORTED_GP_CONVENTION');
  }
  const epoch = epochUs(row.EPOCH);
  const values = [
    'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE',
    'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'BSTAR', 'MEAN_MOTION_DOT',
    'MEAN_MOTION_DDOT'
  ].map((key, i) => {
    const v = row[key];
    if (v === undefined && i >= 6) return null;
    if (typeof v !== 'number' &&
        !(typeof v === 'string' &&
          /^[+-]?(?:[0-9]+(?:[.][0-9]*)?|[.][0-9]+)(?:[Ee][+-]?[0-9]+)?$/.test(
              v)))
      throw new Error('INVALID_GP_ELEMENTS');
    const n = Number(v);
    if (!Number.isFinite(n) || (i === 0 && n <= 0) ||
        (i === 1 && (n < 0 || n >= 1)) || (i === 2 && (n < 0 || n > 180)) ||
        (i >= 3 && i <= 5 && (n < 0 || n >= 360)))
      throw new Error('INVALID_GP_ELEMENTS');
    return n;
  });
  return {
    id: String(id),
    epoch,
    canonical: JSON.stringify([String(id), epoch, ...values])
  };
}

/**
 * 只索引未压缩原始 JSON；在 UTF-8 字节上找对象边界，跳过字符串中的括号和转义。
 */
export async function indexGp(
    bytes: Bytes, expectedHash: string, expectedRows: number): Promise<Span[]> {
  if (!bytes.length || bytes.length > MAX_INPUT_BYTES ||
      await sha256(bytes) !== expectedHash)
    throw new Error('GP_INPUT_MISMATCH');
  let i = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const ws = () => {
    while ([9, 10, 13, 32].includes(bytes[i]!)) i++;
  };
  const invalid = () => new Error('INVALID_GP_ARRAY');
  ws();
  if (bytes[i++] !== 91) throw invalid();
  const spans: Span[] = [], seen = new Set<string>();
  let start = 0, end = 0, count = 0;
  async function flush() {
    spans.push({
      start,
      end,
      first: seen.size - count,
      count,
      hash: await sha256(bytes.subarray(start, end))
    });
    count = 0;
  }
  while (true) {
    ws();
    const from = i;
    if (bytes[i++] !== 123) throw invalid();
    let depth = 1, quoted = false;
    while (depth && i < bytes.length) {
      const c = bytes[i++];
      if (quoted) {
        if (c === 92)
          i++;
        else if (c === 34)
          quoted = false;
      } else if (c === 34)
        quoted = true;
      else if (c === 123)
        depth++;
      else if (c === 125)
        depth--;
      if (i - from + 2 > MAX_BYTES) throw new Error('GP_ROW_TOO_LARGE');
    }
    if (depth) throw invalid();
    const normalized =
        orbit(JSON.parse(decoder.decode(bytes.subarray(from, i))));
    if (seen.has(normalized.id)) throw new Error('DUPLICATE_GP_ID');
    if (count && (count === MAX_ROWS || i - start + 2 > MAX_BYTES))
      await flush();
    if (!count) start = from;
    end = i;
    count++;
    seen.add(normalized.id);
    ws();
    const sep = bytes[i++];
    if (sep === 93) break;
    if (sep !== 44) throw invalid();
  }
  ws();
  if (i !== bytes.length || seen.size !== expectedRows)
    throw new Error('GP_INPUT_MISMATCH');
  await flush();
  return spans;
}

export async function readGpSpan(bytes: Bytes, span: Span) {
  if (bytes.length !== span.end - span.start || bytes.length + 2 > MAX_BYTES ||
      await sha256(bytes) !== span.hash)
    throw new Error('GP_RANGE_MISMATCH');
  const rows: Record<string, unknown>[] =
      JSON.parse('[' + decoder.decode(bytes) + ']');
  if (!rows.length || rows.length !== span.count || rows.length > MAX_ROWS)
    throw new Error('GP_RANGE_MISMATCH');
  return Promise.all(rows.map(async r => {
    const {id, epoch, canonical} = orbit(r);
    const label = (v:unknown, max:number) => typeof v === 'string' && v.length <= max ? v.trim() || null : null;
    const omm:Record<string, string|number> = {NORAD_CAT_ID:id,EPOCH:String(r.EPOCH)};
    for (const key of ['MEAN_MOTION','ECCENTRICITY','INCLINATION','RA_OF_ASC_NODE','ARG_OF_PERICENTER','MEAN_ANOMALY','BSTAR','MEAN_MOTION_DOT','MEAN_MOTION_DDOT']) {
      if (r[key] !== undefined) omm[key]=Number(r[key]);
    }
    return {
      id,
      epoch,
      name:label(r.OBJECT_NAME,160), cospar:label(r.OBJECT_ID,64), omm,
      evidence: 'gp:' + await sha256(encoder.encode(canonical))
    };
  }));
}
