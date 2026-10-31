import { useState } from "react";
import type { ChatTurn } from "@shared/types";
import { useWorkspace } from "../lib/WorkspaceContext";
import { Markdown } from "./Markdown";

interface Props {
  turns: ChatTurn[];
  onTurns: (turns: ChatTurn[]) => void;
}

export function ChatPanel({ turns, onTurns }: Props) {
  const { model, selectedIds, setHighlight, reveal } = useWorkspace();
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const focus = selectedIds.filter((id) => model.symbols.has(id));

  const ask = async () => {
    const text = question.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const answer = await window.atlas.ask(model.analysis.key, text, focus, turns.slice(-6));
      onTurns([...turns, { question: text, answer: answer.answer, highlightIds: answer.highlightIds }]);
      setHighlight(answer.highlightIds);
      setQuestion("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel-body chat">
      <div className="panel-title">Ask about this PR</div>
      <div className="chat-log">
        {turns.length === 0 && (
          <p className="muted small">
            Select cards on the map (shift-click for several) and ask about them, e.g. “what breaks if this returns None?” Answers link back to the map.
          </p>
        )}
        {turns.map((turn, index) => (
          <div key={index} className="chat-turn">
            <div className="chat-q">{turn.question}</div>
            <div className="chat-a">
              <Markdown text={turn.answer} />
              {turn.highlightIds.length > 0 && (
                <button className="link small" onClick={() => (turn.highlightIds[0] ? reveal(turn.highlightIds[0]) : undefined)} onMouseEnter={() => setHighlight(turn.highlightIds)}>
                  Show {turn.highlightIds.length} on the map
                </button>
              )}
            </div>
          </div>
        ))}
        {busy && (
          <div className="pending">
            <span className="spinner" /> Thinking…
          </div>
        )}
        {error && <div className="home-error">{error}</div>}
      </div>
      {focus.length > 0 && (
        <div className="chat-focus">
          Asking about:{" "}
          {focus.map((id) => (
            <span key={id} className="tag">
              {model.symbols.get(id)!.name}
            </span>
          ))}
        </div>
      )}
      <textarea
        className="text-input chat-input"
        placeholder="Ask a question (⌘↵ to send)"
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void ask();
        }}
      />
      <button className="btn primary small" disabled={busy || !question.trim()} onClick={() => void ask()}>
        Ask
      </button>
    </div>
  );
}
