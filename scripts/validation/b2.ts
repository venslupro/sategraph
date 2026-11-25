export function validObjectTarget(
    origin: string, bucket: string, file: string): boolean {
  return /^https:\/\/api[0-9]+\.backblazeb2\.com$/.test(origin) &&
      /^[a-f0-9]{24}$/.test(bucket) && file.length > 0 && file.length <= 256;
}

/** 使用已授权的只读 token 核对确切文件版本。不会列桶、上传或删除。 */
export async function probeObject(
    apiOrigin: string, token: string, bucketId: string, fileId: string,
    send: typeof fetch = fetch) {
  if (!validObjectTarget(apiOrigin, bucketId, fileId)) {
    throw new Error('INVALID_OBJECT_REFERENCE');
  }
  const response = await send(apiOrigin + '/b2api/v4/b2_get_file_info', {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
    headers: {authorization: token, 'content-type': 'application/json'},
    body: JSON.stringify({fileId}),
  });
  if (!response.ok) throw new Error('OBJECT_READ_FAILED');
  const item = await response.json() as {
    bucketId?: string;
    fileId?: string;
    contentLength?: number;
    action?: string;
  };
  if (item.bucketId !== bucketId || item.fileId !== fileId ||
      item.action !== 'upload' || typeof item.contentLength !== 'number' ||
      !Number.isSafeInteger(item.contentLength) || item.contentLength < 0) {
    throw new Error('INVALID_OBJECT_METADATA');
  }
  return {bytes: item.contentLength};
}
