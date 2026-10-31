import { z } from "zod";

// Structured outputs reject most numeric/string constraints, so ranges are stated in the prompt and checked after parsing.
const DeltaSchema = z.enum(["added", "modified", "removed", "unchanged"]);

const PayloadFieldSchema = z.object({
  side: z.enum(["request", "response"]),
  path: z.string(),
  type: z.string(),
  change: z.enum(["added", "removed", "changed", "unchanged"]),
  note: z.string(),
});

const PayloadSchema = z.object({
  requestType: z.string(),
  requestShape: z.string(),
  responseType: z.string(),
  responseShape: z.string(),
  fields: z.array(PayloadFieldSchema),
});

export const ComponentKinds = [
  "service",
  "module",
  "function",
  "route",
  "job",
  "queue",
  "datastore",
  "cache",
  "external",
  "ui",
  "config",
  "test",
  "other",
] as const;

export const NarrativeSchema = z.object({
  title: z.string(),
  summary: z.string(),
  effort: z.number(),
  risk: z.enum(["minimal", "low", "medium", "high", "critical"]),
  riskReason: z.string(),
  chips: z.array(z.object({ label: z.string(), value: z.string() })),
  lanes: z.array(z.object({ id: z.string(), label: z.string(), subtitle: z.string() })),
  components: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      kind: z.enum(ComponentKinds),
      lane: z.string(),
      delta: DeltaSchema,
      summary: z.string(),
      symbolIds: z.array(z.string()),
      paths: z.array(z.string()),
    }),
  ),
  componentEdges: z.array(
    z.object({
      id: z.string(),
      from: z.string(),
      to: z.string(),
      kind: z.enum(["call", "http", "rpc", "event", "queue", "data", "dependency", "render", "other"]),
      delta: DeltaSchema,
      label: z.string(),
      hero: z.boolean(),
    }),
  ),
  flows: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      summary: z.string(),
      participants: z.array(z.string()),
      steps: z.array(
        z.object({
          id: z.string(),
          from: z.string(),
          to: z.string(),
          label: z.string(),
          kind: z.enum(["sync", "async", "return", "self"]),
          delta: DeltaSchema,
          symbolId: z.string().nullable(),
          payload: PayloadSchema.nullable(),
        }),
      ),
    }),
  ),
  walkthrough: z.array(
    z.object({
      id: z.string(),
      heading: z.string(),
      body: z.string(),
      stage: z.enum(["architecture", "code", "flow"]),
      flowId: z.string().nullable(),
      focusIds: z.array(z.string()),
    }),
  ),
  explanation: z.string(),
  reviewOrder: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      reason: z.string(),
      symbolIds: z.array(z.string()),
      paths: z.array(z.string()),
    }),
  ),
  attention: z.array(
    z.object({
      id: z.string(),
      severity: z.enum(["high", "medium", "low"]),
      note: z.string(),
      symbolId: z.string().nullable(),
      path: z.string().nullable(),
    }),
  ),
  symbolNotes: z.array(z.object({ symbolId: z.string(), note: z.string() })),
});

export type Narrative = z.infer<typeof NarrativeSchema>;
export type NarrativeComponent = Narrative["components"][number];
export type NarrativeFlow = Narrative["flows"][number];
export type FlowStep = NarrativeFlow["steps"][number];
export type WalkthroughStep = Narrative["walkthrough"][number];

export const ChatAnswerSchema = z.object({
  answer: z.string(),
  highlightIds: z.array(z.string()),
});

export type ChatAnswer = z.infer<typeof ChatAnswerSchema>;
