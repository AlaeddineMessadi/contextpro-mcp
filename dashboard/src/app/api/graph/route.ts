import { resolveRoot } from "@/lib/projects";
import { codeGraph } from "@/lib/mcp";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const root = await resolveRoot(params.get("root"));
    if (!root) return Response.json({ error: "no project root" }, { status: 404 });
    const maxNodes = Number(params.get("maxNodes") ?? "200");
    return Response.json({ root, graph: await codeGraph(root, maxNodes) });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
