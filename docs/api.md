# The read API and the MCP server

Agents and scripts can read what the dashboard shows: verdicts, groups, runs, reports
and test history. There are two ways in, both on the dashboard port (`PORT`, 3000 by
default) and both answered by the same read service, so they never disagree.

- **HTTP and OpenAPI.** The read routes under `/api` are declared once as an Effect
  `HttpApi` (`packages/app/src/server/http-api.ts`). The OpenAPI 3.1 document comes from
  that declaration, so it cannot drift from the handlers.
- **MCP.** A Model Context Protocol server over streamable HTTP at `POST /mcp`, with
  read-only tools for agents.

Nothing here writes. Ingest, collections, suggestions and proposals keep their own
routes and are not in the document yet.

## OpenAPI

| URL                 | What                                          | Auth |
| ------------------- | --------------------------------------------- | ---- |
| `/api/openapi.json` | The OpenAPI 3.1 document                      | none |
| `/api/docs`         | A Scalar page that renders it, bundled in TAG | none |

Both are public: they describe the API and reveal no data. Every other route but
`/api/health` needs a session when `TAG_PASSWORD` is set.

The routes:

| Route                                            | Returns                                                      |
| ------------------------------------------------ | ------------------------------------------------------------ |
| `GET /api/health`                                | Whether the server is up, its source and its store           |
| `GET /api/overview`                              | Each repository's default-branch run, release and open PRs   |
| `GET /api/repos`                                 | Each repository with its report count                        |
| `GET /api/repositories`                          | Each repository with its backfill state                      |
| `GET /api/fields?q=`                             | Search-bar suggestions: fields, then values with counts      |
| `GET /api/groups`                                | Runs grouped by a field, with a verdict and trend per group  |
| `GET /api/groups/{by}/{key}`                     | One group: runs, failing tests, common errors, flaky tests   |
| `GET /api/runs`                                  | Reports, newest first, filtered by owner, repo, branch, tool |
| `GET /api/reports/{reportId}`                    | One report: tests, metrics, artifacts and the CTRF document  |
| `GET /api/tests/{owner}/{repo}/{testId}/history` | One test's results across reports                            |
| `GET /api/collections`                           | The saved collections and what each holds                    |
| `GET /api/suggestions?org=`                      | Collections and release groups TAG suggests saving           |

The views (`overview`, `groups`, a group) take the same scope:

- `range`: `1d`, `7d`, `30d`, `90d` or `all`. Default `30d` (`90d` for one group).
- `q`: filters in the search-bar language, such as `repo:acme/web branch:main failed:>0`.
- `c`: a collection id; its query applies first.
- `from`, `to`: ISO 8601 timestamps. `from` overrides the start of `range`; `to` drops
  reports after it.

A missing group or report is `404` with `{"_tag":"NotFound","error":"group not found"}`.
A query parameter that does not fit its schema, such as `by=colour`, is `400`.

### curl

With a password set, sign in once and keep the cookie:

```sh
curl -c tag.cookies -H 'content-type: application/json' \
  -d '{"password":"'"$TAG_PASSWORD"'"}' http://localhost:3000/api/login
curl -b tag.cookies 'http://localhost:3000/api/groups?by=release&range=30d&q=repo:acme/web'
```

With `TAG_PASSWORD` empty, drop the cookie. The document needs neither:

```sh
curl http://localhost:3000/api/openapi.json
```

## MCP

The endpoint is `http://<host>:<PORT>/mcp`, streamable HTTP. It accepts the MCP
revisions 2025-03-26, 2025-06-18, 2025-11-25 and 2026-07-28.

| Tool                | Input                                            | Answers                                          |
| ------------------- | ------------------------------------------------ | ------------------------------------------------ |
| `list_repositories` | none                                             | Every repository and its backfill state          |
| `overview`          | `query`, `c`, `range`, `from`, `to`              | What state each repository in scope is in        |
| `list_fields`       | `q`                                              | The fields and values a query can name           |
| `groups`            | `by`, `query`, `c`, `range`, `from`, `to`        | One row per group with verdict, pass rate, trend |
| `group`             | `by`, `key`, `query`, `c`, `range`, `from`, `to` | Failing tests, common errors, flaky tests        |
| `runs`              | `query`, `c`, `range`, `from`, `to`, `limit`     | CI runs in scope, newest first                   |
| `report`            | `reportId`                                       | One report in full                               |
| `test_history`      | `owner`, `repo`, `testId`, `limit`               | One test's results across reports                |

Each tool returns structured content in the shape the OpenAPI document gives its route.
The resource `tag://api/openapi.json` holds the OpenAPI document.

### Auth

When `TAG_PASSWORD` is set, `/mcp` takes either:

- the dashboard session cookie (`tag_session`), or
- `Authorization: Bearer <TAG_PASSWORD>`.

Anything else is `401`. With `TAG_PASSWORD` empty, `/mcp` is open, like the rest of TAG.

The bearer is the shared viewer password for now. When OIDC login lands it becomes a
per-user token, and the shared password stops working here. Serve TAG over HTTPS
anywhere but localhost: the bearer travels in every request.

### Claude Code

```sh
claude mcp add --transport http tag http://localhost:3000/mcp \
  --header "Authorization: Bearer $TAG_PASSWORD"
```

Drop `--header` when auth is off. Then ask, for example, "which releases of acme/web
failed this week, and why?".

### By hand

```sh
curl -i http://localhost:3000/mcp \
  -H "Authorization: Bearer $TAG_PASSWORD" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18",
       "capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

The response carries an `mcp-session-id` header. Send it, with
`mcp-protocol-version: 2025-06-18`, on the `notifications/initialized` notification and
on each `tools/list` or `tools/call` after it.
