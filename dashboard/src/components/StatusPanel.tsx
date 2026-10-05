"use client";
import type { StatusData } from "@/lib/dashboard-types";

export function StatusPanel({ data }: { data: StatusData | null }) {
  if (!data)
    return (
      <section className="panel">
        <h2>Search readiness</h2>
        <p className="muted">Waiting for project status…</p>
      </section>
    );
  const e = data.embeddings;
  const semantic = Boolean(
    e?.vectorTablesReady && (e.fileSearch ?? 0) > 0 && !e.stale,
  );
  const drift =
    (data.index?.missingIndexedFiles ?? 0) +
    (data.index?.removedIndexedFiles ?? 0);
  return (
    <section className="panel health-panel">
      <h2>Search readiness</h2>
      <dl className="fact-list">
        <div>
          <dt>Source coverage</dt>
          <dd>
            <span
              className={`badge ${data.index?.state === "fresh" ? "green" : "yellow"}`}
            >
              {data.index?.state ?? "Unknown"}
            </span>
          </dd>
        </div>
        <div>
          <dt>Index drift</dt>
          <dd>{drift} files</dd>
        </div>
        <div>
          <dt>File search</dt>
          <dd>{semantic ? "Semantic + lexical" : "Lexical available"}</dd>
        </div>
        <div>
          <dt>Source embeddings</dt>
          <dd>
            {e?.stale ? (
              <span className="badge yellow">Stale</span>
            ) : (e?.fileSearch ?? 0) > 0 ? (
              `${e?.fileSearch} files`
            ) : (
              "Not indexed"
            )}
          </dd>
        </div>
      </dl>
      {!semantic && (
        <p className="muted">
          Lexical discovery and precise source reads remain available.
          {e?.staleReason ? ` ${e.staleReason}` : ""}
        </p>
      )}
      {e?.lastReindexSkipped && (
        <p className="muted">
          The last source reindex skipped embedding generation.
        </p>
      )}
      {e?.lastReindexError && (
        <p className="err">Embedding generation: {e.lastReindexError}</p>
      )}
      {Boolean(data.warnings?.length) && (
        <details className="diagnostics">
          <summary>{data.warnings!.length} status notes</summary>
          <ul>
            {data.warnings!.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}
      <details className="diagnostics">
        <summary>Configuration &amp; build</summary>
        <dl className="fact-list">
          <div>
            <dt>Embedding provider</dt>
            <dd>{e?.provider ?? "Not configured"}</dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>{e?.model ?? "—"}</dd>
          </div>
          <div>
            <dt>Dimensions</dt>
            <dd>{e?.dimension ?? "—"}</dd>
          </div>
          <div>
            <dt>Vector storage</dt>
            <dd>{e?.vectorTablesReady ? "Initialized" : "Unavailable"}</dd>
          </div>
          <div>
            <dt>Total embeddings</dt>
            <dd>{e?.total ?? "—"}</dd>
          </div>
          <div>
            <dt>Identifier embeddings</dt>
            <dd>{e?.identifiers ?? "—"}</dd>
          </div>
          <div>
            <dt>Memory embeddings</dt>
            <dd>{e?.memory ?? "—"}</dd>
          </div>
          <div>
            <dt>Working tree changes</dt>
            <dd>{data.git?.uncommitted ?? "—"}</dd>
          </div>
          <div>
            <dt>Reader version</dt>
            <dd>{data.runtime?.serverVersion ?? "Unknown"}</dd>
          </div>
          <div>
            <dt>Reader build</dt>
            <dd>{data.runtime?.buildStamp ?? "Unknown"}</dd>
          </div>
        </dl>
        <p className="muted">
          Build identity comes from the dashboard&apos;s loaded ContextPro
          modules. Running MCP sessions are listed in Resources.
        </p>
      </details>
      {Boolean(data.git?.recentCommits?.length) && (
        <details className="diagnostics">
          <summary>Recent commits</summary>
          <ul className="commit-list">
            {data.git!.recentCommits!.map((c) => (
              <li key={c}>
                <code>{c.slice(0, c.indexOf(" "))}</code>{" "}
                {c.slice(c.indexOf(" ") + 1)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
