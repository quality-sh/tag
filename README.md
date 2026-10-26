# TAG

TAG (test aggregator GUI) collects the test reports that CI already produces.
It turns CTRF, JUnit, Playwright and DeepEval reports into one dashboard with history.

## Run locally

Install Bun, then install the workspace:

```sh
bun install
```

For a local S3-compatible store, start RustFS and its bucket setup:

```sh
docker compose up -d
```

Set these values in `.env` to use that store:

```dotenv
S3_ENDPOINT=http://localhost:9000
S3_BUCKET=tag
S3_ACCESS_KEY_ID=tag
S3_SECRET_ACCESS_KEY=tagdev
S3_REGION=us-east-1
SOURCE=fixtures
```

Without `S3_BUCKET`, TAG stores files under `.data/store` instead.
Build the dashboard once, then run the server with file watching:

```sh
bun run build:web
bun run dev
```

Rebuild the web bundle after web changes. To build and serve in one command:

```sh
bun run start
```

Open <http://localhost:3000>. Artifacts use port 3001.
Without GitHub credentials, the source defaults to the checked-in fixtures.
See `.env.example` for GitHub settings. Omit optional settings you do not use;
an empty value is not always the same as an unset variable.

## Checks

```sh
bun run check
```

This runs type checks, Effect diagnostics, lint, format checks, knip, the file-length
check and tests. The S3 test skips if RustFS is not reachable on port 9000.

## Packages

- `packages/schema`: CTRF schemas, TAG extras and stable ids.
- `packages/adapters`: CTRF, JUnit, Playwright and DeepEval readers.
- `packages/app`: ingest, stores, HTTP servers and the React dashboard.
- `packages/ui`: shared components, styles and tokens.

See [deployment](docs/deploy.md) for configuration, storage and Docker.
See [adapters](docs/adapters.md) for report formats and client-repository changes.
