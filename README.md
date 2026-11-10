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
  the search projection, events and agent runs, Neo4j is the optional graph
  backend, and Backblaze B2 keeps snapshots and backups. Cache API plus an
  in-memory LRU absorb repeated reads.
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

Secrets are never committed. Neo4j AuraDB, Backblaze B2 and a BYOK model are all
optional; the platform degrades to D1, KV and the offline assistant.

## Database

`db/migrations/0001_init.sql` creates the D1 read projection:

- `satellite_search` – one row per satellite, including the full catalog entry
- `relation_edge` – one row per relation, keyed by type and endpoints
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

There is a single production environment. Data resources (D1, KV) are
provisioned with Terraform; the scheduler Worker and the Pages site are
deployed by the CD pipeline with wrangler.

1. Provision the data resources with Terraform:

   ```bash
   export CLOUDFLARE_API_TOKEN=...   # token with D1 + KV edit rights
   terraform -chdir=terraform init
   terraform -chdir=terraform apply -var="cloudflare_account_id=<account id>"
   terraform -chdir=terraform output
   ```

2. Paste `d1_database_id` and `kv_namespace_id` into `wrangler.toml` and
   `apps/scheduler/wrangler.toml` (both are marked with `# terraform output`).

3. Seed the remote database once:

   ```bash
   npm run db:seed:remote
   ```

4. Add optional secrets:

   ```bash
   npx wrangler pages secret put NEO4J_PASSWORD --project-name satgraph
   npx wrangler pages secret put TURNSTILE_SECRET --project-name satgraph
   npx wrangler secret put ADMIN_TOKEN --config apps/scheduler/wrangler.toml
   ```

5. Pipelines (`.github/workflows/`):
   - `ci.yml` runs on every push and pull request: install, typecheck, unit
     tests and the web build.
   - `cd.yml` deploys to production after CI succeeds on `main`: D1
     migrations, `wrangler deploy` for the scheduler worker and
     `wrangler pages deploy` for the site. It needs the
     `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets.

   Manual deploy is still possible with `npm run deploy` (Pages) and
   `npm run deploy:scheduler` (worker).

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
