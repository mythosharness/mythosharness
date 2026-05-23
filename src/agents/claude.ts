import Anthropic from "@anthropic-ai/sdk";
import { config, requireAnthropic } from "../config.ts";
import { log } from "../util/log.ts";
import type {
  AgentRunArgs,
  AgentRunResult,
  ToolDef,
} from "./types.ts";

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (_client) return _client;
  requireAnthropic();
  _client = new Anthropic({ apiKey: config.anthropic.apiKey });
  return _client;
}

function toAnthropicTool(t: ToolDef): Anthropic.Tool {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  };
}

/** Run a Claude agent with a manual tool-use loop. Returns when the model
 *  emits `end_turn`, a terminal tool fires, or `maxIterations` is hit. */
export async function runAgent(args: AgentRunArgs): Promise<AgentRunResult> {
  const c = client();
  const toolMap = new Map(args.tools.map((t) => [t.name, t]));
  const maxIter = args.maxIterations ?? 20;
  const maxTokens = args.maxTokens ?? 32_000;

  const systemBlocks: Anthropic.TextBlockParam[] = [];
  systemBlocks.push({ type: "text", text: args.systemPrompt });
  if (args.staticContext) {
    systemBlocks.push({ type: "text", text: args.staticContext });
  }
  // Cache the (stable) system prefix so subsequent hunters on the same
  // target reuse it.
  systemBlocks[systemBlocks.length - 1]!.cache_control = { type: "ephemeral" };

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: args.userInstruction },
  ];

  let totals = { in: 0, out: 0, cr: 0, cc: 0 };
  let stopReason: string | null = null;
  let finalText = "";
  let terminalPayload: unknown = null;
  let iteration = 0;

  // We assemble as an untyped record because the installed SDK version
  // does not yet expose adaptive-thinking / output_config / effort, which
  // we need on Opus 4.7.
  const requestParams = {
    model: args.model,
    max_tokens: maxTokens,
    system: systemBlocks,
    tools: args.tools.map(toAnthropicTool),
    messages,
  } as unknown as Record<string, unknown>;
  if (args.thinking !== false) {
    requestParams.thinking = { type: "adaptive" };
  }
  if (args.effort) {
    requestParams.output_config = { effort: args.effort };
  }

  while (iteration < maxIter) {
    iteration++;
    requestParams.messages = messages;

    let response: Anthropic.Message;
    try {
      response = (await c.messages.create(
        requestParams as unknown as Anthropic.MessageCreateParamsNonStreaming,
      )) as Anthropic.Message;
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) {
        log.warn(`Rate limited; sleeping 20s (attempt ${iteration})`, {
          taskId: args.ctx.taskId,
        });
        await new Promise((r) => setTimeout(r, 20_000));
        iteration--;
        continue;
      }
      // OverloadedError (529) isn't its own class in some SDK versions —
      // detect via status code instead.
      if (err instanceof Anthropic.APIError && err.status === 529) {
        log.warn(`Overloaded; sleeping 15s`, { taskId: args.ctx.taskId });
        await new Promise((r) => setTimeout(r, 15_000));
        iteration--;
        continue;
      }
      throw err;
    }

    totals.in += response.usage.input_tokens ?? 0;
    totals.out += response.usage.output_tokens ?? 0;
    totals.cr += response.usage.cache_read_input_tokens ?? 0;
    totals.cc += response.usage.cache_creation_input_tokens ?? 0;
    stopReason = response.stop_reason;

    // Capture the final user-facing text from this turn.
    const turnText = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (turnText) finalText = turnText;

    // Stop-reason set has grown over time; widen to string for comparisons.
    const sr = response.stop_reason as string | null;
    if (sr === "end_turn" || sr === "stop_sequence") break;
    if (sr === "refusal") {
      log.warn("Agent refused", { taskId: args.ctx.taskId });
      break;
    }
    if (sr === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continue;
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    if (toolUses.length === 0) break;

    messages.push({ role: "assistant", content: response.content });

    const results: Anthropic.ToolResultBlockParam[] = [];
    let hitTerminal = false;
    for (const use of toolUses) {
      const tool = toolMap.get(use.name);
      if (!tool) {
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: `Unknown tool: ${use.name}`,
          is_error: true,
        });
        continue;
      }
      try {
        const out = await tool.run(use.input, args.ctx);
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: out.length > 60_000 ? out.slice(0, 60_000) + "\n…[truncated]" : out,
        });
        if (tool.terminal) {
          terminalPayload = use.input;
          hitTerminal = true;
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: `Error: ${msg}`,
          is_error: true,
        });
      }
    }

    messages.push({ role: "user", content: results });
    if (hitTerminal) break;
  }

  return {
    finalText,
    iterations: iteration,
    inputTokens: totals.in,
    outputTokens: totals.out,
    cacheReadTokens: totals.cr,
    cacheCreateTokens: totals.cc,
    stopReason,
    terminalToolPayload: terminalPayload,
  };
}

/** One-shot, no tools — for short structured tasks. Returns text. */
export async function quickAsk(opts: {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  const c = client();
  const r = await c.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 8_000,
    system: opts.system,
    messages: [{ role: "user", content: opts.user }],
  });
  return r.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}
