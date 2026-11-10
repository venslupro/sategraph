/** Bottom agent dock: grounded question answering with streamed tool trace. */
import { useEffect, useRef, useState } from 'react';
import type { AgentEvent, Citation, ViewCommand } from '@satgraph/contracts';
import { api, streamChat } from '../api/client';

interface AgentContext {
  selectedId: string | null;
  layerIds: string[];
  linkIds: string[];
  time: string | null;
}

interface AgentBarProps {
  context: AgentContext;
  onCommand: (command: ViewCommand) => void;
  autoAsk: { id: number; text: string } | null;
  onAutoAskHandled: () => void;
  initialShareId: string | null;
}

interface Step {
  step: number;
  tool: string;
  summary: string | null;
  ok: boolean | null;
}

interface Run {
  id: string;
  question: string;
  answer: string;
  steps: Step[];
  status: string | null;
  citations: Citation[];
  commands: ViewCommand[];
  verified: boolean | null;
  unverified: string[];
  shareId: string | null;
  error: string | null;
}

const PROMPTS = [
  'How many active satellites does each layer have?',
  'Which satellites are in the GPS constellation?',
  'Show recent catalog events.',
  'Which relay links are declared?',
];

function newRun(id: string, question: string): Run {
  return {
    id,
    question,
    answer: '',
    steps: [],
    status: null,
    citations: [],
    commands: [],
    verified: null,
    unverified: [],
    shareId: null,
    error: null,
  };
}

export function AgentBar({
  context,
  onCommand,
  autoAsk,
  onAutoAskHandled,
  initialShareId,
}: AgentBarProps) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const handledAsk = useRef<number>(-1);
  const loadedShare = useRef<string | null>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [runs]);

  useEffect(() => {
    if (!initialShareId || loadedShare.current === initialShareId) {
      return;
    }
    loadedShare.current = initialShareId;
    const controller = new AbortController();
    api
      .share(initialShareId, controller.signal)
      .then((response) => {
        const run = newRun(`share-${initialShareId}`, response.data.question);
        run.answer = response.data.answer;
        for (const event of response.data.events) {
          if (event.type === 'tool_call') {
            run.steps.push({ step: event.step, tool: event.tool, summary: null, ok: null });
          } else if (event.type === 'tool_result') {
            const existing = run.steps.find((step) => step.step === event.step);
            if (existing) {
              existing.summary = event.result.summary;
              existing.ok = event.result.ok;
            }
          } else if (event.type === 'view_command') {
            run.commands.push(event.command);
          } else if (event.type === 'citation') {
            run.citations.push(event.citation);
          } else if (event.type === 'done') {
            run.verified = event.verified;
            run.shareId = event.shareId ?? initialShareId;
          }
        }
        setRuns([run]);
      })
      .catch(() => {
        setRuns([
          {
            ...newRun(`share-${initialShareId}`, 'Shared answer'),
            error: 'This shared answer has expired.',
          },
        ]);
      });
    return () => controller.abort();
  }, [initialShareId]);

  const updateRun = (id: string, update: (run: Run) => Run): void => {
    setRuns((current) => current.map((run) => (run.id === id ? update(run) : run)));
  };

  const ask = async (question: string): Promise<void> => {
    const trimmed = question.trim();
    if (!trimmed || busy) {
      return;
    }
    setBusy(true);
    setInput('');
    const id = `run-${Date.now()}`;
    const run = newRun(id, trimmed);
    setRuns((current) => [...current.slice(-3), run]);

    const history = runs
      .filter((item) => item.answer)
      .slice(-3)
      .flatMap((item) => [
        { role: 'user' as const, content: item.question },
        { role: 'assistant' as const, content: item.answer },
      ]);

    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      await streamChat(
        {
          messages: [...history, { role: 'user', content: trimmed }],
          context,
        },
        (event: AgentEvent) => {
          switch (event.type) {
            case 'status':
              updateRun(id, (current) => ({ ...current, status: event.message }));
              break;
            case 'tool_call':
              updateRun(id, (current) => ({
                ...current,
                status: null,
                steps: [
                  ...current.steps,
                  { step: event.step, tool: event.tool, summary: null, ok: null },
                ],
              }));
              break;
            case 'tool_result':
              updateRun(id, (current) => ({
                ...current,
                steps: current.steps.map((step) =>
                  step.step === event.step
                    ? { ...step, summary: event.result.summary, ok: event.result.ok }
                    : step,
                ),
              }));
              break;
            case 'answer_delta':
              updateRun(id, (current) => ({
                ...current,
                status: null,
                answer: current.answer + event.text,
              }));
              break;
            case 'view_command':
              updateRun(id, (current) => ({
                ...current,
                commands: [...current.commands, event.command],
              }));
              onCommand(event.command);
              break;
            case 'citation':
              updateRun(id, (current) =>
                current.citations.some(
                  (citation) =>
                    citation.label === event.citation.label &&
                    citation.source === event.citation.source,
                )
                  ? current
                  : { ...current, citations: [...current.citations, event.citation] },
              );
              break;
            case 'done':
              updateRun(id, (current) => ({
                ...current,
                verified: event.verified,
                unverified: event.unverifiedClaims,
                shareId: event.shareId ?? null,
                status: null,
              }));
              break;
            case 'error':
              updateRun(id, (current) => ({
                ...current,
                error: event.message,
                status: null,
              }));
              break;
          }
        },
        controller.signal,
      );
    } catch (error) {
      if (!controller.signal.aborted) {
        updateRun(id, (current) => ({
          ...current,
          error: error instanceof Error ? error.message : 'Agent request failed',
          status: null,
        }));
      }
    } finally {
      controllerRef.current = null;
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!autoAsk || handledAsk.current === autoAsk.id) {
      return;
    }
    handledAsk.current = autoAsk.id;
    onAutoAskHandled();
    void ask(autoAsk.text);
    // ask is intentionally read from the latest render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAsk]);

  const latest = runs[runs.length - 1] ?? null;

  return (
    <div className="agent">
      {runs.length > 0 ? (
        <div className="agent-log" ref={logRef}>
          {runs.map((run) => (
            <div key={run.id} style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              <div className="agent-meta">
                <span className="pill">You</span>
                <span style={{ color: '#d7e8f7' }}>{run.question}</span>
              </div>
              {run.steps.map((step) => (
                <div className="agent-step" key={`${run.id}-${step.step}`}>
                  <span className="tool">{step.tool}</span>
                  <span>
                    {step.summary ??
                      (step.ok === null ? 'running...' : step.ok ? 'ok' : 'failed')}
                  </span>
                </div>
              ))}
              {run.status ? <div className="agent-step">{run.status}</div> : null}
              {run.answer ? <div className="agent-answer">{run.answer}</div> : null}
              {run.commands
                .filter((command) => command.type === 'show_chart')
                .map((command, index) => {
                  if (command.type !== 'show_chart') {
                    return null;
                  }
                  const max = Math.max(...command.series.map((item) => item.value), 1);
                  return (
                    <div className="chart" key={`chart-${run.id}-${index}`}>
                      <h4>{command.title}</h4>
                      {command.series.map((item) => (
                        <div className="chart-row" key={item.label}>
                          <span className="label">{item.label}</span>
                          <span className="bar-track">
                            <span
                              className="bar"
                              style={{ width: `${(item.value / max) * 100}%` }}
                            />
                          </span>
                          <span className="value">
                            {item.value}
                            {command.unit}
                          </span>
                        </div>
                      ))}
                    </div>
                  );
                })}
              {run.commands
                .filter((command) => command.type === 'show_table')
                .map((command, index) => {
                  if (command.type !== 'show_table') {
                    return null;
                  }
                  return (
                    <div className="table-card" key={`table-${run.id}-${index}`}>
                      <h4 style={{ margin: '0 0 4px', fontSize: 11 }}>{command.title}</h4>
                      <table>
                        <thead>
                          <tr>
                            {command.columns.map((column) => (
                              <th key={column}>{column}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {command.rows.map((row, rowIndex) => (
                            <tr key={rowIndex}>
                              {row.map((cell, cellIndex) => (
                                <td key={cellIndex}>{cell}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  );
                })}
              {run.citations.length > 0 ? (
                <div className="agent-meta">
                  {run.citations.map((citation) => (
                    <span className="pill" key={`${citation.label}-${citation.source}`}>
                      {citation.source}: {citation.label}
                    </span>
                  ))}
                </div>
              ) : null}
              {run.error ? <div className="error-banner">{run.error}</div> : null}
              {run.verified !== null ? (
                <div className="agent-meta">
                  <span className={`pill ${run.verified ? 'ok' : 'warn'}`}>
                    {run.verified ? 'grounded' : 'unverified claims'}
                  </span>
                  <span>{run.steps.length} tool calls</span>
                  {run.shareId ? (
                    <button
                      type="button"
                      className="ghost-button"
                      style={{ height: 24, padding: '0 8px', marginLeft: 'auto' }}
                      onClick={() => {
                        const url = `${window.location.origin}/?share=${run.shareId}`;
                        void navigator.clipboard?.writeText(url);
                      }}
                    >
                      Copy link
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="agent-log">
          <div className="agent-empty">
            Ask about coverage, relationships or operators. Answers use only published
            tools and cite the graph; the agent can also move the camera and open a
            satellite.
          </div>
          <div className="agent-prompts">
            {PROMPTS.map((prompt) => (
              <button
                key={prompt}
                type="button"
                className="prompt-chip"
                onClick={() => void ask(prompt)}
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>
      )}
      <form
        className="agent-input"
        onSubmit={(event) => {
          event.preventDefault();
          void ask(input);
        }}
      >
        <span className="tag">ASK</span>
        <input
          aria-label="Ask SatGraph"
          placeholder={
            latest?.shareId && !busy
              ? 'Ask a follow-up question'
              : 'Ask about satellites, links or coverage'
          }
          value={input}
          onChange={(event) => setInput(event.target.value)}
          disabled={busy}
        />
        {busy ? (
          <button
            type="button"
            onClick={() => controllerRef.current?.abort()}
            aria-label="Stop response"
          >
            Stop
          </button>
        ) : (
          <button type="submit" disabled={!input.trim()}>
            Send
          </button>
        )}
      </form>
    </div>
  );
}
