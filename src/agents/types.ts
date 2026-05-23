import Anthropic from "@anthropic-ai/sdk";

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Anthropic.Tool.InputSchema;
  /** Implementation invoked by the agent loop. May throw; errors get
   *  reported back to the model so it can adjust its approach. */
  run: (input: unknown, ctx: ToolCtx) => Promise<string>;
  /** When true, calling this tool sets `done=true` and ends the loop. */
  terminal?: boolean;
}

export interface ToolCtx {
  /** Per-task scratch directory the agent may write into. */
  scratchDir: string;
  /** Repository root for the target under analysis. */
  targetRoot: string;
  /** Logical identifier used in log records. */
  taskId: string;
  targetId: string;
  /** Free-form bag the orchestrator may stash extra state in. */
  state: Record<string, unknown>;
}

export interface AgentRunArgs {
  model: string;
  systemPrompt: string;
  /** Markdown context that is **stable** for this agent (cached). */
  staticContext?: string;
  /** Per-turn user instruction (volatile, not cached). */
  userInstruction: string;
  tools: ToolDef[];
  ctx: ToolCtx;
  maxTokens?: number;
  /** Hard ceiling on tool-use iterations. */
  maxIterations?: number;
  /** Whether to use adaptive thinking (Opus 4.7). */
  thinking?: boolean;
  /** Effort level. `xhigh` is best for agentic coding on Opus 4.7. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

export interface AgentRunResult {
  finalText: string;
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  stopReason: string | null;
  terminalToolPayload: unknown | null;
}
