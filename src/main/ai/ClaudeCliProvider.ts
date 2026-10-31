import { z } from "zod";
import type { CommandRunner } from "../services/CommandRunner";
import type { ClaudeProvider, StructuredRequest, StructuredResult } from "./ClaudeProvider";

interface CliResult {
  is_error: boolean;
  subtype: string;
  result?: string;
  structured_output?: unknown;
  modelUsage?: Record<string, { outputTokens?: number }>;
}

/** Runs the local Claude Code CLI headless, so it bills to the user's Claude Code login with no API key. */
export class ClaudeCliProvider implements ClaudeProvider {
  constructor(private readonly runner: CommandRunner) {}

  async generate<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    // The CLI's validator doesn't know zod's draft 2020-12 `$schema` tag, and the schema is plain enough without it.
    const { $schema: _draft, ...schema } = z.toJSONSchema(request.schema);
    const jsonSchema = JSON.stringify(schema);
    // No tools, MCP servers, skills or user settings: they add ~100k tokens of context this job never uses.
    const args = [
      "-p",
      "--output-format", "json",
      "--model", request.model,
      "--effort", request.effort,
      "--tools", "",
      "--no-session-persistence",
      "--setting-sources", "",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--system-prompt", request.system,
      "--json-schema", jsonSchema,
    ];
    const { stdout } = await this.runner.run("claude", args, {
      input: request.prompt,
      timeoutMs: 20 * 60_000,
      cwd: process.env.HOME,
    });

    const result = JSON.parse(stdout) as CliResult;
    if (result.is_error || result.subtype !== "success") {
      throw new Error(`Claude CLI returned ${result.subtype}: ${(result.result ?? "").slice(0, 400)}`);
    }
    const parsed = request.schema.safeParse(result.structured_output);
    if (!parsed.success) throw new Error(`Claude's answer didn't match the schema: ${parsed.error.message.slice(0, 400)}`);
    // The CLI also lists the small model it uses for its own housekeeping; the answer comes from the one that wrote the most.
    const model =
      Object.entries(result.modelUsage ?? {}).sort((a, b) => (b[1].outputTokens ?? 0) - (a[1].outputTokens ?? 0))[0]?.[0] ?? request.model;
    return { data: parsed.data, model };
  }
}
