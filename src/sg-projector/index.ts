import {WorkerEntrypoint} from 'cloudflare:workers';

import {projectAt} from './advance.ts';
import type {Writer} from './chunk.ts';
import {graphPort} from './graph.ts';
import {snapshot} from './journal.ts';

interface Env {
  CORE: D1Database;
  GRAPH_ORIGIN: string;
  GRAPH_DATABASE: string;
  GRAPH_INSTANCE: string;
  GRAPH_AUTH: string;
}

export class ProjectionWriter extends WorkerEntrypoint<Env> {
  async cursor(writer: Writer) {
    return (await snapshot(this.env.CORE, writer, this.env.GRAPH_INSTANCE))
        .base.cursor;
  }
  advance(writer: Writer, cursor: number, recoverOnly: boolean) {
    const {CORE, GRAPH_ORIGIN, GRAPH_DATABASE, GRAPH_AUTH, GRAPH_INSTANCE} =
        this.env;
    const graph =
        graphPort(GRAPH_ORIGIN, GRAPH_DATABASE, GRAPH_AUTH, GRAPH_INSTANCE);
    return projectAt(CORE, graph, writer, GRAPH_INSTANCE, cursor, recoverOnly);
  }
}

export default {
  fetch: () => new Response(null, {status: 404})
} satisfies ExportedHandler<Env>;
