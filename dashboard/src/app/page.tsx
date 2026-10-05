"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import { StatusPanel } from "@/components/StatusPanel";
import { StatsPanel } from "@/components/StatsPanel";
import { ToolsPanel, CallTable } from "@/components/ToolsPanel";
import { PerfPanel } from "@/components/PerfPanel";
import { GraphHero } from "@/components/GraphHero";
import { useDashboard } from "@/lib/use-dashboard";
import { visibleProjects, feedsForView } from "@/lib/feed-client.mjs";
import { pendingJobsReducer, pendingJobOutcome } from "@/lib/pending-jobs.mjs";
import type { Project, View } from "@/lib/dashboard-types";

const views: Array<{
  id: View;
  label: string;
  subtitle: string;
  path: string;
}> = [
  {
    id: "overview",
    label: "Overview",
    subtitle: "Readiness and recent activity, at a glance.",
    path: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  },
  {
    id: "activity",
    label: "Activity",
    subtitle: "Recorded tool calls and measured response times.",
    path: "M3 12h4l3-8 4 16 3-8h4",
  },
  {
    id: "index",
    label: "Index",
    subtitle: "Source coverage, search readiness, and index maintenance.",
    path: "M4 5h16v4H4z M4 11h16v4H4z M4 17h16v4H4z",
  },
  {
    id: "graph",
    label: "Graph",
    subtitle: "Explore code dependencies and project memory.",
    path: "M6 6l12 12 M6 18L18 6 M6 6h12 M6 18h12 M4 4h4v4H4z M16 4h4v4h-4z M4 16h4v4H4z M16 16h4v4h-4z",
  },
  {
    id: "resources",
    label: "Resources",
    subtitle: "Machine-wide processes and project tool timings.",
    path: "M5 4h14v16H5z M9 8h6 M9 12h6 M9 16h2",
  },
];
function projectName(p?: Project) {
  return (
    p?.projectId ??
    p?.root.split("/").filter(Boolean).pop() ??
    "Choose a project"
  );
}
function date(value?: number | string | null) {
  return value ? new Date(value).toLocaleString() : "Not recorded";
}

export default function Dashboard() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [root, setRoot] = useState("");
  const [view, setView] = useState<View>("overview");
  const [query, setQuery] = useState("");
  const [includeUnavailable, setIncludeUnavailable] = useState(false);
  const [projectError, setProjectError] = useState("");
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [live, setLive] = useState(true);
  const [pendingJobs, dispatchJob] = useReducer(pendingJobsReducer, {});
  const pending = pendingJobs[root];
  const [actionError, setActionError] = useState<{
    root: string;
    message: string;
  } | null>(null);
  const [posting, setPosting] = useState(false);
  const picker = useRef<HTMLDetailsElement>(null);
  const rootRef = useRef(root);
  rootRef.current = root;
  const project = projects.find((p) => p.root === root);
  const { data, errors, updated, readStarted, refresh } = useDashboard(
    root,
    view,
    live,
    Boolean(project?.hasIndex || pending),
    Boolean(pending),
  );
  const status = data.status?.status;
  const tools = data.tools;
  const job = data.reindex?.state;
  const indexing = Boolean(
    job?.running || pending || status?.index?.state === "indexing",
  );
  const selected = views.find((v) => v.id === view)!;
  const currentFeeds = feedsForView(view);
  const failures = Object.entries(errors).filter(([feed]) =>
    currentFeeds.includes(feed as (typeof currentFeeds)[number]),
  );
  const displayedUpdates = currentFeeds
    .map((feed) => updated[feed])
    .filter((n): n is number => n !== undefined);
  const lastUpdate = displayedUpdates.length
    ? Math.min(...displayedUpdates)
    : undefined;
  const listed = visibleProjects(projects, query, includeUnavailable);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/projects", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok)
          throw new Error(result.error || "Could not load projects");
        if (controller.signal.aborted) return;
        const items: Project[] = result.projects ?? [];
        setProjects(items);
        let remembered: string | null = null;
        try {
          remembered = localStorage.getItem("contextpro.dashboard.project");
        } catch {
          /* storage may be disabled */
        }
        setRoot(
          items.find((p) => p.root === remembered && p.hasIndex)?.root ??
            items.find((p) => p.hasIndex)?.root ??
            items[0]?.root ??
            "",
        );
        setProjectsLoaded(true);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setProjectError(String(error));
          setProjectsLoaded(true);
        }
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (root) {
      try {
        localStorage.setItem("contextpro.dashboard.project", root);
      } catch {
        /* optional preference */
      }
    }
  }, [root]);
  useEffect(() => {
    const outcome = pendingJobOutcome(pending, job, readStarted.reindex ?? 0);
    if (!pending || !outcome) return;
    dispatchJob({ type: "settled", root, acceptedAt: pending.acceptedAt });
    if (outcome === "complete")
      setProjects((items) =>
        items.map((p) => (p.root === root ? { ...p, hasIndex: true } : p)),
      );
    if (outcome === "failed")
      setActionError({ root, message: job?.error || "Indexing failed." });
    if (outcome === "missing") {
      setActionError({
        root,
        message:
          "The indexing job is no longer tracked by this dashboard process. Refresh the project status before retrying.",
      });
    }
  }, [job, pending, root, readStarted.reindex]);

  async function reindex(force: boolean) {
    if (!root || indexing || posting) return;
    const requestedRoot = root;
    const startedRequestAt = Date.now();
    setPosting(true);
    setActionError(null);
    try {
      const response = await fetch("/api/reindex", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root: requestedRoot, force }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "Could not start indexing");
      dispatchJob({
        type: "accepted",
        root: requestedRoot,
        requestedAt: startedRequestAt,
        acceptedAt: performance.now(),
        alreadyRunning: result.alreadyRunning,
      });
      if (rootRef.current === requestedRoot) void refresh();
    } catch (error) {
      setActionError({ root: requestedRoot, message: String(error) });
    } finally {
      setPosting(false);
    }
  }

  const ready = status?.index?.state === "fresh";
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="sidebar">
        <div className="brand">
          <svg viewBox="0 0 32 32" aria-hidden="true">
            <path d="M7 4h12v8H7z M13 12h12v8H13z M7 20h12v8H7z" />
          </svg>
          <span>
            ContextPro<small>DEVELOPMENT CONSOLE</small>
          </span>
        </div>
        <div className="workspace-label">
          WORKSPACE{" "}
          <span>{projects.filter((p) => p.hasIndex).length} indexed</span>
        </div>
        <details className="project-picker" ref={picker}>
          <summary>
            <span>
              {projectName(project)}
              <small>
                {project?.hasIndex
                  ? "Local index"
                  : projectsLoaded
                    ? "No index"
                    : "Loading projects…"}
              </small>
            </span>
            <span aria-hidden="true">⌄</span>
          </summary>
          <div className="project-menu">
            <label className="sr-only" htmlFor="project-search">
              Search projects
            </label>
            <input
              id="project-search"
              placeholder="Find a project or path…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <label className="checkbox">
              <input
                type="checkbox"
                checked={includeUnavailable}
                onChange={(e) => setIncludeUnavailable(e.target.checked)}
              />
              Include projects without an index
            </label>
            <div className="project-list">
              {listed.map((p) => (
                <button
                  key={p.root}
                  aria-pressed={p.root === root}
                  onClick={() => {
                    setRoot(p.root);
                    picker.current?.removeAttribute("open");
                  }}
                >
                  <strong>{projectName(p)}</strong>
                  <small>{p.root}</small>
                  {!p.hasIndex && (
                    <span className="muted">
                      {p.available === false
                        ? "Folder unavailable"
                        : "Not indexed"}
                    </span>
                  )}
                </button>
              ))}
              {listed.length === 0 && (
                <p className="muted">
                  No matching projects. Try a different name or include projects
                  without an index.
                </p>
              )}
            </div>
          </div>
        </details>
        <nav aria-label="Dashboard views">
          {views.map((v) => (
            <button
              key={v.id}
              className={view === v.id ? "nav-item active" : "nav-item"}
              aria-current={view === v.id ? "page" : undefined}
              onClick={() => setView(v.id)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d={v.path} />
              </svg>
              {v.label}
              <span aria-hidden="true">{view === v.id ? "↗" : ""}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="local-marker" />
          Local workspace<p>Index health and activity from your own machine.</p>
        </div>
      </aside>

      <main id="main" className="main">
        <header className="page-header">
          <div>
            <div className="breadcrumb">
              {projectName(project)} <span>/ {selected.label}</span>
            </div>
            <h1>{view === "overview" ? "Project overview" : selected.label}</h1>
            <p className="muted">{selected.subtitle}</p>
          </div>
          <div className="header-actions">
            <button
              className="live-control"
              aria-pressed={live}
              onClick={() => setLive((v) => !v)}
            >
              <span className={live ? "live-indicator" : "paused-indicator"} />
              {live ? "Live updates" : "Updates paused"}
            </button>
            <button
              onClick={() => void refresh()}
              disabled={!root || !project?.hasIndex}
            >
              ↻ Refresh
            </button>
          </div>
        </header>
        <div className="project-context">
          <code title={root}>{root || "No project selected"}</code>
          <span>
            {status?.git?.branch && (
              <>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    d="M6 3v12c0 4 12 4 12-3V6 M3 3h6 M15 6h6 M3 21h6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                  />
                </svg>
                {status.git.branch}
              </>
            )}
          </span>
        </div>
        {projectError && (
          <div className="notice error" role="alert">
            {projectError}
            <button onClick={() => window.location.reload()}>
              Reload projects
            </button>
          </div>
        )}
        {failures.map(([feed, message]) => (
          <div className="notice error" role="alert" key={feed}>
            <strong>{feed} could not update.</strong> {message}{" "}
            {updated[feed as (typeof currentFeeds)[number]] && (
              <span>
                Showing data from{" "}
                {date(updated[feed as (typeof currentFeeds)[number]])}.
              </span>
            )}
            <button onClick={() => void refresh()}>Retry</button>
          </div>
        ))}
        {actionError?.root === root && (
          <div className="notice error" role="alert">
            {actionError.message}
          </div>
        )}
        {job?.running && (
          <div className="notice" role="status">
            Indexing this project. Progress updates continue while live updates
            are paused.
          </div>
        )}
        {job?.finishedAt && !job.running && (
          <div
            className={`notice ${job.error ? "error" : "success"}`}
            role="status"
          >
            {job.error
              ? `Last indexing attempt failed: ${job.error}`
              : `Last indexing run: ${job.indexed ?? 0} ${job.indexed === 1 ? "file" : "files"} updated, ${job.skipped ?? 0} skipped · ${((job.durationMs ?? 0) / 1000).toFixed(1)}s.`}
            <span className="muted">{date(job.finishedAt)}</span>
          </div>
        )}

        {!projectsLoaded && (
          <div className="empty-state">
            <h2>Opening your workspaces</h2>
            <p>Reading the local project registry…</p>
          </div>
        )}
        {projectsLoaded && !root && !projectError && (
          <div className="empty-state">
            <h2>No projects yet</h2>
            <p>
              Use ContextPro in a repository to create its index, then reload
              this dashboard.
            </p>
            <button onClick={() => window.location.reload()}>
              Reload projects
            </button>
          </div>
        )}
        {root && !project?.hasIndex && !pending && (
          <div className="empty-state">
            <h2>
              {project?.available === false
                ? "This folder is unavailable"
                : "This project has no index"}
            </h2>
            <p>
              {project?.available === false
                ? "Choose an indexed workspace above. The registry entry is kept for reference."
                : "Build a source index to inspect this workspace."}
            </p>
            {project?.available !== false && (
              <button
                className="primary"
                onClick={() => void reindex(false)}
                disabled={posting}
              >
                Create index
              </button>
            )}
          </div>
        )}

        {root && (project?.hasIndex || pending) && (
          <>
            {view === "overview" && (
              <>
                <section className="readiness">
                  <div>
                    <span className="eyebrow">SOURCE INDEX</span>
                    <h2>
                      {status
                        ? ready
                          ? "Ready for development."
                          : indexing
                            ? "Indexing in progress."
                            : "Your index needs a look."
                        : errors.status
                          ? "Readiness unavailable."
                          : "Checking project readiness…"}
                    </h2>
                    <p>
                      {status
                        ? ready
                          ? "Source coverage is current. Explore activity or inspect the index for more detail."
                          : status.index?.state === "stale"
                            ? "Source changes are waiting to be reconciled. Refresh the index to bring coverage up to date."
                            : "Inspect the index details to understand the current state."
                        : "Reading the local index and project status."}
                    </p>
                  </div>
                  <button
                    className="text-button"
                    onClick={() => setView("index")}
                  >
                    Inspect index <span aria-hidden="true">→</span>
                  </button>
                </section>
                <div className="summary-row">
                  <div>
                    <span>Indexed source files</span>
                    <strong>
                      {status?.files?.indexed?.toLocaleString() ?? "—"}
                    </strong>
                    <small>
                      {status?.files
                        ? `of ${status.files.source.toLocaleString()} discoverable files`
                        : "Awaiting status"}
                    </small>
                  </div>
                  <div>
                    <span>Recorded tool calls</span>
                    <strong>{tools?.total.toLocaleString() ?? "—"}</strong>
                    <small>Project history · all time</small>
                  </div>
                  <div>
                    <span>Errors in recent calls</span>
                    <strong>
                      {tools
                        ? tools.history.filter((c) => c.status === "error")
                            .length
                        : "—"}
                    </strong>
                    <small>
                      {tools
                        ? `Latest ${tools.history.length} recorded calls`
                        : "Awaiting activity"}
                    </small>
                  </div>
                  <div>
                    <span>Project memory</span>
                    <strong>
                      {status?.memory?.nodes?.toLocaleString() ?? "—"}
                    </strong>
                    <small>
                      {status?.memory
                        ? `${status.memory.edges} connections`
                        : "Awaiting status"}
                    </small>
                  </div>
                </div>
                <div className="overview-grid">
                  <section className="panel">
                    <div className="section-heading">
                      <h2>Recent activity</h2>
                      <button
                        className="text-button"
                        onClick={() => setView("activity")}
                      >
                        View all →
                      </button>
                    </div>
                    {tools ? (
                      <CallTable calls={tools.history.slice(0, 6)} />
                    ) : (
                      <p className="muted">
                        {errors.tools
                          ? "Activity is unavailable. Retry above."
                          : "Loading recorded activity…"}
                      </p>
                    )}
                  </section>
                  <StatusPanel data={status ?? null} />
                </div>
              </>
            )}
            {view === "activity" && (
              <ToolsPanel key={root} data={tools ?? null} />
            )}
            {view === "index" && (
              <>
                <section className="panel maintenance">
                  <div>
                    <h2>Index maintenance</h2>
                    <p className="muted">
                      Update changed files, or rebuild the full index when
                      needed.
                    </p>
                    <small>
                      Last reindex: {date(status?.index?.lastReindexAt)} ·
                      generation {status?.index?.generation ?? "—"}
                    </small>
                  </div>
                  <button
                    className="primary"
                    onClick={() => void reindex(false)}
                    disabled={indexing || posting}
                  >
                    {indexing
                      ? "Indexing…"
                      : posting
                        ? "Starting…"
                        : "Update index"}
                  </button>
                  <details className="advanced">
                    <summary>Advanced</summary>
                    <p>
                      A full rebuild reprocesses every source file and can take
                      several minutes.
                    </p>
                    <button
                      onClick={() => void reindex(true)}
                      disabled={indexing || posting}
                    >
                      Rebuild full index
                    </button>
                  </details>
                </section>
                <StatsPanel
                  data={data.stats?.stats ?? null}
                  timing={status?.index ?? null}
                />
                <StatusPanel data={status ?? null} />
              </>
            )}
            {view === "graph" && (
              <>
                <div className="view-note">
                  Code shows up to 200 connected files. Memory shows recorded
                  concepts, notes, and relationships. Graphs refresh every 30
                  seconds while this view is open.
                </div>
                <GraphHero
                  key={root}
                  code={data.graph?.graph ?? null}
                  memory={data.memory?.memory ?? null}
                />
              </>
            )}
            {view === "resources" && (
              <PerfPanel
                data={data.perf ?? null}
                tools={tools?.aggregates ?? null}
              />
            )}
            <footer className="page-footer">
              <span>
                {lastUpdate
                  ? `Oldest displayed sample: ${date(lastUpdate)}`
                  : "Waiting for the first sample"}
              </span>
              <span>
                {live
                  ? "Visible views refresh every 5 seconds"
                  : "Automatic updates paused"}{" "}
                · local data
              </span>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}
