import Background from "../components/Background";
import Header from "../components/Header";
import IdeSetup from "../components/IdeSetup";
import InstructionsSection from "../components/InstructionsSection";
import IsometricDiagram from "../components/IsometricDiagram";
import ToolDiagram from "../components/ToolDiagram";

export const dynamic = "force-dynamic";

const toolRefRows = [
  {
    "name": "context",
    "desc": "In lean/full profiles, find and read bounded source in one call, or batch known targets without search. Expand explicit omissions only when needed.",
    "input": "{\n  \"targets\": [\n    {\n      \"file\": \"src/api.ts\",\n      \"symbol\": \"create\"\n    }\n  ],\n  \"max_tokens\": 2000\n}",
    "output": "Illustrative: source ranges with file/line provenance, plus omitted targets or spans."
  },
  {
    "name": "search",
    "desc": "Find files and symbols with hybrid ranking or provider-free keyword_only retrieval. Compact output avoids diagnostic verbosity.",
    "input": "{\n  \"query\": \"authentication token validation\",\n  \"preset\": \"keyword_only\",\n  \"format\": \"compact\"\n}",
    "output": "Illustrative: ranked definitions and source excerpts, with freshness and retrieval warnings."
  },
  {
    "name": "skeleton",
    "desc": "Read signatures and public contracts without whole bodies. The exported-only option applies to TypeScript/JavaScript.",
    "input": "{\n  \"file_path\": \"src/api.ts\",\n  \"exported_only\": true\n}",
    "output": "Illustrative: export function create(input: Request): Promise<Response>;"
  },
  {
    "name": "exact_references",
    "desc": "Use project-aware compiler references for TS/JS. Check direct-call counts, total/returned occurrences, truncation and declared scope. Enable through discover_tools when needed.",
    "input": "{\n  \"symbol_name\": \"create\",\n  \"file\": \"src/api.ts\",\n  \"line\": 12,\n  \"format\": \"json\"\n}",
    "output": "Illustrative: total=4, returned=4, truncated=false; definition=1, import=1, call=2. Dynamic/unindexed references are outside scope."
  },
  {
    "name": "blast_radius",
    "desc": "Collect textual usage candidates before a change. Matching lines and names are not a binding-resolved reference set.",
    "input": "{\n  \"symbol_name\": \"create\",\n  \"mode\": \"summary\",\n  \"kind\": \"call\"\n}",
    "output": "Illustrative: call-containing lines grouped by file and enclosing symbol; verify completeness warnings."
  },
  {
    "name": "validate_scope",
    "desc": "Suggest relevant validation for changed files. The agent must still execute and inspect the actual checks.",
    "input": "{\n  \"task\": \"Update request validation\",\n  \"files\": [\n    \"src/api.ts\"\n  ],\n  \"format\": \"json\"\n}",
    "output": "Illustrative: nearest regression tests and build/typecheck commands with reasons."
  },
  {
    "name": "checkpoint",
    "desc": "Write a file with a pre-write restore point and revision checks. Optional style checks do not replace the target project's conventions.",
    "input": "{\n  \"file_path\": \"src/api.ts\",\n  \"new_content\": \"export const version = 2;\"\n}",
    "output": "Illustrative: saved path and restore point, or a conflict that requires rereading current source."
  },
  {
    "name": "restore",
    "desc": "Preview a restore before applying it. Applying a restore creates a recovery point; multi-file publication is not transactional.",
    "input": "{\n  \"point_id\": \"rp-timestamp-hash\",\n  \"preview\": true\n}",
    "output": "Illustrative: planned file overwrites/deletions and available recovery details."
  }
];

async function getStars(): Promise<number> {
  try {
    const res = await fetch(
      "https://api.github.com/repos/AlaeddineMessadi/contextpro-mcp",
      { cache: "no-store" },
    );
    if (!res.ok) {
      return 0;
    }
    const data = await res.json();
    return data.stargazers_count ?? 0;
  } catch {
    return 0;
  }
}

export default async function Home() {
  const stars = await getStars();

  return (
    <div className="relative w-full min-h-screen">
      <Background />
      <Header stars={stars} />

      <div
        className="hero-diagram-row"
        style={{
          display: "flex",
          alignItems: "center",
          padding: "0 100px",
          gap: 60,
          zIndex: 1,
          position: "relative",
        }}
      >
        <section
          className="hero-section flex flex-col relative"
          style={{ gap: 24, flex: "1 1 auto", minWidth: 0, maxWidth: 630 }}
        >
          <h1
            className="hero-title font-light"
            style={{
              fontSize: 56,
              lineHeight: "72px",
              letterSpacing: "-0.02em",
              color: "var(--text-muted)",
              fontFamily: "var(--font-geist-sans)",
            }}
          >
            Semantic Intelligence for
            <br />
            <span style={{ color: "var(--text-primary)" }}>
              Large-Scale Engineering.
            </span>
          </h1>
          <p
            className="hero-text font-light"
            style={{
              fontSize: 18,
              lineHeight: "28px",
              letterSpacing: "-0.02em",
              background:
                "linear-gradient(180deg, var(--text-primary) 0%, var(--gradient-end) 100%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
            }}
          >
            ContextPro gives coding agents bounded source context, project-aware
            references and explicit freshness signals. Discover unfamiliar code,
            inspect contracts and validate changes with less repeated reading.
          </p>
        </section>
      </div>

      <IsometricDiagram />

      <div
        className="diagram-outer"
        style={{
          position: "relative",
          zIndex: 1,
          width: "fit-content",
          margin: "0 auto",
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
        }}
      >
        <ToolDiagram />
      </div>

      <IdeSetup />

      <InstructionsSection />

      <section
        className="tools-ref"
        style={{
          position: "relative",
          zIndex: 1,
          padding: "40px 100px 80px",
          width: "100%",
          maxWidth: 1200,
          marginLeft: "auto",
          marginRight: "auto",
        }}
      >
        <p
          style={{
            fontSize: 18,
            fontWeight: 300,
            lineHeight: "28px",
            fontFamily: "var(--font-geist-pixel-square)",
            letterSpacing: "-0.02em",
            background:
              "linear-gradient(180deg, var(--text-primary) 0%, var(--gradient-end) 100%)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            backgroundClip: "text" as const,
            maxWidth: 630,
            marginLeft: "auto",
            marginRight: "auto",
            textAlign: "center" as const,
            marginBottom: 40,
          }}
        >
          ContextPro guarantees minimal context bloat. It gives your agent deep
          semantic understanding of your codebase, from AST parsing and symbol
          navigation to blast radius analysis and commit validation. Nothing
          misses the context, with RAG.
        </p>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            borderSpacing: 0,
          }}
        >
          <tbody>
            {toolRefRows.map(({ name, desc, input, output }) => (
              <tr key={name} style={{ verticalAlign: "top" }}>
                <td
                  style={{
                    padding: "24px 32px 24px 0",
                    borderBottom: "1px solid var(--table-border)",
                    whiteSpace: "nowrap",
                  }}
                >
                  <code
                    style={{
                      fontFamily: "var(--font-geist-pixel-square)",
                      fontSize: 14,
                      fontWeight: 500,
                      color: "var(--text-primary)",
                      letterSpacing: "-0.02em",
                    }}
                  >
                    {name}
                  </code>
                </td>
                <td
                  style={{
                    padding: "24px 0",
                    borderBottom: "1px solid var(--table-border)",
                  }}
                >
                  <p
                    style={{
                      fontSize: 14,
                      fontWeight: 300,
                      lineHeight: "22px",
                      color: "var(--text-body)",
                      marginBottom: 16,
                      fontFamily: "var(--font-geist-sans)",
                    }}
                  >
                    {desc}
                  </p>
                  <div
                    className="code-pair"
                    style={{ display: "flex", gap: 12, width: "100%" }}
                  >
                    <pre
                      style={{
                        flex: 1,
                        fontFamily: "var(--font-geist-mono)",
                        fontSize: 12,
                        fontWeight: 300,
                        lineHeight: "18px",
                        color: "var(--text-code)",
                        background: "var(--code-bg)",
                        backdropFilter: "blur(8px)",
                        WebkitBackdropFilter: "blur(8px)",
                        borderRadius: 8,
                        padding: "12px 16px",
                        overflow: "auto",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        margin: 0,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 500,
                          color: "var(--text-faint)",
                          display: "block",
                          marginBottom: 6,
                          fontFamily: "var(--font-geist-mono)",
                        }}
                      >
                        INPUT
                      </span>
                      {input}
                    </pre>
                    <pre
                      style={{
                        flex: 2,
                        fontFamily: "var(--font-geist-mono)",
                        fontSize: 12,
                        fontWeight: 300,
                        lineHeight: "18px",
                        color: "var(--text-code)",
                        background: "var(--code-bg)",
                        backdropFilter: "blur(8px)",
                        WebkitBackdropFilter: "blur(8px)",
                        borderRadius: 8,
                        padding: "12px 16px",
                        overflow: "auto",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        margin: 0,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 500,
                          color: "var(--text-faint)",
                          display: "block",
                          marginBottom: 6,
                          fontFamily: "var(--font-geist-mono)",
                        }}
                      >
                        OUTPUT
                      </span>
                      {output}
                    </pre>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section
        className="quote-section"
        style={{
          position: "relative",
          zIndex: 1,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "80px 100px",
          textShadow: "0 4px 12px var(--quote-shadow)",
        }}
      >
        <p
          style={{
            fontFamily: "var(--font-geist-sans)",
            fontSize: 48,
            fontWeight: 300,
            lineHeight: "68px",
            letterSpacing: "-0.05em",
            textAlign: "center",
            maxWidth: 900,
            background:
              "linear-gradient(180deg, var(--text-primary) 0%, var(--gradient-end) 100%)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            backgroundClip: "text" as const,
          }}
        >
          &ldquo;Context engineering is the delicate art and science of filling
          the context window with just the right information for the next
          step.&rdquo;
        </p>
        <a
          href="https://x.com/karpathy/status/1937902205765607626"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            marginTop: 24,
            fontSize: 16,
            fontWeight: 300,
            color: "var(--text-secondary)",
            textDecoration: "none",
            fontFamily: "var(--font-geist-pixel-square)",
            letterSpacing: "-0.02em",
          }}
        >
          - Andrej Karpathy
        </a>
      </section>

      <footer
        className="site-footer"
        style={{
          position: "relative",
          zIndex: 1,
          padding: "80px 100px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderTop: "1.5px solid var(--footer-border)",
          background: "var(--nav-bg)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
        }}
      >
        <span
          className="font-light"
          style={{
            fontSize: 22,
            lineHeight: "28px",
            color: "var(--text-primary)",
          }}
        >
          ContextPro
        </span>
        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          <a
            href="https://www.npmjs.com/package/contextpro-mcp"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 256 256"
              fill="var(--icon-color)"
            >
              <path d="M0 256V0h256v256H0zm41-41h57.5V71.2H141V215h34V41H41v174z" />
            </svg>
          </a>
          <a
            href="https://github.com/AlaeddineMessadi/contextpro-mcp"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center"
            style={{ gap: 8 }}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--icon-color)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
            </svg>
            <span
              className="font-light"
              style={{
                fontSize: 18,
                lineHeight: "24px",
                color: "var(--text-primary)",
              }}
            >
              {stars}
            </span>
          </a>
        </div>
      </footer>
    </div>
  );
}
