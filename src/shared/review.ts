import type { Analysis } from "./types";

export interface ReviewItem {
  id: string;
  path: string;
  /** What a reviewer actually read; when it changes, the item needs reading again. */
  content: string;
}

/**
 * The units of review: every changed function or method, plus one item per changed file that
 * has no changed function (config, other languages, module-level edits) so every file can be ticked.
 */
export function reviewItems(analysis: Analysis): ReviewItem[] {
  const items: ReviewItem[] = [];
  const pathsWithSymbols = new Set<string>();
  for (const symbol of analysis.facts.symbols) {
    if (!symbol.inPr || symbol.delta === "unchanged" || symbol.kind === "class") continue;
    pathsWithSymbols.add(symbol.path);
    items.push({ id: symbol.id, path: symbol.path, content: (symbol.head ?? symbol.base)?.code ?? "" });
  }
  for (const file of analysis.facts.files) {
    if (file.excluded || pathsWithSymbols.has(file.path)) continue;
    const patch = file.hunks.map((hunk) => hunk.lines.map((line) => `${line.kind}${line.text}`).join("\n")).join("\n");
    items.push({ id: fileReviewId(file.path), path: file.path, content: `${file.status}\n${patch}` });
  }
  return items;
}

export function fileReviewId(path: string): string {
  return `file:${path}`;
}
