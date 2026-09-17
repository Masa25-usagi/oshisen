export async function startSession(
  body: object,
  accessCode: string | undefined,
  signal: AbortSignal,
) {
  const response = await fetch("/api/voice/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(accessCode ? { "x-voice-access-code": accessCode } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    let message =
      "音声サービスに接続できませんでした。通常診断で続けられます。";
    try {
      const data = (await response.json()) as { message?: unknown };
      if (typeof data.message === "string") message = data.message;
    } catch {
      /* Never expose upstream error bodies. */
    }
    throw new Error(message);
  }
  const data = (await response.json()) as {
    provider?: string;
    sdp?: string;
    token?: string;
  };
  if (
    data.provider === "openai" &&
    typeof data.sdp === "string" &&
    data.sdp.startsWith("v=0")
  )
    return { provider: "openai" as const, sdp: data.sdp, token: "" };
  if (
    data.provider === "gemini" &&
    typeof data.token === "string" &&
    data.token.startsWith("auth_tokens/")
  )
    return { provider: "gemini" as const, token: data.token, sdp: "" };
  throw new Error("音声接続情報を確認できませんでした。");
}
