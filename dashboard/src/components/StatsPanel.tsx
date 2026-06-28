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
  typescript: "#3178c6", javascript: "#f1e05a", python: "#3572A5", rust: "#dea584",
  go: "#00ADD8", java: "#b07219", ruby: "#701516", php: "#4F5D95", "c++": "#f34b7d",
  c: "#555555", markdown: "#083fa1", json: "#cbcb41", yaml: "#cb171e", other: "#8b90a0",
};

function fmtDuration(ms?: number | null): string {
  if (!ms || ms <= 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export function StatsPanel({ data, timing }: { data: StatsData | null; timing: Timing | null }) {
  if (!data) return <div className="panel"><h2>Index Stats</h2><p className="muted">No data.</p></div>;
  const maxLangFiles = Math.max(1, ...data.languages.map((l) => l.files));
  const throughput = timing?.lastReindexDurationMs && data.totalFiles
    ? Math.round((data.totalFiles / (timing.lastReindexDurationMs / 1000)) * 10) / 10
    : null;

  return (
    <div className="panel">
      <h2>Languages &amp; Files</h2>
      <div className="stat-row" style={{ marginBottom: 14 }}>
        <div className="stat"><span className="v">{data.avgSymbolsPerFile}</span><span className="l">avg symbols / file</span></div>
        <div className="stat"><span className="v">{fmtDuration(timing?.lastReindexDurationMs)}</span><span className="l">last reindex</span></div>
        {throughput !== null && <div className="stat"><span className="v">{throughput}<span className="muted" style={{ fontSize: 12 }}> f/s</span></span><span className="l">throughput</span></div>}
      </div>

      <h2>By language</h2>
      <table>
        <tbody>
          {data.languages.slice(0, 8).map((l) => (
            <tr key={l.language}>
              <td style={{ width: 110 }}>
                <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: LANG_COLORS[l.language] ?? LANG_COLORS.other, marginRight: 6 }} />
                {l.language}
              </td>
              <td className="num" style={{ width: 50 }}>{l.files}</td>
              <td style={{ width: "100%" }}><div className="bar"><span style={{ width: `${(l.files / maxLangFiles) * 100}%`, background: LANG_COLORS[l.language] ?? LANG_COLORS.other }} /></div></td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={{ marginTop: 14 }}>Largest files (by symbols)</h2>
      <div className="scroll" style={{ maxHeight: 160 }}>
        <table>
          <tbody>
            {data.largestFiles.map((f) => (
              <tr key={f.path}>
                <td title={f.path}>{f.path.split("/").slice(-2).join("/")}</td>
                <td className="num">{f.symbols}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
