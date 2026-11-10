/**
 * Minimal result type for domain operations that can fail without throwing.
 */

export type Result<T, E = string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function unwrap<T, E>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(typeof result.error === 'string' ? result.error : 'Failure');
  }
  return result.value;
}
