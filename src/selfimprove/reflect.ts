import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { quickAsk } from "../agents/claude.ts";
import { config } from "../config.ts";
import { db, getKV, setKV } from "../memory/db.ts";
import { writeSkill } from "../memory/skills.ts";
import { AttackClass, Skill } from "../schemas/index.ts";
import { log } from "../util/log.ts";

const REFLECT_CURSOR_KEY = "reflect_cursor_id";

const ReflectSchema = z.object({
  newSkills: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        attackClasses: z.array(AttackClass),
        applicableLanguages: z.array(z.string()).default([]),
        body: z.string(),
      }),
    )
    .default([]),
  harnessProposals: z
    .array(
      z.object({
        file: z.string(),
        rationale: z.string(),
        patch: z.string(),
      }),
    )
    .default([]),
  observations: z.string().default(""),
});

interface RecentFinding {
  id: string;
  title: string;
  attack_class: string;
  severity: string;
  validated: number;
  validator_rationale: string | null;
  poc_reproduced: number | null;
  language: string | null;
}

function recentFindings(sinceId: string | null): RecentFinding[] {
  const sql = `
    SELECT f.id, f.title, f.attack_class, f.severity, f.validated,
           f.validator_rationale,
           CASE WHEN f.poc IS NULL THEN NULL
                ELSE CASE WHEN json_extract(f.poc, '$.reproduced')=1 THEN 1 ELSE 0 END END AS poc_reproduced,
           t.language
    FROM findings f
    LEFT JOIN targets t ON t.id = f.target_id
    ${sinceId ? "WHERE f.id > ?" : ""}
    ORDER BY f.id ASC
    LIMIT 40
  `;
  const stmt = db().query(sql);
  return (sinceId ? stmt.all(sinceId) : stmt.all()) as RecentFinding[];
}

export async function runReflection(): Promise<{
  newSkills: number;
  proposals: number;
}> {
  const cursor = getKV(REFLECT_CURSOR_KEY);
  const rows = recentFindings(cursor);
  if (rows.length < 3) {
    return { newSkills: 0, proposals: 0 };
  }

  const summary = rows
    .map(
      (r) =>
        `- ${r.id} [${r.attack_class}/${r.severity}] validated=${r.validated} reproduced=${r.poc_reproduced ?? "?"} lang=${r.language ?? "?"} title="${r.title.slice(0, 80)}" reason="${(r.validator_rationale ?? "").slice(0, 120)}"`,
    )
    .join("\n");

  const prompt = `Below are the latest hunt outcomes. Reflect on patterns:

${summary}

Distill any transferable lessons into "skills" (markdown blobs). A skill must
be:
- Specific (not generic OWASP advice).
- Tied to one or more attack classes.
- Action-oriented (what to grep for, what kinds of code to read, what PoC
  scaffolding works in this language).

Each skill should fit in <500 words. Only emit a skill if you can name a
concrete pattern that has actually appeared above. If nothing is concrete
enough, return an empty newSkills list — quality over quantity.

You may also propose harness improvements: text patches against files under
\`src/\`. These are PROPOSALS only — a human or smoke test gates the apply.
Keep proposals small and self-contained.

Respond with JSON only, matching:
{
  "newSkills": [{"name":..., "description":..., "attackClasses":[...],
                 "applicableLanguages":[...], "body":"<markdown>"}],
  "harnessProposals": [{"file":..., "rationale":..., "patch":"<unified diff or full-file replacement>"}],
  "observations": "<short paragraph>"
}`;

  let text: string;
  try {
    text = await quickAsk({
      model: config.anthropic.models.reflect,
      system:
        "You are the harness's self-improvement loop. Emit only JSON — no surrounding prose.",
      user: prompt,
      maxTokens: 8_000,
    });
  } catch (e) {
    log.warn(`Reflection call failed: ${(e as Error).message}`, {
      stage: "reflect",
    });
    return { newSkills: 0, proposals: 0 };
  }

  let parsed: z.infer<typeof ReflectSchema>;
  try {
    const cleaned = text.replace(/```json|```/g, "").trim();
    parsed = ReflectSchema.parse(JSON.parse(cleaned));
  } catch (e) {
    log.warn(`Reflection JSON parse failed: ${(e as Error).message}`, {
      stage: "reflect",
    });
    return { newSkills: 0, proposals: 0 };
  }

  for (const s of parsed.newSkills) {
    const skill: Skill = {
      name: s.name,
      description: s.description,
      attackClasses: s.attackClasses,
      applicableLanguages: s.applicableLanguages,
      body: s.body,
      source: "reflection",
      createdAt: new Date().toISOString(),
    };
    writeSkill(skill);
    log.info(`New skill written: ${skill.name}`, { stage: "reflect" });
  }

  // Stash proposals for the operator to review — never auto-apply at this
  // stage; harness self-mutation is gated by an explicit safety check.
  if (parsed.harnessProposals.length > 0) {
    const proposalsDir = path.join(config.runtime.dataDir, "harness-proposals");
    fs.mkdirSync(proposalsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const out = path.join(proposalsDir, `${stamp}.json`);
    fs.writeFileSync(out, JSON.stringify(parsed.harnessProposals, null, 2));
    log.info(
      `Stashed ${parsed.harnessProposals.length} harness proposals → ${out}`,
      { stage: "reflect" },
    );
  }

  if (rows.length > 0) {
    const last = rows[rows.length - 1];
    if (last) setKV(REFLECT_CURSOR_KEY, last.id);
  }
  return {
    newSkills: parsed.newSkills.length,
    proposals: parsed.harnessProposals.length,
  };
}
