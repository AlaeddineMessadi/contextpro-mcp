"use client";

interface StatusData {
  index?: { state?: string; generation?: number; missingIndexedFiles?: number; removedIndexedFiles?: number; lastReindexAt?: string | null };
  files?: { total?: number; source?: number; indexed?: number };
  embeddings?: { provider?: string | null; model?: string | null; dimension?: number | null; total?: number; stale?: boolean; vectorTablesReady?: boolean };
  memory?: { nodes?: number; edges?: number };
  git?: { branch?: string; uncommitted?: number };
  warnings?: string[];
}

function stateClass(state?: string): string {
  if (state === "fresh") return "green";
  if (state === "stale" || state === "indexing") return "yellow";
  return "red";
}

export function StatusPanel({ data }: { data: StatusData | null }) {
  if (!data) return <div className="panel"><h2>Index &amp; Health</h2><p className="muted">No data.</p></div>;
  const i = data.index ?? {};
  const f = data.files ?? {};
  const e = data.embeddings ?? {};

  return (
    <div className="panel">
      <h2>Index &amp; Health</h2>
      <div className="stat-row">
        <div className="stat">
          <span className={`v ${stateClass(i.state)}`}>{i.state ?? "?"}</span>
          <span className="l">index state</span>
        </div>
        <div className="stat"><span className="v">{f.indexed ?? 0}</span><span className="l">indexed files</span></div>
        <div className="stat"><span className={`v ${(i.missingIndexedFiles ?? 0) > 0 ? "yellow" : ""}`}>{i.missingIndexedFiles ?? 0}</span><span className="l">missing</span></div>
        <div className="stat"><span className={`v ${(i.removedIndexedFiles ?? 0) > 0 ? "yellow" : ""}`}>{i.removedIndexedFiles ?? 0}</span><span className="l">removed</span></div>
        <div className="stat"><span className="v">{i.generation ?? 0}</span><span className="l">generation</span></div>
      </div>

      <div className="stat-row" style={{ marginTop: 16 }}>
        <div className="stat"><span className="v">{e.total ?? 0}</span><span className="l">embeddings</span></div>
        <div className="stat"><span className="v" style={{ fontSize: 14 }}>{e.provider ?? "—"}</span><span className="l">provider</span></div>
        <div className="stat"><span className="v" style={{ fontSize: 14 }}>{e.model ?? "—"}</span><span className="l">model</span></div>
        <div className="stat"><span className="v">{e.dimension ?? "—"}</span><span className="l">dim</span></div>
        <div className="stat">
          <span className="v">{data.memory?.nodes ?? 0}<span className="muted" style={{ fontSize: 13 }}> / {data.memory?.edges ?? 0}</span></span>
          <span className="l">memory nodes / edges</span>
        </div>
      </div>

      <div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
        {data.git?.branch && <span className="badge">⎇ {data.git.branch}</span>}
        {(data.git?.uncommitted ?? 0) > 0 && <span className="badge yellow">{data.git!.uncommitted} uncommitted</span>}
        <span className={`badge ${e.stale ? "yellow" : "green"}`}>{e.stale ? "embeddings stale" : "embeddings fresh"}</span>
        {i.lastReindexAt && <span className="badge muted">reindexed {new Date(i.lastReindexAt).toLocaleString()}</span>}
      </div>

      {data.warnings && data.warnings.length > 0 && (
        <div style={{ marginTop: 12 }}>
          {data.warnings.map((w, idx) => <div key={idx} className="err" style={{ fontSize: 11 }}>⚠ {w}</div>)}
        </div>
      )}
    </div>
  );
}
