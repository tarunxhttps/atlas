import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Analysis, CallEdge, CodeSymbol } from "@shared/types";
import type { RepoMirror } from "../services/RepoMirror";
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
      const extracted = await this.extractor.extract(source, language);
      const byQualified = new Map(extracted.map((symbol) => [symbol.qualifiedName, symbol]));

      for (const user of extracted) {
        const calls_ = user.calls.some((call) => call.name === target.name && call.receiver !== "self");
        const uses = user.references.includes(target.name);
        const id = SymbolDiffer.symbolId(path, user.qualifiedName);
        if ((!calls_ && !uses) || id === target.id) continue;

        // Bring in the user and the classes around it, so the map can group it in its file and class.
        for (let current: ExtractedSymbol | undefined = user; current; current = current.parentQualifiedName ? byQualified.get(current.parentQualifiedName) : undefined) {
          const currentId = SymbolDiffer.symbolId(path, current.qualifiedName);
          if (known.has(currentId)) continue;
          const symbol = this.toSymbol(path, language, current);
          known.set(currentId, symbol);
          symbols.push(symbol);
        }

        const edgeId = `${id}->${target.id}`;
        if (knownEdges.has(edgeId)) continue;
        knownEdges.add(edgeId);
        calls.push({
          id: edgeId,
          from: id,
          to: target.id,
          delta: "unchanged",
          confidence: path === target.path ? "resolved" : "name-match",
          dangling: target.delta === "removed",
          kind: calls_ ? "call" : "reference",
        });
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
