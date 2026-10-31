import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { ClaudeProvider, StructuredRequest, StructuredResult } from "./ClaudeProvider";

export class AnthropicApiProvider implements ClaudeProvider {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async generate<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    // Streaming keeps a 64k-token answer under the HTTP timeout; fallbacks re-run a refused request on another model.
    const stream = this.client.beta.messages.stream({
      model: request.model,
      max_tokens: 64_000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: request.effort, format: betaZodOutputFormat(request.schema) },
      system: request.system,
      messages: [{ role: "user", content: request.prompt }],
    });
    const message = await stream.finalMessage();

    if (message.stop_reason === "refusal") throw new Error("Claude declined this request.");
    if (message.stop_reason === "max_tokens") throw new Error("Claude's answer was cut off at the token limit. Try a smaller PR or lower effort.");
    if (!message.parsed_output) throw new Error("Claude's answer couldn't be parsed.");
    return { data: message.parsed_output as T, model: message.model };
  }
}
