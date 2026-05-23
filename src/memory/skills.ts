import fs from "node:fs";
import path from "node:path";
import type { Skill, AttackClass } from "../schemas/index.ts";

const SKILLS_DIR = path.resolve("./skills");

function ensureDir() {
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
}

function frontmatter(s: Skill): string {
  return [
    "---",
    `name: ${s.name}`,
    `description: ${JSON.stringify(s.description)}`,
    `attackClasses: ${JSON.stringify(s.attackClasses)}`,
    `applicableLanguages: ${JSON.stringify(s.applicableLanguages)}`,
    `source: ${s.source}`,
    `createdAt: ${s.createdAt}`,
    "---",
    "",
  ].join("\n");
}

function parseFrontmatter(text: string): { meta: Record<string, unknown>; body: string } | null {
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 4);
  if (end === -1) return null;
  const header = text.slice(4, end);
  const body = text.slice(end + 4).replace(/^\n+/, "");
  const meta: Record<string, unknown> = {};
  for (const line of header.split("\n")) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    const raw = m[2]!.trim();
    try {
      meta[key] = JSON.parse(raw);
    } catch {
      meta[key] = raw;
    }
  }
  return { meta, body };
}

export function writeSkill(s: Skill) {
  ensureDir();
  const safeName = s.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  const file = path.join(SKILLS_DIR, `${safeName}.md`);
  fs.writeFileSync(file, frontmatter(s) + s.body, "utf8");
}

export function listSkills(): Skill[] {
  ensureDir();
  const out: Skill[] = [];
  for (const name of fs.readdirSync(SKILLS_DIR)) {
    if (!name.endsWith(".md")) continue;
    const text = fs.readFileSync(path.join(SKILLS_DIR, name), "utf8");
    const fm = parseFrontmatter(text);
    if (!fm) continue;
    const m = fm.meta;
    out.push({
      name: (m.name as string) ?? name.replace(/\.md$/, ""),
      description: (m.description as string) ?? "",
      attackClasses: (m.attackClasses as AttackClass[]) ?? [],
      applicableLanguages: (m.applicableLanguages as string[]) ?? [],
      source: ((m.source as string) ?? "seed") as Skill["source"],
      createdAt: (m.createdAt as string) ?? new Date().toISOString(),
      body: fm.body,
    });
  }
  return out;
}

export function skillsForHunt(opts: {
  attackClass: AttackClass;
  language?: string | null;
}): Skill[] {
  const all = listSkills();
  return all.filter((s) => {
    if (!s.attackClasses.includes(opts.attackClass)) return false;
    if (
      opts.language &&
      s.applicableLanguages.length > 0 &&
      !s.applicableLanguages.includes(opts.language)
    )
      return false;
    return true;
  });
}

export function renderSkillsContext(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const parts: string[] = ["# Learned skills (auto-distilled from prior findings)", ""];
  for (const s of skills) {
    parts.push(`## ${s.name}`);
    parts.push(`*${s.description}*`);
    parts.push("");
    parts.push(s.body.trim());
    parts.push("");
  }
  return parts.join("\n");
}
