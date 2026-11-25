/** 仅允许已配置的 Aura HTTPS 源站和单个数据库名。 */
export function validGraphTarget(origin: string, database: string): boolean {
  return /^https:\/\/[a-z0-9-]+\.databases\.neo4j\.io$/.test(origin) &&
      /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/.test(database);
}
