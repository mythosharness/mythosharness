import { config } from "../config.ts";
import { runSandboxed } from "../sandbox/exec.ts";
import { log } from "../util/log.ts";

/** Commit any pending changes (skills, reports, applied harness mutations)
 *  to the configured GitHub branch and push. No-op if no GitHub config or no
 *  diff. */
export async function autoCommit(message: string): Promise<boolean> {
  if (!config.github.token || !config.github.repo) {
    return false;
  }
  const cwd = process.cwd();

  // Initialise git if needed.
  const statusCheck = await runSandboxed({
    cmd: "git",
    args: ["rev-parse", "--is-inside-work-tree"],
    cwd,
    timeoutMs: 10_000,
  });
  if (statusCheck.exitCode !== 0) {
    log.info("git not initialised — `git init` and add remote first", {
      stage: "github",
    });
    return false;
  }

  // Ensure on the target branch.
  await runSandboxed({
    cmd: "git",
    args: ["checkout", "-B", config.github.branch],
    cwd,
    timeoutMs: 30_000,
  });

  // Stage the things we own.
  const adds = ["skills", "data/reports", "src"];
  for (const p of adds) {
    await runSandboxed({
      cmd: "git",
      args: ["add", "--all", p],
      cwd,
      timeoutMs: 30_000,
    });
  }

  const diff = await runSandboxed({
    cmd: "git",
    args: ["diff", "--cached", "--quiet"],
    cwd,
    timeoutMs: 10_000,
  });
  if (diff.exitCode === 0) {
    // No staged changes.
    return false;
  }

  const commit = await runSandboxed({
    cmd: "git",
    args: ["commit", "-m", message],
    cwd,
    timeoutMs: 30_000,
  });
  if (commit.exitCode !== 0) {
    log.warn(`git commit failed: ${commit.stderr.slice(0, 500)}`, {
      stage: "github",
    });
    return false;
  }

  // Push with token-authenticated URL.
  const repoUrl = `https://x-access-token:${config.github.token}@github.com/${config.github.repo}.git`;
  const push = await runSandboxed({
    cmd: "git",
    args: ["push", repoUrl, `HEAD:${config.github.branch}`],
    cwd,
    timeoutMs: 120_000,
  });
  if (push.exitCode !== 0) {
    log.warn(`git push failed: ${push.stderr.slice(0, 500)}`, {
      stage: "github",
    });
    return false;
  }
  log.info(`Pushed to ${config.github.repo}@${config.github.branch}`, {
    stage: "github",
  });
  return true;
}
