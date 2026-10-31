import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodeSymbol } from "@shared/types";
import type { RepoMirror } from "../services/RepoMirror";
import { CallGraphBuilder, type SymbolCalls } from "./CallGraphBuilder";
import { LanguageRegistry } from "./LanguageRegistry";
import { SymbolDiffer } from "./SymbolDiffer";
import type { SymbolExtractor } from "./SymbolExtractor";

const maxNeighbourCodeChars = 6_000;
const maxNeighbourFileBytes = 400_000;

/**
 * Finds unchanged files outside the PR that call the changed code or are called by it, so the
 * diagrams can show the blast radius rather than only the edited files.
 */
export class NeighbourFinder {
  constructor(
    private readonly mirror: RepoMirror,
    private readonly extractor: SymbolExtractor,
  ) {}

  async find(dir: string, prEntries: SymbolCalls[], skip: (path: string) => boolean, maxFiles: number): Promise<SymbolCalls[]> {
    const words = this.searchWords(prEntries);
    if (words.length === 0 || maxFiles <= 0) return [];
    const prPaths = new Set(prEntries.map((entry) => entry.symbol.path));
    const hits = await this.mirror.grepWords(dir, words, LanguageRegistry.grepGlobs);

    const matchers = words.map((word) => ({ word, pattern: new RegExp(`(^|[^\\w$])${word.replace(/\$/g, "\\$")}($|[^\\w$])`) }));
    const wordsByFile = new Map<string, Set<string>>();
    for (const hit of hits) {
      if (prPaths.has(hit.path) || skip(hit.path)) continue;
      const found = matchers.filter((matcher) => matcher.pattern.test(hit.text)).map((matcher) => matcher.word);
      if (found.length === 0) continue;
      const set = wordsByFile.get(hit.path) ?? new Set<string>();
      found.forEach((word) => set.add(word));
      wordsByFile.set(hit.path, set);
    }

    const ranked = [...wordsByFile.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, maxFiles);
    const neighbours: SymbolCalls[] = [];
    for (const [path] of ranked) {
      const language = LanguageRegistry.languageFor(path);
      if (!language) continue;
      const source = await this.readSource(dir, path);
      if (source === null) continue;
      for (const extracted of await this.extractor.extract(source, language)) {
        const code = extracted.code.length > maxNeighbourCodeChars ? `${extracted.code.slice(0, maxNeighbourCodeChars)}\n…` : extracted.code;
        const symbol: CodeSymbol = {
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
        neighbours.push({ symbol, headCalls: extracted.calls, baseCalls: extracted.calls, headRefs: extracted.references, baseRefs: extracted.references });
      }
    }
    return neighbours;
  }

  /** Names of changed symbols (to find callers) and of what they call outside the PR (to find callees). */
  private searchWords(prEntries: SymbolCalls[]): string[] {
    const definedInPr = new Set(prEntries.map((entry) => entry.symbol.name));
    const words = new Set<string>();
    for (const entry of prEntries) {
      const { symbol } = entry;
      if (symbol.delta === "unchanged") continue;
      if (this.searchable(symbol.name)) words.add(symbol.name);
      for (const call of entry.headCalls) {
        if (call.receiver === "self" || call.receiver === "super") continue;
        if (!definedInPr.has(call.name) && this.searchable(call.name)) words.add(call.name);
      }
    }
    return [...words].slice(0, 250);
  }

  private searchable(name: string): boolean {
    return name.length >= 4 && /^[A-Za-z_$][\w$]*$/.test(name) && !CallGraphBuilder.genericNames.has(name);
  }

  private async readSource(dir: string, path: string): Promise<string | null> {
    try {
      const buffer = await readFile(join(dir, path));
      return buffer.length > maxNeighbourFileBytes ? null : buffer.toString("utf8");
    } catch {
      return null;
    }
  }
}
