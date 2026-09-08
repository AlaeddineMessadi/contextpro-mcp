"use client";

import { useState } from "react";

import INSTRUCTIONS from "../generated/agent-instructions.json";

export default function InstructionsSection() {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(INSTRUCTIONS);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <section
      className="instructions-section"
      style={{
        position: "relative",
        zIndex: 1,
        padding: "0px 100px 40px",
        width: "100%",
        display: "flex",
        minHeight: "100vh",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        className="instr-inner-row"
        style={{
          display: "flex",
          gap: 40,
          alignItems: "stretch",
          width: "100%",
        }}
      >
        <div
          className="instr-dashed-square"
          style={{
            flex: 1,
            pointerEvents: "none",
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
            borderRadius: 20,
            overflow: "hidden",
          }}
        >
          <svg width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <pattern
                id="instr-diag-lines"
                width="6"
                height="6"
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <line
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="6"
                  stroke="#888888"
                  strokeWidth="1.5"
                />
              </pattern>
            </defs>
            <rect
              x="0"
              y="0"
              width="100%"
              height="100%"
              fill="url(#instr-diag-lines)"
            />
          </svg>
        </div>
        <div style={{ maxWidth: 1200, flex: "0 1 1200px" }}>
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
              textAlign: "right" as const,
              marginBottom: 40,
            }}
          >
            Append this policy to your agent&apos;s project rules, preserving existing
            guidance. Use bounded context, verify reference coverage, and keep
            native reads available when they are the simpler choice.
          </p>

          <div
            style={{
              background: "var(--code-bg)",
              backdropFilter: "blur(8px)",
              WebkitBackdropFilter: "blur(8px)",
              borderRadius: 14,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "10px 24px 0",
              }}
            >
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 300,
                  color: "var(--text-faint)",
                  fontFamily: "var(--font-geist-mono)",
                }}
              >
                INSTRUCTIONS.md
              </span>
              <button
                onClick={handleCopy}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: "4px 8px",
                  fontSize: 13,
                  fontWeight: 300,
                  color: copied ? "var(--text-primary)" : "var(--text-faint)",
                  fontFamily: "var(--font-geist-mono)",
                  transition: "color 0.15s",
                }}
              >
                {copied ? "copied" : "copy"}
              </button>
            </div>
            <pre
              style={{
                fontFamily: "var(--font-geist-mono)",
                fontSize: 13,
                fontWeight: 300,
                lineHeight: "20px",
                color: "var(--text-body)",
                padding: "12px 24px 20px",
                overflow: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                margin: 0,
                maxHeight: 400,
              }}
            >
              {INSTRUCTIONS}
            </pre>
          </div>
        </div>
      </div>
    </section>
  );
}
