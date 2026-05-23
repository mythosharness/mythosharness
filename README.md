# mythosharness

A specialized, long-running, **self-evolving** vulnerability-discovery harness.

Inspired by Cloudflare's Mythos pipeline (Recon → Hunt → Validate → Gapfill →
Dedupe → Trace → Report) and extended with:

- **Email-driven I/O** — the operator gives instructions by email; the harness
  emails back hourly/daily reports of confirmed vulnerabilities.
- **Skill distillation** — every confirmed exploit (and notable miss) gets
  rolled into a markdown skill that future hunters auto-load.
- **Self-mutating code** — the harness proposes patches to its own source,
  gates them behind a smoke test, and commits to GitHub.
- **Indefinite autonomy** — runs forever until the operator emails `stop` or
  `KILL_SWITCH=1` is set.

## Why not a generic coding agent?

Cloudflare's writeup (`https://blog.cloudflare.com/cyber-frontier-models/`)
identifies two failure modes when a generic coding harness is pointed at a
vulnerability-research task:

1. **Context mismatch.** Coding agents hold a single hypothesis; vuln research
   is narrow + parallel. A single session can cover ~0.1% of a large repo
   before compaction discards earlier findings.
2. **Throughput.** Single-stream agents can't fan out. Useful for manual leads,
   wrong for coverage.

The fix is a structured pipeline of narrow, parallel agents with adversarial
review and structured output — that's what this repo implements.

## Pipeline

```
            ┌──────────┐
   operator │  Inbox   │  ──── commands (target add, stop, focus, …) ──┐
            └──────────┘                                                │
                                                                        ▼
┌────────┐  ┌──────┐  ┌──────────────┐  ┌──────────┐  ┌────────┐  ┌─────────┐
│ Recon  │─►│ Hunt │─►│  Validate    │─►│  Gapfill │─►│ Dedupe │─►│  Trace  │
│ (arch) │  │ N× ║║ │  (adversarial)│  │  re-queue│  │ root‑   │  │ x-repo  │
└────────┘  └──┬───┘  └──────────────┘  └──────────┘  │ cause   │  │ reach   │
               │ each hunter gets:                    └────────┘  └────┬────┘
               │   • one attack class                                  │
               │   • one scope hint                                    ▼
               │   • shared arch doc                              ┌─────────┐
               │   • per-task scratch dir for PoC                 │ Report  │
               └─────────────────────────────────────────────────►│ (mail+  │
                                                                  │ github) │
                                                                  └─────────┘
                                  ▲                                    │
                                  └────────── reflection ──────────────┤
                                       (new skills, harness mutations) │
                                                                       ▼
                                                              git commit + push
```

## Running

```bash
bun install
cp .env.example .env  # fill in keys
bun run start         # forever loop
bun run once          # one pipeline tick, useful for debugging
bun run smoke         # tests against the demo vulnerable fixture
```

The operator emails the address in `MAIL_USER`. Recognised commands:

```
subject: target add
body:    https://github.com/some/repo
         focus: deserialization, ssrf

subject: stop                # graceful shutdown
subject: pause               # stop scheduling new hunters but keep email loop
subject: resume
subject: status              # one-shot status reply
subject: focus
body:    use-after-free in src/parser/
```

Replies arrive on the schedule set by `REPORT_INTERVAL_MIN`.

## Layout

| Path                 | Role                                                |
|----------------------|-----------------------------------------------------|
| `src/orchestrator/`  | Long-running main loop + task queue                 |
| `src/stages/`        | recon / hunt / validate / gapfill / dedupe / trace / report |
| `src/agents/`        | Claude tool-use loop, subagent spawn, prompt cache  |
| `src/sandbox/`       | Per-task scratch dirs, sandboxed exec, build detect |
| `src/memory/`        | Findings DB, arch docs, skill loader                |
| `src/email/`         | IMAP poller + SMTP reporter                         |
| `src/github/`        | Auto-commit/push, self-mutation guard               |
| `src/selfimprove/`   | Reflection → skill writer → harness mutator         |
| `src/schemas/`       | Zod schemas (structured output, schema-validated)   |
| `skills/`            | Auto-loaded markdown skills (often self-generated)  |
| `data/`              | SQLite DBs, arch docs, scratch dirs, reports        |
| `targets/`           | Repos under analysis (cloned at runtime)            |

## Safety rails

- Sandboxed exec runs each PoC in a per-task scratch directory with a tight
  argv whitelist (`gcc`, `clang`, `bun`, `python3`, `node`, `cargo`, `make`,
  `cmake`, `pytest`).
- Self-mutations are written to a branch and smoke-tested before push. A
  failing smoke test aborts the commit.
- The harness refuses to operate on targets the operator hasn't explicitly
  added via email.
- `KILL_SWITCH=1` halts the orchestrator on the next tick.
