import { Fragment, type ReactNode } from "react";
import { useWorkspace } from "../lib/WorkspaceContext";

/**
 * A small markdown renderer that builds React elements (never raw HTML) and turns
 * [name](sym:ID) / [label](comp:ID) links into buttons that move the canvas.
 */
export function Markdown({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className="md">
      {blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </div>
  );
}

type MdBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; text: string };

function parseBlocks(text: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.startsWith("```")) {
      const code: string[] = [];
      index++;
      while (index < lines.length && !lines[index].startsWith("```")) code.push(lines[index++]);
      index++;
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      index++;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (index < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*([-*]|\d+\.)\s+/, ""));
        index++;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    if (!line.trim()) {
      index++;
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !/^(#{1,4}\s|```|\s*([-*]|\d+\.)\s)/.test(lines[index])) {
      paragraph.push(lines[index++]);
    }
    blocks.push({ type: "paragraph", text: paragraph.join(" ") });
  }
  return blocks;
}

function Block({ block }: { block: MdBlock }) {
  switch (block.type) {
    case "heading": {
      const Tag = (`h${Math.min(block.level + 2, 6)}`) as "h3" | "h4" | "h5" | "h6";
      return (
        <Tag>
          <Inline text={block.text} />
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p>
          <Inline text={block.text} />
        </p>
      );
    case "list": {
      const items = block.items.map((item, index) => (
        <li key={index}>
          <Inline text={item} />
        </li>
      ));
      return block.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
    }
    case "code":
      return <pre className="md-code">{block.text}</pre>;
  }
}

const inlinePattern = /(\[([^\]]+)\]\(([^)\s]+)\))|(`([^`]+)`)|(\*\*([^*]+)\*\*)/g;

function Inline({ text }: { text: string }) {
  const { reveal, model } = useWorkspace();
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(inlinePattern)) {
    const start = match.index ?? 0;
    if (start > last) parts.push(text.slice(last, start));
    if (match[1]) {
      const [label, target] = [match[2], match[3]];
      const ref = /^(sym|comp):(.+)$/.exec(target);
      if (ref && model.resolve(ref[2])) {
        parts.push(
          <button key={start} className="md-link" onClick={() => reveal(ref[2])}>
            {label}
          </button>,
        );
      } else if (/^https:\/\//.test(target)) {
        parts.push(
          <button key={start} className="md-link external" onClick={() => void window.atlas.openExternal(target)}>
            {label}
          </button>,
        );
      } else {
        parts.push(label);
      }
    } else if (match[4]) {
      parts.push(<code key={start}>{match[5]}</code>);
    } else if (match[6]) {
      parts.push(<strong key={start}>{match[7]}</strong>);
    }
    last = start + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <Fragment>{parts}</Fragment>;
}
