import {WorkerEntrypoint} from 'cloudflare:workers';

import {type GraphEnv, graphRequest} from './query.ts';

export class GraphReader extends WorkerEntrypoint<GraphEnv> {
  fetch(request: Request) {
    return graphRequest(request, this.env);
  }
}
export default {fetch: () => new Response(null, {status: 404})};
