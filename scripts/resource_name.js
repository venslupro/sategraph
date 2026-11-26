export function resourceName(environment, moduleName) {
  if (environment !== 'prd') {
    throw new Error('只允许 prd 生产环境');
  }
  if (typeof moduleName !== 'string' ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(moduleName)) {
    throw new Error('资源名须使用小写短横线模块名');
  }
  return 'sategraph-' + environment + '-' + moduleName;
}
