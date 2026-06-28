"use client";

interface StatusData {
  index?: { state?: string; lastReindexAt?: string | null; lastIndexedAt?: string | null };
  embeddings?: { provider?: string | null; model?: string | null; dimension?: number | null; stale?: boolean; staleReason?: string | null; vectorTablesReady?: boolean };
  git?: { branch?: string; uncommitted?: number; recentCommits?: string[] };
  warnings?: string[];
}

/**
 * Health DETAIL only — headline counts live in the top MetricStrip, so this panel
 * adds the things the strip can't: embedding readiness, warnings, recent commits.
 */
export function StatusPanel({ data }: { data: StatusData | null }) {
  if (!data) return <div className="panel"><h2>Health</h2><p className="muted">No data.</p></div>;
  const e = data.embeddings ?? {};

  return (
    <div className="panel">
      <h2>Health</h2>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <span className={`badge ${e.vectorTablesReady ? "green" : "red"}`}>{e.vectorTablesReady ? "vectors ready" : "vectors not ready"}</span>
        <span className={`badge ${e.stale ? "yellow" : "green"}`}>{e.stale ? "embeddings stale" : "embeddings fresh"}</span>
        {e.provider && <span className="badge muted">{e.provider} · {e.model}</span>}
        {(data.git?.uncommitted ?? 0) > 0 && <span className="badge yellow">{data.git!.uncommitted} uncommitted</span>}
      </div>

      {e.stale && e.staleReason && <div className="muted" style={{ fontSize: 11, marginBottom: 10 }}>↳ {e.staleReason}</div>}

      {data.warnings && data.warnings.length > 0 ? (
        <div style={{ marginBottom: 12 }}>
          <h2>Warnings</h2>
          {data.warnings.map((w, i) => <div key={i} className="err" style={{ fontSize: 11 }}>⚠ {w}</div>)}
        </div>
      ) : (
        <div className="muted" style={{ fontSize: 11, marginBottom: 12 }}>✓ No warnings — index is healthy.</div>
      )}

      {data.git?.recentCommits && data.git.recentCommits.length > 0 && (
        <>
          <h2>Recent commits</h2>
          <div className="scroll" style={{ maxHeight: 150 }}>
            <table>
              <tbody>
                {data.git.recentCommits.map((c, i) => {
                  const [sha, ...rest] = c.split(" ");
                  return <tr key={i}><td style={{ width: 60, color: "var(--accent)" }}>{sha}</td><td>{rest.join(" ")}</td></tr>;
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
