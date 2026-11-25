const TTL_SECONDS = 2 * 60 * 60;
const COOKIE = '__Host-sg_session';
const encoder = new TextEncoder();

interface SigningKey {
  id: string;
  secret: string
}
interface Keyring {
  current: SigningKey;
  previous?: SigningKey
}

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '');
}

function decode(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('INVALID_ENCODING');
  const bytes = Uint8Array.from(
      atob(text.replaceAll('-', '+').replaceAll('_', '/')),
      c => c.charCodeAt(0));
  if (encode(bytes) !== text) throw new Error('INVALID_ENCODING');
  return bytes;
}

function parseKeys(value: string): Keyring {
  const keys = JSON.parse(value) as Keyring;
  for (const key of [keys.current, ...(keys.previous ? [keys.previous] : [])]) {
    if (!key || !/^[A-Za-z0-9_-]{1,32}$/.test(key.id) ||
        decode(key.secret).length !== 32) {
      throw new Error('INVALID_KEYRING');
    }
  }
  if (keys.current.id === keys.previous?.id)
    throw new Error('DUPLICATE_KEY_ID');
  return keys;
}

function importKey(key: SigningKey) {
  return crypto.subtle.importKey(
      'raw', decode(key.secret), {name: 'HMAC', hash: 'SHA-256'}, false,
      ['sign', 'verify']);
}

export async function issueCookie(
    keyring: string, host: string, now = Date.now()) {
  const key = parseKeys(keyring).current;
  const iat = Math.floor(now / 1000);
  const payload = encode(encoder.encode(JSON.stringify({
    sid: crypto.randomUUID(),
    aud: host,
    purpose: 'catalog_read',
    iat,
    exp: iat + TTL_SECONDS
  })));
  const signed = key.id + '.' + payload;
  const sig = await crypto.subtle.sign(
      'HMAC', await importKey(key), encoder.encode(signed));
  return COOKIE + '=' + signed + '.' + encode(new Uint8Array(sig)) +
      '; Max-Age=' + TTL_SECONDS + '; Path=/; Secure; HttpOnly; SameSite=Lax';
}

export async function validSession(
    header: string, keyring: string, host: string, now = Date.now()) {
  const cookies = header.split(';')
                      .map(s => s.trim())
                      .filter(s => s.startsWith(COOKIE + '='));
  if (cookies.length !== 1 || cookies[0]!.length > 1024) return false;
  const parts = cookies[0]!.slice(COOKIE.length + 1).split('.');
  if (parts.length !== 3) return false;
  const [id, payload, sig] = parts as [string, string, string];
  const keys = parseKeys(keyring);
  const key = [keys.current, keys.previous].find(k => k?.id === id);
  if (!key) return false;
  try {
    if (!await crypto.subtle.verify(
            'HMAC', await importKey(key), decode(sig),
            encoder.encode(id + '.' + payload)))
      return false;
    const c = JSON.parse(new TextDecoder().decode(decode(payload)));
    const sec = Math.floor(now / 1000);
    return c.aud === host && c.purpose === 'catalog_read' &&
        typeof c.sid === 'string' && Number.isSafeInteger(c.iat) &&
        c.exp === c.iat + TTL_SECONDS && c.iat <= sec && sec < c.exp;
  } catch {
    return false;
  }
}
