import { resolveRoot } from "@/lib/projects";
import { startReindex, getReindexState } from "@/lib/mcp";

export const dynamic = "force-dynamic";

// POST kicks off a reindex in the background and returns immediately. A full
// reindex (with embeddings) can take minutes — too long to hold an HTTP request —
// so the client polls GET /api/reindex (and /api/status) for live progress.
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const root = await resolveRoot(body.root ?? null);
    if (!root) return Response.json({ error: "no project root" }, { status: 404 });
    const res = await startReindex(root, Boolean(body.force));
    return Response.json({ root, ...res });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}

export async function GET(request: Request) {
  try {
    const root = await resolveRoot(new URL(request.url).searchParams.get("root"));
    if (!root) return Response.json({ error: "no project root" }, { status: 404 });
    return Response.json({ root, state: getReindexState(root) });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
