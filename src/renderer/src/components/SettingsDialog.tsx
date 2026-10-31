import { useEffect, useState } from "react";
import type { AiProviderId, Effort, RepoCorrections, Settings, SettingsPatch, ThemePreference, ToolStatus } from "@shared/types";

interface Props {
  settings: Settings;
  onSave: (patch: SettingsPatch) => Promise<void>;
  onClose: () => void;
}

const models = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"];
const efforts: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export function SettingsDialog({ settings, onSave, onClose }: Props) {
  const [draft, setDraft] = useState(settings);
  const [apiKey, setApiKey] = useState("");
  const [tools, setTools] = useState<ToolStatus | null>(null);
  const [repo, setRepo] = useState(Object.keys(settings.corrections)[0] ?? "");
  const [correctionText, setCorrectionText] = useState(() => toText(settings.corrections[repo]));

  useEffect(() => {
    void window.atlas.checkTools().then(setTools);
  }, []);

  useEffect(() => {
    setCorrectionText(toText(draft.corrections[repo]));
  }, [repo, draft.corrections]);

  const save = async () => {
    const corrections = { ...draft.corrections };
    if (repo.trim()) corrections[repo.trim()] = fromText(correctionText);
    const patch: SettingsPatch = {
      aiProvider: draft.aiProvider,
      model: draft.model,
      effort: draft.effort,
      autoNarrative: draft.autoNarrative,
      maxNeighbourFiles: draft.maxNeighbourFiles,
      theme: draft.theme,
      corrections,
    };
    if (apiKey) patch.anthropicApiKey = apiKey;
    await onSave(patch);
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <h2>Settings</h2>

        <section>
          <div className="section-label">AI engine</div>
          <div className="segmented">
            {(["claude-cli", "anthropic-api"] as AiProviderId[]).map((id) => (
              <button key={id} className={draft.aiProvider === id ? "active" : ""} onClick={() => setDraft({ ...draft, aiProvider: id })}>
                {id === "claude-cli" ? "Claude Code CLI (your login)" : "Anthropic API key"}
              </button>
            ))}
          </div>
          {draft.aiProvider === "anthropic-api" && (
            <label className="field">
              API key {settings.hasApiKey && <span className="muted small">(saved, encrypted in the macOS keychain)</span>}
              <input className="text-input" type="password" placeholder={settings.hasApiKey ? "•••••••• (leave empty to keep)" : "sk-ant-…"} value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
            </label>
          )}
          {draft.aiProvider === "claude-cli" && tools && !tools.claude && <div className="home-error">The `claude` CLI wasn't found on this Mac.</div>}
          <div className="field-row">
            <label className="field">
              Model
              <input className="text-input" list="atlas-models" value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} />
              <datalist id="atlas-models">
                {models.map((model) => (
                  <option key={model} value={model} />
                ))}
              </datalist>
            </label>
            <label className="field">
              Effort
              <select className="text-input" value={draft.effort} onChange={(event) => setDraft({ ...draft, effort: event.target.value as Effort })}>
                {efforts.map((effort) => (
                  <option key={effort}>{effort}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="toggle">
            <input type="checkbox" checked={draft.autoNarrative} onChange={(event) => setDraft({ ...draft, autoNarrative: event.target.checked })} /> Ask Claude automatically when a PR opens
          </label>
        </section>

        <section>
          <div className="section-label">Map</div>
          <div className="field-row">
            <label className="field">
              Files outside the PR to scan for callers and callees
              <input
                className="text-input"
                type="number"
                min={0}
                max={300}
                value={draft.maxNeighbourFiles}
                onChange={(event) => setDraft({ ...draft, maxNeighbourFiles: Number(event.target.value) })}
              />
            </label>
            <label className="field">
              Theme
              <select className="text-input" value={draft.theme} onChange={(event) => setDraft({ ...draft, theme: event.target.value as ThemePreference })}>
                <option value="system">system</option>
                <option value="dark">dark</option>
                <option value="light">light</option>
              </select>
            </label>
          </div>
        </section>

        <section>
          <div className="section-label">Per-repo corrections</div>
          <label className="field">
            Repository (owner/repo)
            <input className="text-input" list="atlas-repos" value={repo} onChange={(event) => setRepo(event.target.value)} placeholder="BikDotAiDev/automation-chatbots" />
            <datalist id="atlas-repos">
              {Object.keys(draft.corrections).map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </label>
          <textarea className="text-input corrections" value={correctionText} onChange={(event) => setCorrectionText(event.target.value)} spellCheck={false} />
          <p className="muted small">
            One per line: <code>exclude: **/migrations/**</code>, <code>rename: path/or#Symbol =&gt; Friendly name</code>, <code>pin: component-id =&gt; lane-id</code>. Re-analyze the PR to apply excludes.
          </p>
        </section>

        <section className="tool-status">
          {tools && (
            <span className="muted small">
              gh: {tools.gh ?? "missing"} {tools.ghAuthenticated ? "(signed in)" : "(not signed in)"} · git: {tools.git ?? "missing"} · claude: {tools.claude ?? "missing"}
            </span>
          )}
        </section>

        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function toText(corrections: RepoCorrections | undefined): string {
  if (!corrections) return "";
  return [
    ...corrections.exclude.map((glob) => `exclude: ${glob}`),
    ...Object.entries(corrections.rename).map(([from, to]) => `rename: ${from} => ${to}`),
    ...Object.entries(corrections.lanePins).map(([component, lane]) => `pin: ${component} => ${lane}`),
  ].join("\n");
}

function fromText(text: string): RepoCorrections {
  const corrections: RepoCorrections = { exclude: [], rename: {}, lanePins: {} };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const match = /^(exclude|rename|pin):\s*(.+)$/.exec(line);
    if (!match) continue;
    if (match[1] === "exclude") {
      corrections.exclude.push(match[2].trim());
      continue;
    }
    const [from, to] = match[2].split("=>").map((part) => part.trim());
    if (!from || !to) continue;
    if (match[1] === "rename") corrections.rename[from] = to;
    else corrections.lanePins[from] = to;
  }
  return corrections;
}
