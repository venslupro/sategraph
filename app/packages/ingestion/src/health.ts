/**
 * Source health and freshness rules. The API exposes these records so users
 * can see whether displayed data is current.
 */
import type { SourceHealth } from '@sategraph/contracts';
import { toIsoUtc } from '@sategraph/shared-kernel';
import type { HealthRecord } from './ports';

export const FRESHNESS_LIMITS_MS: Record<string, number> = {
  'celestrak-gp': 2.5 * 3600 * 1000,
  'celestrak-satcat': 50 * 3600 * 1000,
  gcat: 50 * 3600 * 1000,
  wikidata: 50 * 3600 * 1000,
  satnogs: 50 * 3600 * 1000,
  'gnss-status': 50 * 3600 * 1000,
  curation: 400 * 24 * 3600 * 1000,
};

/** Marks a source stale when its last successful data time has expired. */
export function assessHealth(
  record: HealthRecord,
  now: Date,
): SourceHealth {
  const limit = FRESHNESS_LIMITS_MS[record.source] ?? 50 * 3600 * 1000;
  const reference = record.dataTime ?? record.lastSuccessAt;
  let status = record.status;
  if (reference && status === 'OK') {
    const age = now.getTime() - new Date(reference).getTime();
    if (age > limit) {
      status = 'STALE';
    }
  }
  return {
    source: record.source,
    status,
    lastSuccessAt: record.lastSuccessAt,
    dataTime: record.dataTime,
    message: record.message,
    license: record.license,
  };
}

export function healthyRecord(
  source: string,
  license: string,
  dataTime: Date,
): HealthRecord {
  return {
    source,
    status: 'OK',
    lastSuccessAt: toIsoUtc(dataTime),
    dataTime: toIsoUtc(dataTime),
    message: null,
    license,
  };
}

export function degradedRecord(
  source: string,
  license: string,
  message: string,
): HealthRecord {
  return {
    source,
    status: 'DEGRADED',
    lastSuccessAt: null,
    dataTime: null,
    message,
    license,
  };
}
