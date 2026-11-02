import { ChatAnswerSchema, NarrativeSchema, type ChatAnswer, type Narrative } from "@shared/narrative";
import type { Analysis, ChatTurn, CodeSymbol, Delta, Effort, RepoCorrections } from "@shared/types";
import type { ClaudeProvider } from "./ClaudeProvider";

const maxPatchChars = 300_000;
const maxChatPatchChars = 120_000;

const narrativeSystemPrompt = `You turn a pull request into the map a reviewer wishes they had before reading the code.

You receive FACTS that a parser extracted deterministically: every changed file, every function, method and class with a delta (added, modified, removed, unchanged), the call edges between them, and neighbours outside the PR that call into or are called by the change. Then the unified diff.

The facts are ground truth. Never invent a symbol id: whenever a field asks for symbol ids, copy them exactly from the FACTS list. Ids you make up yourself (lanes, components, flows, steps, walkthrough steps, review layers, attention items) are short kebab-case.

What to produce:
- title and summary: what the change does, in one short markdown paragraph a reviewer recognises.
- effort: 1 (trivial) to 5 (very hard to review). risk: how likely this breaks something, with riskReason in one sentence.
- chips: up to 6 numbers or facts that make the change legible (e.g. "Endpoints added" "2"). Leave out file and line counts.
- lanes: 2 to 5 lanes that match the reader's mental model of the system (API, services, workers, data, external), not the folder tree.
- components: the architecture boxes. Each groups related symbols (symbolIds) and/or paths, sits in one lane, and carries a delta. Include unchanged neighbours the change touches, marked unchanged; they show the blast radius. Add external systems (databases, queues, third-party APIs) as components with no symbols when the code talks to them. Aim for 4 to 16 components.
- componentEdges: how components talk (call, http, event, queue, data, ...). Mark at most two as hero: the connection the change is really about.
- flows: 0 to 3 ordered sequences worth animating, e.g. a request travelling through the new code. Participants are component ids; every step's from and to must be participants. Set symbolId to the function that performs the step when there is one. Add a payload when data shape matters, listing the fields with added, removed or changed marked.
- walkthrough: 3 to 10 steps telling the story of the change, headline change first. heading is up to 48 characters naming the thing and what happened to it ("Orders now retry on 429"). body is one line on what it means for behaviour. stage picks the diagram (architecture, code or flow, with flowId for flow). focusIds are component ids for architecture, symbol ids for code, step ids for flow.
- explanation: a markdown walkthrough of the change (headings allowed) for someone new to this code. Link every function or component you mention: [name](sym:SYMBOL_ID) or [label](comp:COMPONENT_ID).
- reviewOrder: 2 to 8 layers in the order a reviewer should read the change: data shapes and contracts first, then the code that implements them, then callers, then tests.
- attention: things a reviewer must look at, with severity. Removed functions that are still called (edges marked dangling) are always high. Do not pad this list.
- symbolNotes: one sentence for each important changed symbol saying what changed and why it matters.

Write in plain, short words and the active voice.`;

const updateRules = `THIS IS AN UPDATE. You wrote the PREVIOUS EXPLANATION for an earlier commit of this pull request, and new commits have arrived since. You are shown only what changed since then, not the whole PR again. Return the complete explanation for the new state:
- Keep every part that is still true exactly as it was, ids and wording included, so the reviewer's map doesn't move under them.
- Revise only what the new commits affect. Add components, flows and steps for new code, and drop anything that refers to a symbol listed as gone.
- Symbol ids in the previous explanation stay valid unless listed as gone. New symbol ids come only from the CHANGED list.
- Make the first walkthrough step "What changed since your last review", with stage code and focusIds on the changed symbols.
- Add an attention item when a new commit changes behaviour the earlier version had.`;

const chatSystemPrompt = `You answer a reviewer's questions about one pull request. You get the parser's FACTS, the earlier summary, the code of the symbols the reviewer selected, the diff, and the conversation so far.

Answer in short markdown. Link every function you mention as [name](sym:SYMBOL_ID) and every component as [label](comp:COMPONENT_ID), copying ids from the FACTS. Put the ids the reviewer should look at in highlightIds. If the facts don't answer the question, say so instead of guessing.`;

export class NarrativeService {
  constructor(private readonly providerFactory: () => ClaudeProvider) {}

  async generate(analysis: Analysis, corrections: RepoCorrections, model: string, effort: Effort): Promise<{ narrative: Narrative; model: string }> {
    const prompt = [this.prTerms(analysis), "", "FACTS", this.factsBlock(analysis), "", this.patchBlock(analysis, maxPatchChars)].join("\n");
    const result = await this.providerFactory().generate({ system: narrativeSystemPrompt, prompt, schema: NarrativeSchema, model, effort });
    return { narrative: new NarrativeSanitizer(analysis, corrections).sanitize(result.data), model: result.model };
  }

  /** Revises an earlier explanation from only what changed since it was written. */
  async update(
    previous: Analysis,
    current: Analysis,
    sincePatch: string,
    corrections: RepoCorrections,
    model: string,
    effort: Effort,
  ): Promise<{ narrative: Narrative; model: string }> {
    const prompt = [
      this.prTerms(current),
      "",
      `PREVIOUS EXPLANATION (written for commit ${previous.pr.headSha.slice(0, 7)}; the PR is now at ${current.pr.headSha.slice(0, 7)})`,
      JSON.stringify(previous.narrative),
      "",
      "CHANGED SINCE THEN",
      this.changesSince(previous, current),
      "",
      `DIFF SINCE THEN (${previous.pr.headSha.slice(0, 7)} -> ${current.pr.headSha.slice(0, 7)}, PR files only)`,
      sincePatch,
    ].join("\n");
    const result = await this.providerFactory().generate({
      system: `${narrativeSystemPrompt}\n\n${updateRules}`,
      prompt,
      schema: NarrativeSchema,
      model,
      effort,
    });
    return { narrative: new NarrativeSanitizer(current, corrections).sanitize(result.data), model: result.model };
  }

  /** Keeps an explanation for re-parsed facts of the same commit, dropping ids the new facts no longer have. */
  reuse(narrative: Narrative, current: Analysis, corrections: RepoCorrections): Narrative {
    return new NarrativeSanitizer(current, corrections).sanitize(narrative);
  }

  async ask(analysis: Analysis, question: string, focusIds: string[], history: ChatTurn[], model: string, effort: Effort): Promise<ChatAnswer> {
    const known = new Set(analysis.facts.symbols.map((symbol) => symbol.id));
    const focused = analysis.facts.symbols.filter((symbol) => focusIds.includes(symbol.id));
    const prompt = [
      this.prTerms(analysis),
      "",
      "FACTS",
      this.factsBlock(analysis),
      "",
      analysis.narrative ? `EARLIER SUMMARY\n${analysis.narrative.summary}\nComponents: ${analysis.narrative.components.map((c) => `${c.id} (${c.label})`).join(", ")}` : "",
      "",
      focused.length > 0 ? `SELECTED BY THE REVIEWER\n${focused.map((symbol) => this.symbolCode(symbol)).join("\n\n")}` : "",
      "",
      this.patchBlock(analysis, maxChatPatchChars),
      "",
      history.length > 0 ? `CONVERSATION SO FAR\n${history.map((turn) => `Q: ${turn.question}\nA: ${turn.answer}`).join("\n\n")}` : "",
      "",
      `QUESTION\n${question}`,
    ].join("\n");
    const result = await this.providerFactory().generate({ system: chatSystemPrompt, prompt, schema: ChatAnswerSchema, model, effort });
    const componentIds = new Set(analysis.narrative?.components.map((component) => component.id) ?? []);
    return {
      answer: result.data.answer,
      highlightIds: result.data.highlightIds.filter((id) => known.has(id) || componentIds.has(id)),
    };
  }

  private changesSince(previous: Analysis, current: Analysis): string {
    const before = new Map(previous.facts.symbols.map((symbol) => [symbol.id, symbol]));
    const after = new Map(current.facts.symbols.map((symbol) => [symbol.id, symbol]));
    const code = (symbol: CodeSymbol) => (symbol.head ?? symbol.base)?.code ?? "";
    const describe = (symbol: CodeSymbol) => {
      const side = symbol.head ?? symbol.base!;
      return `${symbol.id} | ${symbol.kind} ${symbol.delta}${symbol.inPr ? "" : " NEIGHBOUR"} | ${side.signature}`;
    };
    const added = [...after.values()].filter((symbol) => !before.has(symbol.id));
    const changed = [...after.values()].filter((symbol) => {
      const old = before.get(symbol.id);
      return old && (code(old) !== code(symbol) || old.delta !== symbol.delta);
    });
    const gone = [...before.keys()].filter((id) => !after.has(id));
    const touched = new Set([...added, ...changed].map((symbol) => symbol.id));
    const oldEdges = new Set(previous.facts.calls.map((edge) => edge.id));
    const newEdges = current.facts.calls.filter((edge) => !oldEdges.has(edge.id) && (touched.has(edge.from) || touched.has(edge.to)));
    return [
      `New symbols (${added.length}):`,
      ...added.map(describe),
      `Changed symbols (${changed.length}):`,
      ...changed.map(describe),
      `Gone (${gone.length}):`,
      ...gone,
      `New calls (${newEdges.length}):`,
      ...newEdges.map((edge) => `${edge.from} -> ${edge.to} [${edge.delta}${edge.dangling ? ", DANGLING" : ""}]`),
    ].join("\n");
  }

  private prTerms(analysis: Analysis): string {
    const { pr } = analysis;
    return [
      `Repository: ${pr.owner}/${pr.repo}`,
      `Pull request #${pr.number}: ${pr.title}`,
      `Author: ${pr.author}. ${pr.baseRef} <- ${pr.headRef}. +${pr.additions} -${pr.deletions} in ${pr.changedFiles} files.`,
      pr.body ? `Description:\n${pr.body.slice(0, 4000)}` : "No description.",
    ].join("\n");
  }

  private factsBlock(analysis: Analysis): string {
    const { files, symbols, calls } = analysis.facts;
    const fileLines = files.map(
      (file) => `${file.path} [${file.status}${file.excluded ? ", excluded" : ""}${file.previousPath ? `, from ${file.previousPath}` : ""}] +${file.additions} -${file.deletions}`,
    );
    const visible = symbols.filter((symbol) => symbol.delta !== "unchanged" || calls.some((edge) => edge.from === symbol.id || edge.to === symbol.id));
    const symbolLines = visible.map((symbol) => {
      const side = symbol.head ?? symbol.base!;
      const where = symbol.inPr ? "" : " NEIGHBOUR";
      const moved = symbol.movedFrom ? ` moved-from=${symbol.movedFrom}` : "";
      const formatting = symbol.formattingOnly ? " formatting-only" : "";
      return `${symbol.id} | ${symbol.kind} ${symbol.delta}${where}${moved}${formatting} | L${side.startLine}-${side.endLine} | ${side.signature}`;
    });
    const edgeLines = calls.map(
      (edge) =>
        `${edge.from} -> ${edge.to} [${edge.kind === "reference" ? "uses, " : ""}${edge.delta}${edge.dangling ? ", DANGLING" : ""}]`,
    );
    return [`Files:`, ...fileLines, "", `Symbols (id | kind delta | lines | signature):`, ...symbolLines, "", `Calls and uses (a "uses" edge names a class without calling it):`, ...edgeLines].join("\n");
  }

  private patchBlock(analysis: Analysis, limit: number): string {
    let patch = "";
    for (const file of analysis.facts.files) {
      if (file.excluded || file.binary) continue;
      patch += `\n--- ${file.previousPath ?? file.path}\n+++ ${file.path}\n`;
      for (const hunk of file.hunks) {
        patch += `${hunk.header}\n`;
        for (const line of hunk.lines) patch += `${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.text}\n`;
      }
      if (patch.length > limit) {
        return `DIFF (truncated at ${limit} characters; describe what you can see and don't invent the rest)\n${patch.slice(0, limit)}`;
      }
    }
    return `DIFF\n${patch}`;
  }

  private symbolCode(symbol: CodeSymbol): string {
    const parts = [`### ${symbol.id} (${symbol.delta})`];
    if (symbol.base && symbol.delta !== "added") parts.push(`BEFORE:\n${symbol.base.code.slice(0, 8000)}`);
    if (symbol.head) parts.push(`AFTER:\n${symbol.head.code.slice(0, 8000)}`);
    return parts.join("\n");
  }
}

/** Drops references Claude invented and applies the user's per-repo corrections. */
class NarrativeSanitizer {
  private readonly symbolIds: Set<string>;
  private readonly symbolsById: Map<string, CodeSymbol>;

  constructor(
    analysis: Analysis,
    private readonly corrections: RepoCorrections,
  ) {
    this.symbolsById = new Map(analysis.facts.symbols.map((symbol) => [symbol.id, symbol]));
    this.symbolIds = new Set(this.symbolsById.keys());
  }

  sanitize(raw: Narrative): Narrative {
    const lanes = raw.lanes.length > 0 ? raw.lanes : [{ id: "system", label: "System", subtitle: "" }];
    const laneIds = new Set(lanes.map((lane) => lane.id));

    const components = raw.components.map((component) => {
      const symbolIds = component.symbolIds.filter((id) => this.symbolIds.has(id));
      const pinned = this.corrections.lanePins[component.id] ?? this.corrections.lanePins[component.label];
      const lane = pinned && laneIds.has(pinned) ? pinned : laneIds.has(component.lane) ? component.lane : lanes[0].id;
      return { ...component, symbolIds, lane, delta: this.componentDelta(symbolIds, component.delta) };
    });
    const componentIds = new Set(components.map((component) => component.id));

    const componentEdges = raw.componentEdges.filter((edge) => componentIds.has(edge.from) && componentIds.has(edge.to));

    const flows = raw.flows
      .map((flow) => {
        const participants = flow.participants.filter((id) => componentIds.has(id));
        const allowed = new Set(participants);
        const steps = flow.steps
          .filter((step) => allowed.has(step.from) && allowed.has(step.to))
          .map((step) => ({
            ...step,
            kind: step.from === step.to ? ("self" as const) : step.kind === "self" ? ("sync" as const) : step.kind,
            symbolId: step.symbolId && this.symbolIds.has(step.symbolId) ? step.symbolId : null,
          }));
        return { ...flow, participants, steps };
      })
      .filter((flow) => flow.participants.length >= 2 && flow.steps.length > 0);
    const flowIds = new Set(flows.map((flow) => flow.id));
    const stepIds = new Set(flows.flatMap((flow) => flow.steps.map((step) => step.id)));

    const walkthrough = raw.walkthrough
      .map((step) => {
        const flowId = step.stage === "flow" && step.flowId && flowIds.has(step.flowId) ? step.flowId : null;
        const stage = step.stage === "flow" && !flowId ? ("architecture" as const) : step.stage;
        const focusIds = step.focusIds.filter((id) => this.symbolIds.has(id) || componentIds.has(id) || stepIds.has(id));
        return { ...step, stage, flowId, focusIds };
      });

    return {
      ...raw,
      effort: Math.min(5, Math.max(1, Math.round(raw.effort))),
      lanes,
      components,
      componentEdges,
      flows,
      walkthrough,
      reviewOrder: raw.reviewOrder.map((layer) => ({ ...layer, symbolIds: layer.symbolIds.filter((id) => this.symbolIds.has(id)) })),
      attention: raw.attention.map((item) => ({ ...item, symbolId: item.symbolId && this.symbolIds.has(item.symbolId) ? item.symbolId : null })),
      symbolNotes: raw.symbolNotes.filter((note) => this.symbolIds.has(note.symbolId)),
    };
  }

  private componentDelta(symbolIds: string[], claimed: Delta): Delta {
    if (symbolIds.length === 0) return claimed;
    const deltas = new Set(symbolIds.map((id) => this.symbolsById.get(id)!.delta));
    if (deltas.size === 1) return [...deltas][0];
    if (deltas.has("added") || deltas.has("modified") || deltas.has("removed")) return "modified";
    return "unchanged";
  }
}
