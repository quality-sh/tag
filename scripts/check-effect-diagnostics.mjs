import { spawnSync } from "node:child_process";

const projects = ["tsconfig.json"];

for (const project of projects) {
  const result = spawnSync(
    "effect-language-service",
    ["diagnostics", "--project", project, "--severity", "error", "--format", "json"],
    { encoding: "utf8" },
  );

  if (result.error !== undefined) {
    console.error(result.error.message);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    console.error(`Effect diagnostics returned invalid JSON for ${project}`);
    process.stdout.write(result.stdout);
    process.exit(1);
  }

  const { filesChecked, totalFiles } = report.summary ?? {};
  if (
    !Number.isInteger(filesChecked) ||
    !Number.isInteger(totalFiles) ||
    totalFiles <= 0 ||
    filesChecked !== totalFiles
  ) {
    console.error(
      `Effect diagnostics checked ${String(filesChecked)} of ${String(totalFiles)} files in ${project}`,
    );
    process.exit(1);
  }

  console.log(
    `Effect diagnostics checked ${filesChecked} of ${totalFiles} files in ${project} with no errors`,
  );
}
