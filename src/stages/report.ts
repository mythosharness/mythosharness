import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { markReported, unreportedFindings } from "../memory/findings.ts";
import { getTarget } from "../memory/targets.ts";
import type { Finding } from "../schemas/index.ts";

function renderFindingMd(f: Finding): string {
  const sev = f.severity.toUpperCase();
  const loc = `${f.primaryLocation.file}:${f.primaryLocation.startLine}-${f.primaryLocation.endLine}`;
  const lines: string[] = [
    `## [${sev}] ${f.title}`,
    "",
    `- **Attack class:** ${f.attackClass}`,
    `- **Location:** \`${loc}\`${f.primaryLocation.symbol ? ` (\`${f.primaryLocation.symbol}\`)` : ""}`,
    `- **Trust boundary:** ${f.trustBoundary ?? "—"}`,
    `- **Attacker-controlled input:** ${f.attackerControlledInput ?? "—"}`,
    `- **Validated:** ${f.validated ? "yes" : "no"}${f.reachable === null ? "" : f.reachable ? " (reachable)" : " (NOT reachable from external attacker)"}`,
    `- **Finding id:** ${f.id}`,
    "",
    "### Summary",
    f.summary || "(no summary)",
    "",
    "### Root cause",
    f.rootCause || "(no root cause)",
  ];
  if (f.validatorRationale) {
    lines.push("", "### Validator", f.validatorRationale);
  }
  if (f.poc) {
    lines.push(
      "",
      "### PoC",
      `Build: \`${f.poc.buildCmd ?? "(none)"}\`  Run: \`${f.poc.runCmd}\``,
      `Expected signal: ${f.poc.expectedSignal}`,
      `Observed signal: ${f.poc.observedSignal ?? "(not run)"}`,
      `Reproduced: **${f.poc.reproduced ? "yes" : "no"}**`,
      "",
      "```" + f.poc.language,
      f.poc.source,
      "```",
    );
  }
  if (f.relatedLocations.length) {
    lines.push("", "### Related locations");
    for (const l of f.relatedLocations) {
      lines.push(`- \`${l.file}:${l.startLine}-${l.endLine}\``);
    }
  }
  return lines.join("\n");
}

export interface ReportOutput {
  markdown: string;
  ids: string[];
  path: string | null;
}

export function buildPendingReport(): ReportOutput {
  const findings = unreportedFindings();
  if (findings.length === 0) {
    return { markdown: "", ids: [], path: null };
  }
  const byTarget = new Map<string, Finding[]>();
  for (const f of findings) {
    const arr = byTarget.get(f.targetId) ?? [];
    arr.push(f);
    byTarget.set(f.targetId, arr);
  }
  const sevRank = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

  const lines: string[] = [];
  lines.push(`# Vulnerability report — ${new Date().toISOString()}`);
  lines.push("");
  lines.push(`${findings.length} validated finding(s) since last report.`);
  lines.push("");

  for (const [targetId, list] of byTarget) {
    const t = getTarget(targetId);
    lines.push(`---`);
    lines.push(`# Target: ${t?.url ?? targetId}`);
    list.sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);
    for (const f of list) {
      lines.push("");
      lines.push(renderFindingMd(f));
    }
    lines.push("");
  }

  const md = lines.join("\n");
  const reportsDir = path.join(config.runtime.dataDir, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = path.join(reportsDir, `report_${stamp}.md`);
  fs.writeFileSync(out, md, "utf8");
  return { markdown: md, ids: findings.map((f) => f.id), path: out };
}

export function markBatchReported(ids: string[]) {
  markReported(ids);
}
