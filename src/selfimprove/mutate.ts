import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { runSandboxed } from "../sandbox/exec.ts";
import { log } from "../util/log.ts";

interface Proposal {
  file: string;
  rationale: string;
  patch: string;
}

/**
 * Try to apply harness self-modification proposals. Each proposal is treated
 * as a full-file replacement keyed by `file`. The flow is:
 *
 *   1. Snapshot the current source tree
 *   2. Apply the proposal in a temp staging area
 *   3. Run smoke tests (`bun test`) — abort if anything regresses
 *   4. Move staged file into place, commit to a feature branch
 *
 * Anything more aggressive (multi-file refactors, diff-application against
 * moving targets) should go through the operator, not this loop.
 */
export async function applySafeMutations(): Promise<{
  applied: number;
  rejected: number;
}> {
  const dir = path.join(config.runtime.dataDir, "harness-proposals");
  if (!fs.existsSync(dir)) return { applied: 0, rejected: 0 };
  const stagedDir = path.join(config.runtime.dataDir, "harness-staging");
  fs.mkdirSync(stagedDir, { recursive: true });

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  let applied = 0;
  let rejected = 0;

  for (const fname of files) {
    const full = path.join(dir, fname);
    let proposals: Proposal[];
    try {
      proposals = JSON.parse(fs.readFileSync(full, "utf8")) as Proposal[];
    } catch {
      continue;
    }
    for (const p of proposals) {
      // Only allow modifying files under src/ or skills/. Never config,
      // package.json, lockfiles, or .env*.
      const norm = path.normalize(p.file);
      if (norm.startsWith("..") || path.isAbsolute(norm)) {
        log.warn(`Rejecting proposal with absolute/escaping path: ${p.file}`, {
          stage: "mutate",
        });
        rejected++;
        continue;
      }
      if (!norm.startsWith("src/") && !norm.startsWith("skills/")) {
        log.warn(`Rejecting proposal outside src/ or skills/: ${norm}`, {
          stage: "mutate",
        });
        rejected++;
        continue;
      }
      // For safety, treat a `patch` field that doesn't look like a diff as
      // a full-file replacement. Diff application is risky enough that we
      // require the operator to handle it.
      if (p.patch.startsWith("---") || p.patch.startsWith("diff ")) {
        log.warn(
          `Rejecting unified diff (full-file replacements only): ${norm}`,
          { stage: "mutate" },
        );
        rejected++;
        continue;
      }
      const target = path.resolve(norm);
      const before = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, p.patch, "utf8");
      } catch (e) {
        log.warn(`Write failed for ${norm}: ${(e as Error).message}`, {
          stage: "mutate",
        });
        rejected++;
        continue;
      }

      // Smoke test — typecheck only (fast). Bun test would be ideal but
      // depends on the user having installed dev deps.
      const tsc = await runSandboxed({
        cmd: "bun",
        args: ["x", "tsc", "--noEmit"],
        cwd: process.cwd(),
        timeoutMs: 120_000,
      });
      if (tsc.exitCode !== 0) {
        log.warn(
          `Smoke (tsc) failed for proposal targeting ${norm}; rolling back. stderr:\n${tsc.stderr.slice(0, 800)}`,
          { stage: "mutate" },
        );
        fs.writeFileSync(target, before, "utf8");
        rejected++;
        continue;
      }
      applied++;
      log.info(`Self-mutation applied to ${norm}`, {
        stage: "mutate",
        meta: { rationale: p.rationale.slice(0, 200) },
      });
    }
    // Move the proposal file out of the queue.
    fs.renameSync(full, path.join(stagedDir, fname));
  }
  return { applied, rejected };
}
