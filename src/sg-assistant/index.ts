import {WorkerEntrypoint} from 'cloudflare:workers';

import {assistantRequest, type Env} from './assistant.ts';

export class AssistantReader extends WorkerEntrypoint<Env> {
  fetch(request: Request) {
    return assistantRequest(request, this.env);
  }
}
export default {fetch: () => new Response(null, {status: 404})};
