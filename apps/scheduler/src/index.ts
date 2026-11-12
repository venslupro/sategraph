/**
 * Scheduler Worker entry. Three cron triggers dispatch the data workflows:
 * orbits every two hours, graph publication every 48 hours, backups weekly.
 * The same workflows are exposed as authenticated POST endpoints for manual
 * operation; no user traffic ever reaches this worker.
 */
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';
import type { Manifest } from '@sategraph/contracts';
import type { SchedulerBindings } from './services';
import { readModelStore } from './services';
import { refreshOrbits } from './workflows/orbit-refresh';
import {
  buildPublicationSnapshot,
  isUnchanged,
  publishSnapshot,
  type GraphRefreshResult,
} from './workflows/graph-refresh';
import { runBackup } from './workflows/backup';

const ORBIT_CRON = '0 */2 * * *';
const GRAPH_CRON = '0 3 */2 * *';
const BACKUP_CRON = '0 4 * * 1';

interface WorkflowParams {
  trigger: string;
}

function modeOf(env: SchedulerBindings): Manifest['modes'] {
  return {
    graph: env.GRAPH_BACKEND ?? 'd1',
    agent: env.AGENT_MODE ?? 'fake',
  };
}

export class GraphRefreshWorkflow extends WorkflowEntrypoint<
  SchedulerBindings,
  WorkflowParams
> {
  override async run(
    _event: WorkflowEvent<WorkflowParams>,
    step: WorkflowStep,
  ): Promise<GraphRefreshResult> {
    const env = this.env;
    const orbit = await step.do('load-orbit-elements', async () => {
      const store = readModelStore(env);
      const orbitVersion = (await store.getText('ptr:orbit')) ?? 'o-unpublished';
      const csv = await store.getText(`orbits:${orbitVersion}`);
      return { orbitVersion, csv };
    });

    const snapshot = await step.do('build-snapshot', async () =>
      buildPublicationSnapshot(orbit.csv, orbit.orbitVersion, new Date()),
    );

    const unchanged = await step.do('compare-version', async () =>
      isUnchanged(env, snapshot),
    );
    if (unchanged) {
      return {
        changed: false,
        graphVersion: snapshot.graphVersion,
        orbitVersion: snapshot.orbitVersion,
        satelliteCount: snapshot.satellites.length,
        relationCount: snapshot.relations.length,
        staged: false,
      };
    }

    const result = await step.do(
      'publish-read-models',
      { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' } },
      async () => publishSnapshot(env, snapshot, modeOf(env)),
    );

    await step.do('verify-publication', async () => {
      const store = readModelStore(env);
      const pointer = await store.getText('ptr:graph');
      if (pointer !== result.graphVersion) {
        throw new Error(
          `Publication pointer mismatch: expected ${result.graphVersion}, found ${pointer}`,
        );
      }
      const manifest = await store.get<Manifest>(
        `rm:${result.graphVersion}:manifest`,
      );
      if (!manifest) {
        throw new Error('Published manifest is missing');
      }
      return { graphVersion: pointer, satellites: manifest.satelliteCount };
    });

    return result;
  }
}

export class BackupWorkflow extends WorkflowEntrypoint<
  SchedulerBindings,
  WorkflowParams
> {
  override async run(
    _event: WorkflowEvent<WorkflowParams>,
    step: WorkflowStep,
  ): Promise<{ graphVersion: string; backupKey: string | null }> {
    return step.do(
      'write-backup',
      { retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' } },
      async () => {
        const result = await runBackup(this.env);
        return {
          graphVersion: result.graphVersion,
          backupKey: result.backupKey,
        };
      },
    );
  }
}

async function runGraph(env: SchedulerBindings, trigger: string): Promise<unknown> {
  if (env.GRAPH_REFRESH_WORKFLOW) {
    const instance = await env.GRAPH_REFRESH_WORKFLOW.create({
      params: { trigger } satisfies WorkflowParams,
    });
    return { workflow: 'graph-refresh', id: instance.id };
  }
  const store = readModelStore(env);
  const orbitVersion = (await store.getText('ptr:orbit')) ?? 'o-unpublished';
  const csv = await store.getText(`orbits:${orbitVersion}`);
  const snapshot = buildPublicationSnapshot(csv, orbitVersion, new Date());
  if (await isUnchanged(env, snapshot)) {
    return { workflow: 'graph-refresh', changed: false, graphVersion: snapshot.graphVersion };
  }
  return publishSnapshot(env, snapshot, modeOf(env));
}

async function runBackupNow(env: SchedulerBindings, trigger: string): Promise<unknown> {
  if (env.BACKUP_WORKFLOW) {
    const instance = await env.BACKUP_WORKFLOW.create({
      params: { trigger } satisfies WorkflowParams,
    });
    return { workflow: 'backup', id: instance.id };
  }
  return runBackup(env);
}

function authorized(request: Request, env: SchedulerBindings): boolean {
  if (!env.ADMIN_TOKEN) {
    return false;
  }
  const header = request.headers.get('authorization') ?? '';
  return header === `Bearer ${env.ADMIN_TOKEN}`;
}

async function handleAdmin(
  request: Request,
  env: SchedulerBindings,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/health') {
    return Response.json({ status: 'ok', service: 'sategraph-scheduler' });
  }
  if (request.method !== 'POST') {
    return Response.json({ error: 'METHOD_NOT_ALLOWED' }, { status: 405 });
  }
  if (!authorized(request, env)) {
    return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }
  try {
    switch (url.pathname) {
      case '/run/orbit':
        return Response.json(await refreshOrbits(env));
      case '/run/graph':
        return Response.json(await runGraph(env, 'manual'));
      case '/run/backup':
        return Response.json(await runBackupNow(env, 'manual'));
      default:
        return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
    }
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'WORKFLOW_FAILED' },
      { status: 500 },
    );
  }
}

export default {
  async fetch(request: Request, env: SchedulerBindings): Promise<Response> {
    return handleAdmin(request, env);
  },

  async scheduled(
    controller: ScheduledController,
    env: SchedulerBindings,
    context: ExecutionContext,
  ): Promise<void> {
    context.waitUntil(
      (async () => {
        if (controller.cron === ORBIT_CRON) {
          await refreshOrbits(env);
          return;
        }
        if (controller.cron === GRAPH_CRON) {
          await runGraph(env, 'cron');
          return;
        }
        if (controller.cron === BACKUP_CRON) {
          await runBackupNow(env, 'cron');
        }
      })(),
    );
  },
};
