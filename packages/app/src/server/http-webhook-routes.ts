// The GitHub webhook: signed workflow_run deliveries queue the finished run for ingest.
import { createHmac, timingSafeEqual } from "node:crypto";
import { Effect, Option, Redacted, Schema } from "effect";
import { HttpRouter } from "effect/http";
import type { AppConfig } from "./config.ts";
import type { Ingest } from "./ingest.ts";
import { json } from "./http-helpers.ts";

export const WEBHOOK_PATH = "/api/webhooks/github";

/** The fields of a workflow_run delivery TAG reads; GitHub sends many more. */
const WorkflowRunEvent = Schema.Struct({
  action: Schema.String,
  workflow_run: Schema.Struct({ id: Schema.Number }),
  repository: Schema.Struct({
    name: Schema.String,
    owner: Schema.Struct({ login: Schema.String }),
  }),
});
const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkflowRunEvent));

/** GitHub signs the raw body with HMAC-SHA256 and sends `sha256=<hex>`. */
export const signatureMatches = (
  secret: Redacted.Redacted<string>,
  body: Uint8Array,
  header: string | undefined,
) => {
  if (header === undefined || !header.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", Redacted.value(secret)).update(body).digest();
  const given = Buffer.from(header.slice("sha256=".length), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
};

export const addWebhookRoutes = (deps: {
  readonly router: HttpRouter.HttpRouter;
  readonly cfg: AppConfig.Interface;
  readonly ingest: Ingest.Interface;
}) =>
  Effect.gen(function* () {
    const { router, cfg, ingest } = deps;
    // Only the configured repositories are ingested; an empty list means every installed one.
    const allowed = Option.match(cfg.github, {
      onNone: () => () => true,
      onSome: (g) => (owner: string, repo: string) =>
        g.repos.length === 0 || g.repos.some((r) => r.owner === owner && r.repo === repo),
    });
    let warned = false;

    yield* router.add("POST", WEBHOOK_PATH, (req) =>
      Effect.gen(function* () {
        if (Option.isNone(cfg.webhookSecret)) {
          if (!warned) {
            warned = true;
            yield* Effect.logWarning(
              `webhook: a delivery arrived but GITHUB_WEBHOOK_SECRET is unset; answering 404`,
            );
          }
          return json({ error: "webhook not configured" }, 404);
        }
        const body = yield* req.arrayBuffer.pipe(Effect.option);
        if (Option.isNone(body)) return json({ error: "unreadable body" }, 400);
        const bytes = new Uint8Array(body.value);
        if (!signatureMatches(cfg.webhookSecret.value, bytes, req.headers["x-hub-signature-256"]))
          return json({ error: "bad signature" }, 401);

        const event = req.headers["x-github-event"];
        if (event !== "workflow_run") return json({ ignored: event ?? "no event" });
        const payload = yield* decodeEvent(new TextDecoder().decode(bytes)).pipe(Effect.option);
        if (Option.isNone(payload)) return json({ error: "unexpected workflow_run payload" }, 400);
        const { action, workflow_run, repository } = payload.value;
        if (action !== "completed") return json({ ignored: `workflow_run.${action}` });
        const run = {
          owner: repository.owner.login,
          repo: repository.name,
          runId: String(workflow_run.id),
        };
        if (!allowed(run.owner, run.repo))
          return json({ ignored: `${run.owner}/${run.repo} is not in GITHUB_REPOS` });
        const { duplicate } = yield* ingest.queueRun(req.headers["x-github-delivery"], run);
        return json({ queued: !duplicate, duplicate });
      }),
    );
  });
