import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { runAgent } from "../agents/claude.ts";
import { huntTools } from "../agents/tools.ts";
import { config } from "../config.ts";
import { saveArchDoc } from "../memory/archdoc.ts";
import { enqueue } from "../memory/tasks.ts";
import { setTargetMeta } from "../memory/targets.ts";
import { ArchDoc, AttackClass, HuntTaskPayload, type Target } from "../schemas/index.ts";
import { scratchDirFor } from "../sandbox/scratch.ts";
import { newId } from "../util/ids.ts";
import { log } from "../util/log.ts";

const ReconJson = z.object({
  summary: z.string(),
  language: z.string().nullable(),
  buildSystem: z.string().nullable(),
  buildCommands: z.array(z.string()),
  testCommands: z.array(z.string()).default([]),
  entryPoints: z.array(
    z.object({
      file: z.string(),
      symbol: z.string().nullable().default(null),
      description: z.string(),
    }),
  ),
  trustBoundaries: z.array(
    z.object({ from: z.string(), to: z.string(), description: z.string() }),
  ),
  attackSurface: z.array(
    z.object({
      area: z.string(),
      rationale: z.string(),
      priority: z.enum(["low", "medium", "high"]),
    }),
  ),
  subsystems: z.array(
    z.object({ name: z.string(), path: z.string(), purpose: z.string() }),
  ),
  dependencies: z.array(z.string()).default([]),
  initialHuntTasks: z.array(
    z.object({
      attackClass: AttackClass,
      scopeHint: z.string(),
      rationale: z.string(),
    }),
  ),
});

const SYSTEM = `You are the **Recon** agent of an autonomous vulnerability research harness.

Your one job: read the target repository top-down and emit a single JSON document
describing its architecture from a security perspective. Be specific to *this*
codebase — do not output generic advice.

Do this:
1. List the repo root and the top 2-3 levels to understand layout.
2. Read package manifests, build files, CI configs, READMEs, INSTALL docs.
3. Identify entry points: HTTP handlers, RPC endpoints, CLI argv parsers, network
   listeners, file parsers, deserializers, IPC.
4. Identify trust boundaries: where attacker-controlled input crosses into
   privileged code (HTTP → parser; parser → sandboxed VM; renderer → JS exec; etc.)
5. Identify dangerous subsystems: anything dealing with memory safety, native
   code, command execution, deserialization, crypto, auth.
6. Pick the highest-priority attack surfaces and seed 8-15 initial hunt tasks,
   each tying ONE attack class to ONE narrow scope hint.

When done, call the \`finalize\` tool with the JSON object. Do not output prose.`;

export async function runRecon(target: Target): Promise<void> {
  log.info(`Recon starting for ${target.url}`, { stage: "recon", targetId: target.id });

  const scratchDir = scratchDirFor(`recon_${target.id}`);

  type FinalizeInput = z.infer<typeof ReconJson>;
  // Wrapper object: closures can mutate the field, and TS flow analysis
  // won't narrow `captured.value` to `never` after the early return.
  const captured: { value: FinalizeInput | null } = { value: null };

  const finalizeTool = {
    name: "finalize",
    description:
      "Emit the final architecture document and the initial hunt task queue. Call exactly once when your analysis is complete.",
    terminal: true,
    input_schema: {
      type: "object" as const,
      properties: {
        summary: { type: "string" },
        language: { type: ["string", "null"] },
        buildSystem: { type: ["string", "null"] },
        buildCommands: { type: "array", items: { type: "string" } },
        testCommands: { type: "array", items: { type: "string" } },
        entryPoints: {
          type: "array",
          items: {
            type: "object",
            properties: {
              file: { type: "string" },
              symbol: { type: ["string", "null"] },
              description: { type: "string" },
            },
            required: ["file", "description"],
          },
        },
        trustBoundaries: {
          type: "array",
          items: {
            type: "object",
            properties: {
              from: { type: "string" },
              to: { type: "string" },
              description: { type: "string" },
            },
            required: ["from", "to", "description"],
          },
        },
        attackSurface: {
          type: "array",
          items: {
            type: "object",
            properties: {
              area: { type: "string" },
              rationale: { type: "string" },
              priority: { type: "string", enum: ["low", "medium", "high"] },
            },
            required: ["area", "rationale", "priority"],
          },
        },
        subsystems: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              path: { type: "string" },
              purpose: { type: "string" },
            },
            required: ["name", "path", "purpose"],
          },
        },
        dependencies: { type: "array", items: { type: "string" } },
        initialHuntTasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              attackClass: {
                type: "string",
                enum: AttackClass.options,
              },
              scopeHint: { type: "string" },
              rationale: { type: "string" },
            },
            required: ["attackClass", "scopeHint", "rationale"],
          },
        },
      },
      required: [
        "summary",
        "buildCommands",
        "entryPoints",
        "trustBoundaries",
        "attackSurface",
        "subsystems",
        "initialHuntTasks",
      ],
    },
    async run(input: unknown) {
      const parsed = ReconJson.safeParse(input);
      if (!parsed.success) {
        return `Schema validation failed:\n${JSON.stringify(parsed.error.issues, null, 2)}\nFix and call again.`;
      }
      captured.value = parsed.data;
      return "OK — architecture document accepted.";
    },
  };

  const result = await runAgent({
    model: config.anthropic.models.recon,
    systemPrompt: SYSTEM,
    userInstruction: `Target repository is mounted at the target root. URL: ${target.url}. ${
      target.focusAreas.length > 0
        ? `Operator-specified focus areas: ${target.focusAreas.join(", ")}.`
        : ""
    }\n\nBegin by listing the repo root.`,
    tools: [...huntTools(), finalizeTool],
    ctx: {
      scratchDir,
      targetRoot: target.localPath,
      taskId: `recon_${target.id}`,
      targetId: target.id,
      state: {},
    },
    maxIterations: 40,
    maxTokens: 16_000,
    thinking: false,
  });

  const final = captured.value;
  if (!final) {
    log.error(`Recon ended without finalize (stop=${result.stopReason})`, {
      stage: "recon",
      targetId: target.id,
    });
    throw new Error("Recon did not finalize");
  }

  const doc: ArchDoc = {
    targetId: target.id,
    summary: final.summary,
    language: final.language,
    buildSystem: final.buildSystem,
    buildCommands: final.buildCommands,
    testCommands: final.testCommands,
    entryPoints: final.entryPoints.map((e) => ({
      file: e.file,
      symbol: e.symbol ?? null,
      description: e.description,
    })),
    trustBoundaries: final.trustBoundaries,
    attackSurface: final.attackSurface,
    subsystems: final.subsystems,
    dependencies: final.dependencies,
    builtAt: new Date().toISOString(),
  };
  saveArchDoc(doc);

  // Persist a human-readable copy for the operator.
  const docsDir = path.join(config.runtime.dataDir, "arch-docs");
  fs.mkdirSync(docsDir, { recursive: true });
  const mdPath = path.join(docsDir, `${target.id}.md`);
  fs.writeFileSync(mdPath, renderArchDoc(doc), "utf8");

  setTargetMeta(target.id, {
    language: doc.language ?? undefined,
    buildSystem: doc.buildSystem ?? undefined,
    archDocPath: mdPath,
  });

  // Seed the hunt queue.
  let enqueued = 0;
  for (const t of final.initialHuntTasks) {
    const payload = HuntTaskPayload.parse({
      targetId: target.id,
      attackClass: t.attackClass,
      scopeHint: t.scopeHint,
      rationale: t.rationale,
    });
    enqueue({ kind: "hunt", payload, targetId: target.id, parentId: `recon_${target.id}` });
    enqueued++;
  }
  log.info(`Recon complete: ${enqueued} hunt tasks queued`, {
    stage: "recon",
    targetId: target.id,
    meta: {
      tokens: result.inputTokens + result.outputTokens,
      cacheRead: result.cacheReadTokens,
    },
  });
}

function renderArchDoc(d: ArchDoc): string {
  const lines: string[] = [];
  lines.push(`# Architecture for ${d.targetId}`);
  lines.push(`Built at ${d.builtAt}`);
  lines.push("");
  lines.push("## Summary");
  lines.push(d.summary);
  lines.push("");
  lines.push(`**Language:** ${d.language ?? "n/a"}  `);
  lines.push(`**Build system:** ${d.buildSystem ?? "n/a"}`);
  lines.push("");
  lines.push("## Build commands");
  for (const c of d.buildCommands) lines.push(`- \`${c}\``);
  lines.push("");
  lines.push("## Entry points");
  for (const e of d.entryPoints) {
    lines.push(`- \`${e.file}\`${e.symbol ? ` :: \`${e.symbol}\`` : ""} — ${e.description}`);
  }
  lines.push("");
  lines.push("## Trust boundaries");
  for (const t of d.trustBoundaries) {
    lines.push(`- **${t.from}** → **${t.to}** — ${t.description}`);
  }
  lines.push("");
  lines.push("## Attack surface (by priority)");
  for (const a of d.attackSurface) lines.push(`- [${a.priority}] **${a.area}** — ${a.rationale}`);
  return lines.join("\n");
}

/** Build the static context block hunters and the validator share. */
export function archDocContext(d: ArchDoc): string {
  const lines = ["# Target architecture (recon output, stable across hunters)", ""];
  lines.push(`Summary: ${d.summary}`);
  lines.push(`Language: ${d.language ?? "unknown"}; Build: ${d.buildSystem ?? "unknown"}`);
  if (d.buildCommands.length) {
    lines.push("Build commands:");
    for (const c of d.buildCommands) lines.push(`  - ${c}`);
  }
  if (d.entryPoints.length) {
    lines.push("Entry points:");
    for (const e of d.entryPoints) {
      lines.push(`  - ${e.file}${e.symbol ? ` :: ${e.symbol}` : ""} — ${e.description}`);
    }
  }
  if (d.trustBoundaries.length) {
    lines.push("Trust boundaries:");
    for (const t of d.trustBoundaries) {
      lines.push(`  - ${t.from} → ${t.to}: ${t.description}`);
    }
  }
  if (d.subsystems.length) {
    lines.push("Subsystems:");
    for (const s of d.subsystems) lines.push(`  - ${s.name} (${s.path}) — ${s.purpose}`);
  }
  return lines.join("\n");
}

// Silence unused-import warning in environments that strip types.
void newId;
