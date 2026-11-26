import {MAX_INPUT_BYTES} from './source_snapshot.ts';

export const ARCHIVE_PREFIX = 'raw/celestrak-gp/';
export type ReadArchiveRange =
    (version: {bucketId: string; fileId: string; byteLength: number},
     start: number, end: number) => Promise<Uint8Array<ArrayBuffer>>;

export interface ArchiveIdentity {
  sha256: string;
  sha1: string;
  byteLength: number;
}

export interface ArchivePort {
  readonly bucketId: string;
  find(input: ArchiveIdentity): Promise<string|null>;
  upload(input: ArchiveIdentity, bytes: Uint8Array<ArrayBuffer>):
      Promise<string>;
}

type Json = Record<string, unknown>;
type Send = typeof fetch;

function record(value: unknown): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('B2_INVALID_RESPONSE');
  }
  return value as Json;
}

function token(value: unknown): string {
  if (typeof value !== 'string' || !value || /[\s\x00-\x1f\x7f]/.test(value)) {
    throw new Error('B2_INVALID_RESPONSE');
  }
  return value;
}

function endpoint(value: unknown, upload: boolean): string {
  if (typeof value !== 'string') {
    throw new Error('B2_INVALID_ENDPOINT');
  }
  const url = new URL(value);
  const valid = upload ?
      /^(?:pod-[a-z0-9-]+|api[0-9]+)\.(?:backblazeb2|backblaze)\.com$/.test(
          url.hostname) &&
          /^\/b2api\/v[234]\/b2_upload_file(?:\/|$)/.test(url.pathname) :
      /^api[0-9]+\.backblazeb2\.com$/.test(url.hostname) &&
          url.pathname === '/' && !url.search;
  if (!valid || url.protocol !== 'https:' || url.username || url.password ||
      url.port || url.hash) {
    throw new Error('B2_INVALID_ENDPOINT');
  }
  return upload ? url.href : url.origin;
}

function key(input: ArchiveIdentity): string {
  if (!/^[\da-f]{64}$/.test(input.sha256) ||
      !/^[\da-f]{40}$/.test(input.sha1) ||
      !Number.isSafeInteger(input.byteLength) || input.byteLength <= 0) {
    throw new Error('INVALID_ARCHIVE_IDENTITY');
  }
  return ARCHIVE_PREFIX + input.sha256 + '.json';
}

async function request(
    send: Send, url: string, init: RequestInit): Promise<Json> {
  const response = await send(
      url, {...init, redirect: 'manual', signal: AbortSignal.timeout(30000)});
  if (!response.ok) {
    throw new Error('B2_HTTP_' + response.status);
  }
  return record(await response.json());
}

function fileId(file: Json, bucket: string, input: ArchiveIdentity): string {
  if (file.action !== 'upload' || file.bucketId !== bucket ||
      file.fileName !== key(input) || file.contentLength !== input.byteLength ||
      file.contentSha1 !== input.sha1 ||
      record(file.fileInfo).sha256 !== input.sha256) {
    throw new Error('B2_PROOF_MISMATCH');
  }
  return token(file.fileId);
}

/** 仅使用限定到目标桶的应用密钥；不创建、删除或公开对象。 */
export async function authorizeArchive(
    bucketId: string, keyId: string, appKey: string,
    send: Send = fetch): Promise<ArchivePort&{readRange: ReadArchiveRange}> {
  if (!/^[\da-f]{24}$/.test(bucketId) || !keyId || !appKey ||
      /[:\s]/.test(keyId)) {
    throw new Error('INVALID_ARCHIVE_CONFIG');
  }
  const auth = await request(
      send, 'https://api.backblazeb2.com/b2api/v4/b2_authorize_account', {
        headers: {Authorization: 'Basic ' + btoa(keyId + ':' + appKey)},
      });
  const api = record(record(auth.apiInfo).storageApi);
  const allowed = record(api.allowed);
  const buckets = allowed.buckets;
  const caps = allowed.capabilities;
  if (!Array.isArray(buckets) || buckets.length !== 1 ||
      record(buckets[0]).id !== bucketId || !Array.isArray(caps) ||
      !['listFiles', 'writeFiles'].every(cap => caps.includes(cap)) ||
      (allowed.namePrefix != null &&
       (typeof allowed.namePrefix !== 'string' ||
        !ARCHIVE_PREFIX.startsWith(allowed.namePrefix)))) {
    throw new Error('B2_KEY_SCOPE_MISMATCH');
  }
  const apiUrl = endpoint(api.apiUrl, false);
  const accountToken = token(auth.authorizationToken);
  const call = (method: string, data: Json) =>
      request(send, apiUrl + '/b2api/v4/' + method, {
        method: 'POST',
        headers:
            {Authorization: accountToken, 'Content-Type': 'application/json'},
        body: JSON.stringify(data),
      });
  return {
    bucketId,
    async readRange(version, start, end) {
      if (!caps.includes('readFiles') || version.bucketId !== bucketId ||
          typeof api.downloadUrl !== 'string' ||
          !/^https:[/][/]f[0-9]+[.]backblazeb2[.]com$/.test(api.downloadUrl)) {
        throw new Error('B2_DOWNLOAD_SCOPE');
      }
      if (!version.fileId || version.fileId.length > 256 ||
          ![version.byteLength, start, end].every(Number.isSafeInteger) ||
          version.byteLength > MAX_INPUT_BYTES || start < 0 || end <= start ||
          end > version.byteLength) {
        throw new Error('B2_INVALID_RANGE');
      }
      const entire = start === 0 && end === version.byteLength;
      const size = end - start;
      const res = await send(
          api.downloadUrl + '/b2api/v4/b2_download_file_by_id?fileId=' +
              encodeURIComponent(version.fileId),
          {
            headers: {
              Authorization: accountToken,
              Range: 'bytes=' + start + '-' + (end - 1),
              'Accept-Encoding': 'identity'
            },
            redirect: 'manual',
            signal: AbortSignal.timeout(30000),
          });
      const expectedRange = entire ?
          null :
          'bytes ' + start + '-' + (end - 1) + '/' + version.byteLength;
      if (!res.body || res.status !== (entire ? 200 : 206) ||
          res.headers.get('content-range') !== expectedRange ||
          res.headers.get('x-bz-file-id') !== version.fileId ||
          res.headers.get('content-length') !== String(size) ||
          (res.headers.get('content-encoding') ?? 'identity') !== 'identity') {
        await res.body?.cancel();
        throw new Error('B2_RANGE_MISMATCH');
      }
      const data = new Uint8Array(size);
      const reader = res.body.getReader();
      let offset = 0;
      try {
        while (true) {
          const {done, value} = await reader.read();
          if (done) {
            break;
          }
          if (offset + value.length > size) {
            await reader.cancel();
            throw new Error('B2_RANGE_MISMATCH');
          }
          data.set(value, offset);
          offset += value.length;
        }
      } finally {
        reader.releaseLock();
      }
      if (offset !== size) {
        throw new Error('B2_RANGE_MISMATCH');
      }
      return data;
    },
    async find(input) {
      const name = key(input);
      const result = await call(
          'b2_list_file_versions',
          {bucketId, prefix: name, startFileName: name, maxFileCount: 2});
      if (!Array.isArray(result.files) || result.nextFileName === name ||
          !Object.hasOwn(result, 'nextFileName')) {
        throw new Error('B2_AMBIGUOUS_VERSION');
      }
      const files =
          result.files.map(record).filter(file => file.fileName === name);
      if (files.length > 1) {
        throw new Error('B2_AMBIGUOUS_VERSION');
      }
      const [match] = files;
      return match ? fileId(match, bucketId, input) : null;
    },
    async upload(input, bytes) {
      const name = key(input);
      if (bytes.byteLength !== input.byteLength) {
        throw new Error('INVALID_ARCHIVE_LENGTH');
      }
      const target = await call('b2_get_upload_url', {bucketId});
      if (target.bucketId !== bucketId) {
        throw new Error('B2_BUCKET_MISMATCH');
      }
      const uploaded = await request(send, endpoint(target.uploadUrl, true), {
        method: 'POST',
        headers: {
          Authorization: token(target.authorizationToken),
          'Content-Type': 'application/json',
          'X-Bz-File-Name': encodeURIComponent(name),
          'X-Bz-Content-Sha1': input.sha1,
          'X-Bz-Info-sha256': input.sha256
        },
        body: bytes,
      });
      return fileId(uploaded, bucketId, input);
    },
  };
}
