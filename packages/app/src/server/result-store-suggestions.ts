// Suggestion state: the release groups a person accepted, and the suggestions they dismissed.
import type { Database } from "bun:sqlite";
import { Effect, Schema } from "effect";
import { ReleaseGroup } from "../grouping.ts";
import type { Interface } from "./result-store-rows.ts";
import { dbError, trySync, type Params } from "./result-store-db.ts";

const ReleaseGroupRow = Schema.Struct({
  ...ReleaseGroup.fields,
  repositories: Schema.fromJsonString(ReleaseGroup.fields.repositories),
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(ReleaseGroupRow));

export const makeSuggestionStore = (
  db: Database,
): Pick<
  Interface,
  "releaseGroups" | "saveReleaseGroup" | "dismissedSuggestions" | "dismissSuggestion"
> => {
  const releaseGroups = Effect.fn("ResultStore.releaseGroups")(function* () {
    const rows = yield* trySync("releaseGroups", () =>
      db
        .query<Record<string, string>, []>(
          `SELECT id, org, repositories, rule, created_at AS createdAt
           FROM release_groups ORDER BY created_at`,
        )
        .all(),
    );
    return yield* decodeRows(rows).pipe(Effect.mapError(dbError("releaseGroups")));
  });

  const saveReleaseGroup = (group: ReleaseGroup) =>
    trySync("saveReleaseGroup", () => {
      db.query<unknown, Params>(
        `INSERT INTO release_groups (id, org, repositories, rule, created_at)
         VALUES ($id, $org, $repositories, $rule, $createdAt)
         ON CONFLICT(id) DO UPDATE SET repositories = excluded.repositories, rule = excluded.rule`,
      ).run({
        $id: group.id,
        $org: group.org,
        $repositories: JSON.stringify(group.repositories),
        $rule: group.rule,
        $createdAt: group.createdAt,
      });
    });

  const dismissedSuggestions = () =>
    trySync(
      "dismissedSuggestions",
      (): ReadonlySet<string> =>
        new Set(
          db
            .query<{ id: string }, []>(`SELECT id FROM dismissed_suggestions`)
            .all()
            .map((r) => r.id),
        ),
    );

  const dismissSuggestion = (id: string) =>
    trySync("dismissSuggestion", () => {
      db.query<unknown, Params>(
        `INSERT INTO dismissed_suggestions (id, dismissed_at) VALUES ($id, $at)
         ON CONFLICT(id) DO NOTHING`,
      ).run({ $id: id, $at: new Date().toISOString() });
    });

  return { releaseGroups, saveReleaseGroup, dismissedSuggestions, dismissSuggestion };
};
