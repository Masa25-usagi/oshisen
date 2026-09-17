import { voiceConfig } from "../../../../lib/voice/server";
export const dynamic = "force-dynamic";
export function GET() {
  return Response.json(voiceConfig(process.env), {
    headers: { "Cache-Control": "no-store" },
  });
}
