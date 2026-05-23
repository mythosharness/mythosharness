import fs from "node:fs";
import path from "node:path";
import { runSandboxed } from "../sandbox/exec.ts";
import type { ToolDef } from "./types.ts";

function inside(root: string, p: string): boolean {
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function safeJoin(root: string, p: string): string {
  if (!inside(root, p)) throw new Error(`Path escapes root: ${p}`);
  return path.resolve(root, p);
}

export const readFileTool: ToolDef = {
  name: "read_file",
  description:
    "Read a file from the target repository or scratch dir. Provide a path relative to the target root, or prefix with `scratch:` to read from the per-task scratch directory.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "relative path" },
      start_line: { type: "integer", description: "1-indexed start line" },
      end_line: { type: "integer", description: "inclusive end line" },
    },
    required: ["path"],
  },
  async run(input, ctx) {
    const { path: p, start_line, end_line } = input as {
      path: string;
      start_line?: number;
      end_line?: number;
    };
    const inScratch = p.startsWith("scratch:");
    const rel = inScratch ? p.slice("scratch:".length) : p;
    const root = inScratch ? ctx.scratchDir : ctx.targetRoot;
    const abs = safeJoin(root, rel);
    const text = await fs.promises.readFile(abs, "utf8");
    const lines = text.split("\n");
    const s = Math.max(1, start_line ?? 1);
    const e = Math.min(lines.length, end_line ?? lines.length);
    const out = lines
      .slice(s - 1, e)
      .map((line, i) => `${s + i}\t${line}`)
      .join("\n");
    return `# ${rel} [${s}-${e}/${lines.length}]\n${out}`;
  },
};

export const listDirTool: ToolDef = {
  name: "list_dir",
  description:
    "List the contents of a directory under the target repository. Pass empty string for repo root.",
  input_schema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
  async run(input, ctx) {
    const { path: p } = input as { path: string };
    const abs = safeJoin(ctx.targetRoot, p || ".");
    const entries = await fs.promises.readdir(abs, { withFileTypes: true });
    return entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
      .join("\n");
  },
};

export const grepTool: ToolDef = {
  name: "grep",
  description:
    "Run ripgrep (or grep -r if unavailable) under the target repository. Returns matching lines with file:line prefixes.",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: {
        type: "string",
        description: "subpath to limit search; empty for repo root",
      },
      glob: { type: "string", description: "optional file glob" },
      case_insensitive: { type: "boolean" },
    },
    required: ["pattern"],
  },
  async run(input, ctx) {
    const {
      pattern,
      path: p,
      glob,
      case_insensitive,
    } = input as {
      pattern: string;
      path?: string;
      glob?: string;
      case_insensitive?: boolean;
    };
    const args = ["--line-number", "--with-filename", "--no-heading"];
    if (case_insensitive) args.push("-i");
    if (glob) args.push("--glob", glob);
    args.push(pattern, p || ".");
    const r = await runSandboxed({
      cmd: "rg",
      args,
      cwd: ctx.targetRoot,
      timeoutMs: 30_000,
    });
    if (r.exitCode === 127 || r.stderr.includes("not found")) {
      const fallback = await runSandboxed({
        cmd: "grep",
        args: ["-rnH", pattern, p || "."],
        cwd: ctx.targetRoot,
        timeoutMs: 30_000,
      });
      return fallback.stdout || fallback.stderr || "(no matches)";
    }
    return r.stdout || "(no matches)";
  },
};

export const writeScratchTool: ToolDef = {
  name: "write_scratch",
  description:
    "Write a file into the per-task scratch directory (for PoCs, test harnesses, etc.). Overwrites if present.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "relative path inside scratch" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
  async run(input, ctx) {
    const { path: p, content } = input as { path: string; content: string };
    const abs = safeJoin(ctx.scratchDir, p);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, content, "utf8");
    return `wrote ${p} (${content.length} bytes)`;
  },
};

export const runTool: ToolDef = {
  name: "run",
  description:
    "Execute a command in the per-task scratch directory. Only a fixed whitelist of binaries is allowed (gcc, clang, python3, bun, node, cargo, make, pytest, …). Returns stdout/stderr/exit code. Use this to compile and run PoCs.",
  input_schema: {
    type: "object",
    properties: {
      cmd: { type: "string", description: "executable name" },
      args: {
        type: "array",
        items: { type: "string" },
        description: "argv (no shell parsing)",
      },
      stdin: { type: "string" },
      timeout_ms: { type: "integer" },
    },
    required: ["cmd", "args"],
  },
  async run(input, ctx) {
    const { cmd, args, stdin, timeout_ms } = input as {
      cmd: string;
      args: string[];
      stdin?: string;
      timeout_ms?: number;
    };
    const r = await runSandboxed({
      cmd,
      args,
      cwd: ctx.scratchDir,
      stdin,
      timeoutMs: timeout_ms ?? 60_000,
    });
    return [
      `$ ${cmd} ${args.join(" ")}`,
      `exit=${r.exitCode} signal=${r.signal ?? ""} dur=${r.durationMs}ms${r.timedOut ? " TIMEOUT" : ""}`,
      `--- stdout ---`,
      r.stdout,
      `--- stderr ---`,
      r.stderr,
    ].join("\n");
  },
};

/** Common tool bundle for hunters/validators. */
export function huntTools(): ToolDef[] {
  return [readFileTool, listDirTool, grepTool, writeScratchTool, runTool];
}
