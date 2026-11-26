import {inspectTarget} from './validation/readiness.ts';

const args = process.argv.slice(2);
const targets = ['neo4j', 'b2'];
const live = args[0] === '--live';
const selected = args.length > 1 ? [args[1]] : targets;
const valid = args.length === 0 ||
    (args[0] === '--check' && args.length === 1) ||
    (args.length === 2 && (live || args[0] === '--check') &&
     targets.includes(args[1]));

if (!valid) {
  console.error('用法：npm run a2 -- [--check [neo4j|b2] | --live neo4j|b2]');
  process.exitCode = 2;
} else {
  const checks = await Promise.all(
      selected.map(target => inspectTarget(target, process.env, live)));
  console.log(
      JSON.stringify({mode: live ? 'LIVE' : 'OFFLINE', checks}, null, 2));
  if (checks.some(
          check => ['BLOCKED', 'INVALID_CONFIG'].includes(check.status))) {
    process.exitCode = 2;
  } else if (
      checks.some(check => ['FAILED', 'UNKNOWN'].includes(check.status))) {
    process.exitCode = 1;
  }
}
