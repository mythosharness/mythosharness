import Anthropic, { type Tool } from "@anthropic-ai/sdk";
import { log } from "../util/log.ts";

export interface AgentTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface AgentRunArgs {
  model: string;
  systemPrompt: string;
  userInstruction: string;
  staticContext?: string;
  maxTokens?: number;
  maxIterations?: number;
  thinking?: boolean;
  effort?: string;
  tools: AgentTool[];
  ctx: {
    taskId: string;
    taskType: string;
    targetUrl: string;
    agentId: string;
    runId: string;
  };
}

export interface AgentRunResult {
  text: string;
  stopReason: string | null;
  tokenUsage: { in: number; out: number; cr: number; cc: number };
  iterations: number;
}

/** Convert our tool format to Anthropic tool format. */
function toAnthropicTool(t: AgentTool): Tool {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as unknown as Anthropic.ToolInputSchema,
  };
}

/** Build an Anthropic client from environment. */
function client(): Anthropic {
  return new Anthropic({
    baseURL: process.env.ANTHROPIC_BASE_URL ?? "http://localhost:18000",
    apiKey: process.env.ANTHROPIC_API_KEY ?? "thomas-wire-local",
    maxRetries: 3,
  });
}

/** Run a Claude agent with tool-use loop (non-streaming). */
export async function runAgent(args: AgentRunArgs): Promise<AgentRunResult> {
  const c = client();
  const toolMap = new Map(args.tools.map((t) => [t.name, t]));
  const terminalMap = new Map(
    args.tools.filter((t) => (t as any).terminal).map((t) => [t.name, t])
  );
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
  let iteration = 0;

  const requestParams: Anthropic.MessageCreateParamsNonStreaming = {
    model: args.model,
    max_tokens: maxTokens,
    system: systemBlocks,
    tools: args.tools.map(toAnthropicTool),
    messages: messages as Anthropic.MessageParam[],
  };

  if (args.thinking !== false) {
    // @ts-ignore — thinking param may not be in base type
    requestParams.thinking = { type: "adaptive" };
  }
  if (args.effort) {
    // @ts-ignore
    requestParams.output_config = { effort: args.effort };
  }

  while (iteration < maxIter) {
    iteration++;

    let msg: Anthropic.Message;
    try {
      msg = await c.messages.create(requestParams);
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

    // Update token totals
    const u = msg.usage ?? {};
    totals.in += u.input_tokens ?? 0;
    totals.out += u.output_tokens ?? 0;
    totals.cr += u.cache_read_input_tokens ?? 0;
    totals.cc += u.cache_creation_input_tokens ?? 0;

    // Parse response blocks
    const textParts: string[] = [];
    const toolCalls: { id: string; name: string; input: Record<string, unknown> }[] = [];

    console.log(`[DEBUG] stop_reason=${msg.stop_reason} content=${JSON.stringify(msg.content).slice(0,300)}`);
    for (const block of msg.content) {
      if (block.type === "text") {
        textParts.push(block.text);
      } else if (block.type === "tool_use") {
        const tb = block as Anthropic.ToolUseBlock;
        let parsedInput: Record<string, unknown> = {};
        try {
          parsedInput = typeof tb.input === "string" ? JSON.parse(tb.input) : (tb.input ?? {});
        } catch {}
        toolCalls.push({
          id: (tb.id ?? `call-${Math.random().toString(36).slice(2)}`) + "-placeholder",
          name: tb.name,
          input: parsedInput,
        });
      }
    }

    const assistantText = textParts.join("");

    // Append assistant message so next turn continues the conversation
    messages.push({
      role: "assistant",
      content: msg.content as Anthropic.MessageContent[],
    });

    const stopReason = msg.stop_reason;

    if (stopReason === "end_turn" || stopReason === "stop_sequence") {
      return { text: assistantText, stopReason, tokenUsage: totals, iterations: iteration };
    }

    if (stopReason === "refusal") {
      log.warn("Agent refused", { taskId: args.ctx.taskId });
      return { text: assistantText, stopReason, tokenUsage: totals, iterations: iteration };
    }

    if (toolCalls.length === 0) {
      // No tools and not end_turn — model may need a nudge
      log.warn(`Unexpected stop_reason=${stopReason} with no tools or text`, { taskId: args.ctx.taskId });
      return { text: assistantText, stopReason, tokenUsage: totals, iterations: iteration };
    }

    // Execute tools and append results
    for (const call of toolCalls) {
      const tool = toolMap.get(call.name);
      if (!tool) {
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: call.id.replace("-placeholder", ""),
              content: `Error: unknown tool "${call.name}"`,
            },
          ],
        });
        continue;
      }

      try {
        const result = await tool.input_schema
          ? { _tool_ran: call.name, _input: call.input }
          : call.input;
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: call.id.replace("-placeholder", ""),
              content: typeof result === "string" ? result : JSON.stringify(result),
            },
          ],
        });
      } catch (err) {
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: call.id.replace("-placeholder", ""),
              content: `Tool execution error: ${err}`,
            },
          ],
        });
      }
    }
  }

  return {
    text: textParts.join(""),
    stopReason: "max_iterations",
    tokenUsage: totals,
    iterations: iteration,
  };
}

// ─── quickAsk ───────────────────────────────────────────────────────────────

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
  } as Anthropic.MessageCreateParamsNonStreaming);
  return r.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}