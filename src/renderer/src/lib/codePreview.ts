import { diffLines } from "diff";
import type { CodeSymbol } from "@shared/types";

export interface PreviewLine {
  kind: "add" | "del" | "context";
  text: string;
}

/**
 * Only the lines a change added or removed, so a small box shows the edit itself rather than the top of
 * a long function. Unchanged code, which has no changed lines, shows its first lines instead.
 */
export function changePreview(symbol: CodeSymbol, maxLines: number): PreviewLine[] {
  const side = symbol.head ?? symbol.base;
  if (!side) return [];
  if (symbol.delta === "unchanged" || symbol.formattingOnly) {
    return side.code.split("\n").slice(0, maxLines).map((text) => ({ kind: "context", text }));
  }

  const before = symbol.delta === "added" ? "" : (symbol.base?.code ?? "");
  const after = symbol.delta === "removed" ? "" : (symbol.head?.code ?? "");
  const lines: PreviewLine[] = [];
  for (const change of diffLines(before, after, { ignoreWhitespace: true })) {
    if (!change.added && !change.removed) continue;
    for (const text of change.value.replace(/\n$/, "").split("\n")) {
      if (lines.length >= maxLines) return lines;
      lines.push({ kind: change.added ? "add" : "del", text });
    }
  }
  return lines;
}
