import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authorizeVoice,
  createVoiceSession,
  voiceConfig,
  geminiSessionConfig,
} from "../lib/voice/server.ts";
const env: NodeJS.ProcessEnv = {
  NODE_ENV: "development",
  OPENAI_API_KEY: "unit-test-not-a-real-key",
};
test("Gemini 3.8 waits for tool acceptance and omits unsupported legacy options", () => {
  const config = geminiSessionConfig("neutral-interview");
  assert.ok(
    config.tools[0].functionDeclarations.every(
      (tool) => tool.behavior === "BLOCKING",
    ),
  );
  assert.deepEqual(config.responseModalities, ["AUDIO"]);
  assert.doesNotMatch(
    JSON.stringify(config),
    /thinkingConfig|proactiveAudio|enableAffectiveDialog/,
  );
  assert.ok(
    voiceConfig({ NODE_ENV: "test" }).models.some(
      (model) => model.id === "gemini-3.8-live",
    ),
  );
});
const body = {
  model: "gpt-realtime-2.1",
  questionId: "transport",
  revision: 1,
  sdp: "v=0\r\nunit-test",
};
const request = (value: unknown = body, origin = "http://localhost:3100") =>
  new Request("http://localhost:3100/api/voice/session", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
test("session creation refuses cross-origin and unconfigured remote access", () => {
  assert.equal(authorizeVoice(request(), env), true);
  assert.equal(
    authorizeVoice(request(body, "https://attacker.example"), env),
    false,
  );
  assert.equal(
    authorizeVoice(request(), { ...env, NODE_ENV: "production" }),
    false,
  );
  const remote = new Request("https://demo.example/api/voice/session", {
    headers: {
      origin: "https://demo.example",
      "x-voice-access-code": "test-invite",
    },
  });
  assert.equal(
    authorizeVoice(remote, {
      NODE_ENV: "production",
      VOICE_ALLOWED_ORIGIN: "https://demo.example",
      VOICE_DEMO_ACCESS_CODE: "test-invite",
    }),
    true,
  );
});
test("public config exposes availability but no secrets or credentials", () => {
  const config = voiceConfig({
    ...env,
    GEMINI_API_KEY: "unit-test-gemini",
    VOICE_DEMO_ACCESS_CODE: "test-invite",
  });
  assert.ok(config.models.every((m) => m.configured));
  assert.doesNotMatch(JSON.stringify(config), /unit-test|test-invite/);
});
test("missing credentials, invalid request shapes, and unsupported models fail without upstream calls", async () => {
  const never = async () => {
    throw new Error("Upstream must not be called");
  };
  assert.equal(
    (await createVoiceSession(request(), { NODE_ENV: "development" }, never))
      .status,
    503,
  );
  for (const bad of [
    null,
    [],
    {},
    { ...body, model: "arbitrary-model" },
    { ...body, questionId: "candidate-answers" },
    { ...body, revision: -1 },
    { ...body, sdp: "bad-sdp" },
  ])
    assert.equal(
      (await createVoiceSession(request(bad), env, never)).status,
      400,
    );
  assert.equal(
    (
      await createVoiceSession(
        request(body, "https://attacker.example"),
        env,
        never,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await createVoiceSession(
        request({ ...body, padding: "x".repeat(66000) }),
        env,
        never,
      )
    ).status,
    413,
  );
  assert.equal(
    (
      await createVoiceSession(
        request({
          ...body,
          model: "gemini-3.8-live",
          syntheticOnly: false,
        }),
        { ...env, GEMINI_API_KEY: "unit-test" },
        never,
      )
    ).status,
    400,
  );
});
test("OpenAI receives only server-owned context, and the browser receives SDP only", async () => {
  const mock: typeof fetch = async (url, init) => {
    assert.equal(url, "https://api.openai.com/v1/realtime/calls");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      `Bearer ${env.OPENAI_API_KEY}`,
    );
    const form = init?.body as FormData;
    const session = JSON.parse(String(form.get("session")));
    assert.equal(session.model, "gpt-realtime-2.1");
    assert.equal(session.type, "realtime");
    assert.doesNotMatch(
      session.instructions,
      /attack-prompt|佐藤 美咲|sato-misaki/,
    );
    assert.equal(session.audio.input.turn_detection.interrupt_response, true);
    assert.equal(session.tools.length, 3);
    return new Response("v=0\r\nunit-test-answer");
  };
  const response = await createVoiceSession(
    request({
      ...body,
      instructions: "attack-prompt",
      candidateAnswers: { "sato-misaki": 4 },
    }),
    env,
    mock,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const text = await response.text();
  assert.doesNotMatch(text, /unit-test-not-a-real-key|Bearer|instructions/);
  assert.match(text, /unit-test-answer/);
});
test("provider error bodies are never relayed to browser", async () => {
  const response = await createVoiceSession(
    request(),
    env,
    async () => new Response("raw-provider-secret", { status: 401 }),
  );
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /raw-provider-secret/);
});

test("Next.js normalized loopback URL uses the incoming Host without trusting arbitrary origins", () => {
  const make = (origin: string, host = "127.0.0.1:3100") =>
    new Request("http://localhost:3100/api/voice/session", {
      headers: { origin, host },
    });
  assert.equal(authorizeVoice(make("http://127.0.0.1:3100"), env), true);
  assert.equal(authorizeVoice(make("http://localhost:3100"), env), false);
  assert.equal(authorizeVoice(make("https://attacker.example"), env), false);
  assert.equal(
    authorizeVoice(make("http://127.0.0.1:4000", "127.0.0.1:4000"), env),
    false,
  );
  assert.equal(authorizeVoice(make("null"), env), false);
  assert.equal(
    authorizeVoice(make("http://127.0.0.1:3100"), {
      ...env,
      NODE_ENV: "production",
    }),
    false,
  );
});
