// The run queue: completed runs named by webhook deliveries, and the deliveries already seen.
import type { Database } from "bun:sqlite";
import type { Interface, QueuedRun } from "./result-store-rows.ts";
import { trySync, type Params } from "./result-store-db.ts";

/** Redeliveries come within days; a month of ids is plenty to recognise one. */
const DELIVERY_DAYS = 30;
const DAY = 86_400_000;

const QUEUE_COLS = `owner, repo, run_id AS runId, queued_at AS queuedAt, attempts, last_error AS lastError`;

type RunKey = Pick<QueuedRun, "owner" | "repo" | "runId">;
const keyParams = (run: RunKey): Params => ({
  $owner: run.owner,
  $repo: run.repo,
  $runId: run.runId,
});

export const makeQueue = (
  db: Database,
): Pick<Interface, "queueRun" | "queuedRuns" | "dequeueRun" | "failQueuedRun"> => {
  const record = db.transaction((deliveryId: string | undefined, run: RunKey, now: Date) => {
    if (deliveryId !== undefined) {
      const fresh = db
        .query<unknown, Params>(
          `INSERT INTO webhook_deliveries (delivery_id, received_at) VALUES ($id, $at)
           ON CONFLICT(delivery_id) DO NOTHING`,
        )
        .run({ $id: deliveryId, $at: now.toISOString() });
      if (fresh.changes === 0) return { duplicate: true };
      db.query<unknown, [string]>(`DELETE FROM webhook_deliveries WHERE received_at < ?`).run(
        new Date(now.getTime() - DELIVERY_DAYS * DAY).toISOString(),
      );
    }
    db.query<unknown, Params>(
      `INSERT INTO run_queue (owner, repo, run_id, queued_at) VALUES ($owner, $repo, $runId, $at)
       ON CONFLICT(owner, repo, run_id) DO NOTHING`,
    ).run({ ...keyParams(run), $at: now.toISOString() });
    return { duplicate: false };
  });

  const queueRun = (deliveryId: string | undefined, run: RunKey) =>
    trySync("queueRun", () => record(deliveryId, run, new Date()));

  const queuedRuns = () =>
    trySync("queuedRuns", () =>
      db
        .query<QueuedRun, []>(`SELECT ${QUEUE_COLS} FROM run_queue ORDER BY queued_at, run_id`)
        .all(),
    );

  const dequeueRun = (run: RunKey) =>
    trySync("dequeueRun", () => {
      db.query<unknown, Params>(
        `DELETE FROM run_queue WHERE owner = $owner AND repo = $repo AND run_id = $runId`,
      ).run(keyParams(run));
    });

  const failQueuedRun = (run: RunKey, error: string) =>
    trySync(
      "failQueuedRun",
      () =>
        db
          .query<{ attempts: number }, Params>(
            `UPDATE run_queue SET attempts = attempts + 1, last_error = $error
             WHERE owner = $owner AND repo = $repo AND run_id = $runId RETURNING attempts`,
          )
          .get({ ...keyParams(run), $error: error })?.attempts ?? 0,
    );

  return { queueRun, queuedRuns, dequeueRun, failQueuedRun };
};
