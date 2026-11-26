type Field = string|number|boolean|null;

function index(input: unknown): Map<string, string> {
  if (!Array.isArray(input) || !input.length) {
    throw new Error('EMPTY_OR_INVALID_SNAPSHOT');
  }
  const rows = new Map<string, string>();
  for (const record of input) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error('INVALID_ROW');
    }
    const row = record as Record<string, Field>;
    const id = String(row.NORAD_CAT_ID);
    if (!/^[1-9][0-9]{0,8}$/.test(id) || rows.has(id)) {
      throw new Error('INVALID_OR_DUPLICATE_ID');
    }
    const entries = Object.keys(row).sort().map(key => {
      const value = row[key];
      if (value !== null &&
          !['number', 'boolean', 'string'].includes(typeof value)) {
        throw new Error('INVALID_FIELD');
      }
      return [key, key === 'NORAD_CAT_ID' ? id : value];
    });
    rows.set(id, JSON.stringify(entries));
  }
  return rows;
}

/** 比较整个来源记录，不将一次未出现解释为删除或退役。 */
export function compareSnapshots(previous: unknown, current: unknown) {
  const before = index(previous);
  const after = index(current);
  let added = 0;
  let changed = 0;
  for (const [id, row] of after) {
    if (!before.has(id)) {
      added++;
    } else if (before.get(id) !== row) {
      changed++;
    }
  }
  const matched = after.size - added;
  return {
    previousRows: before.size,
    currentRows: after.size,
    added,
    changed,
    unchanged: matched - changed,
    absentInCurrent: before.size - matched,
    changedShareOfMatched: matched ? changed / matched : null
  };
}
