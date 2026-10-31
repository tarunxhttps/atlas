import { useEffect, useState } from "react";
import type { ProgressEvent, RecentEntry, ToolStatus } from "@shared/types";

interface Props {
  loadingUrl: string | null;
  progress: ProgressEvent[];
  error: string | null;
  onOpen: (url: string) => void;
  onOpenSettings: () => void;
}

const stages: { stage: ProgressEvent["stage"]; label: string }[] = [
  { stage: "fetch", label: "Read the PR" },
  { stage: "clone", label: "Sync the repo" },
  { stage: "diff", label: "Diff against the merge base" },
  { stage: "parse", label: "Parse functions and classes" },
  { stage: "graph", label: "Find callers and callees" },
];

export function Home({ loadingUrl, progress, error, onOpen, onOpenSettings }: Props) {
  const [url, setUrl] = useState("");
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  const [tools, setTools] = useState<ToolStatus | null>(null);

  useEffect(() => {
    void window.atlas.listRecent().then(setRecent);
    void window.atlas.checkTools().then(setTools);
  }, [loadingUrl]);

  const reached = new Set(progress.map((event) => event.stage));
  const latest = progress.at(-1);
  const missing = tools ? [!tools.gh && "gh", !tools.git && "git"].filter(Boolean) : [];

  return (
    <div className="home">
      <div className="home-drag" />
      <div className="home-card">
        <div className="home-brand">
          <span className="brand-mark">◎</span> Atlas
        </div>
        <p className="home-tagline">Paste a pull request. See where the code flows and what changed, before you read a line.</p>

        <form
          className="home-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (url.trim() && !loadingUrl) onOpen(url.trim());
          }}
        >
          <input
            autoFocus
            className="home-input"
            placeholder="https://github.com/owner/repo/pull/123"
            value={url}
            disabled={Boolean(loadingUrl)}
            onChange={(event) => setUrl(event.target.value)}
          />
          <button className="btn primary" disabled={!url.trim() || Boolean(loadingUrl)}>
            {loadingUrl ? "Mapping…" : "Map this PR"}
          </button>
        </form>

        {error && <div className="home-error">{error}</div>}
        {missing.length > 0 && <div className="home-error">Atlas needs {missing.join(" and ")} installed.</div>}
        {tools && tools.gh && !tools.ghAuthenticated && <div className="home-error">Run `gh auth login` in a terminal so Atlas can read your PRs.</div>}

        {loadingUrl && (
          <ol className="home-steps">
            {stages.map(({ stage, label }) => {
              const done = reached.has(stage) && latest?.stage !== stage;
              const active = latest?.stage === stage;
              return (
                <li key={stage} className={done ? "done" : active ? "active" : ""}>
                  <span className="step-dot" />
                  {label}
                  {active && <span className="step-detail">{latest?.message}</span>}
                </li>
              );
            })}
          </ol>
        )}

        {!loadingUrl && recent.length > 0 && (
          <div className="home-recent">
            <div className="section-label">Recent</div>
            {recent.slice(0, 12).map((entry) => (
              <button key={entry.key} className="recent-row" onClick={() => onOpen(entry.url)}>
                <span className="recent-key">{entry.key}</span>
                <span className="recent-title">{entry.title}</span>
                <span className="recent-date">{new Date(entry.openedAt).toLocaleDateString()}</span>
              </button>
            ))}
          </div>
        )}

        <div className="home-footer">
          <button className="link" onClick={onOpenSettings}>
            Settings
          </button>
          {tools && (
            <span className="muted">
              gh {tools.gh ? "✓" : "✗"} · git {tools.git ? "✓" : "✗"} · claude {tools.claude ? "✓" : "✗"}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
