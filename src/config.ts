import path from "node:path";

function env(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v && v.length > 0) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env var: ${key}`);
}

function envOpt(key: string): string | undefined {
  const v = process.env[key];
  return v && v.length > 0 ? v : undefined;
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  anthropic: {
    apiKey: env("ANTHROPIC_API_KEY", ""),
    // Optional override. `thomas wire` typically sets this in the env for us;
    // explicit overrides go here. The Anthropic SDK reads ANTHROPIC_BASE_URL
    // natively, but we surface it on the config so it's visible at the
    // harness level too.
    baseURL: envOpt("ANTHROPIC_BASE_URL"),
    models: {
      hunter: env("MODEL_HUNTER", "claude-opus-4-7"),
      validator: env("MODEL_VALIDATOR", "claude-sonnet-4-6"),
      recon: env("MODEL_RECON", "claude-opus-4-7"),
      report: env("MODEL_REPORT", "claude-sonnet-4-6"),
      reflect: env("MODEL_REFLECT", "claude-sonnet-4-6"),
    },
  },
  mail: {
    imapHost: env("IMAP_HOST", "imap.gmail.com"),
    imapPort: envInt("IMAP_PORT", 993),
    smtpHost: env("SMTP_HOST", "smtp.gmail.com"),
    smtpPort: envInt("SMTP_PORT", 465),
    user: envOpt("MAIL_USER") ?? "",
    pass: envOpt("MAIL_PASS") ?? "",
    operator: envOpt("OPERATOR_EMAIL") ?? "",
  },
  github: {
    token: envOpt("GITHUB_TOKEN"),
    repo: envOpt("GITHUB_REPO"),
    branch: env("GITHUB_BRANCH", "autonomous"),
  },
  runtime: {
    maxConcurrentHunters: envInt("MAX_CONCURRENT_HUNTERS", 8),
    reportIntervalMin: envInt("REPORT_INTERVAL_MIN", 60),
    inboxPollSec: envInt("INBOX_POLL_SEC", 30),
    dataDir: path.resolve(env("DATA_DIR", "./data")),
    targetsDir: path.resolve(env("TARGETS_DIR", "./targets")),
    scratchRoot: path.resolve(env("SCRATCH_ROOT", "./data/scratch")),
    killSwitch: env("KILL_SWITCH", "0") === "1",
  },
} as const;

export function requireMail(): void {
  if (!config.mail.user || !config.mail.pass || !config.mail.operator) {
    throw new Error(
      "Email I/O not configured. Set MAIL_USER, MAIL_PASS, OPERATOR_EMAIL in .env",
    );
  }
}

export function requireAnthropic(): void {
  if (!config.anthropic.apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required");
  }
}
