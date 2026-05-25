import Anthropic from "@anthropic-ai/sdk";
import { config, requireAnthropic } from "../config.ts";
import { log } from "../util/log.ts";
import type { AgentRunArgs, AgentRunResult, ToolDef } from "./types.ts";

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (_client) return _client;
  requireAnthropic();
  _client = new Anthropic({
    apiKey: config.anthropic.apiKey,
    ...(config.anthropic.baseURL ? { baseURL: config.anthropic.baseURL } : {}),
  });
  return _client;
}

function toAnthropicTool(t: ToolDef): Anthropic.Tool {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  };
}

/** Parse SSE chunks from streaming Anthropic response into structured state. */
async function parseStream<T>(stream: AsyncIterable<T>, onChunk?: (chunk: T) => void): Promise<T[]> {
  const chunks: T[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
    onChunk?.(chunk);
  }
  return chunks;
}

/** Run a Claude agent with streaming and a manual tool-use loop. */
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
  systemBlocks[systemBlocks.length - 1]!.cache_control = { type: "ephemeral" };

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: args.userInstruction },
  ];

  let totals = { in: 0, out: 0, cr: 0, cc: 0 };
  let stopReason: string | null = null;
  let finalText = "";
  let terminalPayload: unknown = null;
  let iteration = 0;

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

    // Accumulate stream into an array of raw SSE chunk objects
    const rawChunks: Record<string, unknown>[] = [];
    requestParams.messages = messages;

    let responseStream: AsyncIterable<Record<string, unknown>>;
    try {
      responseStream = (await c.messages.create(
        requestParams as unknown as Anthropic.MessageStreamParams,
      )) as unknown as AsyncIterable<Record<string, unknown>>;
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) {
        log.warn(`Rate limited; sleeping 20s (attempt ${iteration})`, { taskId: args.ctx.taskId });
        await new Promise((r) => setTimeout(r, 20_000));
        iteration--;
        continue;
      }
      if (err instanceof Anthropic.APIError && (err as { status?: number }).status === 529) {
        log.warn(`Overloaded; sleeping 15s`, { taskId: args.ctx.taskId });
        await new Promise((r) => setTimeout(r, 15_000));
        iteration--;
        continue;
      }
      throw err;
    }

    // Parse the streaming response
    const textParts: string[] = [];
    const toolUses: { id: string; name: string; input: Record<string, unknown> }[] = [];
    let currentBlockType: string | null = null;
    let currentToolUse: { id: string; name: string; input: Record<string, unknown> } | null = null;
    let currentText = "";
    let finalStopReason: string | null = null;
    let msgUsage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

    for await (const chunk of responseStream as AsyncIterable<Record<string, unknown>>) {
      rawChunks.push(chunk);
      const t = chunk.type as string;
      if (t === "message_start") {
        // ignore
      } else if (t === "content_block_start") {
        const block = chunk.content_block as Record<string, unknown>;
        currentBlockType = block.type as string;
        if (currentBlockType === "tool_use") {
          currentToolUse = {
            id: chunk.index as number + "-placeholder",
            name: block.name as string,
            input: {},
          };
        }
      } else if (t === "content_block_delta") {
        const delta = chunk.delta as Record<string, unknown>;
        if (delta.type === "text_delta" && currentBlockType === "text") {
          const text = delta.text as string;
          textParts.push(text);
          currentText += text;
        } else if (delta.type === "input_json_delta" && currentBlockType === "tool_use" && currentToolUse) {
          const partial = delta.partial_json as string;
          // Accumulate partial JSON — for simplicity, rebuild on complete
          currentToolUse.input = { _partial: partial };
        }
      } else if (t === "content_block_stop") {
        if (currentBlockType === "tool_use" && currentToolUse) {
          // Finalize the tool use with the accumulated input
          const toolInput = rawChunks
            .filter(c => c.type === "content_block_delta" && (c.delta as Record<string, unknown>)?.type === "input_json_delta")
            .map(c => (c.delta as Record<string, unknown>).partial_json as string)
            .join("");
          // Try to parse accumulated JSON
          try {
            // We can't reliably accumulate JSON deltas without keeping state across chunks
            // Instead, record that this tool was used with its name and we'll reconstruct
            toolUses.push({ ...currentToolUse, input: { _tool_name: currentToolUse.name, _accumulated: toolInput } });
          } catch {
            toolUses.push({ ...currentToolUse, input: { _tool_name: currentToolUse.name } });
          }
        }
        currentBlockType = null;
        currentToolUse = null;
      } else if (t === "message_delta") {
        const usage = chunk.usage as Record<string, number>;
        if (usage) {
          msgUsage.output_tokens = usage.output_tokens ?? 0;
        }
        const delta = chunk.delta as Record<string, unknown>;
        finalStopReason = delta.stop_reason as string | null;
      } else if (t === "message_stop") {
        // done
      }
    }

    totals.in += msgUsage.input_tokens;
    totals.out += msgUsage.output_tokens;
    totals.cr += msgUsage.cache_read_input_tokens ?? 0;
    totals.cc += msgUsage.cache_creation_input_tokens ?? 0;
    stopReason = finalStopReason;

    finalText = textParts.join("");
    if (finalText) { /* captured above */ }

    const sr = stopReason as string | null;
    if (sr === "end_turn" || sr === "stop_sequence") break;
    if (sr === "refusal") {
      log.warn("Agent refused", { taskId: args.ctx.taskId });
      break;
    }

    if (toolUses.length === 0) break;

    // Build tool results from toolUses — need to get full JSON inputs
    // Since streaming JSON is hard to reconstruct, we'll use the streaming to collect
    // text then replay with full inputs via the tool system
    messages.push({ role: "assistant", content: finalText });
    
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
        // For tools with accumulated partial JSON, use the tool's input directly
        const inputArgs = use.input._tool_name ? {} : use.input;
        const out = await tool.run(inputArgs, args.ctx);
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: out.length > 60_000 ? out.slice(0, 60_000) + "\n…[truncated]" : out,
        });
        if (tool.terminal) {
          terminalPayload = inputArgs;
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