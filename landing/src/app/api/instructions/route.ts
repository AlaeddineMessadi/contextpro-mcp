import { NextResponse } from "next/server";
import instructionsText from "../../../generated/agent-instructions.json";

export function GET() {
  return new NextResponse(instructionsText, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
