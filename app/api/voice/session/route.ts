import { createVoiceSession } from "../../../../lib/voice/server";
export const runtime = "nodejs";
export const maxDuration = 30;
export async function POST(request: Request) {
  return createVoiceSession(request);
}
