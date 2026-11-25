/** 未经配置批准的来源不进入对外查询。 */
export function displaySources(config: string | undefined): string[] {
  if (!config) return [];
  return [...new Set(config.split(',').map((id) => id.trim()).filter(
      (id) => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id)))];
}
