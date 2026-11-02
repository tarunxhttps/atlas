import type { CallEdge, CodeSymbol } from "@shared/types";
import { ImportResolver } from "./ImportResolver";
import { SymbolDiffer } from "./SymbolDiffer";
import type { CallSite, ImportBinding } from "./SymbolExtractor";

export interface SymbolCalls {
  symbol: CodeSymbol;
  headCalls: CallSite[];
  baseCalls: CallSite[];
  headRefs: string[];
  baseRefs: string[];
  /** The imports of the symbol's file on each side. */
  headImports: ImportBinding[];
  baseImports: ImportBinding[];
}

type Side = "head" | "base";

/**
 * Resolves call sites to symbols. An edge is drawn only when the code proves it: the same class
 * (`self.x()`), the same file, or an import that names the target's file. Calls through an object
 * whose type isn't visible (`self.client.send()`) get no edge rather than a guess.
 */
export class CallGraphBuilder {
  private readonly imports = new ImportResolver();

  build(entries: SymbolCalls[]): CallEdge[] {
    const symbols = entries.map((entry) => entry.symbol);
    const edges = new Map<string, { from: string; to: string; sides: Set<Side>; dangling: boolean; kind: "call" | "reference" }>();

    const record = (from: CodeSymbol, target: CodeSymbol, side: Side, dangling = false, kind: "call" | "reference" = "call") => {
      if (from.id === target.id) return;
      const key = `${from.id}->${target.id}`;
      const existing = edges.get(key);
      if (existing) {
        existing.sides.add(side);
        existing.dangling ||= dangling;
        // Calling a class also names it; the call is the stronger fact.
        if (kind === "call") existing.kind = "call";
        return;
      }
      edges.set(key, { from: from.id, to: target.id, sides: new Set([side]), dangling, kind });
    };

    for (const side of ["head", "base"] as const) {
      const available = symbols.filter((symbol) => this.existsOn(symbol, side));
      const byName = this.indexByName(available);
      const removedByName = side === "head" ? this.indexByName(symbols.filter((symbol) => symbol.delta === "removed")) : null;

      for (const entry of entries) {
        if (!this.existsOn(entry.symbol, side)) continue;
        // Files outside the PR are identical on both sides, so their head calls stand in for base.
        const useHead = side === "head" || !entry.symbol.inPr;
        const imports = useHead ? entry.headImports : entry.baseImports;
        for (const call of useHead ? entry.headCalls : entry.baseCalls) {
          const target = this.resolve(entry.symbol, call, imports, byName);
          if (target) {
            record(entry.symbol, target, side);
            continue;
          }
          const removedTarget = removedByName ? this.resolve(entry.symbol, call, imports, removedByName) : null;
          if (removedTarget) record(entry.symbol, removedTarget, "head", true);
        }

        for (const name of useHead ? entry.headRefs : entry.baseRefs) {
          const target = this.resolveClass(entry.symbol, name, imports, byName);
          if (target) {
            record(entry.symbol, target, side, false, "reference");
            continue;
          }
          const removedTarget = removedByName ? this.resolveClass(entry.symbol, name, imports, removedByName) : null;
          if (removedTarget) record(entry.symbol, removedTarget, "head", true, "reference");
        }
      }
    }

    return [...edges.values()].map((edge) => ({
      id: `${edge.from}->${edge.to}`,
      from: edge.from,
      to: edge.to,
      delta: edge.dangling ? "unchanged" : edge.sides.size === 2 ? "unchanged" : edge.sides.has("head") ? "added" : "removed",
      dangling: edge.dangling,
      kind: edge.kind,
    }));
  }

  /** A capitalised name the code mentions, resolved to a class in the same file or one it imports. */
  private resolveClass(user: CodeSymbol, name: string, imports: ImportBinding[], byName: Map<string, CodeSymbol[]>): CodeSymbol | null {
    const local = (byName.get(name) ?? []).find((candidate) => candidate.kind === "class" && candidate.path === user.path);
    if (local) return local;
    return this.imported(user, name, imports, byName, (candidate) => candidate.kind === "class");
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

  private resolve(caller: CodeSymbol, call: CallSite, imports: ImportBinding[], byName: Map<string, CodeSymbol[]>): CodeSymbol | null {
    if (call.receiver === "super") return null;
    const candidates = byName.get(call.name) ?? [];

    if (call.receiver === "self") {
      const callerClass = this.classOf(caller);
      return candidates.find((candidate) => candidate.kind === "method" && candidate.parentId === callerClass) ?? null;
    }

    if (call.receiver === null) {
      const local = candidates.filter((candidate) => candidate.path === caller.path && candidate.kind !== "method");
      if (local.length >= 1) return this.closest(caller, local);
      return this.imported(caller, call.name, imports, byName, (candidate) => candidate.parentId === null);
    }

    // `Foo.create()` where `Foo` is a class in the caller's own file.
    const localClassId = SymbolDiffer.symbolId(caller.path, call.object ?? "");
    const onLocalClass = candidates.find((candidate) => candidate.kind === "method" && candidate.parentId === localClassId);
    if (onLocalClass) return onLocalClass;

    const binding = imports.find((entry) => entry.local === call.object);
    if (!binding) return null;
    if (binding.imported === null) {
      return this.unique(candidates.filter((candidate) => candidate.parentId === null && this.imports.provides(caller.path, binding.module, candidate.path)));
    }
    // `Foo.create()` on an imported class, or `module.fn()` on a Python module imported by name.
    const className = binding.imported;
    return this.unique(
      candidates.filter(
        (candidate) =>
          (candidate.kind === "method" &&
            candidate.parentId === SymbolDiffer.symbolId(candidate.path, className) &&
            this.imports.provides(caller.path, binding.module, candidate.path)) ||
          (candidate.parentId === null && this.imports.provides(caller.path, `${binding.module}/${className}`, candidate.path)),
      ),
    );
  }

  /** A bare name the file imports, by name (aliases included) or through a wildcard import. */
  private imported(
    caller: CodeSymbol,
    name: string,
    imports: ImportBinding[],
    byName: Map<string, CodeSymbol[]>,
    accept: (candidate: CodeSymbol) => boolean,
  ): CodeSymbol | null {
    const found = new Set<CodeSymbol>();
    for (const binding of imports) {
      const lookup = binding.local === name && binding.imported !== null ? binding.imported : binding.local === "*" ? name : null;
      if (!lookup) continue;
      for (const candidate of byName.get(lookup) ?? []) {
        if (candidate.path !== caller.path && accept(candidate) && this.imports.provides(caller.path, binding.module, candidate.path)) found.add(candidate);
      }
    }
    return this.unique([...found]);
  }

  private unique(candidates: CodeSymbol[]): CodeSymbol | null {
    return candidates.length === 1 ? candidates[0] : null;
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
