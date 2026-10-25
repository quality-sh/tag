// Artifact and run bookkeeping: what is listed, cached, swept, and already seen.
import type { Database } from "bun:sqlite";
import { Option } from "effect";
import type { ArtifactRow, Interface } from "./result-store-rows.ts";
import { trySync, type Params } from "./result-store-db.ts";

const ARTIFACT_COLS = `artifact_id AS artifactId, owner, repo, run_id AS runId, name, size_bytes AS sizeBytes, expires_at AS expiresAt, state, cached_at AS cachedAt`;

export const makeArtifacts = (
  db: Database,
): Pick<
  Interface,
  | "upsertArtifact"
  | "artifactsOfRun"
  | "getArtifact"
  | "markRunSeen"
  | "seenRuns"
  | "artifactNames"
  | "markArtifactSwept"
  | "cachedArtifactsBefore"
> => {
  const upsertArtifact = (row: ArtifactRow) =>
    trySync("upsertArtifact", () => {
      db.query<unknown, Params>(
        `INSERT INTO artifacts (artifact_id, owner, repo, run_id, name, size_bytes, expires_at, state, cached_at)
         VALUES ($id, $owner, $repo, $runId, $name, $size, $expiresAt, $state, $cachedAt)
         ON CONFLICT(artifact_id) DO UPDATE SET size_bytes = excluded.size_bytes, expires_at = excluded.expires_at,
           state = CASE WHEN artifacts.state = 'cached' AND excluded.state = 'listed' THEN 'cached' ELSE excluded.state END,
           cached_at = COALESCE(excluded.cached_at, artifacts.cached_at)`,
      ).run({
        $id: row.artifactId,
        $owner: row.owner,
        $repo: row.repo,
        $runId: row.runId,
        $name: row.name,
        $size: row.sizeBytes,
        $expiresAt: row.expiresAt,
        $state: row.state,
        $cachedAt: row.cachedAt,
      });
    });

  const markRunSeen = (owner: string, repo: string, runId: string) =>
    trySync("markRunSeen", () => {
      db.query<unknown, [string, string, string, string]>(
        `INSERT OR REPLACE INTO runs_seen (owner, repo, run_id, seen_at) VALUES (?, ?, ?, ?)`,
      ).run(owner, repo, runId, new Date().toISOString());
    });

  const seenRuns = (owner: string, repo: string) =>
    trySync(
      "seenRuns",
      () =>
        new Set(
          db
            .query<{ runId: string }, [string, string]>(
              `SELECT run_id AS runId FROM runs_seen WHERE owner = ? AND repo = ?`,
            )
            .all(owner, repo)
            .map((r) => r.runId),
        ) as ReadonlySet<string>,
    );

  const artifactNames = (owner: string, repo: string) =>
    trySync("artifactNames", () =>
      db
        .query<{ name: string; reported: number }, [string, string]>(
          `SELECT a.name, EXISTS(SELECT 1 FROM reports r
             WHERE r.owner = a.owner AND r.repo = a.repo AND r.artifact_name = a.name) AS reported
           FROM artifacts a WHERE a.owner = ? AND a.repo = ? GROUP BY a.name ORDER BY a.name`,
        )
        .all(owner, repo)
        .map((r) => ({ name: r.name, reported: r.reported === 1 })),
    );

  const artifactsOfRun = (owner: string, repo: string, runId: string) =>
    trySync("artifactsOfRun", () =>
      db
        .query<ArtifactRow, [string, string, string]>(
          `SELECT ${ARTIFACT_COLS} FROM artifacts WHERE owner = ? AND repo = ? AND run_id = ? ORDER BY name`,
        )
        .all(owner, repo, runId),
    );
  const markArtifactSwept = (artifactId: string, state: "listed" | "expired") =>
    trySync("markArtifactSwept", () => {
      db.query(`UPDATE artifacts SET state = ?, cached_at = NULL WHERE artifact_id = ?`).run(
        state,
        artifactId,
      );
    });
  const cachedArtifactsBefore = (cutoff: string) =>
    trySync("cachedArtifactsBefore", () =>
      db
        .query<ArtifactRow, [string]>(
          `SELECT ${ARTIFACT_COLS} FROM artifacts a
           WHERE a.state = 'cached'
             AND COALESCE((SELECT MAX(r.timestamp) FROM reports r WHERE r.artifact_id = a.artifact_id), a.cached_at, '') < ?
           ORDER BY a.cached_at`,
        )
        .all(cutoff),
    );
  const getArtifact = (artifactId: string) =>
    trySync("getArtifact", () =>
      Option.fromNullOr(
        db
          .query<ArtifactRow, [string]>(
            `SELECT ${ARTIFACT_COLS} FROM artifacts WHERE artifact_id = ?`,
          )
          .get(artifactId),
      ),
    );

  return {
    upsertArtifact,
    artifactsOfRun,
    getArtifact,
    markRunSeen,
    seenRuns,
    artifactNames,
    markArtifactSwept,
    cachedArtifactsBefore,
  };
};
