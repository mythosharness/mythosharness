import { config } from "../config.ts";
import { handleCommand, getRunState, setRunState } from "../email/commands.ts";
import { pollInbox } from "../email/inbox.ts";
import { sendToOperator } from "../email/smtp.ts";
import { autoCommit } from "../github/commit.ts";
import { db, getKV, setKV } from "../memory/db.ts";
import { countFindings } from "../memory/findings.ts";
import { claimNext, countByStatus, finishTask } from "../memory/tasks.ts";
import { getTarget, listTargets } from "../memory/targets.ts";
import { applySafeMutations } from "../selfimprove/mutate.ts";
import { runReflection } from "../selfimprove/reflect.ts";
import { runGapfill } from "../stages/gapfill.ts";
import { runHunt } from "../stages/hunt.ts";
import { runRecon } from "../stages/recon.ts";
import { buildPendingReport, markBatchReported } from "../stages/report.ts";
import { runValidate } from "../stages/validate.ts";
import { log } from "../util/log.ts";

const LAST_REPORT_KEY = "last_report_ts";
const LAST_INBOX_KEY = "last_inbox_ts";
const LAST_GAPFILL_KEY = "last_gapfill_ts";
const LAST_REFLECT_KEY = "last_reflect_ts";

function nowMin(): number {
  return Math.floor(Date.now() / 60_000);
}

async function maybePollInbox(): Promise<void> {
  const lastTs = parseInt(getKV(LAST_INBOX_KEY) ?? "0", 10);
  if (Date.now() - lastTs < config.runtime.inboxPollSec * 1000) return;
  setKV(LAST_INBOX_KEY, String(Date.now()));
  try {
    const cmds = await pollInbox();
    for (const c of cmds) {
      try {
        await handleCommand(c);
      } catch (e) {
        log.error(`Command handler failed: ${(e as Error).message}`, {
          stage: "email",
          meta: { subject: c.subject },
        });
      }
    }
  } catch (e) {
    log.warn(`Inbox poll failed: ${(e as Error).message}`, { stage: "email" });
  }
}

async function maybeReport(): Promise<void> {
  const lastTs = parseInt(getKV(LAST_REPORT_KEY) ?? "0", 10);
  if (Date.now() - lastTs < config.runtime.reportIntervalMin * 60_000) return;
  const out = buildPendingReport();
  if (out.ids.length > 0) {
    await sendToOperator({
      subject: `Vulnerability report — ${out.ids.length} new validated finding(s)`,
      text: out.markdown,
      markdown: out.markdown,
    });
    markBatchReported(out.ids);
  }
  setKV(LAST_REPORT_KEY, String(Date.now()));
}

async function maybeGapfill(): Promise<void> {
  const lastTs = parseInt(getKV(LAST_GAPFILL_KEY) ?? "0", 10);
  if (Date.now() - lastTs < 30 * 60_000) return;
  for (const t of listTargets("active")) {
    try {
      await runGapfill(t);
    } catch (e) {
      log.warn(`Gapfill failed for ${t.id}: ${(e as Error).message}`, {
        stage: "gapfill",
        targetId: t.id,
      });
    }
  }
  setKV(LAST_GAPFILL_KEY, String(Date.now()));
}

async function maybeReflect(): Promise<void> {
  const lastTs = parseInt(getKV(LAST_REFLECT_KEY) ?? "0", 10);
  if (Date.now() - lastTs < 45 * 60_000) return;
  try {
    const r = await runReflection();
    if (r.proposals > 0) {
      await applySafeMutations();
    }
  } catch (e) {
    log.warn(`Reflection failed: ${(e as Error).message}`, { stage: "reflect" });
  }
  setKV(LAST_REFLECT_KEY, String(Date.now()));
}

interface Slot {
  promise: Promise<void>;
  id: string;
  done: boolean;
}

async function runOneTask(): Promise<void> {
  const task = claimNext(["recon", "hunt", "validate"]);
  if (!task) return;
  log.info(`Tick: claimed ${task.kind} ${task.id}`, {
    stage: "orch",
    taskId: task.id,
  });
  try {
    if (task.kind === "recon") {
      const { targetId } = task.payload as { targetId: string };
      const target = getTarget(targetId);
      if (!target) {
        finishTask(task.id, "failed", { error: "no target" });
        return;
      }
      await runRecon(target);
      finishTask(task.id, "succeeded", { ok: true });
    } else if (task.kind === "hunt") {
      await runHunt(task);
    } else if (task.kind === "validate") {
      await runValidate(task);
    }
  } catch (e) {
    log.error(`Task ${task.id} failed: ${(e as Error).message}`, {
      stage: "orch",
      taskId: task.id,
    });
    finishTask(task.id, "failed", { error: (e as Error).message });
  }
}

export interface LoopOpts {
  once?: boolean;
}

export async function orchestrate(opts: LoopOpts = {}): Promise<void> {
  db(); // touch to migrate
  if (getRunState() === "stopping") setRunState("running");

  log.info(`Orchestrator starting (once=${!!opts.once})`, { stage: "orch" });

  const slots: Slot[] = [];
  const maxParallel = Math.max(1, config.runtime.maxConcurrentHunters);

  while (true) {
    if (config.runtime.killSwitch) {
      log.warn("KILL_SWITCH set; exiting", { stage: "orch" });
      break;
    }

    await maybePollInbox();

    const state = getRunState();
    if (state === "stopping") {
      await Promise.all(slots.map((s) => s.promise));
      log.info("Stop complete", { stage: "orch" });
      break;
    }

    // Periodic maintenance.
    await maybeReport();
    await maybeGapfill();
    await maybeReflect();

    // Reap finished slots.
    for (let i = slots.length - 1; i >= 0; i--) {
      if (slots[i]!.done) slots.splice(i, 1);
    }

    if (state === "paused") {
      if (opts.once) break;
      await sleep(2_000);
      continue;
    }

    // Fill up to maxParallel.
    while (slots.length < maxParallel) {
      const counts = countByStatus();
      const pending = counts.pending ?? 0;
      if (pending === 0) break;
      const id = `slot_${slots.length}_${Date.now()}`;
      const slot: Slot = { promise: Promise.resolve(), id, done: false };
      slot.promise = runOneTask()
        .catch((e) => {
          log.error(`Slot error: ${(e as Error).message}`, { stage: "orch" });
        })
        .finally(() => {
          slot.done = true;
        });
      slots.push(slot);
    }

    if (opts.once && slots.length === 0) break;
    if (slots.length === 0) {
      // Idle tick — wait for either inbox arrival or report time.
      await sleep(5_000);
      continue;
    }
    // Wait for at least one to complete before refilling.
    await Promise.race(slots.map((s) => s.promise));
  }

  // Final report on the way out.
  try {
    const out = buildPendingReport();
    if (out.ids.length > 0) {
      await sendToOperator({
        subject: `Final report — harness stopping (${out.ids.length} new finding(s))`,
        text: out.markdown,
        markdown: out.markdown,
      });
      markBatchReported(out.ids);
    }
    const counts = countFindings();
    await autoCommit(`harness checkpoint: ${counts.total} findings, ${counts.validated} validated`);
  } catch (e) {
    log.warn(`Shutdown housekeeping failed: ${(e as Error).message}`, {
      stage: "orch",
    });
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
