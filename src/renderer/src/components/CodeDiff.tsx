import { Fragment, useMemo, useState } from "react";
import { diffLines, diffWordsWithSpace } from "diff";

interface Props {
  before: { code: string; startLine: number } | null;
  after: { code: string; startLine: number } | null;
}

interface Cell {
  no: number;
  text: string;
  kind: "context" | "add" | "del";
}

interface Row {
  left: Cell | null;
  right: Cell | null;
}

type Segment = { type: "rows"; rows: Row[] } | { type: "gap"; rows: Row[] };

export function CodeDiff({ before, after }: Props) {
  const [mode, setMode] = useState<"split" | "unified">("split");
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(true);
  const [withContext, setWithContext] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const rows = useMemo(() => buildRows(before, after, ignoreWhitespace), [before, after, ignoreWhitespace]);
  const segments = useMemo(() => (withContext ? [{ type: "rows" as const, rows }] : collapse(rows)), [rows, withContext]);

  return (
    <div className="code-diff">
      <div className="diff-toolbar">
        <div className="segmented small">
          <button className={mode === "split" ? "active" : ""} onClick={() => setMode("split")}>
            Before | After
          </button>
          <button className={mode === "unified" ? "active" : ""} onClick={() => setMode("unified")}>
            Unified
          </button>
        </div>
        <div className="segmented small">
          <button className={!withContext ? "active" : ""} onClick={() => setWithContext(false)}>
            Exact
          </button>
          <button className={withContext ? "active" : ""} onClick={() => setWithContext(true)}>
            With context
          </button>
        </div>
        <label className="toggle small">
          <input type="checkbox" checked={ignoreWhitespace} onChange={(event) => setIgnoreWhitespace(event.target.checked)} /> hide whitespace
        </label>
      </div>
      <div className={`diff-table ${mode}`}>
        {segments.map((segment, index) =>
          segment.type === "gap" && !expanded.has(index) ? (
            <button key={index} className="diff-gap" onClick={() => setExpanded(new Set([...expanded, index]))}>
              ⋯ {segment.rows.length} unchanged lines
            </button>
          ) : (
            <Fragment key={index}>{segment.rows.map((row, rowIndex) => (mode === "split" ? <SplitRow key={rowIndex} row={row} /> : <UnifiedRows key={rowIndex} row={row} />))}</Fragment>
          ),
        )}
      </div>
    </div>
  );
}

function buildRows(before: Props["before"], after: Props["after"], ignoreWhitespace: boolean): Row[] {
  const changes = diffLines(before?.code ?? "", after?.code ?? "", { ignoreWhitespace });
  const rows: Row[] = [];
  let oldNo = before?.startLine ?? 1;
  let newNo = after?.startLine ?? 1;
  const split = (value: string) => value.replace(/\n$/, "").split("\n");

  for (let index = 0; index < changes.length; index++) {
    const change = changes[index];
    if (change.removed && changes[index + 1]?.added) {
      const removed = split(change.value);
      const added = split(changes[index + 1].value);
      for (let line = 0; line < Math.max(removed.length, added.length); line++) {
        rows.push({
          left: line < removed.length ? { no: oldNo++, text: removed[line], kind: "del" } : null,
          right: line < added.length ? { no: newNo++, text: added[line], kind: "add" } : null,
        });
      }
      index++;
    } else if (change.removed) {
      for (const text of split(change.value)) rows.push({ left: { no: oldNo++, text, kind: "del" }, right: null });
    } else if (change.added) {
      for (const text of split(change.value)) rows.push({ left: null, right: { no: newNo++, text, kind: "add" } });
    } else {
      for (const text of split(change.value)) {
        rows.push({ left: { no: oldNo++, text, kind: "context" }, right: { no: newNo++, text, kind: "context" } });
      }
    }
  }
  return rows;
}

function collapse(rows: Row[]): Segment[] {
  const segments: Segment[] = [];
  const isContext = (row: Row) => row.left?.kind === "context" && row.right?.kind === "context";
  let index = 0;
  while (index < rows.length) {
    let end = index;
    while (end < rows.length && isContext(rows[end])) end++;
    const run = end - index;
    if (run > 8) {
      const keepHead = index === 0 ? 0 : 3;
      const keepTail = end === rows.length ? 0 : 3;
      if (keepHead) segments.push({ type: "rows", rows: rows.slice(index, index + keepHead) });
      segments.push({ type: "gap", rows: rows.slice(index + keepHead, end - keepTail) });
      if (keepTail) segments.push({ type: "rows", rows: rows.slice(end - keepTail, end) });
      index = end;
    } else if (run > 0) {
      segments.push({ type: "rows", rows: rows.slice(index, end) });
      index = end;
    } else {
      let changeEnd = index;
      while (changeEnd < rows.length && !isContext(rows[changeEnd])) changeEnd++;
      segments.push({ type: "rows", rows: rows.slice(index, changeEnd) });
      index = changeEnd;
    }
  }
  return segments;
}

function SplitRow({ row }: { row: Row }) {
  const words = row.left && row.right && row.left.kind === "del" && row.right.kind === "add" ? diffWordsWithSpace(row.left.text, row.right.text) : null;
  return (
    <div className="diff-row">
      <CellView cell={row.left} words={words} side="left" />
      <CellView cell={row.right} words={words} side="right" />
    </div>
  );
}

function UnifiedRows({ row }: { row: Row }) {
  if (row.left?.kind === "context") return <div className="diff-row"><CellView cell={row.right} words={null} side="right" /></div>;
  return (
    <>
      {row.left && <div className="diff-row"><CellView cell={row.left} words={null} side="left" /></div>}
      {row.right && <div className="diff-row"><CellView cell={row.right} words={null} side="right" /></div>}
    </>
  );
}

function CellView({ cell, words, side }: { cell: Cell | null; words: ReturnType<typeof diffWordsWithSpace> | null; side: "left" | "right" }) {
  if (!cell) return <div className="diff-cell empty" />;
  return (
    <div className={`diff-cell ${cell.kind}`}>
      <span className="diff-no">{cell.no}</span>
      <span className="diff-sign">{cell.kind === "add" ? "+" : cell.kind === "del" ? "−" : " "}</span>
      <span className="diff-text">
        {words
          ? words
              .filter((part) => (side === "left" ? !part.added : !part.removed))
              .map((part, index) => (
                <span key={index} className={part.added ? "word-add" : part.removed ? "word-del" : undefined}>
                  {part.value}
                </span>
              ))
          : cell.text}
      </span>
    </div>
  );
}

/** Plain code with its real line numbers, for code the PR didn't change. */
export function CodeBlock({ code, startLine }: { code: string; startLine: number }) {
  return (
    <div className="code-diff">
      <div className="diff-table unified">
        {code.split("\n").map((text, index) => (
          <div key={index} className="diff-row">
            <div className="diff-cell context">
              <span className="diff-no">{startLine + index}</span>
              <span className="diff-text">{text}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
