import type { CallEdge, CodeSymbol } from "@shared/types";

export interface CallSiteLine {
  kind: "added" | "removed" | "changed" | "unchanged";
  /** Head line number, or the base one for a removed call. */
  line: number;
  text: string;
  /** The base text a changed call replaced. */
  before?: string;
}

/**
 * Pairs a call's lines on the base and head sides of its caller. Same text on both sides is unchanged;
 * leftovers pair up in order as changed (the call stayed, its line was edited), and the rest are added or removed.
 */
export class CallSiteDiff {
  constructor(private readonly caller: CodeSymbol) {}

  lines(call: CallEdge): CallSiteLine[] {
    if (!call.lines) return [];
    const head = call.lines.head.map((line) => ({ line, text: this.textAt("head", line) }));
    const base = call.lines.base.map((line) => ({ line, text: this.textAt("base", line) }));

    const result: CallSiteLine[] = [];
    const leftoverHead: typeof head = [];
    for (const site of head) {
      const match = base.findIndex((candidate) => candidate.text === site.text);
      if (match < 0) {
        leftoverHead.push(site);
        continue;
      }
      base.splice(match, 1);
      result.push({ kind: "unchanged", ...site });
    }
    leftoverHead.forEach((site, index) => {
      const before = base[index];
      result.push(before ? { kind: "changed", ...site, before: before.text } : { kind: "added", ...site });
    });
    for (const site of base.slice(leftoverHead.length)) result.push({ kind: "removed", ...site });
    return result.sort((a, b) => a.line - b.line);
  }

  private textAt(side: "head" | "base", line: number): string {
    // Callers outside the PR only carry a head side, and it is the same code on both.
    const code = side === "head" ? this.caller.head : (this.caller.base ?? this.caller.head);
    if (!code) return "";
    return code.code.split("\n")[line - code.startLine]?.trim() ?? "";
  }
}
