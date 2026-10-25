// Collections and settings: the saved scopes, and the key/value rows between boots.
import type { Database } from "bun:sqlite";
import { Option } from "effect";
import type { Collection } from "../grouping.ts";
import type { Interface } from "./result-store-rows.ts";
import { trySync, type Params } from "./result-store-db.ts";

const COLLECTION_COLS = `id, name, description, query, created_at AS createdAt`;

export const makeCollections = (
  db: Database,
): Pick<
  Interface,
  "collections" | "saveCollection" | "deleteCollection" | "getSetting" | "setSetting"
> => {
  const collections = () =>
    trySync("collections", () =>
      db
        .query<Collection, []>(`SELECT ${COLLECTION_COLS} FROM collections ORDER BY created_at`)
        .all(),
    );

  const saveCollection = (c: Collection) =>
    trySync("saveCollection", () => {
      db.query<unknown, Params>(
        `INSERT INTO collections (id, name, description, query, group_by, created_at)
         VALUES ($id, $name, $description, $query, $groupBy, $createdAt)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description,
           query = excluded.query`,
      ).run({
        $id: c.id,
        $name: c.name,
        $description: c.description,
        $query: c.query,
        // The column predates scopes; every view is on a collection's page now.
        $groupBy: "release",
        $createdAt: c.createdAt,
      });
    });

  const deleteCollection = (id: string) =>
    trySync(
      "deleteCollection",
      () => db.query<unknown, [string]>(`DELETE FROM collections WHERE id = ?`).run(id).changes > 0,
    );

  const getSetting = (key: string) =>
    trySync("getSetting", () =>
      Option.map(
        Option.fromNullOr(
          db
            .query<{ value: string }, [string]>(`SELECT value FROM settings WHERE key = ?`)
            .get(key),
        ),
        (row) => row.value,
      ),
    );

  const setSetting = (key: string, value: string) =>
    trySync("setSetting", () => {
      db.query<unknown, Params>(
        `INSERT INTO settings (key, value) VALUES ($key, $value)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run({ $key: key, $value: value });
    });

  return { collections, saveCollection, deleteCollection, getSetting, setSetting };
};
