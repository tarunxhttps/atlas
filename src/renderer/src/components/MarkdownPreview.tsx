import { isValidElement, useEffect, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChangedFile } from "@shared/types";
import { useWorkspace } from "../lib/WorkspaceContext";

type Load = { status: "loading" } | { status: "ready"; text: string; deleted: boolean } | { status: "error"; message: string };

/** The whole markdown file rendered as it reads at the PR head, fetched from the local clone when opened. */
export function MarkdownFileView({ file }: { file: ChangedFile }) {
  const { model } = useWorkspace();
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const [load, setLoad] = useState<Load>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setLoad({ status: "loading" });
    const deleted = file.status === "removed";
    window.atlas
      .readFile(model.analysis.key, file.path, deleted ? "base" : "head")
      .then((text) => !cancelled && setLoad(text === null ? { status: "error", message: "File not found in the repo." } : { status: "ready", text, deleted }))
      .catch((error: unknown) => !cancelled && setLoad({ status: "error", message: error instanceof Error ? error.message : String(error) }));
    return () => {
      cancelled = true;
    };
  }, [model.analysis.key, file.path, file.status]);

  return (
    <div className="md-file">
      <div className="diff-toolbar">
        <div className="segmented small">
          <button className={mode === "preview" ? "active" : ""} onClick={() => setMode("preview")}>
            Preview
          </button>
          <button className={mode === "source" ? "active" : ""} onClick={() => setMode("source")}>
            Source diff
          </button>
        </div>
      </div>
      {mode === "preview" && (
        <div className="md-doc">
          {load.status === "loading" && (
            <p className="muted small">
              <span className="spinner" /> Loading…
            </p>
          )}
          {load.status === "error" && <p className="muted small">{load.message}</p>}
          {load.status === "ready" && (
            <>
              {load.deleted && <p className="muted small">This PR deletes the file; this is how it read before.</p>}
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
                {load.text}
              </ReactMarkdown>
            </>
          )}
        </div>
      )}
      {mode === "source" && <SourceDiff file={file} />}
    </div>
  );
}

/** GitHub's heading anchors: lower-case, punctuation dropped, spaces to hyphens. */
function slug(children: ReactNode): string {
  const text = (node: ReactNode): string => {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(text).join("");
    if (isValidElement<{ children?: ReactNode }>(node)) return text(node.props.children);
    return "";
  };
  return text(children)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

const heading =
  (Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") =>
  ({ children }: { children?: ReactNode }) => <Tag id={`md-${slug(children)}`}>{children}</Tag>;

// Images would need repo auth to load, so they show as labelled placeholders; links open in the browser.
const components: Components = {
  h1: heading("h1"),
  h2: heading("h2"),
  h3: heading("h3"),
  h4: heading("h4"),
  h5: heading("h5"),
  h6: heading("h6"),
  a: ({ href, children }) =>
    href && /^https?:\/\//.test(href) ? (
      <button className="md-link external" onClick={() => void window.atlas.openExternal(href)}>
        {children}
      </button>
    ) : href?.startsWith("#") ? (
      <button
        className="md-link"
        onClick={() => document.getElementById(`md-${decodeURIComponent(href.slice(1))}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}
      >
        {children}
      </button>
    ) : (
      <span className="md-link-local" title={href}>
        {children}
      </span>
    ),
  img: ({ alt, src }) => (
    <span className="md-image" title={typeof src === "string" ? src : undefined}>
      🖼 {alt || "image"}
    </span>
  ),
};

function SourceDiff({ file }: { file: ChangedFile }) {
  return (
    <pre className="hunks">
      {file.hunks.map((hunk, index) => (
        <div key={index}>
          <div className="hunk-header">{hunk.header}</div>
          {hunk.lines.map((line, lineIndex) => (
            <div key={lineIndex} className={`hunk-line ${line.kind}`}>
              {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
              {line.text}
            </div>
          ))}
        </div>
      ))}
    </pre>
  );
}
