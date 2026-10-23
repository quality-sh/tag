import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { FileRef, RunContext } from "../src/types.ts";

export async function filesFromDir(root: string): Promise<FileRef[]> {
  const out: FileRef[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        const s = await stat(full);
        const rel = relative(root, full).split("\\").join("/");
        out.push({
          path: rel,
          size: s.size,
          text: () => Bun.file(full).text(),
          bytes: async () => new Uint8Array(await Bun.file(full).arrayBuffer()),
        });
      }
    }
  }
  await walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export const ctx = (artifactName: string, runId = "run-1001"): RunContext => ({
  owner: "acme",
  repo: "widgets",
  runId,
  artifactName,
  branch: "main",
  commit: "a1b2c3d",
  buildUrl: `https://github.com/acme/widgets/actions/runs/${runId.slice(4)}`,
  timestamp: "2026-10-20T09:12:00Z",
});

export const FIXTURES = new URL("../../../fixtures/", import.meta.url).pathname;
