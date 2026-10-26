// The webhook against the real dashboard app: signed deliveries queue a run the worker ingests,
// bad signatures and redeliveries queue nothing, and a queued run survives a restart.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { Effect, Option, Redacted } from "effect";
import type { AppConfig } from "../src/server/config.ts";
import { cfg, repoRoutes, run } from "./github-fixtures.ts";
import { fakeGithub, serveApp, tmpDir } from "./helpers.ts";

const SECRET = "webhook-secret";

const overrides = (sqlitePath: string): Partial<AppConfig.Interface> => ({
  github: Option.some(cfg()),
  password: Redacted.make(""),
  webhookSecret: Option.some(Redacted.make(SECRET)),
  sqlitePath,
});

const completed = (id: number, repo = { owner: "acme", name: "widgets" }) =>
  JSON.stringify({
    action: "completed",
    workflow_run: { id, name: "ci", status: "completed" },
    repository: { name: repo.name, owner: { login: repo.owner }, full_name: "ignored" },
    sender: { login: "octocat" },
  });

const sign = (body: string, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

const deliver = (
  base: string,
  body: string,
  headers: { event?: string; delivery?: string; signature?: string | null } = {},
) =>
  fetch(`${base}/api/webhooks/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": headers.event ?? "workflow_run",
      "x-github-delivery": headers.delivery ?? crypto.randomUUID(),
      ...(headers.signature === null
        ? {}
        : { "x-hub-signature-256": headers.signature ?? sign(body) }),
    },
    body,
  });

const queueRows = (sqlitePath: string) => {
  const db = new Database(sqlitePath, { readonly: true });
  try {
    return db
      .query<{ runId: string; attempts: number }, []>(
        "SELECT run_id AS runId, attempts FROM run_queue",
      )
      .all();
  } finally {
    db.close();
  }
};

const runsOf = async (base: string, runId: string) =>
  (await (await fetch(`${base}/api/runs?runId=${runId}`)).json()) as Array<{ runId: string }>;

describe("the GitHub webhook", () => {
  test("a signed workflow_run.completed delivery puts the run's reports in the index", async () => {
    const gh = fakeGithub(await repoRoutes([run(2001)]));
    const sqlitePath = join(await tmpDir(), "tag.sqlite");
    const app = await serveApp({ overrides: overrides(sqlitePath), http: gh.layer });
    try {
      const body = completed(2001);
      const res = await deliver(app.base, body, { delivery: "delivery-1" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ queued: true, duplicate: false });
      await Effect.runPromise(app.ingest.settled());

      const indexed = await runsOf(app.base, "2001");
      expect(indexed).toHaveLength(1);
      expect(queueRows(sqlitePath)).toEqual([]);
      const runReads = gh.hits.filter(
        (h) => h.url.pathname === "/repos/acme/widgets/actions/runs/2001",
      );
      expect(runReads).toHaveLength(1);

      // A redelivery of the same id is a no-op: no queue row, no GitHub read.
      const again = await deliver(app.base, body, { delivery: "delivery-1" });
      expect(await again.json()).toEqual({ queued: false, duplicate: true });
      await Effect.runPromise(app.ingest.settled());
      expect(
        gh.hits.filter((h) => h.url.pathname === "/repos/acme/widgets/actions/runs/2001"),
      ).toHaveLength(1);
      expect(await runsOf(app.base, "2001")).toHaveLength(1);
    } finally {
      await app.stop();
    }
  });

  test("a bad or missing signature is 401 and queues nothing", async () => {
    const gh = fakeGithub(await repoRoutes([run(2001)]));
    const sqlitePath = join(await tmpDir(), "tag.sqlite");
    const app = await serveApp({ overrides: overrides(sqlitePath), http: gh.layer });
    try {
      const body = completed(2001);
      expect((await deliver(app.base, body, { signature: sign(body, "wrong") })).status).toBe(401);
      expect((await deliver(app.base, body, { signature: "sha256=00" })).status).toBe(401);
      expect((await deliver(app.base, body, { signature: "sha1=abc" })).status).toBe(401);
      expect((await deliver(app.base, body, { signature: null })).status).toBe(401);
      await Effect.runPromise(app.ingest.settled());
      expect(queueRows(sqlitePath)).toEqual([]);
      expect(gh.hits).toEqual([]);
    } finally {
      await app.stop();
    }
  });

  test("other events, other actions and unlisted repositories are answered and ignored", async () => {
    const gh = fakeGithub(await repoRoutes([run(2001)]));
    const sqlitePath = join(await tmpDir(), "tag.sqlite");
    const app = await serveApp({ overrides: overrides(sqlitePath), http: gh.layer });
    try {
      const ping = JSON.stringify({ zen: "Keep it logically awesome." });
      const pong = await deliver(app.base, ping, { event: "ping" });
      expect(pong.status).toBe(200);
      expect(await pong.json()).toEqual({ ignored: "ping" });

      const requested = JSON.stringify({ ...JSON.parse(completed(2001)), action: "requested" });
      const early = await deliver(app.base, requested);
      expect(await early.json()).toEqual({ ignored: "workflow_run.requested" });

      const elsewhere = await deliver(app.base, completed(7, { owner: "acme", name: "other" }));
      expect(await elsewhere.json()).toEqual({ ignored: "acme/other is not in GITHUB_REPOS" });

      const garbled = "{not json";
      expect((await deliver(app.base, garbled)).status).toBe(400);

      await Effect.runPromise(app.ingest.settled());
      expect(queueRows(sqlitePath)).toEqual([]);
      expect(gh.hits).toEqual([]);
    } finally {
      await app.stop();
    }
  });

  test("with no secret configured the endpoint is 404", async () => {
    const gh = fakeGithub({});
    const app = await serveApp({
      overrides: { github: Option.some(cfg()), password: Redacted.make("") },
      http: gh.layer,
    });
    try {
      const body = completed(2001);
      expect((await deliver(app.base, body)).status).toBe(404);
      expect((await deliver(app.base, body)).status).toBe(404);
    } finally {
      await app.stop();
    }
  });

  test("a queued run survives a restart and the next app ingests it", async () => {
    const sqlitePath = join(await tmpDir(), "tag.sqlite");
    // The first app cannot read the run, so the delivery stays queued with one attempt.
    const down = fakeGithub({});
    const first = await serveApp({ overrides: overrides(sqlitePath), http: down.layer });
    try {
      expect((await deliver(first.base, completed(2001))).status).toBe(200);
      await Effect.runPromise(first.ingest.settled());
      expect(queueRows(sqlitePath)).toEqual([{ runId: "2001", attempts: 1 }]);
    } finally {
      await first.stop();
    }

    const gh = fakeGithub(await repoRoutes([run(2001)]));
    const second = await serveApp({ overrides: overrides(sqlitePath), http: gh.layer });
    try {
      await Effect.runPromise(second.ingest.settled());
      expect(await runsOf(second.base, "2001")).toHaveLength(1);
      expect(queueRows(sqlitePath)).toEqual([]);
    } finally {
      await second.stop();
    }
  });
});
