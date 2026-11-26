import {DurableObject, WorkerEntrypoint} from 'cloudflare:workers';

import {commitGpChunk} from '../sg-sync/gp_ingest.ts';

import {catalog} from './catalog.ts';

type Writer = {
  runId: string; epoch: number
};
interface Env {
  CORE: D1Database;
  DISPLAY_SOURCES?: string;
  COMMAND: DurableObjectNamespace<FactCommand>
}
export class CatalogReader extends WorkerEntrypoint<Env> {
  async fetch(req: Request) {
    if (req.method !== 'GET') {
      return new Response(null, {status: 405});
    }
    return catalog(this.env.CORE, this.env.DISPLAY_SOURCES, new URL(req.url));
  }
}
export class FactCommand extends DurableObject<Env> {
  commit(w: Writer, chunk: number, bytes: Uint8Array<ArrayBuffer>) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > 256 * 1024) {
      throw Error('INVALID_CHUNK');
    }
    return commitGpChunk(this.env.CORE, w, chunk, bytes);
  }
}
export class FactCommands extends WorkerEntrypoint<Env> {
  commit(w: Writer, chunk: number, bytes: Uint8Array<ArrayBuffer>) {
    return this.env.COMMAND.get(this.env.COMMAND.idFromName('gp-facts'))
        .commit(w, chunk, bytes);
  }
}
export default {fetch: () => new Response(null, {status: 404})};
