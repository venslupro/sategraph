# satgraph
卫星知识图谱

SatGraph is a public satellite knowledge graph. It fuses catalog metadata,
orbital elements, constellation structure and modeled links into one browsable
graph, and pairs a 3D globe with a grounded assistant. The project keeps the
original positioning: 卫星知识图谱 (satellite knowledge graph).

## What it does

- **3D globe** – every tracked object is propagated in the browser with SGP4.
- **Knowledge graph** – satellites, constellations, planes, slots, launches,
  operators, buses, relays and modeled inter-satellite links.
- **Three confidence levels** – `DECLARED`, `DERIVED` and `MODELED`, rendered
  with solid, dashed and dash-dot lines.
- **Versioned read models** – orbital data and graph structure have separate
  versions, so caches never mix epochs.
- **Grounded assistant** – answers are built from tool results and every numeric
  claim is checked against the retrieved evidence.

## Architecture

Domain-driven design with a hexagonal dependency rule: `domain` depends on
nothing, `application` orchestrates use cases, `infrastructure` implements
adapters and `interfaces` expose HTTP and the web UI. Dependencies always point
inward.

Eight bounded contexts (not all are separate packages yet):

| Context | Responsibility |
| --- | --- |
| Ingestion | Source adapters, freshness/health, provenance |
| Catalog | Identity resolution and field-level merge policy |
| Orbit | OMM parsing, orbit summaries, TLE generation |
| Graph | Constellations, planes, slots and link rules |
| Publishing | Snapshots and versioned read models |
| Query | Read-model access, search, neighbourhoods |
| Visualization | Globe, layers, detail panel and dialogs |
| Assistant | Tool orchestration, grounding, SSE stream |

Design decisions worth knowing:

- **Compute stays close to the user.** Workers only move bytes; the browser runs
  SGP4 with `satellite.js` and derives display positions.
- **Storage is specialised.** KV holds orbit bundles and read models, D1 holds
  the search projection, events and agent runs, Neo4j is the graph store
  (nodes and relations), and Backblaze B2 keeps snapshots and backups. Cache
  API plus an in-memory LRU absorb repeated reads.
- **OMM replaces TLE at the edge.** `satellite.js` v5 has no `json2satrec`, so
  OMM records are converted to TLE lines before `twoline2satrec`.
- **The assistant always answers.** Workers AI is used when available, a BYOK
  OpenAI-compatible endpoint is optional, and a deterministic offline provider
  keeps local development and tests working.

## Repository layout

```
apps/
  api/            Hono + Zod application API (HTTP interface layer)
  scheduler/      Worker + Workflows for orbit/graph refresh and backups
  web/            React + three.js + Cytoscape front end
packages/
  shared-kernel/  Ids, time, geo math, confidence, result types
  contracts/      Shared read models and API schemas
  orbit/          OMM parsing, orbit summaries, TLE conversion
  catalog/        Satellite aggregate, matching and merge policy
  graph/          Relations, constellation clustering and link rules
  publishing/     Snapshot assembly and read-model keys
  ingestion/      Source adapters, health and Cypher import
  infra/          KV/D1/Neo4j/B2/LLM adapters, seed runtime, caches
db/migrations/    D1 schema and generated seed data
curation/         Human-curated relations (relays, dockings, formations)
functions/        Cloudflare Pages Functions entry point
scripts/          Build-time tooling (seed SQL generator)
```

## Requirements

- Node.js 20 or newer
- npm 10 or newer
- A Cloudflare account with Workers, Pages, D1, KV, Queues/Workflows and
  Workers AI available on the free plan (only needed for deployment)

## Local development

```bash
npm install
npm run dev
```

- Web UI: http://localhost:5173
- API: http://localhost:8787 (Vite proxies `/api` and `/health`)

The API starts in seed mode: `GRAPH_BACKEND=seed` and `AGENT_MODE=fake` are the
defaults when bindings are absent, so no Cloudflare resources are required for a
full UI walkthrough.

Useful commands:

```bash
npm run typecheck        # strict TypeScript across every workspace
npm test                 # unit, domain and API route tests
npm run build            # production web bundle in apps/web/dist
npm run db:setup:local   # D1 schema + seed rows in the local Miniflare database
```

### Optional environment overrides

Create `.dev.vars` for the API/scheduler when you want real adapters:

```dotenv
GRAPH_BACKEND=neo4j          # neo4j | d1 | seed
AGENT_MODE=workers-ai        # workers-ai | byok | fake
AI_MODEL=@cf/meta/llama-3.1-8b-instruct
NEO4J_HTTP_URL=https://your-instance.databases.neo4j.io
NEO4J_DATABASE=neo4j
NEO4J_USER=neo4j
NEO4J_PASSWORD=...
BYOK_BASE_URL=https://api.openai.com/v1
BYOK_API_KEY=...
BYOK_MODEL=gpt-4o-mini
TURNSTILE_SECRET=...
ADMIN_TOKEN=...              # protects the scheduler run endpoints
```

Secrets are never committed. Neo4j AuraDB is the graph store in production;
Backblaze B2 and a BYOK model are optional. Without Neo4j secrets the API
degrades to the bundled seed graph, while catalog search, events and read
models keep working from D1 and KV.

## Graph store (Neo4j)

Graph data — satellites, constellations, organizations, launches, buses and
all relations — lives in Neo4j, never in D1. The scheduler's graph-refresh
workflow MERGEs every snapshot into Neo4j tagged with its `graphVersion` and
deletes stale nodes and relationships afterwards, so a failed publication
leaves the previous version readable.

Point the platform at an AuraDB (or any Neo4j Query API v2 endpoint) with
secrets on both the Pages project and the scheduler worker:

```bash
npx wrangler pages secret put NEO4J_HTTP_URL --project-name satgraph
npx wrangler pages secret put NEO4J_USER --project-name satgraph
npx wrangler pages secret put NEO4J_PASSWORD --project-name satgraph
npx wrangler secret put NEO4J_HTTP_URL --config apps/scheduler/wrangler.toml
npx wrangler secret put NEO4J_USER --config apps/scheduler/wrangler.toml
npx wrangler secret put NEO4J_PASSWORD --config apps/scheduler/wrangler.toml
# NEO4J_DATABASE is optional and defaults to "neo4j".
```

## Database

`db/migrations/0001_init.sql` creates the D1 read projection:

- `satellite_search` – one row per satellite, including the full catalog entry
- `domain_event` – recent graph/ops events
- `agent_run` – assistant runs for auditing and shares
- `alert` – source health and data-quality alerts

`db/migrations/0002_seed.sql` is generated from the deterministic seed snapshot:

```bash
npm run db:seed:build    # regenerate the migration
npm run db:seed:local    # migrate locally and load the example data
```

The seed contains 310 satellites across GPS, BeiDou, Galileo, GLONASS, Iridium,
Starlink and OneWeb subsets, plus named satellites such as the ISS, Hubble,
Tiangong, Landsat and Sentinel. All records are synthetic demonstrations derived
from public catalog conventions, not an operational source of truth.

## API

All responses are `{ data, meta }` envelopes with `graphVersion`,
`orbitVersion`, `generatedAt`, cache status and source. ETags enable 304s.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness and mode summary |
| GET | `/api/v1/manifest` | Versions, counts, modes and source health |
| GET | `/api/v1/orbits` | OMM CSV for browser-side propagation |
| GET | `/api/v1/catalog` | Catalog entries for the globe and search |
| GET | `/api/v1/layers`, `/api/v1/layers/:id` | Layers and their membership |
| GET | `/api/v1/links` | Layer-scoped links with relay assignments |
| GET | `/api/v1/constellations`, `/api/v1/constellations/:id` | Constellation structure |
| GET | `/api/v1/satellites/:id` | Dossier: identity, orbit, relations, provenance |
| GET | `/api/v1/search?q=` | Search projection with ranking |
| GET | `/api/v1/graph/neighborhood?id=&depth=` | Bounded graph neighbourhood |
| GET | `/api/v1/graph/path?from=&to=` | Shortest relation path |
| GET | `/api/v1/events` | Recent domain events |
| GET | `/api/v1/sources` | Ingestion source health |
| GET | `/api/v1/history/snapshots` | Published snapshot history |
| POST | `/api/v1/agent/chat` | SSE answer stream with tool events |
| GET | `/api/v1/agent/share/:id` | Shared assistant conversation |

## Deployment (Cloudflare free plan)

There is a single production environment, and three pipelines in
`.github/workflows/` own the whole lifecycle:

| Pipeline | Trigger | Responsibility |
| --- | --- | --- |
| `ci.yml` | push and pull request on **any branch** | `npm ci`, typecheck, unit tests, web build |
| `terraform.yml` | `terraform/**` changes, or manual dispatch | plan runs anywhere; **apply only on `main`** in the `production` environment (D1 database, KV namespace) |
| `cd.yml` | after CI succeeds on `main`, or manual dispatch **from `main` only** | database initialization, backend worker deploy, frontend and Pages Functions deploy, all in the `production` environment |

Only the `main` branch can run `terraform apply` or deploy services; both are
gated by the `production` GitHub environment, and dispatches from other
branches skip those jobs entirely.

### Repository configuration

Secrets:

- `CLOUDFLARE_API_TOKEN` — token with D1 and KV edit rights.
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account ID.
- `R2_STATE_ACCESS_KEY_ID` / `R2_STATE_SECRET_ACCESS_KEY` — S3 keys for the
  Terraform state bucket.

Variables: `R2_STATE_BUCKET` and `R2_STATE_ENDPOINT`
(`https://<account id>.r2.cloudflarestorage.com`).

### Bootstrap (once)

1. Create the R2 bucket that stores Terraform state (Terraform cannot create
   the bucket that holds its own state).
2. Run the `terraform` pipeline; it applies the D1 database and the KV
   namespace. Outputs are printed in the job summary.
3. Add the optional runtime secrets:

   ```bash
   npx wrangler pages secret put NEO4J_PASSWORD --project-name satgraph
   npx wrangler pages secret put TURNSTILE_SECRET --project-name satgraph
   npx wrangler secret put ADMIN_TOKEN --config apps/scheduler/wrangler.toml
   ```

After that every merge to `main` goes CI → CD. The CD pipeline resolves the
D1 and KV identifiers from the Cloudflare API and injects them into both
`wrangler.toml` files, then applies the schema, seeds the database only when
it is empty, deploys the scheduler worker and finally the Pages site (static
assets plus `functions/api/[[path]].ts`).

Manual deploy is still possible with `npm run deploy` (Pages) and
`npm run deploy:scheduler` (worker) after filling the binding IDs.

The scheduler runs three crons: orbit refresh every 2 hours, graph publication
every 48 hours, and a weekly backup. It exposes `/health`, `POST /run/orbit`,
`POST /run/graph` and `POST /run/backup`, all protected by `ADMIN_TOKEN`. If a
Workflow binding is missing, the job runs inline.

## Testing

```bash
npm test
```

Coverage includes OMM parsing and TLE/SGP4 round-trips, orbit classification,
merge policy, constellation clustering, link rules, grounding checks and the
HTTP routes through `app.request`.

## Licenses and attribution

- Celestrak GP/SATCAT data: public domain, credit Celestrak.
- GCAT: CC BY 4.0 (when enabled).
- Wikidata: CC0.
- SatNOGS and GNSS status feeds: attribution required by their operators.
- Seed data in this repository is synthetic and provided for demonstration.
