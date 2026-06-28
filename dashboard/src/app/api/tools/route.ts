import { resolveRoot } from "@/lib/projects";
import { toolHistory, toolAggregates, toolTotal } from "@/lib/mcp";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const root = await resolveRoot(params.get("root"));
    if (!root) return Response.json({ error: "no project root" }, { status: 404 });

    const limit = Number(params.get("limit") ?? "200");
    const sinceParam = params.get("since");
    const sinceMs = sinceParam ? Number(sinceParam) : undefined;

    const [history, aggregates, total] = await Promise.all([
      toolHistory(root, limit),
      toolAggregates(root, sinceMs),
      toolTotal(root),
    ]);
    return Response.json({ root, total, aggregates, history });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
