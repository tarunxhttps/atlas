import type { ChangedFile, CodeSymbol, Delta, LanguageId, SymbolSide } from "@shared/types";
import type { ExtractedSymbol } from "./SymbolExtractor";

export interface DiffedSymbol {
  symbol: CodeSymbol;
  headCalls: ExtractedSymbol["calls"];
  baseCalls: ExtractedSymbol["calls"];
  headRefs: string[];
  baseRefs: string[];
}

export class SymbolDiffer {
  static symbolId(path: string, qualifiedName: string): string {
    return `${path}#${qualifiedName}`;
  }

  /** Pairs base and head symbols of one changed file by qualified name. */
  diffFile(file: ChangedFile, language: LanguageId, base: ExtractedSymbol[], head: ExtractedSymbol[]): DiffedSymbol[] {
    const baseByName = new Map(base.map((symbol) => [symbol.qualifiedName, symbol]));
    const headByName = new Map(head.map((symbol) => [symbol.qualifiedName, symbol]));
    const names = [...new Set([...headByName.keys(), ...baseByName.keys()])];

    return names.map((qualifiedName) => {
      const before = baseByName.get(qualifiedName) ?? null;
      const after = headByName.get(qualifiedName) ?? null;
      const shape = (after ?? before)!;
      const { delta, formattingOnly } = this.compare(before, after, language);
      const symbol: CodeSymbol = {
        id: SymbolDiffer.symbolId(file.path, qualifiedName),
        name: shape.name,
        qualifiedName,
        kind: shape.kind,
        path: file.path,
        language,
        parentId: shape.parentQualifiedName ? SymbolDiffer.symbolId(file.path, shape.parentQualifiedName) : null,
        delta,
        formattingOnly,
        movedFrom: null,
        inPr: true,
        head: after ? this.side(after) : null,
        base: before ? this.side(before) : null,
        additions: after ? this.countLines(file, "add", after.startLine, after.endLine) : 0,
        deletions: before ? this.countLines(file, "del", before.startLine, before.endLine) : 0,
      };
      return { symbol, headCalls: after?.calls ?? [], baseCalls: before?.calls ?? [], headRefs: after?.references ?? [], baseRefs: before?.references ?? [] };
    });
  }

  /** Marks an added symbol as moved when a removed symbol elsewhere had the same name and body. */
  linkMoves(symbols: CodeSymbol[]): void {
    const removed = symbols.filter((symbol) => symbol.delta === "removed" && symbol.base);
    for (const added of symbols.filter((symbol) => symbol.delta === "added" && symbol.head)) {
      const match = removed.find(
        (candidate) =>
          candidate.name === added.name &&
          candidate.kind === added.kind &&
          this.normalize(candidate.base!.code, candidate.language) === this.normalize(added.head!.code, added.language),
      );
      if (match) added.movedFrom = match.id;
    }
  }

  private compare(
    before: ExtractedSymbol | null,
    after: ExtractedSymbol | null,
    language: LanguageId,
  ): { delta: Delta; formattingOnly: boolean } {
    if (!before) return { delta: "added", formattingOnly: false };
    if (!after) return { delta: "removed", formattingOnly: false };
    if (before.compareText === after.compareText) return { delta: "unchanged", formattingOnly: false };
    const formattingOnly = this.normalize(before.compareText, language) === this.normalize(after.compareText, language);
    return { delta: "modified", formattingOnly };
  }

  // Rough comment stripping is enough here: both sides go through the same transform.
  private normalize(text: string, language: LanguageId): string {
    const withoutComments =
      language === "python"
        ? text.replace(/#.*$/gm, "")
        : text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    return withoutComments.replace(/[\s,;]+/g, "");
  }

  private side(symbol: ExtractedSymbol): SymbolSide {
    return { startLine: symbol.startLine, endLine: symbol.endLine, signature: symbol.signature, code: symbol.code };
  }

  private countLines(file: ChangedFile, kind: "add" | "del", start: number, end: number): number {
    let count = 0;
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind !== kind) continue;
        const number = kind === "add" ? line.newNo : line.oldNo;
        if (number !== null && number >= start && number <= end) count++;
      }
    }
    return count;
  }
}
