// GitHubSource repository info: the default branch and environments, the file
// tree of the default branch, and file texts from the contents endpoint.
import { describe, expect, test } from "bun:test";
import { fakeGithub } from "./helpers.ts";
import { cfg, sourceWith, using } from "./github-fixtures.ts";

describe("GitHubSource", () => {
  test("reads the repository's default branch and environments", async () => {
    const gh = fakeGithub({
      "/repos/acme/widgets": () => ({ default_branch: "trunk" }),
      "/repos/acme/widgets/environments": () => ({
        environments: [{ name: "production" }, { name: "staging" }],
      }),
    });
    const info = await using(sourceWith(cfg(), gh.layer), (s) =>
      s.repoInfo({ owner: "acme", repo: "widgets" }),
    );
    expect(info).toEqual({
      defaultBranch: "trunk",
      environments: ["production", "staging"],
    });
    expect(gh.hits.map((h) => h.url.pathname)).toEqual([
      "/repos/acme/widgets",
      "/repos/acme/widgets/environments",
    ]);
  });

  test("an unreadable environments endpoint leaves the branch with no environments", async () => {
    const gh = fakeGithub({
      "/repos/acme/widgets": () => ({ default_branch: "trunk" }),
    });
    const info = await using(sourceWith(cfg(), gh.layer), (s) =>
      s.repoInfo({ owner: "acme", repo: "widgets" }),
    );
    expect(info).toEqual({ defaultBranch: "trunk", environments: [] });
  });

  test("a repository without a default_branch says null", async () => {
    const gh = fakeGithub({
      "/repos/acme/widgets": () => ({}),
      "/repos/acme/widgets/environments": () => ({ environments: [] }),
    });
    const info = await using(sourceWith(cfg(), gh.layer), (s) =>
      s.repoInfo({ owner: "acme", repo: "widgets" }),
    );
    expect(info).toEqual({ defaultBranch: null, environments: [] });
  });

  test("reads the repository tree from the default branch", async () => {
    const gh = fakeGithub({
      "/repos/acme/widgets": () => ({ default_branch: "main" }),
      "/repos/acme/widgets/environments": () => ({ environments: [] }),
      "/repos/acme/widgets/git/trees/main": (url) => {
        expect(url.searchParams.get("recursive")).toBe("1");
        return {
          tree: [
            { path: "README.md", type: "blob" },
            { path: "packages", type: "tree" },
            { path: ".github/workflows/ci.yml", type: "blob" },
          ],
          truncated: false,
        };
      },
    });
    const paths = await using(sourceWith(cfg(), gh.layer), (s) =>
      s.repoTree({ owner: "acme", repo: "widgets" }),
    );
    expect(paths).toEqual(["README.md", ".github/workflows/ci.yml"]);
  });

  test("reads file texts from contents; absent paths come back absent", async () => {
    const gh = fakeGithub({
      "/repos/acme/widgets": () => ({ default_branch: "main" }),
      "/repos/acme/widgets/environments": () => ({ environments: [] }),
      "/repos/acme/widgets/contents/.github/workflows/ci.yml": (url) => {
        expect(url.searchParams.get("ref")).toBe("main");
        return {
          content: Buffer.from("jobs:\n  Tests:\n    steps:\n      - run: bun test\n").toString(
            "base64",
          ),
          encoding: "base64",
        };
      },
    });
    const files = await using(sourceWith(cfg(), gh.layer), (s) =>
      s.repoFiles({ owner: "acme", repo: "widgets" }, [".github/workflows/ci.yml", "gone.yml"]),
    );
    expect(files).toEqual([
      {
        path: ".github/workflows/ci.yml",
        text: "jobs:\n  Tests:\n    steps:\n      - run: bun test\n",
      },
    ]);
  });
});
