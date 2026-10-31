import { dirname } from "node:path";
import { isTestPath } from "@shared/paths";
import type { CallEdge, CodeSymbol, EdgeConfidence } from "@shared/types";
import type { CallSite } from "./SymbolExtractor";

export interface SymbolCalls {
  symbol: CodeSymbol;
  headCalls: CallSite[];
  baseCalls: CallSite[];
  headRefs: string[];
  baseRefs: string[];
}

type Side = "head" | "base";

interface Resolution {
  target: CodeSymbol;
  confidence: EdgeConfidence;
}

/**
 * Resolves call sites to symbols by name. Without type information this is a heuristic, so edges
 * that rely on a name match outside the caller's own file are marked `name-match`.
 */
export class CallGraphBuilder {
  // Method names so common that matching them by name would wire half the codebase together.
  static readonly genericNames = new Set([
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

  build(entries: SymbolCalls[]): CallEdge[] {
    const symbols = entries.map((entry) => entry.symbol);
    const edges = new Map<
      string,
      { from: string; to: string; sides: Set<Side>; confidence: EdgeConfidence; dangling: boolean; kind: "call" | "reference" }
    >();

    const record = (from: CodeSymbol, resolution: Resolution, side: Side, dangling = false, kind: "call" | "reference" = "call") => {
      if (from.id === resolution.target.id) return;
      const key = `${from.id}->${resolution.target.id}`;
      const existing = edges.get(key);
      if (existing) {
        existing.sides.add(side);
        existing.dangling ||= dangling;
        if (resolution.confidence === "resolved") existing.confidence = "resolved";
        // Calling a class also names it; the call is the stronger fact.
        if (kind === "call") existing.kind = "call";
        return;
      }
      edges.set(key, { from: from.id, to: resolution.target.id, sides: new Set([side]), confidence: resolution.confidence, dangling, kind });
    };

    for (const side of ["head", "base"] as const) {
      const available = symbols.filter((symbol) => this.existsOn(symbol, side));
      const byName = this.indexByName(available);
      const removedByName = side === "head" ? this.indexByName(symbols.filter((symbol) => symbol.delta === "removed")) : null;

      for (const entry of entries) {
        if (!this.existsOn(entry.symbol, side)) continue;
        // Files outside the PR are identical on both sides, so their head calls stand in for base.
        const calls = side === "head" || !entry.symbol.inPr ? entry.headCalls : entry.baseCalls;
        for (const call of calls) {
          const resolution = this.resolve(entry.symbol, call, byName);
          if (resolution) {
            record(entry.symbol, resolution, side);
            continue;
          }
          const removedTarget = removedByName ? this.resolve(entry.symbol, call, removedByName) : null;
          if (removedTarget) record(entry.symbol, removedTarget, "head", true);
        }

        const refs = side === "head" || !entry.symbol.inPr ? entry.headRefs : entry.baseRefs;
        for (const name of refs) {
          const resolution = this.resolveClass(entry.symbol, name, byName);
          if (resolution) {
            record(entry.symbol, resolution, side, false, "reference");
            continue;
          }
          const removedTarget = removedByName ? this.resolveClass(entry.symbol, name, removedByName) : null;
          if (removedTarget) record(entry.symbol, removedTarget, "head", true, "reference");
        }
      }
    }

    return [...edges.values()].map((edge) => ({
      id: `${edge.from}->${edge.to}`,
      from: edge.from,
      to: edge.to,
      delta: edge.dangling ? "unchanged" : edge.sides.size === 2 ? "unchanged" : edge.sides.has("head") ? "added" : "removed",
      confidence: edge.confidence,
      dangling: edge.dangling,
      kind: edge.kind,
    }));
  }

  /** A capitalised name the code mentions, resolved to a class: same file first, then a unique match. */
  private resolveClass(user: CodeSymbol, name: string, byName: Map<string, CodeSymbol[]>): Resolution | null {
    const classes = (byName.get(name) ?? []).filter((candidate) => candidate.kind === "class");
    if (classes.length === 0 || CallGraphBuilder.genericNames.has(name)) return null;
    const local = classes.find((candidate) => candidate.path === user.path);
    if (local) return { target: local, confidence: "resolved" };
    return this.pickUnique(user, classes);
  }

  private existsOn(symbol: CodeSymbol, side: Side): boolean {
    if (!symbol.inPr) return true;
    return side === "head" ? symbol.head !== null : symbol.base !== null;
  }

  private indexByName(symbols: CodeSymbol[]): Map<string, CodeSymbol[]> {
    const index = new Map<string, CodeSymbol[]>();
    for (const symbol of symbols) {
      const list = index.get(symbol.name);
      if (list) list.push(symbol);
      else index.set(symbol.name, [symbol]);
    }
    return index;
  }

  private resolve(caller: CodeSymbol, call: CallSite, byName: Map<string, CodeSymbol[]>): Resolution | null {
    const candidates = byName.get(call.name);
    if (!candidates || candidates.length === 0 || call.receiver === "super") return null;
    const callerClass = this.classOf(caller);

    if (call.receiver === "self" && callerClass) {
      const sameClass = candidates.find((candidate) => candidate.kind === "method" && candidate.parentId === callerClass);
      if (sameClass) return { target: sameClass, confidence: "resolved" };
    }

    if (call.receiver === null) {
      const local = candidates.filter((candidate) => candidate.path === caller.path && candidate.kind !== "method");
      if (local.length >= 1) return { target: this.closest(caller, local), confidence: "resolved" };
      const global = candidates.filter((candidate) => candidate.kind !== "method");
      return this.pickUnique(caller, global);
    }

    if (CallGraphBuilder.genericNames.has(call.name)) return null;
    return this.pickUnique(caller, candidates);
  }

  private pickUnique(caller: CodeSymbol, all: CodeSymbol[]): Resolution | null {
    // Production code matched by name to a test helper or mock is almost always a false edge.
    const candidates = isTestPath(caller.path) ? all : all.filter((candidate) => !isTestPath(candidate.path));
    if (candidates.length === 1) {
      return { target: candidates[0], confidence: candidates[0].path === caller.path ? "resolved" : "name-match" };
    }
    const callerDir = dirname(caller.path);
    const nearby = candidates.filter((candidate) => dirname(candidate.path) === callerDir);
    if (nearby.length === 1) return { target: nearby[0], confidence: "name-match" };
    return null;
  }

  /** Prefers a nested function declared inside the caller's own parent. */
  private closest(caller: CodeSymbol, local: CodeSymbol[]): CodeSymbol {
    return local.find((candidate) => candidate.parentId === caller.id) ?? local.find((candidate) => candidate.parentId === caller.parentId) ?? local[0];
  }

  private classOf(symbol: CodeSymbol): string | null {
    if (symbol.kind === "method") return symbol.parentId;
    return null;
  }
}
