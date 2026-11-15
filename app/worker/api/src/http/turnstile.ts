/** Optional Cloudflare Turnstile verification for the agent endpoint. */
export async function verifyTurnstile(
  secret: string | undefined,
  token: string | undefined,
): Promise<boolean> {
  if (!secret) {
    return true;
  }
  if (!token) {
    return false;
  }
  const body = new URLSearchParams({
    secret,
    response: token,
  });
  const response = await fetch(
    'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    {
      method: 'POST',
      body,
    },
  );
  if (!response.ok) {
    return false;
  }
  const result = (await response.json()) as { success?: boolean };
  return result.success === true;
}
