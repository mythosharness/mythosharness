import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { setKV, getKV } from "../memory/db.ts";
import { enqueue, cancelAllForTarget } from "../memory/tasks.ts";
import {
  addFocusAreas,
  addTarget,
  getTargetByUrl,
  listTargets,
  setTargetStatus,
} from "../memory/targets.ts";
import { runSandboxed } from "../sandbox/exec.ts";
import { newId } from "../util/ids.ts";
import { log } from "../util/log.ts";
import type { InboundCommand } from "./inbox.ts";
import { sendToOperator } from "./smtp.ts";

const RUN_STATE_KEY = "run_state";
export type RunState = "running" | "paused" | "stopping";

export function getRunState(): RunState {
  return (getKV(RUN_STATE_KEY) as RunState) ?? "running";
}
export function setRunState(s: RunState) {
  setKV(RUN_STATE_KEY, s);
}

export async function handleCommand(c: InboundCommand): Promise<void> {
  const subj = c.subject.trim().toLowerCase();
  log.info(`Inbound command: ${subj}`, { stage: "email", meta: { uid: c.uid } });

  if (subj.startsWith("target add")) return cmdTargetAdd(c);
  if (subj === "stop") return cmdStop(c);
  if (subj === "pause") return cmdPause(c);
  if (subj === "resume") return cmdResume(c);
  if (subj === "status") return cmdStatus(c);
  if (subj.startsWith("focus")) return cmdFocus(c);
  if (subj.startsWith("target remove")) return cmdTargetRemove(c);

  await sendToOperator({
    subject: `Re: ${c.subject}`,
    text: `Unrecognised command "${c.subject}". Recognised: target add, target remove, stop, pause, resume, status, focus.`,
    inReplyTo: c.messageId,
  });
}

async function cmdTargetAdd(c: InboundCommand): Promise<void> {
  // Body shape:
  //   <repo url>
  //   focus: ssrf, deserialization
  const lines = c.body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const urlLine = lines.find(
    (l) => /^https?:\/\//.test(l) || /^git@/.test(l) || /\.git$/.test(l),
  );
  if (!urlLine) {
    await sendToOperator({
      subject: `Re: ${c.subject}`,
      text: "No repo URL found in body. First non-blank line should be the repo URL.",
      inReplyTo: c.messageId,
    });
    return;
  }
  const focusLine = lines.find((l) => l.toLowerCase().startsWith("focus:"));
  const focus = focusLine
    ? focusLine
        .slice(focusLine.indexOf(":") + 1)
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  if (getTargetByUrl(urlLine)) {
    await sendToOperator({
      subject: `Re: ${c.subject}`,
      text: `Target ${urlLine} is already in the queue.`,
      inReplyTo: c.messageId,
    });
    return;
  }

  const cloneRoot = config.runtime.targetsDir;
  fs.mkdirSync(cloneRoot, { recursive: true });
  const slug = urlLine
    .replace(/^https?:\/\//, "")
    .replace(/\.git$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_");
  const localPath = path.join(cloneRoot, `${slug}_${newId("t").slice(2, 8)}`);

  log.info(`Cloning ${urlLine} → ${localPath}`, { stage: "email" });
  const clone = await runSandboxed({
    cmd: "git",
    args: ["clone", "--depth", "1", urlLine, localPath],
    cwd: cloneRoot,
    timeoutMs: 300_000,
  });
  if (clone.exitCode !== 0) {
    await sendToOperator({
      subject: `Re: ${c.subject}`,
      text: `git clone failed (exit ${clone.exitCode}):\n${clone.stderr.slice(0, 4000)}`,
      inReplyTo: c.messageId,
    });
    return;
  }

  const target = addTarget({ url: urlLine, localPath, focusAreas: focus });
  enqueue({ kind: "recon", payload: { targetId: target.id }, targetId: target.id });

  await sendToOperator({
    subject: `Re: ${c.subject}`,
    text: [
      `Target accepted: ${urlLine}`,
      `Local clone: ${localPath}`,
      `Focus areas: ${focus.length ? focus.join(", ") : "(none — full surface)"}`,
      `Recon enqueued. You'll get a report when the first validated findings land.`,
    ].join("\n"),
    inReplyTo: c.messageId,
  });
}

async function cmdTargetRemove(c: InboundCommand): Promise<void> {
  const lines = c.body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const url = lines[0];
  if (!url) return;
  const t = getTargetByUrl(url);
  if (!t) {
    await sendToOperator({
      subject: `Re: ${c.subject}`,
      text: `No active target for ${url}.`,
      inReplyTo: c.messageId,
    });
    return;
  }
  setTargetStatus(t.id, "done");
  cancelAllForTarget(t.id);
  await sendToOperator({
    subject: `Re: ${c.subject}`,
    text: `Target ${url} marked done; pending tasks cancelled.`,
    inReplyTo: c.messageId,
  });
}

async function cmdStop(c: InboundCommand): Promise<void> {
  setRunState("stopping");
  await sendToOperator({
    subject: `Re: ${c.subject}`,
    text: "Graceful stop requested. The harness will finish in-flight tasks then exit.",
    inReplyTo: c.messageId,
  });
}

async function cmdPause(c: InboundCommand): Promise<void> {
  setRunState("paused");
  await sendToOperator({
    subject: `Re: ${c.subject}`,
    text: "Paused. New hunters won't be scheduled; in-flight tasks continue. Send 'resume' to restart.",
    inReplyTo: c.messageId,
  });
}

async function cmdResume(c: InboundCommand): Promise<void> {
  setRunState("running");
  await sendToOperator({
    subject: `Re: ${c.subject}`,
    text: "Resumed.",
    inReplyTo: c.messageId,
  });
}

async function cmdFocus(c: InboundCommand): Promise<void> {
  // Body shape: first line = target url, rest = focus phrases (one per line or
  // comma separated)
  const lines = c.body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const url = lines[0];
  const focusBlob = lines.slice(1).join(" ");
  const focus = focusBlob
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!url || focus.length === 0) {
    await sendToOperator({
      subject: `Re: ${c.subject}`,
      text: "Format: first line = target URL, then focus phrases (comma or newline separated).",
      inReplyTo: c.messageId,
    });
    return;
  }
  const t = getTargetByUrl(url);
  if (!t) {
    await sendToOperator({
      subject: `Re: ${c.subject}`,
      text: `Unknown target ${url}`,
      inReplyTo: c.messageId,
    });
    return;
  }
  addFocusAreas(t.id, focus);
  // Convert focus phrases into immediate hunt tasks (logic_flaw is the
  // generic bucket; reflection later may diversify).
  for (const f of focus) {
    enqueue({
      kind: "hunt",
      targetId: t.id,
      payload: {
        targetId: t.id,
        attackClass: "logic_flaw",
        scopeHint: f,
        rationale: "operator focus directive",
      },
    });
  }
  await sendToOperator({
    subject: `Re: ${c.subject}`,
    text: `Added ${focus.length} focus areas for ${url} and queued matching hunt tasks.`,
    inReplyTo: c.messageId,
  });
}

async function cmdStatus(c: InboundCommand): Promise<void> {
  const targets = listTargets();
  const lines = [
    `Run state: ${getRunState()}`,
    `Targets: ${targets.length}`,
    ...targets.map((t) => `  - ${t.url} [${t.status}] focus=${t.focusAreas.join(",") || "(none)"}`),
  ];
  await sendToOperator({
    subject: `Re: ${c.subject}`,
    text: lines.join("\n"),
    inReplyTo: c.messageId,
  });
}
