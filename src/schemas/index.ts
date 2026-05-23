import { z } from "zod";

export const AttackClass = z.enum([
  "memory_safety",            // UAF, double-free, OOB read/write, heap overflow
  "type_confusion",
  "integer_overflow",
  "format_string",
  "command_injection",
  "sql_injection",
  "ssrf",
  "xxe",
  "deserialization",
  "path_traversal",
  "auth_bypass",
  "race_condition",
  "logic_flaw",
  "crypto_misuse",
  "supply_chain",
  "info_disclosure",
  "denial_of_service",
  "other",
]);
export type AttackClass = z.infer<typeof AttackClass>;

export const Severity = z.enum(["info", "low", "medium", "high", "critical"]);
export type Severity = z.infer<typeof Severity>;

export const TaskStatus = z.enum([
  "pending",
  "claimed",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TaskKind = z.enum([
  "recon",
  "hunt",
  "validate",
  "gapfill",
  "trace",
  "report",
  "reflect",
]);
export type TaskKind = z.infer<typeof TaskKind>;

export const HuntTaskPayload = z.object({
  targetId: z.string(),
  attackClass: AttackClass,
  scopeHint: z.string().describe("file glob or function name or subsystem"),
  rationale: z.string().optional(),
  budgetTokens: z.number().int().positive().default(80_000),
});
export type HuntTaskPayload = z.infer<typeof HuntTaskPayload>;

export const Task = z.object({
  id: z.string(),
  kind: TaskKind,
  status: TaskStatus,
  payload: z.unknown(),
  createdAt: z.string(),
  updatedAt: z.string(),
  attempt: z.number().int().nonnegative().default(0),
  parentId: z.string().nullable().default(null),
  targetId: z.string().nullable().default(null),
});
export type Task = z.infer<typeof Task>;

export const PocArtifact = z.object({
  language: z.string(),
  filename: z.string(),
  source: z.string(),
  buildCmd: z.string().nullable(),
  runCmd: z.string(),
  expectedSignal: z.string().describe("e.g. 'crash with SIGSEGV', 'response 200', 'flag printed'"),
  observedSignal: z.string().nullable(),
  reproduced: z.boolean(),
});
export type PocArtifact = z.infer<typeof PocArtifact>;

export const CodeLocation = z.object({
  file: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  symbol: z.string().nullable().default(null),
});

export const Finding = z.object({
  id: z.string(),
  targetId: z.string(),
  attackClass: AttackClass,
  severity: Severity,
  title: z.string().max(180),
  summary: z.string(),
  rootCause: z.string(),
  trustBoundary: z.string().nullable(),
  attackerControlledInput: z.string().nullable(),
  primaryLocation: CodeLocation,
  relatedLocations: z.array(CodeLocation).default([]),
  poc: PocArtifact.nullable(),
  validated: z.boolean().default(false),
  validatorRationale: z.string().nullable().default(null),
  reachable: z.boolean().nullable().default(null),
  dedupHash: z.string(),
  createdAt: z.string(),
  reportedAt: z.string().nullable().default(null),
});
export type Finding = z.infer<typeof Finding>;

export const Target = z.object({
  id: z.string(),
  url: z.string(),
  localPath: z.string(),
  language: z.string().nullable(),
  buildSystem: z.string().nullable(),
  focusAreas: z.array(z.string()).default([]),
  status: z.enum(["active", "paused", "done"]),
  addedAt: z.string(),
  archDocPath: z.string().nullable().default(null),
});
export type Target = z.infer<typeof Target>;

export const ArchDoc = z.object({
  targetId: z.string(),
  summary: z.string(),
  language: z.string().nullable(),
  buildSystem: z.string().nullable(),
  buildCommands: z.array(z.string()),
  testCommands: z.array(z.string()),
  entryPoints: z.array(z.object({
    file: z.string(),
    symbol: z.string().nullable(),
    description: z.string(),
  })),
  trustBoundaries: z.array(z.object({
    from: z.string(),
    to: z.string(),
    description: z.string(),
  })),
  attackSurface: z.array(z.object({
    area: z.string(),
    rationale: z.string(),
    priority: z.enum(["low", "medium", "high"]),
  })),
  subsystems: z.array(z.object({
    name: z.string(),
    path: z.string(),
    purpose: z.string(),
  })),
  dependencies: z.array(z.string()).default([]),
  builtAt: z.string(),
});
export type ArchDoc = z.infer<typeof ArchDoc>;

export const ValidatorVerdict = z.object({
  findingId: z.string(),
  keep: z.boolean(),
  reachable: z.boolean().nullable(),
  rationale: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
});
export type ValidatorVerdict = z.infer<typeof ValidatorVerdict>;

export const Skill = z.object({
  name: z.string(),
  description: z.string(),
  attackClasses: z.array(AttackClass),
  applicableLanguages: z.array(z.string()).default([]),
  body: z.string(),
  source: z.enum(["seed", "reflection", "operator"]),
  createdAt: z.string(),
});
export type Skill = z.infer<typeof Skill>;

export const ReflectionOutput = z.object({
  newSkills: z.array(Skill).default([]),
  harnessProposals: z.array(z.object({
    file: z.string(),
    rationale: z.string(),
    diff: z.string(),
  })).default([]),
  newHuntTasks: z.array(HuntTaskPayload).default([]),
  observations: z.string(),
});
export type ReflectionOutput = z.infer<typeof ReflectionOutput>;
