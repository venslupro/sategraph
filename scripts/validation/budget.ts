/** 输入为同一周期、同一单位的实测量和已经核验的账户上限。 */
export interface Meter {
  used: number|null;
  limit: number|null;
}

export const METRICS = [
  'd1RowsWrittenPerDay',
  'd1RowsReadPerDay',
  'd1Bytes',
  'workerRequestsPerDay',
  'workerCpuMsPerInvocation',
  'doRequestsPerDay',
  'doGbSecondsPerDay',
  'doRowsWrittenPerDay',
  'doRowsReadPerDay',
  'doStorageBytes',
  'graphNodesPeak',
  'graphRelationshipsPeak',
  'b2StoredBytesPeak',
  'b2EgressBytesPerMonth',
  'aiNeuronsPerDay',
] as const;

type Metric = typeof METRICS[number];
type Status = 'UNKNOWN'|'EXCEEDED'|'AT_LIMIT'|'RESTRICT'|'WARN'|'OK';

function classify(meter?: Meter): Status {
  if (!meter || meter.used == null || meter.limit == null) {
    return 'UNKNOWN';
  }
  const {used, limit} = meter;
  if (![used, limit].every(n => Number.isFinite(n) && n >= 0)) {
    throw new RangeError('用量和上限必须为非负有限数');
  }
  if (used > limit) {
    return 'EXCEEDED';
  }
  if (used === limit) {
    return 'AT_LIMIT';
  }
  const ratio = used / limit;
  return ratio >= 0.85 ? 'RESTRICT' : ratio >= 0.7 ? 'WARN' : 'OK';
}

export function assessBudget(meters: Partial<Record<Metric, Meter>>) {
  return METRICS.map(metric => ({metric, status: classify(meters[metric])}));
}
