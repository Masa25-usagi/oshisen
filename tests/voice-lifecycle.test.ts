import test from "node:test";
import assert from "node:assert/strict";
import type { Session } from "@google/genai";
import { OpenAIRealtimeProvider } from "../lib/voice/providers/openai.ts";
import { GeminiLiveProvider } from "../lib/voice/providers/gemini.ts";

for (const Provider of [OpenAIRealtimeProvider, GeminiLiveProvider]) {
  test(`${Provider.name}: a microphone granted after cancellation is stopped without opening a session`, async () => {
    const originals = new Map<string, PropertyDescriptor | undefined>();
    function replace(name: string, value: unknown) {
      originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { configurable: true, value });
    }
    let grant!: (value: unknown) => void;
    let microphoneRequested!: () => void;
    const requested = new Promise<void>((resolve) => {
      microphoneRequested = resolve;
    });
    let stopped = 0;
    let closedContexts = 0;
    replace("navigator", {
      mediaDevices: {
        getUserMedia: () => {
          microphoneRequested();
          return new Promise((resolve) => {
            grant = resolve;
          });
        },
      },
    });
    replace(
      "Audio",
      class {
        autoplay = false;
        srcObject = null;
        pause() {}
      },
    );
    replace(
      "AudioContext",
      class {
        resume() {
          return Promise.resolve();
        }
        close() {
          closedContexts++;
          return Promise.resolve();
        }
      },
    );
    replace(
      "RTCPeerConnection",
      class {
        constructor() {
          assert.fail("must not connect after cancellation");
        }
      },
    );
    const provider = new Provider();
    try {
      const pending = provider.connect(
        {
          model:
            Provider === OpenAIRealtimeProvider
              ? "gpt-realtime-2.1"
              : "gemini-3.8-live",
          questionId: "transport",
          revision: 1,
          syntheticOnly: true,
        },
        () => {},
      );
      await requested;
      provider.disconnect();
      grant({
        getTracks: () => [
          {
            stop() {
              stopped++;
            },
          },
        ],
      });
      await pending;
      assert.equal(stopped, 1);
      if (Provider === GeminiLiveProvider) assert.equal(closedContexts, 2);
    } finally {
      provider.disconnect();
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });
}

function mockGeminiConnectEnvironment() {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  function replace(name: string, value: unknown) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  const state = { stopped: 0, closedContexts: 0 };
  replace("navigator", {
    mediaDevices: {
      getUserMedia: async () => ({
        getTracks: () => [
          {
            stop() {
              state.stopped++;
            },
          },
        ],
      }),
    },
  });
  replace(
    "AudioContext",
    class {
      sampleRate = 16000;
      audioWorklet = { addModule: () => Promise.resolve() };
      resume() {
        return Promise.resolve();
      }
      close() {
        state.closedContexts++;
        return Promise.resolve();
      }
      createMediaStreamSource() {
        return { connect() {} };
      }
      createGain() {
        return { gain: { value: 1 }, connect() {} };
      }
    },
  );
  replace(
    "AudioWorkletNode",
    class {
      port = { onmessage: null };
      connect() {}
      disconnect() {}
    },
  );
  replace(
    "fetch",
    async () =>
      Response.json({ provider: "gemini", token: "auth_tokens/unit-test" }),
  );
  return {
    state,
    restore() {
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

test("Gemini injected connection keeps the normal session setup path", async () => {
  const environment = mockGeminiConnectEnvironment();
  const sent: unknown[] = [];
  let closed = 0;
  const session = {
    sendClientContent: (value: unknown) => sent.push(value),
    close: () => closed++,
  } as unknown as Session;
  const provider = new GeminiLiveProvider(() => Promise.resolve(session), 1000);
  const events: string[] = [];
  try {
    await provider.connect(
      {
        model: "gemini-3.8-live",
        questionId: "transport",
        revision: 1,
        syntheticOnly: true,
      },
      (event) => events.push(event.type),
    );
    assert.deepEqual(events, ["status", "status"]);
    assert.equal(sent.length, 1);
    provider.disconnect();
    assert.equal(closed, 1);
    assert.equal(environment.state.stopped, 1);
    assert.equal(environment.state.closedContexts, 2);
  } finally {
    provider.disconnect();
    environment.restore();
  }
});

for (const failure of ["onerror", "onclose"] as const) {
  test(`Gemini ${failure} settles a pending connection and closes a late session`, async () => {
    const environment = mockGeminiConnectEnvironment();
    let signal!: () => void;
    let resolveSession!: (session: Session) => void;
    let lateCloses = 0;
    const opening = new Promise<Session>((resolve) => {
      resolveSession = resolve;
    });
    const provider = new GeminiLiveProvider(
      (_token, _model, callbacks) => {
        signal = callbacks[failure];
        return opening;
      },
      1000,
    );
    const events: string[] = [];
    try {
      const pending = provider.connect(
        {
          model: "gemini-3.8-live",
          questionId: "transport",
          revision: 1,
          syntheticOnly: true,
        },
        (event) => events.push(event.type),
      );
      while (!signal) await Promise.resolve();
      signal();
      await pending;
      resolveSession({ close: () => lateCloses++ } as unknown as Session);
      await Promise.resolve();
      assert.deepEqual(events, ["status", "error"]);
      assert.equal(environment.state.stopped, 1);
      assert.equal(environment.state.closedContexts, 2);
      assert.equal(lateCloses, 1);
    } finally {
      provider.disconnect();
      environment.restore();
    }
  });
}

for (const ending of ["cancel", "timeout"] as const) {
  test(`Gemini ${ending} settles a pending connection and closes a late session`, async () => {
    const environment = mockGeminiConnectEnvironment();
    let started!: () => void;
    const connecting = new Promise<void>((resolve) => {
      started = resolve;
    });
    let resolveSession!: (session: Session) => void;
    let lateCloses = 0;
    const opening = new Promise<Session>((resolve) => {
      resolveSession = resolve;
    });
    const provider = new GeminiLiveProvider(
      () => {
        started();
        return opening;
      },
      ending === "timeout" ? 5 : 1000,
    );
    const events: string[] = [];
    try {
      const pending = provider.connect(
        {
          model: "gemini-3.8-live",
          questionId: "transport",
          revision: 1,
          syntheticOnly: true,
        },
        (event) => events.push(event.type),
      );
      await connecting;
      if (ending === "cancel") provider.disconnect();
      await pending;
      resolveSession({ close: () => lateCloses++ } as unknown as Session);
      await Promise.resolve();
      assert.deepEqual(
        events,
        ending === "timeout" ? ["status", "error"] : ["status"],
      );
      assert.equal(environment.state.stopped, 1);
      assert.equal(environment.state.closedContexts, 2);
      assert.equal(lateCloses, 1);
    } finally {
      provider.disconnect();
      environment.restore();
    }
  });
}

test("Gemini batches parallel tool results once and ignores duplicate calls", async () => {
  const provider = new GeminiLiveProvider();
  const sent: unknown[] = [];
  let calls = 0;
  Object.assign(provider, {
    closed: false,
    session: {
      sendToolResponse: (value: unknown) => sent.push(value),
      close() {},
    },
    listener: (event: import("../lib/voice/contract.ts").VoiceEvent) => {
      if (event.type === "tool") {
        calls++;
        event.respond({ accepted: true });
      }
    },
  });
  const handle = Reflect.get(provider, "handle").bind(provider);
  const message = {
    toolCall: {
      functionCalls: [
        { id: "a", name: "suggest_answer", args: {} },
        { id: "b", name: "show_sources", args: {} },
      ],
    },
  };
  handle(message);
  handle(message);
  await Promise.resolve();
  assert.equal(calls, 2);
  assert.deepEqual(sent, [
    {
      functionResponses: [
        { id: "a", name: "suggest_answer", response: { accepted: true } },
        { id: "b", name: "show_sources", response: { accepted: true } },
      ],
    },
  ]);
  handle({
    toolCall: { functionCalls: [{ id: "c", name: "show_sources", args: {} }] },
  });
  provider.disconnect();
  await Promise.resolve();
  assert.equal(sent.length, 1, "no queued response is sent after disconnect");
});
