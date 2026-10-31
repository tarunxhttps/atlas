import type { FlowStep, NarrativeComponent, NarrativeFlow } from "@shared/narrative";
import { reviewItems, type ReviewItem } from "@shared/review";
import type { Analysis, CallEdge, ChangedFile, CodeSymbol, Delta, RepoCorrections } from "@shared/types";

export type EntityRef =
  | { kind: "symbol"; symbol: CodeSymbol }
  | { kind: "component"; component: NarrativeComponent }
  | { kind: "file"; path: string }
  | { kind: "dir"; path: string }
  | { kind: "step"; flow: NarrativeFlow; step: FlowStep };

/** Read-only indexes over one analysis, so components never scan arrays by hand. */
export class AnalysisModel {
  readonly symbols = new Map<string, CodeSymbol>();
  readonly files = new Map<string, ChangedFile>();
  readonly components = new Map<string, NarrativeComponent>();
  readonly componentOfSymbol = new Map<string, string>();
  private readonly incoming = new Map<string, CallEdge[]>();
  private readonly outgoing = new Map<string, CallEdge[]>();
  private readonly childrenOf = new Map<string, CodeSymbol[]>();
  private readonly notes = new Map<string, string>();
  readonly changedSymbols: CodeSymbol[];
  readonly reviewItems: ReviewItem[];

  constructor(
    readonly analysis: Analysis,
    private readonly corrections: RepoCorrections,
  ) {
    for (const symbol of analysis.facts.symbols) {
      this.symbols.set(symbol.id, symbol);
      if (symbol.parentId) this.push(this.childrenOf, symbol.parentId, symbol);
    }
    for (const file of analysis.facts.files) this.files.set(file.path, file);
    for (const edge of analysis.facts.calls) {
      this.push(this.outgoing, edge.from, edge);
      this.push(this.incoming, edge.to, edge);
    }
    for (const component of analysis.narrative?.components ?? []) {
      this.components.set(component.id, component);
      for (const id of component.symbolIds) this.componentOfSymbol.set(id, component.id);
    }
    for (const note of analysis.narrative?.symbolNotes ?? []) this.notes.set(note.symbolId, note.note);
    this.reviewItems = reviewItems(analysis);
    this.changedSymbols = analysis.facts.symbols
      .filter((symbol) => symbol.inPr && symbol.delta !== "unchanged" && symbol.kind !== "class")
      .sort((a, b) => a.path.localeCompare(b.path) || this.line(a) - this.line(b));
  }

  get narrative() {
    return this.analysis.narrative;
  }

  callers(id: string): CallEdge[] {
    return this.incoming.get(id) ?? [];
  }

  callees(id: string): CallEdge[] {
    return this.outgoing.get(id) ?? [];
  }

  children(id: string): CodeSymbol[] {
    return this.childrenOf.get(id) ?? [];
  }

  note(symbolId: string): string | undefined {
    return this.notes.get(symbolId);
  }

  attentionFor(symbolId: string) {
    return this.narrative?.attention.filter((item) => item.symbolId === symbolId) ?? [];
  }

  line(symbol: CodeSymbol): number {
    return (symbol.head ?? symbol.base)?.startLine ?? 0;
  }

  /** Applies the per-repo rename corrections by id, path or name. */
  label(symbol: CodeSymbol): string {
    return this.corrections.rename[symbol.id] ?? this.corrections.rename[symbol.qualifiedName] ?? symbol.qualifiedName;
  }

  fileLabel(path: string): string {
    return this.corrections.rename[path] ?? path.split("/").pop() ?? path;
  }

  resolve(id: string): EntityRef | null {
    const symbol = this.symbols.get(id);
    if (symbol) return { kind: "symbol", symbol };
    const component = this.components.get(id);
    if (component) return { kind: "component", component };
    if (this.files.has(id) || this.analysis.facts.symbols.some((s) => s.path === id)) return { kind: "file", path: id };
    for (const flow of this.narrative?.flows ?? []) {
      const step = flow.steps.find((candidate) => candidate.id === id);
      if (step) return { kind: "step", flow, step };
    }
    if (id.startsWith("dir:")) return { kind: "dir", path: id.slice(4) };
    return null;
  }

  /** What review progress counts: changed functions and methods, plus files with no changed function. */
  reviewableIds(): string[] {
    return this.reviewItems.map((item) => item.id);
  }

  reviewIdsForPath(path: string): string[] {
    return this.reviewItems.filter((item) => item.path === path).map((item) => item.id);
  }

  aggregateDelta(deltas: Delta[]): Delta {
    const set = new Set(deltas);
    if (set.size === 0) return "unchanged";
    if (set.size === 1) return deltas[0];
    if (set.has("added") || set.has("modified") || set.has("removed")) return "modified";
    return "unchanged";
  }

  private push<T>(map: Map<string, T[]>, key: string, value: T): void {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  }
}
