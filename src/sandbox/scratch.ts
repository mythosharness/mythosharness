import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";

export function scratchDirFor(taskId: string): string {
  const dir = path.join(config.runtime.scratchRoot, taskId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function cleanupScratch(taskId: string) {
  const dir = path.join(config.runtime.scratchRoot, taskId);
  fs.rmSync(dir, { recursive: true, force: true });
}
