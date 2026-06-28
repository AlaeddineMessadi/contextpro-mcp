import { perfSnapshot } from "@/lib/perf";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(await perfSnapshot());
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
