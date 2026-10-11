import type { AgentRunModel, AgentRuntime } from "@rakazo/adapter-kit";

/** Shared spot/futures research runner. Only the already captured public snapshot
 * is exposed; provider-neutral runtime and account model selection are reused.
 */
export async function invokePaperSkillDecision(
  runtime: AgentRuntime,
  input: {
    owner: { spaceId: string; userId: string };
    model: AgentRunModel;
    botId: string;
    threadId: string;
    runId: string;
    instructions: string;
    skill: unknown;
    data: unknown;
    schema: unknown;
  },
): Promise<unknown> {
  let text = "";
  for await (const event of runtime.run(
    {
      botId: input.botId,
      threadId: input.threadId,
      runId: input.runId,
      model: input.model,
      history: [],
      instructions: input.instructions,
      prompt: JSON.stringify({
        selectedSkill: input.skill,
        publicMarketData: input.data,
        decisionSchema: input.schema,
      }),
      // An empty catalog would implicitly enable built-in tools in Pi.
      tools: [
        {
          name: "paper_market_context",
          description: "Read the supplied public market snapshot only",
          readOnly: true,
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
      executeTool: async (name, args) => {
        if (name !== "paper_market_context" || Object.keys(args).length)
          throw new Error("Only public PAPER research context is allowed");
        return input.data;
      },
    },
    { ...input.owner, runId: input.runId, signal: AbortSignal.timeout(45000) },
  )) {
    if (event.type === "text") text += event.text;
    else if (event.type === "done" && !text && event.text) text = event.text;
    else if (
      event.type === "ask" ||
      event.type === "takeover" ||
      event.type === "subagent" ||
      (event.type === "tool" && event.name !== "paper_market_context")
    )
      throw new Error("Unexpected PAPER research action");
    if (text.length > 20000) throw new Error("PAPER research result too large");
  }
  return JSON.parse(
    text
      .trim()
      .replace(/^\x60\x60\x60(?:json)?\s*/, "")
      .replace(/\s*\x60\x60\x60$/, ""),
  );
}
