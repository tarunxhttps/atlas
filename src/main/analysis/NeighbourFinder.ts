import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodeSymbol } from "@shared/types";
import type { RepoMirror } from "../services/RepoMirror";
import type { SymbolCalls } from "./CallGraphBuilder";
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
  // Names so common that searching the repo for them would pull in half the codebase.
  private static readonly genericNames = new Set([
    "get", "set", "has", "add", "push", "pop", "append", "extend", "insert", "remove", "delete", "update", "clear",
    "map", "filter", "reduce", "forEach", "find", "some", "every", "includes", "indexOf", "slice", "splice", "join",
    "split", "replace", "trim", "strip", "lower", "upper", "format", "keys", "values", "items", "entries", "then",
    "catch", "finally", "toString", "valueOf", "call", "apply", "bind", "emit", "on", "off", "once", "log", "info",
    "warn", "error", "debug", "json", "send", "close", "open", "read", "write", "run", "init", "__init__", "copy",
    "sort", "count", "index", "encode", "decode", "load", "loads", "dump", "dumps", "exists", "next", "render",
    "execute", "process", "handle", "create", "start", "stop", "main", "test", "setUp", "tearDown", "constructor",
    "length", "default", "parse", "validate", "dict", "model_dump", "model_validate", "isinstance", "len", "str",
    "int", "list", "print", "range", "super", "getattr", "setattr", "hasattr", "enumerate", "zip", "sorted", "any",
    "all", "min", "max", "sum", "Promise", "Error", "Date", "Object", "Array", "String", "Number", "Boolean",
  ]);

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
      const parsed = await this.extractor.extract(source, language);
      for (const extracted of parsed.symbols) {
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
        neighbours.push({
          symbol,
          headCalls: extracted.calls,
          baseCalls: extracted.calls,
          headRefs: extracted.references,
          baseRefs: extracted.references,
          headImports: parsed.imports,
          baseImports: parsed.imports,
        });
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
    return name.length >= 4 && /^[A-Za-z_$][\w$]*$/.test(name) && !NeighbourFinder.genericNames.has(name);
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
