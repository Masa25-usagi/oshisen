// Server entry points only. No client component imports this module.
import { Behavior, GoogleGenAI, Modality } from "@google/genai";
import { interviewInstructions, interviewTools } from "./prompt.ts";
import { isInterviewId, isVoiceModel, modelOptions } from "./catalog.ts";

const noStore = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};
const failure = (status: number, code: string, message: string) =>
  Response.json({ code, message }, { status, headers: noStore });
const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

// 3.8 defaults to asynchronous tools. Wait for permission/acceptance before
// speaking so the per-question clarification gate retains its semantics.
export function geminiSessionConfig(instructions: string) {
  return {
    responseModalities: [Modality.AUDIO],
    systemInstruction: instructions,
    outputAudioTranscription: {},
    speechConfig: {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
    },
    tools: [
      {
        functionDeclarations: interviewTools.map((t) => ({
          name: t.name,
          description: t.description,
          parametersJsonSchema: t.parameters,
          behavior: Behavior.BLOCKING,
        })),
      },
    ],
  };
}
// Local demo guard. Remote deployments require both an exact origin and a demo
// access code. This per-process limiter is NOT distributed production auth.
export function authorizeVoice(
  request: Request,
  env: NodeJS.ProcessEnv,
): boolean {
  const url = new URL(request.url);
  const originHeader = request.headers.get("origin");
  if (!originHeader) return false;
  let origin: URL;
  try {
    origin = new URL(originHeader);
  } catch {
    return false;
  }
  // Next.js can normalize request.url to localhost behind its local proxy.
  // Verify the browser Origin against the incoming Host, never a forwarded
  // origin supplied by the client. Production still requires an exact allowlist.
  if (
    origin.origin !== originHeader ||
    origin.host !== (request.headers.get("host") ?? url.host)
  )
    return false;
  if (
    env.NODE_ENV !== "production" &&
    localHosts.has(url.hostname) &&
    localHosts.has(origin.hostname) &&
    origin.protocol === url.protocol &&
    origin.port === url.port
  )
    return true;
  return Boolean(
    env.VOICE_ALLOWED_ORIGIN &&
    origin.origin === env.VOICE_ALLOWED_ORIGIN &&
    env.VOICE_DEMO_ACCESS_CODE &&
    request.headers.get("x-voice-access-code") === env.VOICE_DEMO_ACCESS_CODE,
  );
}
export function voiceConfig(env: NodeJS.ProcessEnv) {
  return {
    models: modelOptions.map((m) => ({
      ...m,
      configured: Boolean(
        m.provider === "openai" ? env.OPENAI_API_KEY : env.GEMINI_API_KEY,
      ),
    })),
    geminiFreeTier: env.VOICE_GEMINI_FREE_TIER !== "false",
    requiresAccessCode: env.NODE_ENV === "production",
    maxSessionSeconds: 600,
  };
}
let windowStart = 0;
let attempts = 0;
export async function createVoiceSession(
  request: Request,
  env = process.env,
  upstream: typeof fetch = fetch,
): Promise<Response> {
  if (!authorizeVoice(request, env))
    return failure(
      403,
      "forbidden",
      "この環境では音声デモの利用が許可されていません。通常診断を利用できます。",
    );
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
    return failure(415, "content_type", "リクエスト形式が違います。");
  let body: Record<string, unknown>;
  try {
    // Bound actual streamed bytes, not only the attacker-controlled length header.
    const reader = request.body?.getReader();
    if (!reader) return failure(400, "bad_request", "接続情報がありません。");
    const decoder = new TextDecoder();
    let text = "";
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 65536) {
        await reader.cancel();
        return failure(413, "too_large", "接続情報が大きすぎます。");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    body = JSON.parse(text);
    if (!body || Array.isArray(body) || typeof body !== "object")
      throw new Error();
  } catch {
    return failure(400, "bad_request", "接続情報を読み取れませんでした。");
  }
  const { model, questionId, revision } = body;
  if (
    !isVoiceModel(model) ||
    !isInterviewId(questionId) ||
    !Number.isSafeInteger(revision) ||
    (revision as number) < 1 ||
    (revision as number) > 10000
  )
    return failure(400, "invalid_session", "モデルまたは設問が不正です。");
  const openai = model.startsWith("gpt-");
  const key = openai ? env.OPENAI_API_KEY : env.GEMINI_API_KEY;
  if (!key)
    return failure(
      503,
      "not_configured",
      "選んだ音声モデルはまだ接続されていません。別のモデルか通常診断を選べます。",
    );
  if (
    !openai &&
    env.VOICE_GEMINI_FREE_TIER !== "false" &&
    body.syntheticOnly !== true
  )
    return failure(
      400,
      "synthetic_only",
      "Gemini無料枠では架空の発言での開発テストに同意してください。",
    );
  if (
    openai &&
    (typeof body.sdp !== "string" ||
      !body.sdp.startsWith("v=0") ||
      body.sdp.length > 60000)
  )
    return failure(400, "invalid_sdp", "音声接続情報が不正です。");
  if (Date.now() - windowStart > 3600000) {
    windowStart = Date.now();
    attempts = 0;
  }
  if (++attempts > 20)
    return failure(
      429,
      "rate_limit",
      "デモの接続回数の上限です。時間をおくか通常診断をご利用ください。",
    );
  const instructions = interviewInstructions(questionId, revision as number);
  try {
    if (openai) {
      const form = new FormData();
      form.set("sdp", body.sdp as string);
      form.set(
        "session",
        JSON.stringify({
          type: "realtime",
          model,
          instructions,
          output_modalities: ["audio"],
          max_output_tokens: 650,
          audio: {
            input: {
              noise_reduction: { type: "near_field" },
              turn_detection: {
                type: "semantic_vad",
                eagerness: "low",
                create_response: true,
                interrupt_response: true,
              },
            },
            output: { voice: "marin" },
          },
          tools: interviewTools.map((t) => ({ type: "function", ...t })),
          tool_choice: "auto",
        }),
      );
      const response = await upstream(
        "https://api.openai.com/v1/realtime/calls",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${key}` },
          body: form,
          signal: AbortSignal.timeout(20000),
        },
      );
      if (!response.ok)
        return failure(
          response.status === 429 ? 429 : 502,
          "provider_unavailable",
          "音声サービスに接続できません。利用枠・モデルの利用権限を確認するか、通常診断をご利用ください。",
        );
      return Response.json(
        {
          provider: "openai",
          sdp: await response.text(),
          maxSessionSeconds: 600,
        },
        { headers: noStore },
      );
    }
    const ai = new GoogleGenAI({
      apiKey: key,
      httpOptions: { apiVersion: "v1beta", timeout: 20000 },
    });
    const config = geminiSessionConfig(instructions);
    const token = await ai.authTokens.create({
      config: {
        uses: 1,
        expireTime: new Date(Date.now() + 600000).toISOString(),
        newSessionExpireTime: new Date(Date.now() + 60000).toISOString(),
        liveConnectConstraints: { model, config },
      },
    });
    if (!token.name) throw new Error("No ephemeral credential");
    return Response.json(
      { provider: "gemini", token: token.name, model, maxSessionSeconds: 600 },
      { headers: noStore },
    );
  } catch {
    return failure(
      502,
      "connection_failed",
      "音声サービスとの接続が途切れました。もう一度接続するか、通常診断で続けられます。",
    );
  }
}
