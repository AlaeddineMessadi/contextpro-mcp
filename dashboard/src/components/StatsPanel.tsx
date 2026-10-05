"use client";

interface StatsData {
  totalFiles: number;
  totalSymbols: number;
  avgSymbolsPerFile: number;
  languages: Array<{ language: string; files: number; symbols: number }>;
  largestFiles: Array<{ path: string; symbols: number }>;
}

interface Timing {
  lastReindexDurationMs?: number | null;
  lastReindexAt?: string | null;
  state?: string;
}

const LANG_COLORS: Record<string, string> = {
  typescript: "#3178c6",
  javascript: "#f1e05a",
  python: "#3572A5",
  rust: "#dea584",
  go: "#00ADD8",
  java: "#b07219",
  ruby: "#701516",
  php: "#4F5D95",
  "c++": "#f34b7d",
  c: "#555555",
  markdown: "#083fa1",
  json: "#cbcb41",
  yaml: "#cb171e",
  other: "#8b90a0",
};

function fmtDuration(ms?: number | null): string {
  if (!ms || ms <= 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export function StatsPanel({
  data,
  timing,
}: {
  data: StatsData | null;
  timing: Timing | null;
}) {
  if (!data)
    return (
      <section className="panel">
        <h2>Index Stats</h2>
        <p className="muted">Waiting for index statistics…</p>
      </section>
    );
  const maxLangFiles = Math.max(1, ...data.languages.map((l) => l.files));

  return (
    <section className="panel">
      <h2>Index composition</h2>
      <div className="stat-row" style={{ marginBottom: 14 }}>
        <div className="stat">
          <span className="v">{data.totalFiles.toLocaleString()}</span>
          <span className="l">indexed files</span>
        </div>
        <div className="stat">
          <span className="v">{data.totalSymbols.toLocaleString()}</span>
          <span className="l">symbols</span>
        </div>
        <div className="stat">
          <span className="v">{data.avgSymbolsPerFile}</span>
          <span className="l">avg symbols / file</span>
        </div>
        <div className="stat">
          <span className="v">
            {fmtDuration(timing?.lastReindexDurationMs)}
          </span>
          <span className="l">last reindex</span>
        </div>
      </div>

      <h2>By language</h2>
      <div className="table-wrap">
        <table>
          <tbody>
            {data.languages.map((l) => (
              <tr key={l.language}>
                <td style={{ minWidth: 120, whiteSpace: "nowrap" }}>
                  <span
                    style={{
                      display: "inline-block",
                      width: 8,
                      height: 8,
                      borderRadius: 2,
                      background: LANG_COLORS[l.language] ?? LANG_COLORS.other,
                      marginRight: 6,
                    }}
                  />
                  {l.language}
                </td>
                <td className="num" style={{ width: 70 }}>
                  {l.files} {l.files === 1 ? "file" : "files"}
                </td>
                <td style={{ width: "100%", minWidth: 140 }}>
                  <div className="bar">
                    <span
                      style={{
                        width: `${(l.files / maxLangFiles) * 100}%`,
                        background:
                          LANG_COLORS[l.language] ?? LANG_COLORS.other,
                      }}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 style={{ marginTop: 14 }}>Top 10 files by symbol count</h2>
      <div className="scroll" style={{ maxHeight: 400 }}>
        <table>
          <tbody>
            {data.largestFiles.map((f) => (
              <tr key={f.path}>
                <td title={f.path}>{f.path}</td>
                <td className="num">{f.symbols}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
