import {DurableObject, WorkerEntrypoint} from 'cloudflare:workers';

import {authorizeArchive} from './b2_archive.ts';
import {admit, readStatus, resume} from './coordinator.ts';
import {type Ports, runStage} from './pipeline.ts';

interface Env {
  COORDINATOR: DurableObjectNamespace<UpdateCoordinator>;
  CORE?: D1Database;
  PROJECTOR?: Ports['projector'];
  FACTS?: {commit: NonNullable<Ports['commitGp']>};
  B2_BUCKET_ID: string;
  B2_KEY_ID: string;
  B2_APP_KEY: string;
}

export class UpdateCoordinator extends DurableObject<Env> {
  start(cron: string, scheduledTime: number) {
    return admit(this.ctx.storage, cron, scheduledTime, Date.now());
  }
  status() {
    return readStatus(this.ctx.storage);
  }
  alarm() {
    const {CORE, PROJECTOR, B2_BUCKET_ID, B2_KEY_ID, B2_APP_KEY} = this.env;
    const facts = this.env.FACTS;
    if (!CORE || !PROJECTOR || !facts || !B2_BUCKET_ID || !B2_KEY_ID ||
        !B2_APP_KEY) {
      return resume(this.ctx.storage);
    }
    const ports: Ports = {
      db: CORE,
      commitGp: (w, c, bytes) => facts.commit(w, c, bytes),
      projector: PROJECTOR,
      archive: () => authorizeArchive(B2_BUCKET_ID, B2_KEY_ID, B2_APP_KEY)
    };
    return resume(
        this.ctx.storage, lease => runStage(ports, lease), Date.now,
        lease => runStage(ports, lease, true));
  }
}

function coordinator(env: Env) {
  return env.COORDINATOR.get(env.COORDINATOR.idFromName('daily-update'));
}

// Web 绑定这个只读入口，而不是协调器或默认定时入口。
export class StatusReader extends WorkerEntrypoint<Env> {
  status() {
    return coordinator(this.env).status();
  }
}

export default {
  async scheduled(event: ScheduledController, env: Env) {
    await coordinator(env).start(event.cron, event.scheduledTime);
  },
  fetch() {
    return new Response(null, {status: 404});
  },
} satisfies ExportedHandler<Env>;
