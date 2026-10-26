# Deploy TAG

TAG runs a dashboard and an artifact server in one Bun process.
It keeps the index in SQLite and report files in a filesystem directory or an
S3-compatible bucket.

## Configuration

These are all the variables read by `packages/app/src/server/config.ts`.
Defaults apply when a variable is absent. Omit unused optional variables rather
than setting them to empty strings.

| Variable | Default | Use |
| --- | --- | --- |
| `DATA_DIR` | `.data` | Local data directory. |
| `SQLITE_PATH` | `${DATA_DIR}/tag.sqlite` | SQLite index path. |
| `S3_BUCKET` | Unset | Selects S3 storage when set. The bucket must exist. |
| `S3_ENDPOINT` | Unset | Custom S3 endpoint; omit for AWS. Read only with `S3_BUCKET`. |
| `S3_REGION` | `us-east-1` | S3 region. Read only with `S3_BUCKET`. |
| `S3_ACCESS_KEY_ID` | No default | Required with `S3_BUCKET`. |
| `S3_SECRET_ACCESS_KEY` | No default | Required with `S3_BUCKET`. |
| `FIXTURES_DIR` | `fixtures` | Root of the fixture source. |
| `SOURCE` | Empty string | `fixtures` or `github`. Other values choose GitHub if credentials exist, else fixtures. |
| `GITHUB_APP_ID` | Unset | Selects App auth. Takes precedence over a token. |
| `GITHUB_APP_PRIVATE_KEY` | No default | PEM private key; required when the App id is set. |
| `GITHUB_INSTALLATION_ID` | Unset | Initial App installation id. A stored id takes precedence. |
| `GITHUB_TOKEN` | Unset | Token auth when no App id is set. |
| `GITHUB_API_URL` | `https://api.github.com` | API base URL; for GHES use `https://ghe.example.com/api/v3`. Read with GitHub credentials. |
| `GITHUB_APP_SLUG` | Unset | App URL slug for the install link. Read with GitHub credentials. |
| `GITHUB_REPOS` | Empty string | Comma-separated `owner/repo` list. Empty lets an App use all installed repositories. Read with GitHub credentials. |
| `TAG_PASSWORD` | Empty string | Shared viewer password. Empty disables viewer auth. |
| `SESSION_SECRET` | `dev-only-secret` | Signs sessions, artifact handoffs and install state. Set a private value for deployment. |
| `PORT` | `3000` | Dashboard and API port. |
| `ARTIFACT_PORT` | `3001` | Artifact server port. |
| `ARTIFACT_COPY_POLICY` | `copy` | `copy` caches artifacts at ingest; `on-view` defers the copy until viewed. Other values mean `copy`. |
| `ARTIFACT_RETENTION_DAYS` | `90` | Age window for cached artifacts. `0` disables the sweep; negative values are clamped to zero. |

## GitHub access

App mode is the primary path. Set `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and
`GITHUB_APP_SLUG`. Give the App read access to Actions, Contents, Pull requests,
Deployments and Metadata. Set its setup URL to the dashboard's
`/api/install/callback` URL.

When no installation is recorded, the dashboard shows an install link. It sends
the admin through `/api/install` to GitHub with signed state. The callback checks
the state, records the installation id in SQLite and a live reference, and starts
an ingest pass. No restart is needed. There is one installation per TAG instance.
`GITHUB_INSTALLATION_ID` is only a seed; a stored id wins on the next boot.

Token mode uses `GITHUB_TOKEN` and `GITHUB_REPOS`. Use a fine-grained token with the
read permissions above and list the repositories to read. Token mode has no install
link. `.env.example` shows both modes; choose one and omit the other mode's settings.

## Storage and retention

Without `S3_BUCKET`, files live under `${DATA_DIR}/store`. With it, files live in
the configured bucket. SQLite stays local in either mode, so persist its directory.
Normalized reports use `reports/`; cached source files use `artifacts/`.

The retention sweep runs at boot and every six hours. It removes cached files for
artifacts whose newest report is older than `ARTIFACT_RETENTION_DAYS`. It marks
those artifacts as `listed`, or `expired` if their source expiry has passed.
A later view can fetch the files again if the source still has them. Reports stay.
`POST /api/retention/sweep` runs a sweep by hand.

For AWS S3, this lifecycle rule moves only `artifacts/` to Standard-IA after 30
days. It has no expiry rule and never touches `reports/`. Use a class supported by
your storage provider. The TAG sweep still applies at its configured age.

```json
{
  "Rules": [
    {
      "ID": "cool-artifacts",
      "Status": "Enabled",
      "Filter": { "Prefix": "artifacts/" },
      "Transitions": [{ "Days": 30, "StorageClass": "STANDARD_IA" }]
    }
  ]
}
```

## Ports and ingest

`PORT` serves the dashboard. `ARTIFACT_PORT` serves cached HTML, traces and other
files on a separate origin, so report scripts do not share the dashboard origin.
The artifact server uses its own cookie, a 60-second signed handoff and a content
security policy. The dashboard embeds reports in a sandboxed iframe.

Artifact links use the request host and scheme with `ARTIFACT_PORT`. Behind a
proxy, `ARTIFACT_ORIGIN` can override the public artifact origin. This extra variable
is read in `http-collection-routes.ts`, outside the config module. Route that origin
to the artifact port and keep it separate from the dashboard origin.

Ingest runs at boot with a limit of 20 recent runs per repository. The dashboard's
ingest button calls `POST /api/ingest`. The App install callback also starts a pass.
There is no periodic ingest poll yet.

## Docker

The Dockerfile pins the official Bun image to `oven/bun:1.4.3`. It builds the web
bundle and bundles the server with its dependencies. The runtime holds those two
outputs and runs as the `bun` user. It does not include fixtures.

```sh
docker build -t tag .
docker run --rm --name tag \
  -p 3000:3000 -p 3001:3001 \
  --mount source=tag-data,target=/data \
  --env-file .env.deploy \
  tag
```

The image sets `DATA_DIR=/data` and declares it as a volume. Leave `SQLITE_PATH`
unset to keep the index there. A bind mount must be writable by the image's `bun`
user. If you change `DATA_DIR`, mount the new path too.

Create `.env.deploy` with your GitHub mode, `TAG_PASSWORD` and `SESSION_SECRET`.
Add the S3 variables to use a bucket; otherwise the volume holds files too. For
local RustFS, the endpoint must be reachable from the container: `localhost` there
is the TAG container, not the host. Fixture mode needs a mounted fixture directory
and `FIXTURES_DIR` pointing to it.
