# TAG: smallest practical implementation

Repository: `github.com/quality-sh/tag`. npm scope: `@quality-sh`. Both free as of today.

Date: 2026-10-23. Versions checked against npm the same day.

## Headline recommendations

1. **Do not invent a schema. Adopt CTRF 0.2.0** (Common Test Report Format) as the normalized contract. It already has versioning, stable `testId`, `runId`, suites, status, duration, attachments, environment (repo, branch, commit, build URL), and a namespaced `extra` object for framework metadata. Playwright, pytest, Jest, Cypress, .NET, Go and JUnit XML already have CTRF reporters or converters. The only adapter you must write is DeepEval.
2. **Skip DuckDB for the MVP.** Data volume is tiny. A run has hundreds of tests; a year is a few hundred thousand rows. Bun scans that from JSONL in milliseconds. `@duckdb/node-api` on Bun has segfault reports and breaks `bun build --compile`. Revisit when a trend query takes over a second, and then run the DuckDB CLI as a subprocess over Parquet rather than linking the N-API binding.
3. **JSON Render: yes, but on day 2 and time-boxed.** It is a fit: flat JSON spec, Zod-typed catalog, `$state` data binding, hand-written specs work without an LLM, and `@json-render/react-pdf` gives PDF from the same spec later. It is also 0.21.x with 200 releases since January, so pin it and keep it out of the schema package. Build the DeepEval view in plain React first; move it onto a catalog once the components exist.
4. **Effect 4.0.6 is stable (released 2026-10-22).** Use it for the server only. Adapters are pure functions `(files, context) => CtrfReport` with no Effect import.
5. **S3-compatible object storage from day one; SQLite for the query index.** Bun ships `Bun.S3Client`, which takes an endpoint, so MinIO, R2, Backblaze, GCS interop and AWS all work with one config change. Every report and artifact lives in one bucket and is the store of record. The index (runs, test history, trends) is Bun's built-in SQLite on the container volume, rebuilt from the bucket on boot. No Redis, no DynamoDB, no NoSQL: reports are immutable documents read by key, which is what object storage is for.
6. **Skip PDF, Excel, MCP and the GitHub webhook for the MVP.**

## 1. Libraries worth reusing

| Need | Library | Version | Notes |
|---|---|---|---|
| Normalized schema + types + validator | `ctrf` (TypeScript SDK) | 0.5.0 | Reference implementation. Types and JSON Schema validation. |
| Playwright → CTRF | `playwright-ctrf-json-reporter` | 0.2.0 | Add to the client repo's `playwright.config.ts`. Zero server-side adapter work. Also keep the HTML reporter for the artifact. |
| JUnit XML → CTRF | `junit-to-ctrf` | 0.1.0 | Server-side adapter for any JUnit producer. Fallback: `junit2json` 4.0.0 if its output is too lossy. |
| pytest → CTRF | `pytest-json-ctrf` | 0.3.x | Client-side plugin. Means pytest users never touch the JUnit path. |
| GitHub App auth | `@octokit/app` | 16.1.4 | Installation tokens, auto refresh. |
| GitHub REST | `@octokit/rest` | 22.0.1 | `actions.listWorkflowRunsForRepo`, `listWorkflowRunArtifacts`, `downloadArtifact` (returns a 302 to a signed zip URL). |
| Zip extraction | `fflate` | 0.8.x | Pure JS, streaming unzip. Bun has no built-in zip reader. |
| Server effects, HTTP, schema | `effect` | 4.0.6 | HTTP API, Schema, Layer, Config all in the one package in v4. |
| Object storage | `Bun.S3Client` | built in | S3-compatible: endpoint, bucket, credentials from env. |
| Query index | `bun:sqlite` | built in | Embedded, synchronous, zero dependencies. |
| Declarative UI | `@json-render/core`, `@json-render/react` | 0.21.1 | Day 2, pinned. |
| Charts | `recharts` or `uplot` | current | Line and bar only. |

Not reused: Allure (heavy, Java, its own format), ReportPortal (full platform), Playwright's own merge-reports (only merges Playwright).

## 2. Evaluations

### JSON Render

What it is: a catalog of components declared with Zod prop schemas, a registry binding them to React components, and a renderer that takes a flat spec `{ root, elements: { id: { type, props, children } } }`. Props can read data with `{ "$state": "/path" }`, templates, conditions and computed functions. Renderer targets include React, Vue, Svelte, React PDF, email and image.

Fit to the brief:

- Deterministic, no model at runtime. Specs are plain JSON literals.
- Separation the brief asks for maps one to one: adapters produce data, specs describe layout, the catalog is the component set, renderers are react and react-pdf.
- An adapter can ship a spec file next to its parser. A contributor writes JSON, not React.
- The future "LLM writes the spec" feature is the project's primary design goal, so it will stay supported.

Risks:

- Pre-1.0. Pin exact versions. Keep the spec type in the web package, never in the schema package.
- The 36 shadcn components are a web-app kit, not a reporting kit. You will write your own catalog of about eight components: Heading, Text, MetricTile, StatRow, Table, LineChart, BarChart, Section.
- The PDF renderer cannot reuse chart components without an SVG path. Defer.

TAG: suitable. Build plain React first, extract to a catalog on day 2 afternoon in a two-hour box. If it slips, it is the first follow-up.

### DuckDB

Fit: excellent query engine for JSONL and Parquet on object storage. Would answer every trend query in the brief with SQL.

Why not now:

- `@duckdb/node-api` 2.0.0-r.1 was published two days ago. The 1.4 LTS line is the safe one.
- Bun users report intermittent segfaults with the neo binding, and the native `.so` cannot be embedded by `bun build --compile`.
- The data is small. Filter and group over a few hundred thousand JSONL rows in Bun takes tens of milliseconds. Hold the index in memory, rebuild it from JSONL on boot.

Trigger to adopt: a trend query over one second, or a request for ad hoc SQL. Adoption path: write Parquet per month, run the `duckdb` CLI binary as a subprocess with `read_parquet('s3://...')`. No N-API, no bundling issue, and the query interface stays the same.

## 3. Normalized schema

Use CTRF 0.2.0 as published. Do not fork it. Add two namespaced conventions inside `extra` and document them in `docs/schema.md`.

### What CTRF gives you

- Root: `reportFormat: "CTRF"`, `specVersion`, `reportId`, `runId`, `timestamp`, `generatedBy`, `results`.
- `results.tool`: `{ name, version }`.
- `results.summary`: `tests, passed, failed, skipped, pending, other, start, stop, duration, flaky`.
- `results.environment`: `repositoryName, repositoryUrl, branchName, commit, buildId, buildNumber, buildUrl, testEnvironment, shardId`.
- `results.tests[]`: `name, status (passed|failed|skipped|pending|other), duration, testId, suite[], filePath, line, message, trace, retries, flaky, tags, labels, parameters, attachments[] { name, contentType, path }, steps[], extra`.
- Unknown fields are forbidden outside `extra`, so validation with the `ctrf` SDK stays strict.

### Convention 1: `extra["tag.metrics"]` on a test

Framework-agnostic numeric metrics so trends work for any adapter, not just DeepEval.

```json
{
  "name": "answer_relevancy",
  "value": 0.83,
  "threshold": 0.7,
  "comparator": ">=",
  "passed": true,
  "unit": null,
  "reason": "The output addresses ..."
}
```

### Convention 2: `extra["tag.artifacts"]` on `results`

References to original artifacts the dashboard should link or embed.

```json
{ "kind": "playwright-html", "name": "playwright-report", "path": "playwright-report/index.html" }
```

`kind` is an open string. The MVP knows `playwright-html`, `deepeval-json`, `junit-xml`, `file`.

### DeepEval mapping

Source: `.deepeval/.latest_test_run.json` (`{ "testRunData": TestRun }`) or a `test_run_*.json` from `DEEPEVAL_RESULTS_FOLDER`. Keys are camelCase, `None` fields omitted.

| DeepEval | CTRF |
|---|---|
| `testRunData.testFile` | `tests[].filePath` |
| `testCases[].name` | `tests[].name` |
| `testCases[].success` | `status: passed` / `failed` |
| `testCases[].runDuration` (s) | `duration` (ms) |
| `testCases[].metricsData[]` `{ name, score, threshold, success, reason, evaluationModel, error }` | `extra["tag.metrics"][]` and the full array under `extra["deepeval.metricsData"]` |
| `testCases[].input / actualOutput / expectedOutput / retrievalContext` | `extra["deepeval.io"]` |
| `testCases[].tags` | `tags` |
| `hyperparameters`, `evaluationCost`, `datasetAlias` | `results.extra["deepeval"]` |
| `metricsScores[]` | `results.extra["deepeval.metricsScores"]` |

Verify `metricsData` field names against the installed DeepEval version before coding; the model lives in `deepeval/tracing/api.py` and has moved before.

### Stable test identity

`testId = sha1(tool.name + "\n" + filePath + "\n" + suite.join("/") + "\n" + name + "\n" + canonical(parameters))`, truncated to 16 hex chars. Computed by the ingester when the adapter does not set it. Playwright's reporter sets its own; keep it when present.

### What the ingester persists

The bucket is the store of record. SQLite is a derived index that can be dropped and rebuilt.

- Bucket `reports/<owner>/<repo>/<reportId>.ctrf.json`: the validated report, as received. Immutable.
- SQLite `runs`: one row per report. `report_id, run_id, owner, repo, tool, branch, commit, build_url, timestamp, tests, passed, failed, skipped, flaky, duration, artifact_id`.
- SQLite `tests`: one row per test per report. `report_id, test_id, name, status, duration, file_path, suite, flaky, message`.
- SQLite `metrics`: one row per `tag.metrics` entry. `report_id, test_id, name, value, threshold, passed`.
- SQLite `artifacts`: `artifact_id, owner, repo, run_id, name, size, github_expires_at, cached_at, state (listed|cached|expired)`.

Idempotency: the key is `reportId` when present, else `sha1(runId + tool.name + shardId)`. An ingest of a seen key is a no-op. On boot, if the SQLite file is missing, list `reports/` and re-index.

## 4. Interfaces

Four small interfaces. Everything in the brief is an implementation of one of them.

### Adapter (pure, no Effect, any language via the file contract)

```ts
export interface AdapterInput {
  files: FileRef[];                 // extracted artifact contents
  context: RunContext;              // repo, branch, commit, runId, buildUrl, artifactName
}
export interface FileRef {
  path: string;                     // relative, posix
  size: number;
  text(): Promise<string>;
  bytes(): Promise<Uint8Array>;
}
export interface Adapter {
  name: string;                     // "deepeval"
  version: string;
  detect(paths: string[]): boolean; // cheap: could any file hold this format? parse() decides by content
  parse(input: AdapterInput): Promise<CtrfReport>;
}
```

The cross-language contract is simpler than an interface: **emit a `*.ctrf.json` file in your artifact and no adapter runs at all.** The `ctrf` adapter is the identity. Server-side adapters exist only for tools that cannot emit CTRF themselves.

Dispatch order: `ctrf` → `playwright` → `deepeval` → `junit`. First `detect` wins per artifact; one artifact can yield several reports if several adapters detect.

### ArtifactSource

```ts
export interface ArtifactSource {
  listRuns(repo: RepoRef, opts: { branch?: string; since?: Date; limit: number }): Effect<RunMeta[]>;
  listArtifacts(repo: RepoRef, runId: string): Effect<ArtifactMeta[]>;   // name, id, sizeBytes, expiresAt
  openArtifact(repo: RepoRef, artifactId: string): Effect<ReadableStream<Uint8Array>>; // zip bytes
}
```

Implementations: `FixtureSource` (reads `fixtures/<owner>/<repo>/<runId>/<artifact>/`), `GitHubSource` (Octokit with an installation token; `downloadArtifact` follows the 302 to the signed URL and streams).

### ArtifactStore

```ts
export interface ArtifactStore {
  has(key: string): Effect<boolean>;
  put(key: string, body: ReadableStream<Uint8Array> | Uint8Array, contentType: string): Effect<void>;
  get(key: string): Effect<{ body: ReadableStream<Uint8Array>; contentType: string } | null>;
  list(prefix: string): Effect<string[]>;
}
```

Implementations: `S3Store` (`Bun.S3Client`, the default), `FsStore` (tests and local dev). Keys: `artifacts/<owner>/<repo>/<artifactId>/<path>` for extracted files, `reports/...` as above. One bucket holds both; the brief's "optional permanent storage" is a lifecycle rule, not a second system.

### ResultStore

```ts
export interface ResultStore {
  ingest(report: CtrfReport, origin: { artifactId?: string }): Effect<{ inserted: boolean }>;
  listRuns(filter: RunFilter): Effect<RunRow[]>;
  getReport(reportId: string): Effect<CtrfReport | null>;
  testHistory(repo: RepoRef, testId: string, limit: number): Effect<TestRow[]>;
  trends(filter: RunFilter, series: "passRate" | "duration" | { metric: string }): Effect<Point[]>;
  compare(a: string, b: string): Effect<Diff>;
}
```

One implementation for the MVP: `SqliteResultStore` over `bun:sqlite`, writing the raw report to `ArtifactStore` first and the index rows second. A DuckDB or Postgres implementation can replace it later with no caller change.

### Ingest pipeline (one Effect program)

```
for run in source.listRuns(repo):
  for artifact in source.listArtifacts(run):
    if store.has(artifacts/.../<id>/.complete): skip
    unzip(source.openArtifact(id)) -> store.put per file   // reject paths with ".." or absolute (zip slip), cap total size
    store.put(.complete)
  files = store.list(artifacts/.../<id>/)
  for adapter in adapters where adapter.detect(paths):
    report = adapter.parse({files, context(run)})
    validate(report)            // ctrf SDK
    results.ingest(report)
```

Triggered three ways: on boot for recent runs, on a `POST /ingest/:owner/:repo` from the UI, and later by a `workflow_run.completed` webhook. Polling is enough for the weekend.

### Storage and caching model

GitHub is the source of truth for as long as it retains an artifact (90 days by default, configurable per repository). The bucket is the long-term store.

- **Small result files are copied at ingest.** CTRF, DeepEval and JUnit files are fetched, parsed and written to `reports/` as soon as a run is discovered. This is what survives expiry.
- **Large artifacts are copied at ingest by default.** A Playwright report with traces can run to hundreds of megabytes, but storage is cheap and a lazy cache loses anything nobody opened in 90 days. Per-artifact-name-pattern setting: `copy` (default) or `on-view`.
- **Serving reads the bucket only.** On a miss, fetch from GitHub, extract to `artifacts/`, mark `.complete`, serve. If GitHub says expired and the bucket has nothing, the UI says "original artifact expired" and still shows the normalized results.
- **Expiry is recorded.** `artifacts.github_expires_at` comes from the GitHub API; the UI shows "original expires in N days" or "archived".
- **Tiering is a lifecycle rule, not a second bucket.** Transition `artifacts/` to a cheaper class after 30 days and expire it after a configured age. `reports/` stays in the standard class forever; it is tiny. Lifecycle rules exist on S3, GCS and MinIO, and partly on R2. Storage class names differ per provider, so they are config values.
- **Presigned URLs are optional.** They let viewers download trace zips straight from the bucket and save server bandwidth, at the cost of origin and CSP control. Proxy HTML; consider presigned for large zips later.
- **Redis is not needed.** Locks, the ingest queue and the installation-token cache live in process on a single instance. Add Redis only when scaling out.

Bucket layout:

```
reports/<owner>/<repo>/<reportId>.ctrf.json
artifacts/<owner>/<repo>/<artifactId>/<path...>
artifacts/<owner>/<repo>/<artifactId>/.complete
```

### Serving artifacts to viewers without GitHub access

- `GET /a/:owner/:repo/:artifactId/*path` reads from the store and streams the file with the right content type. The GitHub token never leaves the server; the signed GitHub URL is never returned to a browser.
- Auth for the MVP: one shared password set by env var, exchanged for an `HttpOnly; Secure; SameSite=Strict` session cookie. Swap for OIDC later; the check is one middleware.
- Playwright's HTML report is a self-contained app that runs scripts. Serve artifact files from a **separate origin** (`reports.example.com` or a second port) so a hostile artifact cannot read the dashboard's cookie, and send `Content-Security-Policy: default-src 'self'; connect-src 'self'` plus `X-Content-Type-Options: nosniff`. The dashboard embeds reports in a sandboxed `iframe`.
- Expiry: store `expiresAt` from GitHub on the artifact index. When cached, serve past expiry. When not cached and expired, show "artifact expired; normalized results retained".

### GitHub App

Permissions: Actions read, Metadata read. Optional subscription: `workflow_run`. Config via env: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID`, repos list. The App mints an installation token per request through `@octokit/app`, which caches and refreshes it.

## 5. Repository structure

One Bun workspace, three packages. Fewer would mix Effect into adapters; more is premature.

```
tag/
  package.json                # bun workspaces, scripts; packages publish as @quality-sh/tag-schema, -adapters, -app
  bunfig.toml
  packages/
    schema/                   # CTRF re-export, the two `tag.*` conventions, Zod schemas, testId helper. No Effect.
      src/index.ts
      docs/schema.md          # the public contract
    adapters/                 # pure functions. One file per adapter + fixture tests.
      src/ctrf.ts
      src/playwright.ts       # Playwright JSON reporter -> CTRF (fallback when the CTRF reporter is absent)
      src/deepeval.ts
      src/junit.ts            # wraps junit-to-ctrf
      src/index.ts            # registry + detect dispatch
      test/*.test.ts          # bun test, fixtures in ../../fixtures
    app/
      src/server/             # Effect: layers for ArtifactSource, ArtifactStore, ResultStore, Ingest, HttpApi
      src/web/                # React. Bun HTML imports, no Vite. Pages: Runs, Run, Test history, Trends, Report viewer.
      src/index.ts            # Bun.serve: API + static web + artifact origin
  fixtures/
    acme/widgets/<runId>/playwright-report/...
    acme/widgets/<runId>/deepeval/.latest_test_run.json
    acme/widgets/<runId>/junit/results.xml
  docs/
    adapters.md               # how to add one, in any language: "emit CTRF"
    deploy.md                 # single container, S3 env vars, sample lifecycle rule
  docker-compose.yml          # MinIO for local dev
  .github/workflows/ci.yml
  LICENSE                     # MIT or Apache-2.0
```

Bun HTML imports (`Bun.serve({ routes: { "/": index.html } })`) bundle React with no extra toolchain. If hot reload or plugin needs appear, add Vite then.

## 6. Implementation plan: two days

Each step ends with something runnable. Order is a vertical slice first, GitHub second.

### Day 1: fixtures to dashboard

| # | Hours | Step | Done when |
|---|---|---|---|
| 1 | 0.5 | Workspace, three packages, `bun test`, CI | `bun test` green on an empty suite. |
| 2 | 0.5 | Fixtures: one real DeepEval `.latest_test_run.json`, one real `playwright-report/` plus `ctrf` JSON, one JUnit XML | Files committed. |
| 3 | 1 | `schema`: re-export `ctrf` types, Zod for `tag.metrics` and `tag.artifacts`, `testId()` | Unit tests. |
| 4 | 2 | `adapters`: `ctrf` (identity+validate), `deepeval`, `junit`, `playwright` JSON fallback | Each fixture parses to a valid CTRF report; snapshot tests. |
| 5 | 1.5 | `S3Store` against local MinIO (docker compose), `FsStore` for tests, `FixtureSource`, unzip with zip-slip guard | Ingest from fixtures writes `reports/` and `artifacts/` to MinIO. |
| 6 | 1 | `SqliteResultStore`: schema, ingest, listRuns, getReport, testHistory, rebuild from bucket | Tests; idempotent re-ingest; delete the db file and it rebuilds. |
| 7 | 1 | HTTP API: `/api/runs`, `/api/runs/:id`, `/api/tests/:testId/history`, `/a/...` artifact serving | curl works. |
| 8 | 2 | Web: Runs list, Run page (summary, tests table, failures with message), DeepEval metrics panel (score vs threshold, reason), Playwright report link opening in sandboxed iframe | Open a browser, click from run to report. |

End of day 1: the success criterion holds against fixtures.

### Day 2: GitHub and trends

| # | Hours | Step | Done when |
|---|---|---|---|
| 9 | 2 | `GitHubSource` with `@octokit/app`, `listRuns`, `listArtifacts`, streamed `downloadArtifact` | Ingest a real repo's last 20 runs. |
| 10 | 0.5 | Shared-password auth middleware, separate artifact origin, CSP | Reports open while logged in; 401 otherwise. |
| 11 | 1 | `trends()`: pass rate, duration p50, per-metric mean over time; `compare(a, b)` | API returns series. |
| 12 | 1.5 | Trends page: three line charts with branch and date filters; test history page | Charts render from real data. |
| 13 | 1 | Boot-time ingest of recent runs, `POST /ingest` button, README, `docs/adapters.md`, `docs/deploy.md` with a sample lifecycle rule, Dockerfile | `docker run` with S3 env vars works. |
| 14 | 2 (box) | JSON Render: catalog of eight components, DeepEval run page spec, renderer | Same page via spec. Drop if over time. |

### Client-repo changes (ten minutes each)

- Playwright config: add `['playwright-ctrf-json-reporter', { outputDir: 'playwright-report' }]` alongside `html`; upload `playwright-report/` as an artifact.
- DeepEval job: set `DEEPEVAL_RESULTS_FOLDER=deepeval-results`, upload that directory. Give each parallel job its own folder; DeepEval's temp file is not safe across shards.
- pytest jobs: `pip install pytest-json-ctrf`, `--ctrf results.ctrf.json`, upload.

### Deferred, in priority order

1. JSON Render catalog if cut from day 2.
2. `workflow_run` webhook.
3. OIDC login (Auth.js or WorkOS).
4. Excel export (`exceljs`, from the SQLite `tests` table), PDF (`@json-render/react-pdf` over the same specs).
5. Presigned URLs for large trace zips.
6. DuckDB CLI over Parquet, or Postgres, when SQLite on one volume is not enough.
7. OpenAPI from the Effect HttpApi, MCP server.

## Things in the brief to push back on

- **"Lazily cache" artifacts.** Lazy loses anything nobody viewed in 90 days. Copy at ingest by default; lazy is a per-pattern option.
- **A second store for cold data.** One bucket with prefixes and a lifecycle rule does the same job with no second system.
- **Redis or a NoSQL store for reports.** Reports are immutable documents read by key, which is object storage. The index needs SQL, which is SQLite.
- **"Explore DuckDB" and "consider Parquet".** Explored above. Not for the MVP. Keep `ResultStore` so they slot in.
- **A custom normalized schema.** CTRF exists, is versioned, has the `extra` escape hatch, and has the reporters. Writing your own loses the ecosystem and gains nothing.
- **Adapters as a plugin system.** The contract is a file in the artifact. Server adapters are a short list in one file. Do not build a loader.
- **Presentation specs from adapters.** Keep the hook (an adapter may return `{ report, spec? }`) but do not use it until JSON Render lands.

## Day 1 status and deviations (2026-10-23)

Day 1 is built and verified end to end on fixtures. Where the build departed from the plan above:

- **Effect Schema, not Zod.** The whole stack is Effect v4, so the CTRF schema, validation and JSON Schema output use `effect/Schema`. The official `ctrf` npm package is a dev dependency used only to cross-check our output in tests.
- **fast-xml-parser, not junit-to-ctrf.** A 60-line converter over fast-xml-parser gives us testId stability and `extra` conventions directly, without a second opinion on shape.
- **RustFS, not MinIO, for local S3.** MinIO's images are no longer pullable from Docker Hub or quay. RustFS is S3-compatible and runs from `docker compose up`.
- **Deterministic ids.** `testId` = sha1(tool, filePath, suite, name, params)[:16]; `reportId` is a UUID v5-style digest of (runId, tool, shard, start) so re-ingest is idempotent and the official validator accepts it.
- **Two origins.** Cached artifacts (Playwright HTML, traces) are served from a second port with its own cookie, a 60-second signed hand-off from the dashboard, and a strict CSP. The dashboard embeds them in a sandboxed iframe.
- **Web UI in the quality-sh design language.** The dashboard follows hyp.dev and provenance.sh: black canvas, Cormorant Garamond light for display and prose, Fragment Mono for tracked labels and ids, the Aether Rose palette, hairlines rather than filled cards. Numerals are lining and tabular everywhere, so figures sit on the baseline and align in columns.
- **`packages/ui` is the design language as components.** Pages compose `Head`, `Section`, `Lead`, `Rows`, `Big`, `Stats`, `Bars`, `Meter`, `Table`, `Plot` and the rest; no page carries its own styles.
- **StyleX, not plain CSS.** As in provenance-web: tokens in `theme.stylex.ts` (`defineVars`/`defineConsts`), styles co-located with each component, one small `global.css` for the fonts, reset and selection. Vite builds the bundle with `@stylexjs/unplugin` and `@vitejs/plugin-react`; the server serves `packages/app/dist`.
- **Effect atoms for client state.** `effect/reactivity/Atom` with `@effect/atom-react`: the API is a `Context.Service` behind `Atom.runtime`, each page reads `Atom.family` atoms, mutations are `runtime.fn` with reactivity keys, so a login or an ingest refreshes exactly the atoms that depend on it.
- **Hyperstition's rules.** ESLint with the shared `effect` and `architecture` rule packs, Prettier at 100 columns, knip, the Effect language-service diagnostics, `bun audit`, changed-line coverage at 80 %, and the same CI matrix. `bun run check` is green.

- **Groupings, not a runs list, as the home page.** Runs are grouped by a field and filtered by a query, in a time range. The group-bys are release (GitHub releases and tags: the verdict is the run at the tagged commit, the trend is every run since the previous tag, runs on the target branch after the last tag are "unreleased"), branch (compared with the default branch), pull request (compared with its base), environment (CTRF `testEnvironment`), tag (`tag.tags` in `results.extra`, set at upload), tool, workflow (CTRF `buildName`), repository, day and run. The model is one pure module, `packages/app/src/grouping.ts`, shared by the server and the web app; `computeGroups` runs over the whole index on each request, which is fine until the index is far larger than a year of a busy org's runs.
- **Search as filter.** The query grammar is `field:value`, `field:a,b`, `-field:value`, `field:>n`, and bare words for text; it lives in the URL (`#/g/release?q=repo:acme/widgets failed:>0`). The bar suggests fields, then values with counts, from `GET /api/fields`. Applied filters show as chips at the right of the bar.
- **Scopes, not views, are what you open.** A page is about an org (`#/org/acme`), a repository (`#/r/acme/widgets`) or a collection (`#/c/payments`). Each scope page has the same shape: the state of every repository in it (the overview's strip and recent runs), the filter bar, then every view as a section in reading order (releases, branches, pull requests, environments, tags, tools, workflows, days), each fetched from `GET /api/groups` when it scrolls within a screen of the viewport and showing its newest eight rows with a link to the full table. The rail lists orgs with their repositories, the collections, and the sections of the page. A scope is a query prefix (`org:acme`, `repo:acme/widgets`) or, for a collection, its saved query, which the server prepends when a request names the collection by `c`. The full-table view pages (`#/g/:by`) and the group pages stay as the drill-in.
- **Collections are saved queries.** A collection is a name, a description and a query, stored in SQLite and created from the collections page or `POST /api/collections`. It no longer carries a group-by: every view is on its page. Refs (releases, tags, pull requests, deployments) come from the artifact source; the fixtures source reads `fixtures/<owner>/<repo>/refs.json`, the GitHub source reads the GitHub API.
- **Reports take the run's time.** Every adapter stamps a report with the CI run's timestamp when the source knows it, so the reports of one run agree on when it ran and land in the same release and day. The tool's own start and stop stay in `summary`.

- **GitHub without Octokit.** `GitHubSource` (`packages/app/src/server/github-source.ts`) talks to the REST API through the Effect HttpClient: `retryTransient` for 429s and 5xx, every response decoded with a Schema at the boundary, `per_page=100` paging. Auth is a GitHub App (the App JWT is signed with `node:crypto`, the installation token is cached for 50 minutes with `Effect.cachedWithTTL`) or a plain `GITHUB_TOKEN`; `GITHUB_REPOS` lists repositories, and an App with no list takes every repository it is installed on. Workflow runs become `RunMeta` (the workflow name, `head_branch`, `head_sha`, `run_started_at`, the event as the tag `event:push`); the artifact zip is fetched by reading the 302 by hand so the token never crosses to the blob origin. Refs: releases (commit from the tags list, drafts skipped), tags without a release, pull requests (`#n`, head branch and sha, `base`, `author`, `closedAt`, `mergedAt`), and the newest deployment per environment. `SOURCE` defaults to `github` once either credential is set. Octokit would have added two packages for the same six calls.
- **Installing the App is a link, not a form.** With `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_APP_SLUG` set, the dashboard shows "install on GitHub" beside the sign-out control, and `GET /api/install` sends the admin to `https://github.com/apps/<slug>/installations/new` with a ten-minute signed `state`. GitHub redirects back to `GET /api/install/callback?installation_id=…&state=…` — a top-level navigation, so the `SameSite=Lax` session cookie rides along and `requireSession` still guards the route, with the signed `state` as the anti-forgery check. The callback records the installation id (a `settings` row in the SQLite index, and a live ref the source rereads on every token mint, so no restart) and forks a backfill pass before redirecting to the dashboard. Token mode stays the self-hosted and local path: a `GITHUB_TOKEN` and `GITHUB_REPOS`, no install link.
- **Retention is a sweep, not only a lifecycle rule.** `ARTIFACT_RETENTION_DAYS` (default 90, 0 off): on boot and every six hours, `Retention.sweep` removes the cached files of artifacts whose newest report is older than the window and sets the index row back to `listed` (or `expired` when the source has expired it too). Reports are never swept. A later view fetches the artifact again from the source when it still exists. `POST /api/retention/sweep` runs it by hand. A bucket lifecycle rule on `artifacts/` remains the cheap belt-and-braces for very large stores.
- **Tests over time on the group page.** Below the strip, a `Plot` of the test count per run in the group, oldest first, with runs that had failures marked; the note says how the count moved since the first run in the range.
- **JSON Render spike: built our own, did not adopt the package.** `packages/app/src/web/render.tsx` is a flat JSON spec (`root`, `elements` keyed by id, each with `type`, `props`, `children`, and `each` to repeat children over a list) over a nine-component catalog from `packages/ui` (section, figures, facts, rows, row, stack, meter, message, fields), validated with Effect Schema; props bind to page data with `{ "$": "path" }`. The DeepEval view of a report (`deepeval.tsx`) is now a static spec plus a data shaper, rendered through it; the hand-written React went away. Verdict on `@json-render`: the fit is real (flat spec, catalog, bindings) but the renderer we need is 150 lines, it already uses our components and our schema library, and the package is still at 0.21.x with weekly breaking releases. Revisit it when specs start coming from a model rather than from code.
