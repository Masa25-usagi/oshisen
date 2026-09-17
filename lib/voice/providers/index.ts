import type { VoiceModel } from "../catalog.ts";
import type { VoiceProvider } from "../contract.ts";
export async function createProvider(
  model: VoiceModel,
): Promise<VoiceProvider> {
  if (model.startsWith("gpt-")) {
    const { OpenAIRealtimeProvider } = await import("./openai.ts");
    return new OpenAIRealtimeProvider();
  }
  const { GeminiLiveProvider } = await import("./gemini.ts");
  return new GeminiLiveProvider();
}
