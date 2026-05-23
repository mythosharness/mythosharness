import { z } from "zod";
import { quickAsk } from "../agents/claude.ts";
import { config } from "../config.ts";
import { loadArchDoc } from "../memory/archdoc.ts";
import { findingsForTarget } from "../memory/findings.ts";
import { enqueue } from "../memory/tasks.ts";
import { getTarget } from "../memory/targets.ts";
import {
  AttackClass,
  HuntTaskPayload,
  type Target,
} from "../schemas/index.ts";
import { log } from "../util/log.ts";

const GapfillSchema = z.object({
  newTasks: z.array(
    z.object({
      attackClass: AttackClass,
      scopeHint: z.string(),
      rationale: z.string(),
    }),
  ),
});

/** Looks at which (attackClass × subsystem) cells have been hunted on this
 *  target, and asks the model to seed tasks for under-covered combinations.
 *  Counteracts model drift toward already-successful attack classes. */
export async function runGapfill(target: Target): Promise<number> {
  const doc = loadArchDoc(target.id);
  if (!doc) return 0;

  const findings = findingsForTarget(target.id);
  const covered = new Map<string, number>();
  for (const f of findings) {
    const key = `${f.attackClass}|${f.primaryLocation.file.split("/").slice(0, 2).join("/")}`;
    covered.set(key, (covered.get(key) ?? 0) + 1);
  }

  const summary = [
    `# Coverage so far for ${target.id}`,
    "",
    `Total findings: ${findings.length}`,
    `Validated: ${findings.filter((f) => f.validated).length}`,
    "",
    "Findings per (attackClass, subdir):",
    ...Array.from(covered.entries())
      .sort()
      .map(([k, n]) => `- ${k}: ${n}`),
    "",
    "Subsystems:",
    ...doc.subsystems.map((s) => `- ${s.name} (${s.path}) — ${s.purpose}`),
    "",
    "Attack surface:",
    ...doc.attackSurface.map((a) => `- [${a.priority}] ${a.area}: ${a.rationale}`),
  ].join("\n");

  const prompt = `Identify (attackClass, scope) cells that haven't been hunted
or are likely under-covered given the attack surface. Emit JSON with
\`newTasks\`. Each task pairs ONE attack class with ONE narrow scope hint
(file/dir/symbol). Aim for 4-8 tasks that diversify coverage; do not duplicate
existing finding locations.

Coverage and surface:
${summary}

Respond with a single JSON object matching:
{"newTasks": [{"attackClass": ..., "scopeHint": ..., "rationale": ...}, ...]}
No prose, no markdown fences.`;

  const text = await quickAsk({
    model: config.anthropic.models.reflect,
    system:
      "You are a coverage planner. Emit only the JSON object — no surrounding prose.",
    user: prompt,
    maxTokens: 4_000,
  });

  let parsed: z.infer<typeof GapfillSchema>;
  try {
    const cleaned = text.replace(/```json|```/g, "").trim();
    parsed = GapfillSchema.parse(JSON.parse(cleaned));
  } catch (e) {
    log.warn(`Gapfill output unparseable: ${(e as Error).message}`, {
      stage: "gapfill",
      targetId: target.id,
    });
    return 0;
  }

  let n = 0;
  for (const t of parsed.newTasks) {
    const payload = HuntTaskPayload.parse({
      targetId: target.id,
      attackClass: t.attackClass,
      scopeHint: t.scopeHint,
      rationale: `gapfill: ${t.rationale}`,
    });
    enqueue({ kind: "hunt", payload, targetId: target.id });
    n++;
  }
  log.info(`Gapfill enqueued ${n} hunt tasks`, {
    stage: "gapfill",
    targetId: target.id,
  });
  return n;
}

void getTarget;
