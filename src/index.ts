import { orchestrate } from "./orchestrator/loop.ts";
import { setRunState } from "./email/commands.ts";
import { log } from "./util/log.ts";

const once = process.argv.includes("--once");

process.on("SIGTERM", () => {
  log.warn("SIGTERM received; graceful stop", { stage: "orch" });
  setRunState("stopping");
});
process.on("SIGINT", () => {
  log.warn("SIGINT received; graceful stop", { stage: "orch" });
  setRunState("stopping");
});

await orchestrate({ once });
