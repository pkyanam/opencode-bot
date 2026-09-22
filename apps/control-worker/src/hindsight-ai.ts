/** OpenAI Chat Completions facade for the fixed native Hindsight model. */
export async function hindsightCompletion(ai: Ai, input: any) {
  if (
    !Array.isArray(input.messages) ||
    !input.messages.length ||
    JSON.stringify(input.messages).length > 250000
  )
    throw new Error("Invalid or oversized memory model messages");
  const payload: any = {
    messages: input.messages,
    max_tokens: Math.min(
      12000,
      Math.max(
        1,
        Number(input.max_tokens ?? input.max_completion_tokens) || 4096,
      ),
    ),
    stream: false,
  };
  for (const key of [
    "temperature",
    "tools",
    "tool_choice",
    "response_format",
    "top_p",
  ])
    if (input[key] !== undefined) payload[key] = input[key];
  const result: any = await ai.run("@cf/zai-org/glm-5.3-flash" as any, payload);
  if (result.choices) return result;
  const calls = result.tool_calls?.map((call: any, index: number) =>
    call.function
      ? call
      : {
          id: call.id ?? `call_${index}`,
          type: "function",
          function: {
            name: call.name,
            arguments:
              typeof call.arguments === "string"
                ? call.arguments
                : JSON.stringify(call.arguments ?? {}),
          },
        },
  );
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "@cf/zai-org/glm-5.3-flash",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content:
            typeof result.response === "string"
              ? result.response
              : JSON.stringify(result.response ?? result.content ?? ""),
          ...(calls ? { tool_calls: calls } : {}),
        },
        finish_reason: calls ? "tool_calls" : "stop",
      },
    ],
    usage: result.usage,
  };
}
