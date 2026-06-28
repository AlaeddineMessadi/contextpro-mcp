import { resolveRoot } from "@/lib/projects";
import { indexStats } from "@/lib/mcp";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const root = await resolveRoot(new URL(request.url).searchParams.get("root"));
    if (!root) return Response.json({ error: "no project root" }, { status: 404 });
    return Response.json({ root, stats: await indexStats(root) });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
