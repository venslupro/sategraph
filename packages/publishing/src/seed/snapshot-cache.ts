/**
 * Builds the demonstration snapshot once per isolate. Rebuilding on every
 * request would be wasteful; workflows replace this with published read models.
 */
import { buildSeedSnapshot } from './snapshot';
import type { GraphSnapshot } from '../model';

let cached: GraphSnapshot | null = null;

export function getSeedSnapshot(): GraphSnapshot {
  if (!cached) {
    cached = buildSeedSnapshot();
  }
  return cached;
}
