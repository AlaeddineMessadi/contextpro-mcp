"use client";
import { useState } from "react";
import type { ToolCall } from "@/lib/mcp";
import type { ToolsData } from "@/lib/dashboard-types";

export function CallTable({ calls }: { calls: ToolCall[] }) {
  if (!calls.length)
    return (
      <div className="empty-inline">
        <strong>No recorded calls here yet.</strong>
        <p>
          Run a ContextPro tool in this workspace, or change the activity
          filters.
        </p>
      </div>
    );
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Tool</th>
            <th>Result</th>
            <th className="num">Duration</th>
            <th className="num">Called at</th>
          </tr>
        </thead>
        <tbody>
          {calls.map((c, i) => (
            <tr key={`${c.calledAt}-${i}`}>
              <td>
                <code>{c.tool}</code>
              </td>
              <td>
                <span
                  className={`badge ${c.status === "error" ? "red" : "green"}`}
                >
                  {c.status}
                </span>
              </td>
              <td className="num">{c.durationMs.toLocaleString()} ms</td>
              <td className="num muted">
                <time
                  dateTime={new Date(c.calledAt).toISOString()}
                  title={new Date(c.calledAt).toLocaleString()}
                >
                  {new Date(c.calledAt).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function ToolsPanel({ data }: { data: ToolsData | null }) {
  const [tool, setTool] = useState("");
  const [result, setResult] = useState("all");
  const [limit, setLimit] = useState(25);
  if (!data)
    return (
      <section className="panel">
        <h2>Recorded activity</h2>
        <p className="muted">Waiting for tool history…</p>
      </section>
    );
  const filtered = data.history.filter(
    (c) =>
      (!tool || c.tool === tool) && (result === "all" || c.status === result),
  );
  const saved = data.aggregates.reduce((n, a) => n + (a.savedTokens ?? 0), 0);
  return (
    <>
      <section className="panel">
        <div className="section-heading">
          <h2>Recorded activity</h2>
          <span className="muted">
            {data.total.toLocaleString()} calls · all time
          </span>
        </div>
        <div className="filters">
          <label>
            Tool
            <select
              value={tool}
              onChange={(e) => {
                setTool(e.target.value);
                setLimit(25);
              }}
            >
              <option value="">All tools</option>
              {data.aggregates.map((a) => (
                <option key={a.tool}>{a.tool}</option>
              ))}
            </select>
          </label>
          <label>
            Result
            <select
              value={result}
              onChange={(e) => {
                setResult(e.target.value);
                setLimit(25);
              }}
            >
              <option value="all">All results</option>
              <option value="ok">Successful</option>
              <option value="error">Errors</option>
            </select>
          </label>
          <span className="muted">
            {filtered.length} matches in latest {data.history.length} calls
          </span>
        </div>
        <CallTable calls={filtered.slice(0, limit)} />
        {filtered.length > limit && (
          <button className="load-more" onClick={() => setLimit((n) => n + 25)}>
            Show 25 more calls
          </button>
        )}
      </section>
      <details className="panel diagnostics">
        <summary>Tool timings · {data.aggregates.length} tools</summary>
        <p className="muted">
          Measured durations across this project&apos;s recorded history.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Tool</th>
                <th className="num">Calls</th>
                <th className="num">Errors</th>
                <th className="num">Average</th>
                <th className="num">Maximum</th>
              </tr>
            </thead>
            <tbody>
              {data.aggregates.map((a) => (
                <tr key={a.tool}>
                  <td>
                    <button
                      className="tool-link"
                      onClick={() => {
                        setTool(a.tool);
                        setLimit(25);
                      }}
                    >
                      {a.tool}
                    </button>
                  </td>
                  <td className="num">{a.calls.toLocaleString()}</td>
                  <td className={`num ${a.errors ? "err" : ""}`}>{a.errors}</td>
                  <td className="num">{a.avgMs.toLocaleString()} ms</td>
                  <td className="num">{a.maxMs.toLocaleString()} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <details className="panel diagnostics">
        <summary>Source-output estimates</summary>
        <p>
          ~{saved.toLocaleString()} estimated source tokens avoided compared
          with full-file reads. These estimates are not measured billing savings
          or a comparison with native coding-agent behavior.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Tool</th>
                <th className="num">Estimated tokens avoided</th>
                <th className="num">Represented file references</th>
              </tr>
            </thead>
            <tbody>
              {data.aggregates.map((a) => (
                <tr key={a.tool}>
                  <td>
                    <code>{a.tool}</code>
                  </td>
                  <td className="num">
                    ~{(a.savedTokens ?? 0).toLocaleString()}
                  </td>
                  <td className="num">{a.representedFiles ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}
