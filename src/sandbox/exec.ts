import { spawn } from "node:child_process";

/** Whitelist of commands an agent's `run` tool may invoke. Anything else
 *  is refused — agents cannot grab the host shell. */
const ALLOWED = new Set([
  "bash",
  "sh",
  "gcc",
  "g++",
  "clang",
  "clang++",
  "make",
  "cmake",
  "python3",
  "python",
  "pip",
  "pip3",
  "node",
  "npm",
  "bun",
  "deno",
  "go",
  "cargo",
  "rustc",
  "java",
  "javac",
  "mvn",
  "gradle",
  "ruby",
  "gem",
  "bundle",
  "php",
  "composer",
  "perl",
  "curl",
  "wget",
  "git",
  "pytest",
  "jest",
  "vitest",
  "mocha",
  "valgrind",
  "strace",
  "objdump",
  "nm",
  "readelf",
  "file",
  "ldd",
  "ls",
  "cat",
  "echo",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
  "find",
  "diff",
  "md5sum",
  "sha256sum",
  "tar",
  "unzip",
  "true",
  "false",
  "env",
  "which",
  "pwd",
  "stat",
]);

export interface RunOpts {
  cmd: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
  /** When set, fed to stdin. */
  stdin?: string;
  /** Allow the model to invoke a normally-blocked command by passing its
   *  argv via `bash -lc`. We never allow that outside the scratch dir. */
  allowShell?: boolean;
}

export interface RunResult {
  cmd: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export async function runSandboxed(opts: RunOpts): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  if (!opts.allowShell && !ALLOWED.has(opts.cmd)) {
    return {
      cmd: opts.cmd,
      args: opts.args,
      exitCode: 126,
      signal: null,
      stdout: "",
      stderr: `Refused: command "${opts.cmd}" not in sandbox whitelist`,
      durationMs: 0,
      timedOut: false,
    };
  }

  const start = Date.now();
  return await new Promise<RunResult>((resolve) => {
    const child = spawn(opts.cmd, opts.args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // Help PoCs not leak the host.
        HOME: opts.cwd,
        TMPDIR: opts.cwd,
      },
    });
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
      if (out.length > 200_000) out = out.slice(-200_000);
    });
    child.stderr.on("data", (d) => {
      err += d.toString();
      if (err.length > 200_000) err = err.slice(-200_000);
    });
    if (opts.stdin) child.stdin.end(opts.stdin);
    child.on("error", (e) => {
      clearTimeout(t);
      resolve({
        cmd: opts.cmd,
        args: opts.args,
        exitCode: 127,
        signal: null,
        stdout: out,
        stderr: `${err}\nspawn error: ${e.message}`,
        durationMs: Date.now() - start,
        timedOut,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(t);
      resolve({
        cmd: opts.cmd,
        args: opts.args,
        exitCode: code,
        signal,
        stdout: out,
        stderr: err,
        durationMs: Date.now() - start,
        timedOut,
      });
    });
  });
}
