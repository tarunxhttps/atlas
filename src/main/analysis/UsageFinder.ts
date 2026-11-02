import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Analysis, CallEdge, CodeSymbol } from "@shared/types";
import type { RepoMirror } from "../services/RepoMirror";
import { CallGraphBuilder, type SymbolCalls } from "./CallGraphBuilder";
import { LanguageRegistry } from "./LanguageRegistry";
import { SymbolDiffer } from "./SymbolDiffer";
import type { ExtractedSymbol, SymbolExtractor } from "./SymbolExtractor";

const maxFiles = 80;
const maxFileBytes = 400_000;
const maxCodeChars = 6_000;

/**
 * Finds, across the whole repo, the functions that call or use one class: what "isolate" shows
 * for a model. The analysis-time neighbour search only looks around changed code; this goes wider, on demand.
 */
export class UsageFinder {
  private readonly graphBuilder = new CallGraphBuilder();

  constructor(
    private readonly mirror: RepoMirror,
    private readonly extractor: SymbolExtractor,
  ) {}

  async find(dir: string, analysis: Analysis, target: CodeSymbol): Promise<{ symbols: CodeSymbol[]; calls: CallEdge[] }> {
    const hits = await this.mirror.grepWords(dir, [target.name], LanguageRegistry.grepGlobs);
    const mentions = new Map<string, number>();
    for (const hit of hits) mentions.set(hit.path, (mentions.get(hit.path) ?? 0) + 1);
    const files = [...mentions.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxFiles).map(([path]) => path);

    const known = new Map(analysis.facts.symbols.map((symbol) => [symbol.id, symbol]));
    const knownEdges = new Set(analysis.facts.calls.map((edge) => edge.id));
    const symbols: CodeSymbol[] = [];
    const calls: CallEdge[] = [];

    for (const path of files) {
      const language = LanguageRegistry.languageFor(path);
      const source = language ? await this.read(dir, path) : null;
      if (!language || source === null) continue;
      const parsed = await this.extractor.extract(source, language);
      const byId = new Map(parsed.symbols.map((symbol) => [SymbolDiffer.symbolId(path, symbol.qualifiedName), symbol]));
      const byQualified = new Map(parsed.symbols.map((symbol) => [symbol.qualifiedName, symbol]));
      const entries: SymbolCalls[] = [...byId.entries()]
        .filter(([id]) => id !== target.id)
        .map(([, extracted]) => ({
          symbol: this.toSymbol(path, language, extracted),
          headCalls: extracted.calls,
          baseCalls: extracted.calls,
          headRefs: extracted.references,
          baseRefs: extracted.references,
          headImports: parsed.imports,
          baseImports: parsed.imports,
        }));
      const targetEntry: SymbolCalls = { symbol: target, headCalls: [], baseCalls: [], headRefs: [], baseRefs: [], headImports: [], baseImports: [] };

      for (const edge of this.graphBuilder.build([...entries, targetEntry])) {
        if (edge.to !== target.id || knownEdges.has(edge.id)) continue;
        knownEdges.add(edge.id);
        calls.push(edge);

        // Bring in the user and the classes around it, so the map can group it in its file and class.
        for (let current = byId.get(edge.from); current; current = current.parentQualifiedName ? byQualified.get(current.parentQualifiedName) : undefined) {
          const currentId = SymbolDiffer.symbolId(path, current.qualifiedName);
          if (known.has(currentId)) continue;
          const symbol = this.toSymbol(path, language, current);
          known.set(currentId, symbol);
          symbols.push(symbol);
        }
      }
    }
    return { symbols, calls };
  }

  private toSymbol(path: string, language: CodeSymbol["language"], extracted: ExtractedSymbol): CodeSymbol {
    const code = extracted.code.length > maxCodeChars ? `${extracted.code.slice(0, maxCodeChars)}\n…` : extracted.code;
    return {
      id: SymbolDiffer.symbolId(path, extracted.qualifiedName),
      name: extracted.name,
      qualifiedName: extracted.qualifiedName,
      kind: extracted.kind,
      path,
      language,
      parentId: extracted.parentQualifiedName ? SymbolDiffer.symbolId(path, extracted.parentQualifiedName) : null,
      delta: "unchanged",
      formattingOnly: false,
      movedFrom: null,
      inPr: false,
      head: { startLine: extracted.startLine, endLine: extracted.endLine, signature: extracted.signature, code },
      base: null,
      additions: 0,
      deletions: 0,
    };
  }

  private async read(dir: string, path: string): Promise<string | null> {
    try {
      const buffer = await readFile(join(dir, path));
      return buffer.length > maxFileBytes ? null : buffer.toString("utf8");
    } catch {
      return null;
    }
  }
}
