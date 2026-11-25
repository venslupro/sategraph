export const GP_URL =
    'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=JSON';
export const MAX_INPUT_BYTES = 24 * 1024 * 1024;

export interface RawSnapshot {
  bytes: Uint8Array<ArrayBuffer>;
  sha256: string;
  sha1: string;
  rows: number;
  etag: string|null;
}

async function hexDigest(algorithm: string, bytes: Uint8Array<ArrayBuffer>) {
  return Array
      .from(
          new Uint8Array(await crypto.subtle.digest(algorithm, bytes)),
          b => b.toString(16).padStart(2, '0'))
      .join('');
}

/** 冻结原始字节；超限拒绝整份输入，不截断后宣称全量。 */
export async function fetchSnapshot(
    etag?: string, send: typeof fetch = fetch): Promise<RawSnapshot|null> {
  const headers = new Headers({accept: 'application/json'});
  if (etag) headers.set('if-none-match', etag);
  const response = await send(
      GP_URL, {headers, redirect: 'manual', signal: AbortSignal.timeout(30000)});
  if (response.status === 304 && etag) return null;
  if (response.status !== 200 || !response.body)
    throw new Error('SOURCE_UNAVAILABLE');
  if (Number(response.headers.get('content-length')) > MAX_INPUT_BYTES) {
    await response.body.cancel();
    throw new Error('SOURCE_TOO_LARGE');
  }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_INPUT_BYTES) {
        await reader.cancel();
        throw new Error('SOURCE_TOO_LARGE');
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  parts.length = 0;
  const records: unknown = JSON.parse(
      new TextDecoder('utf-8', {fatal: true, ignoreBOM: false}).decode(bytes));
  if (!Array.isArray(records) || !records.length)
    throw new Error('INVALID_GP_INPUT');
  const seen = new Set<string>();
  for (const row of records) {
    const id = String(row?.NORAD_CAT_ID ?? '');
    if (!/^[1-9][0-9]{0,8}$/.test(id) || seen.has(id) ||
        typeof row.EPOCH !== 'string' ||
        !Number.isFinite(Date.parse(row.EPOCH)))
      throw new Error('INVALID_GP_INPUT');
    seen.add(id);
  }
  const [sha256, sha1] = await Promise.all(
      [hexDigest('SHA-256', bytes), hexDigest('SHA-1', bytes)]);
  return {
    bytes,
    sha256,
    sha1,
    rows: seen.size,
    etag: response.headers.get('etag')
  };
}
