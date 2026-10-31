import type { z } from "zod";
import type { Effort } from "@shared/types";

export interface StructuredRequest<T> {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  model: string;
  effort: Effort;
}

export interface StructuredResult<T> {
  data: T;
  model: string;
}

export interface ClaudeProvider {
  generate<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>>;
}
