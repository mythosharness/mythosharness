import { z } from "zod";
import { runAgent } from "../agents/claude.ts";
import { huntTools } from "../agents/tools.ts";
import { config } from "../config.ts";
import { archDocContext } from "./recon.ts";
import { loadArchDoc } from "../memory/archdoc.ts";
import {
  findingsForTarget,
  updateValidatorVerdict,
} from "../memory/findings.ts";
import { finishTask } from "../memory/tasks.ts";
import { getTarget } from "../memory/targets.ts";
import { ValidatorVerdict, type Task } from "../schemas/index.ts";
import { scratchDirFor } from "../sandbox/scratch.ts";
import { log } from "../util/log.ts";

const VerdictJson = z.object({
  keep: z.boolean(),
  reachable: z.boolean().nullable().optional(),
  rationale: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
});

const SYSTEM = `You are the **Validator** — an adversarial reviewer. A Hunter agent
(different model, different prompt) claimed a vulnerability. Your one job is to
try to **disprove** it.

Rules:
- You CANNOT emit new findings. Stay focused on the one in front of you.
- Re-read the code at the cited locations carefully. Do not trust the Hunter's
  paraphrase — check the source yourself.
- Walk through the reachability claim. Can the named input actually reach the
  buggy code path under realistic conditions? Are there sanitizers, bounds
  checks, or authorization gates the Hunter missed?
- If a PoC is attached, run it from the scratch dir and confirm the observed
  signal matches the claimed expected signal.
- Decide:
    keep=true  → finding appears genuine. Optionally set \`reachable\` based on
                 attacker-controlled input reachability.
    keep=false → finding does not hold up. Explain why.
- Call \`emit_verdict\` exactly once.`;

export async function runValidate(task: Task): Promise<void> {
  const { findingId } = task.payload as { findingId: string };
  // Pull the finding back out of the DB.
  const targetId = task.targetId;
  if (!targetId) {
    finishTask(task.id, "failed", { error: "no target" });
    return;
  }
  const target = getTarget(targetId);
  if (!target) {
    finishTask(task.id, "failed", { error: "target missing" });
    return;
  }
  const finding = findingsForTarget(targetId).find((f) => f.id === findingId);
  if (!finding) {
    finishTask(task.id, "failed", { error: "finding missing" });
    return;
  }
  const doc = loadArchDoc(targetId);
  if (!doc) {
    finishTask(task.id, "failed", { error: "no arch doc" });
    return;
  }

  const scratchDir = scratchDirFor(task.id);

  type VerdictType = z.infer<typeof VerdictJson>;
  const captured: { value: VerdictType | null } = { value: null };

  const emitTool = {
    name: "emit_verdict",
    description: "Emit the final keep/reject verdict.",
    terminal: true,
    input_schema: {
      type: "object" as const,
      properties: {
        keep: { type: "boolean" },
        reachable: { type: ["boolean", "null"] },
        rationale: { type: "string" },
        confidence: { type: "string", enum: ["low", "medium", "high"] },
      },
      required: ["keep", "rationale", "confidence"],
    },
    async run(input: unknown) {
      const parsed = VerdictJson.safeParse(input);
      if (!parsed.success) {
        return `Schema validation failed:\n${JSON.stringify(parsed.error.issues, null, 2)}\nFix and call again.`;
      }
      captured.value = parsed.data;
      return "OK — verdict recorded.";
    },
  };

  const findingBlock = [
    "## Claimed finding",
    `Title:        ${finding.title}`,
    `Attack class: ${finding.attackClass}`,
    `Severity:     ${finding.severity}`,
    `Location:     ${finding.primaryLocation.file}:${finding.primaryLocation.startLine}-${finding.primaryLocation.endLine}${finding.primaryLocation.symbol ? ` (${finding.primaryLocation.symbol})` : ""}`,
    `Trust boundary: ${finding.trustBoundary ?? "(unspecified)"}`,
    `Attacker input: ${finding.attackerControlledInput ?? "(unspecified)"}`,
    "",
    "### Summary",
    finding.summary,
    "",
    "### Claimed root cause",
    finding.rootCause,
  ];
  if (finding.poc) {
    findingBlock.push(
      "",
      "### Hunter PoC",
      `Filename: ${finding.poc.filename} (${finding.poc.language})`,
      `Build cmd: ${finding.poc.buildCmd ?? "(none)"}`,
      `Run cmd:   ${finding.poc.runCmd}`,
      `Expected:  ${finding.poc.expectedSignal}`,
      `Observed:  ${finding.poc.observedSignal ?? "(not run)"}`,
      `Reproduced: ${finding.poc.reproduced}`,
      "",
      "Source:",
      "```",
      finding.poc.source,
      "```",
    );
  }

  const result = await runAgent({
    model: config.anthropic.models.validator,
    systemPrompt: SYSTEM,
    staticContext: archDocContext(doc),
    userInstruction: findingBlock.join("\n"),
    tools: [...huntTools(), emitTool],
    ctx: {
      scratchDir,
      targetRoot: target.localPath,
      taskId: task.id,
      targetId,
      state: {},
    },
    maxIterations: 25,
    maxTokens: 24_000,
    effort: "high",
  });

  const final = captured.value;
  if (!final) {
    log.warn(`Validator did not emit verdict for ${findingId}`, {
      stage: "validate",
      taskId: task.id,
      targetId,
    });
    finishTask(task.id, "failed", { stopReason: result.stopReason });
    return;
  }

  const verdict = ValidatorVerdict.parse({
    findingId,
    keep: final.keep,
    reachable: final.reachable ?? null,
    rationale: final.rationale,
    confidence: final.confidence,
  });

  updateValidatorVerdict(
    findingId,
    verdict.keep,
    verdict.rationale,
    verdict.reachable,
  );

  log.info(
    `Validator: ${verdict.keep ? "KEEP" : "REJECT"} ${findingId} (${verdict.confidence})`,
    { stage: "validate", taskId: task.id, targetId, meta: { findingId } },
  );

  finishTask(task.id, "succeeded", verdict);
}
