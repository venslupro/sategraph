/** 跨只读服务的限定输入，不依赖任何写适配器。 */
export class ReadError extends Error {
  readonly status: number;
  constructor(code: string, status = 422) { super(code); this.status = status; }
}
export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
export const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
export function keys(o: Obj, names: string[]) {
  if (!Object.keys(o).every(k => names.includes(k))) throw new ReadError('UNSUPPORTED_CONSTRAINT');
}
export async function readJson(message: Request|Response, limit: number): Promise<unknown> {
  const reader = message.body?.getReader();
  if (!reader) throw new ReadError('INVALID_JSON');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new ReadError('LIMIT_REACHED', 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
    return JSON.parse(new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes));
  } catch (err) { if (err instanceof ReadError) throw err; throw new ReadError('INVALID_JSON'); }
  finally { reader.releaseLock(); }
}
export async function requestObject(req: Request, maxBytes: number) {
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
    throw new ReadError('JSON_REQUIRED', 415);
  const obj = await readJson(req, maxBytes);
  if (!isObj(obj)) throw new ReadError('INVALID_QUERY');
  return obj;
}
export function failure(err: unknown, fallback: string) {
  const code = err instanceof ReadError ? err.message : fallback;
  return Response.json({status: code, error: code, query_execution_complete: false},
      {status: err instanceof ReadError ? err.status : 503, headers: {'cache-control': 'no-store'}});
}
