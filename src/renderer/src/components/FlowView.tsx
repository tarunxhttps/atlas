import { useEffect, useMemo, useState } from "react";
import type { FlowStep, NarrativeFlow } from "@shared/narrative";
import { useWorkspace } from "../lib/WorkspaceContext";
import { deltaColors } from "./Canvas";

interface Props {
  flowId: string | null;
  stepId: string | null;
  onFlowChange: (flowId: string) => void;
  onStepChange: (stepId: string | null) => void;
}

const columnWidth = 210;
const headerHeight = 74;
const rowHeight = 58;
const leftGutter = 56;

export function FlowView({ flowId, stepId, onFlowChange, onStepChange }: Props) {
  const { model, highlightIds, reveal } = useWorkspace();
  const flows = model.narrative?.flows ?? [];
  const flow = flows.find((candidate) => candidate.id === flowId) ?? flows[0];
  const [playing, setPlaying] = useState(false);
  const [playIndex, setPlayIndex] = useState(-1);

  useEffect(() => {
    setPlaying(false);
    setPlayIndex(-1);
  }, [flow?.id]);

  useEffect(() => {
    if (!playing || !flow) return;
    if (playIndex >= flow.steps.length - 1) {
      const stop = setTimeout(() => setPlaying(false), 900);
      return () => clearTimeout(stop);
    }
    const timer = setTimeout(() => {
      const next = playIndex + 1;
      setPlayIndex(next);
      onStepChange(flow.steps[next].id);
    }, playIndex < 0 ? 50 : 1100);
    return () => clearTimeout(timer);
  }, [playing, playIndex, flow, onStepChange]);

  if (!flow) {
    return (
      <div className="flow-empty">
        {model.analysis.narrativeStatus === "pending"
          ? "Claude is still working out the data flows…"
          : "No ordered data flow was worth animating for this PR. Try the Code view for the call graph."}
      </div>
    );
  }

  const step = flow.steps.find((candidate) => candidate.id === stepId) ?? null;

  return (
    <div className="flow-view">
      <div className="flow-tabs">
        {flows.map((candidate) => (
          <button key={candidate.id} className={`tab ${candidate.id === flow.id ? "active" : ""}`} onClick={() => onFlowChange(candidate.id)}>
            {candidate.title}
          </button>
        ))}
        <span className="spacer" />
        <button
          className="btn primary small"
          onClick={() => {
            setPlayIndex(-1);
            setPlaying(true);
          }}
        >
          ▶ Play
        </button>
      </div>
      <p className="flow-summary">{flow.summary}</p>
      <div className="flow-body">
        <div className="flow-scroll">
          <SequenceDiagram
            flow={flow}
            activeStepId={step?.id ?? null}
            highlight={highlightIds}
            animateStepId={playing || playIndex >= 0 ? flow.steps[playIndex]?.id ?? null : null}
            onStep={(id) => {
              setPlaying(false);
              onStepChange(id);
            }}
          />
        </div>
        {step && <PayloadPanel flow={flow} step={step} onReveal={reveal} />}
      </div>
    </div>
  );
}

function SequenceDiagram({
  flow,
  activeStepId,
  highlight,
  animateStepId,
  onStep,
}: {
  flow: NarrativeFlow;
  activeStepId: string | null;
  highlight: Set<string>;
  animateStepId: string | null;
  onStep: (id: string) => void;
}) {
  const { model } = useWorkspace();
  const column = useMemo(() => new Map(flow.participants.map((id, index) => [id, index])), [flow]);
  const width = leftGutter + flow.participants.length * columnWidth;
  const height = headerHeight + flow.steps.length * rowHeight + 30;
  const x = (participant: string) => leftGutter + (column.get(participant) ?? 0) * columnWidth + columnWidth / 2;

  return (
    <svg className="sequence" width={width} height={height}>
      <defs>
        {Object.entries(deltaColors).map(([delta, color]) => (
          <marker key={delta} id={`arrow-${delta}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill={color} />
          </marker>
        ))}
      </defs>
      {flow.participants.map((id) => {
        const component = model.components.get(id);
        const cx = x(id);
        const color = deltaColors[component?.delta ?? "unchanged"];
        return (
          <g key={id}>
            <line x1={cx} x2={cx} y1={headerHeight - 8} y2={height - 10} className="lifeline" />
            <rect x={cx - 92} y={8} width={184} height={50} rx={8} className="participant" style={{ stroke: color }} />
            <text x={cx} y={30} textAnchor="middle" className="participant-label">
              {truncate(component?.label ?? id, 24)}
            </text>
            <text x={cx} y={47} textAnchor="middle" className="participant-kind">
              {component?.kind ?? ""}
              {component && component.delta !== "unchanged" ? ` · ${component.delta}` : ""}
            </text>
          </g>
        );
      })}
      {flow.steps.map((step, index) => {
        const y = headerHeight + index * rowHeight + rowHeight / 2;
        const x1 = x(step.from);
        const x2 = x(step.to);
        const color = deltaColors[step.delta];
        const selected = step.id === activeStepId;
        const lit = selected || highlight.has(step.id);
        const dashed = step.kind === "async" || step.kind === "return";
        const path = step.kind === "self" ? `M${x1},${y - 8} h46 v20 h-44` : `M${x1},${y} L${x2 + (x2 > x1 ? -4 : 4)},${y}`;
        return (
          <g key={step.id} className={`seq-step ${lit ? "lit" : ""}`} onClick={() => onStep(step.id)}>
            <rect x={0} y={y - rowHeight / 2} width={width} height={rowHeight} className="seq-hit" />
            <circle cx={22} cy={y} r={11} className="step-number" style={{ stroke: color }} />
            <text x={22} y={y + 4} textAnchor="middle" className="step-number-text">
              {index + 1}
            </text>
            <path d={path} fill="none" stroke={color} strokeWidth={lit ? 2.6 : 1.6} strokeDasharray={dashed ? "6 4" : undefined} markerEnd={`url(#arrow-${step.delta})`} />
            <text x={step.kind === "self" ? x1 + 54 : (x1 + x2) / 2} y={y - 9} textAnchor={step.kind === "self" ? "start" : "middle"} className="seq-label">
              {truncate(step.label, 40)}
              {step.payload ? " ⧉" : ""}
            </text>
            {animateStepId === step.id && (
              <circle r={6} className="seq-dot" style={{ fill: color }}>
                <animateMotion dur="0.9s" path={path} fill="freeze" />
              </circle>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function PayloadPanel({ flow, step, onReveal }: { flow: NarrativeFlow; step: FlowStep; onReveal: (id: string) => void }) {
  const { model } = useWorkspace();
  const from = model.components.get(step.from)?.label ?? step.from;
  const to = model.components.get(step.to)?.label ?? step.to;
  const payload = step.payload;
  return (
    <aside className="payload">
      <div className="section-label">Step {flow.steps.indexOf(step) + 1}</div>
      <h3>{step.label}</h3>
      <div className="muted small">
        {from} → {to} · {step.kind} · <span className={`delta-text delta-${step.delta}`}>{step.delta}</span>
      </div>
      {step.symbolId && (
        <button className="btn ghost small" onClick={() => onReveal(step.symbolId!)}>
          Open {model.symbols.get(step.symbolId)?.name ?? "function"} in code
        </button>
      )}
      {payload ? (
        <>
          <PayloadSide title="Request" type={payload.requestType} shape={payload.requestShape} fields={payload.fields.filter((field) => field.side === "request")} />
          <PayloadSide title="Response" type={payload.responseType} shape={payload.responseShape} fields={payload.fields.filter((field) => field.side === "response")} />
        </>
      ) : (
        <p className="muted small">No payload details for this step.</p>
      )}
    </aside>
  );
}

function PayloadSide({
  title,
  type,
  shape,
  fields,
}: {
  title: string;
  type: string;
  shape: string;
  fields: NonNullable<FlowStep["payload"]>["fields"];
}) {
  if (!type && !shape && fields.length === 0) return null;
  return (
    <div className="payload-side">
      <div className="payload-title">
        {title} <code>{type || "void"}</code>
      </div>
      {fields.length > 0 && (
        <ul className="payload-fields">
          {fields.map((field) => (
            <li key={`${field.side}:${field.path}`} className={`field-${field.change}`}>
              <code>{field.path}</code>
              <span className="muted">{field.type}</span>
              {field.change !== "unchanged" && <span className={`badge field-${field.change}`}>{field.change}</span>}
              {field.note && <div className="field-note">{field.note}</div>}
            </li>
          ))}
        </ul>
      )}
      {shape && <pre className="payload-shape">{shape}</pre>}
    </div>
  );
}

function truncate(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}
