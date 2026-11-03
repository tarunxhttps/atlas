import { useMemo } from "react";
import { CallSiteDiff, type CallSiteLine } from "../lib/CallSiteDiff";
import { useWorkspace } from "../lib/WorkspaceContext";

interface Props {
  callIds: string[];
  /** Cursor position inside the canvas, and the canvas size, to keep the box on screen. */
  x: number;
  y: number;
  width: number;
  height: number;
}

const maxCalls = 6;
const offset = 16;
const marks: Record<CallSiteLine["kind"], string> = { added: "+", removed: "−", changed: "~", unchanged: " " };

/** ⌘ + hover on a line: the call lines behind it, marked added, removed, changed or unchanged. */
export function CallPeek({ callIds, x, y, width, height }: Props) {
  const { model } = useWorkspace();
  const calls = useMemo(() => {
    const byId = new Map(model.analysis.facts.calls.map((call) => [call.id, call]));
    return callIds.flatMap((id) => {
      const call = byId.get(id);
      const caller = call && model.symbols.get(call.from);
      const callee = call && model.symbols.get(call.to);
      if (!call || !caller || !callee) return [];
      return [{ call, caller, callee, lines: new CallSiteDiff(caller).lines(call) }];
    });
  }, [callIds, model]);

  if (calls.length === 0) return null;
  // Open away from the nearest edges of the canvas so the box never runs off it.
  const place = {
    ...(x < width / 2 ? { left: x + offset } : { right: width - x + offset }),
    ...(y < height / 2 ? { top: y + offset } : { bottom: height - y + offset }),
  };

  return (
    <div className="call-peek" style={place}>
      {calls.slice(0, maxCalls).map(({ call, caller, callee, lines }) => (
        <div key={call.id} className="call-peek-call">
          <div className="call-peek-title">
            {model.label(caller)} → {model.label(callee)}
          </div>
          {lines.length === 0 ? (
            <p className="peek-summary">{call.kind === "reference" ? "Uses the class (type hint, isinstance or attribute)." : "No call line recorded."}</p>
          ) : (
            <pre className="peek-code">
              {lines.map((site) => (
                <div key={`${site.kind}-${site.line}`}>
                  {site.before !== undefined && (
                    <div className="hunk-line call-line removed">
                      <span className="call-line-mark">−</span>
                      {site.before}
                    </div>
                  )}
                  <div className={`hunk-line call-line ${site.kind}`}>
                    <span className="call-line-mark">{marks[site.kind]}</span>
                    <span className="call-line-number">{site.line}</span>
                    {site.text}
                  </div>
                </div>
              ))}
            </pre>
          )}
        </div>
      ))}
      {calls.length > maxCalls && <p className="peek-summary">+{calls.length - maxCalls} more calls</p>}
    </div>
  );
}
