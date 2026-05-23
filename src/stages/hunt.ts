import { z } from "zod";
import { runAgent } from "../agents/claude.ts";
import { huntTools } from "../agents/tools.ts";
import { config } from "../config.ts";
import { archDocContext } from "./recon.ts";
import { loadArchDoc } from "../memory/archdoc.ts";
import { upsertFinding } from "../memory/findings.ts";
import { renderSkillsContext, skillsForHunt } from "../memory/skills.ts";
import { enqueue, finishTask } from "../memory/tasks.ts";
import { getTarget } from "../memory/targets.ts";
import {
  AttackClass,
  Finding,
  HuntTaskPayload,
  Severity,
  type Task,
} from "../schemas/index.ts";
import { scratchDirFor } from "../sandbox/scratch.ts";
import { dedupHash, newId } from "../util/ids.ts";
import { log } from "../util/log.ts";

const FindingJson = z.object({
  found: z.boolean(),
  severity: Severity.optional(),
  title: z.string().optional(),
  summary: z.string().optional(),
  rootCause: z.string().optional(),
  trustBoundary: z.string().nullable().optional(),
  attackerControlledInput: z.string().nullable().optional(),
  primaryLocation: z
    .object({
      file: z.string(),
      startLine: z.number().int().positive(),
      endLine: z.number().int().positive(),
      symbol: z.string().nullable().optional(),
    })
    .optional(),
  relatedLocations: z
    .array(
      z.object({
        file: z.string(),
        startLine: z.number().int().positive(),
        endLine: z.number().int().positive(),
        symbol: z.string().nullable().optional(),
      }),
    )
    .default([]),
  poc: z
    .object({
      language: z.string(),
      filename: z.string(),
      source: z.string(),
      buildCmd: z.string().nullable().optional(),
      runCmd: z.string(),
      expectedSignal: z.string(),
      observedSignal: z.string().nullable().optional(),
      reproduced: z.boolean(),
    })
    .nullable()
    .default(null),
  notes: z.string().optional(),
});
type FindingJson = z.infer<typeof FindingJson>;

const SYSTEM = `You are a **Hunter** agent — one of many running in parallel. You investigate
ONE attack class against ONE narrow scope. Your goal is to confirm OR rule out
an exploitable vulnerability in that scope.

Rules:
- Stay inside your assigned attack class + scope. Don't drift.
- Read the relevant source carefully before claiming a bug.
- A "finding" must include a concrete path from attacker-controlled input to the
  buggy behavior. If you can't articulate that path, it isn't a finding.
- Whenever feasible, write a PoC into the scratch directory and run it with the
  \`run\` tool. A reproduced PoC is the strongest evidence.
- The harness over-reports on purpose — emit borderline findings with low/medium
  confidence; the validator will adjudicate. Do NOT silently drop possible bugs.
- When done (whether you found something or not), call \`emit_finding\` exactly
  once with the JSON. Use \`found: false\` if nothing was found.`;

export async function runHunt(task: Task): Promise<void> {
  const payload = HuntTaskPayload.parse(task.payload);
  const target = getTarget(payload.targetId);
  if (!target) {
    finishTask(task.id, "failed", { error: "target not found" });
    return;
  }
  const doc = loadArchDoc(target.id);
  if (!doc) {
    finishTask(task.id, "failed", { error: "no arch doc" });
    return;
  }

  const skills = skillsForHunt({
    attackClass: payload.attackClass,
    language: doc.language,
  });
  const skillsContext = renderSkillsContext(skills);

  const scratchDir = scratchDirFor(task.id);

  const captured: { value: FindingJson | null } = { value: null };

  const emitTool = {
    name: "emit_finding",
    description:
      "Emit the final structured finding for this hunt task. Call exactly once. Set found=false if nothing actionable was discovered.",
    terminal: true,
    input_schema: {
      type: "object" as const,
      properties: {
        found: { type: "boolean" },
        severity: { type: "string", enum: Severity.options },
        title: { type: "string" },
        summary: { type: "string" },
        rootCause: { type: "string" },
        trustBoundary: { type: ["string", "null"] },
        attackerControlledInput: { type: ["string", "null"] },
        primaryLocation: {
          type: "object",
          properties: {
            file: { type: "string" },
            startLine: { type: "integer" },
            endLine: { type: "integer" },
            symbol: { type: ["string", "null"] },
          },
          required: ["file", "startLine", "endLine"],
        },
        relatedLocations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              file: { type: "string" },
              startLine: { type: "integer" },
              endLine: { type: "integer" },
              symbol: { type: ["string", "null"] },
            },
            required: ["file", "startLine", "endLine"],
          },
        },
        poc: {
          type: ["object", "null"],
          properties: {
            language: { type: "string" },
            filename: { type: "string" },
            source: { type: "string" },
            buildCmd: { type: ["string", "null"] },
            runCmd: { type: "string" },
            expectedSignal: { type: "string" },
            observedSignal: { type: ["string", "null"] },
            reproduced: { type: "boolean" },
          },
        },
        notes: { type: "string" },
      },
      required: ["found"],
    },
    async run(input: unknown) {
      const parsed = FindingJson.safeParse(input);
      if (!parsed.success) {
        return `Schema validation failed:\n${JSON.stringify(parsed.error.issues, null, 2)}\nFix and call again.`;
      }
      captured.value = parsed.data;
      return "OK — finding recorded.";
    },
  };

  const staticContext = [archDocContext(doc), "", skillsContext].join("\n");

  const userInstruction = [
    `Attack class: ${payload.attackClass}`,
    `Scope hint:  ${payload.scopeHint}`,
    payload.rationale ? `Rationale:   ${payload.rationale}` : "",
    "",
    "Investigate this slice. Read code, build a hypothesis, and (if possible) write a PoC into the scratch dir and run it.",
    "When done, call emit_finding with the result.",
  ]
    .filter(Boolean)
    .join("\n");

  const result = await runAgent({
    model: config.anthropic.models.hunter,
    systemPrompt: SYSTEM,
    staticContext,
    userInstruction,
    tools: [...huntTools(), emitTool],
    ctx: {
      scratchDir,
      targetRoot: target.localPath,
      taskId: task.id,
      targetId: target.id,
      state: {},
    },
    maxIterations: 35,
    maxTokens: 32_000,
    effort: "xhigh",
  });

  const final = captured.value;
  if (!final) {
    log.warn(`Hunt task ${task.id} ended without emit_finding`, {
      stage: "hunt",
      taskId: task.id,
      targetId: target.id,
    });
    finishTask(task.id, "failed", { stopReason: result.stopReason });
    return;
  }

  if (!final.found || !final.title || !final.primaryLocation) {
    log.info(`Hunt task ${task.id}: no finding`, {
      stage: "hunt",
      taskId: task.id,
      targetId: target.id,
    });
    finishTask(task.id, "succeeded", { found: false });
    return;
  }

  const f: Finding = Finding.parse({
    id: newId("find"),
    targetId: target.id,
    attackClass: payload.attackClass,
    severity: final.severity ?? "medium",
    title: final.title,
    summary: final.summary ?? "",
    rootCause: final.rootCause ?? "",
    trustBoundary: final.trustBoundary ?? null,
    attackerControlledInput: final.attackerControlledInput ?? null,
    primaryLocation: {
      file: final.primaryLocation.file,
      startLine: final.primaryLocation.startLine,
      endLine: final.primaryLocation.endLine,
      symbol: final.primaryLocation.symbol ?? null,
    },
    relatedLocations: (final.relatedLocations ?? []).map((l) => ({
      file: l.file,
      startLine: l.startLine,
      endLine: l.endLine,
      symbol: l.symbol ?? null,
    })),
    poc: final.poc ?? null,
    validated: false,
    validatorRationale: null,
    reachable: null,
    dedupHash: dedupHash({
      file: final.primaryLocation.file,
      symbol: final.primaryLocation.symbol ?? null,
      attackClass: payload.attackClass,
      rootCause: final.rootCause ?? final.summary ?? "",
    }),
    createdAt: new Date().toISOString(),
    reportedAt: null,
  });

  const { inserted } = upsertFinding(f);
  if (inserted) {
    log.info(`Finding inserted: ${f.title}`, {
      stage: "hunt",
      taskId: task.id,
      targetId: target.id,
      meta: { findingId: f.id, severity: f.severity, reproduced: f.poc?.reproduced },
    });
    enqueue({
      kind: "validate",
      payload: { findingId: f.id },
      targetId: target.id,
      parentId: task.id,
    });
  } else {
    log.info(`Finding deduped: ${f.title}`, {
      stage: "hunt",
      taskId: task.id,
      targetId: target.id,
    });
  }

  finishTask(task.id, "succeeded", { found: true, findingId: f.id, inserted });
}

void AttackClass;
