import {
  GoogleGenAI,
  Modality,
  type Session,
  type LiveServerMessage,
} from "@google/genai";
import type { VoiceProvider, VoiceListener } from "../contract.ts";
import { questionContext, type InterviewId } from "../catalog.ts";
import { startSession } from "./http.ts";

interface GeminiLiveCallbacks {
  onmessage: (message: LiveServerMessage) => void;
  onerror: () => void;
  onclose: () => void;
}

type GeminiLiveConnector = (
  token: string,
  model: string,
  callbacks: GeminiLiveCallbacks,
) => Promise<Session>;

const connectGeminiLive: GeminiLiveConnector = (token, model, callbacks) => {
  const ai = new GoogleGenAI({
    apiKey: token,
    httpOptions: { apiVersion: "v1beta" },
  });
  return ai.live.connect({
    model,
    config: { responseModalities: [Modality.AUDIO] },
    callbacks,
  });
};

export class GeminiLiveProvider implements VoiceProvider {
  private session: Session | null = null;
  private stream: MediaStream | null = null;
  private input: AudioContext | null = null;
  private output: AudioContext | null = null;
  private worklet: AudioWorkletNode | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private listener: VoiceListener = () => {};
  private controller = new AbortController();
  private closed = true;
  private muted = false;
  private playAt = 0;
  private speaking = false;
  private lastLoudAt = 0;
  private caption = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private seenTools = new Set<string>();
  private toolResponses: {
    id: string;
    name: string;
    response: Record<string, unknown>;
  }[] = [];
  private toolFlushQueued = false;
  private cancelConnect: ((reason?: unknown) => void) | null = null;
  private readonly connectLive: GeminiLiveConnector;
  private readonly connectTimeoutMs: number;
  constructor(
    connectLive: GeminiLiveConnector = connectGeminiLive,
    connectTimeoutMs = 30000,
  ) {
    this.connectLive = connectLive;
    this.connectTimeoutMs = connectTimeoutMs;
  }
  async connect(
    options: Parameters<VoiceProvider["connect"]>[0],
    listener: VoiceListener,
  ) {
    this.listener = listener;
    this.closed = false;
    let cancel!: (reason?: unknown) => void;
    const cancelled = new Promise<never>((_, reject) => {
      cancel = reject;
      this.cancelConnect = reject;
    });
    const waitForConnect = <T>(pending: Promise<T>) =>
      Promise.race([pending, cancelled]);
    this.connectTimer = setTimeout(
      () =>
        this.fail(
          "音声の接続が時間切れになりました。再接続または通常診断をご利用ください。",
        ),
      this.connectTimeoutMs,
    );
    listener({ type: "status", status: "connecting" });
    try {
      this.input = new AudioContext({ sampleRate: 16000 });
      this.output = new AudioContext({ sampleRate: 24000 });
      await waitForConnect(
        Promise.all([this.input.resume(), this.output.resume()]),
      );
      if (this.closed) return;
      const pendingStream = navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      void pendingStream
        .then((lateStream) => {
          if (this.closed)
            lateStream.getTracks().forEach((track) => track.stop());
        })
        .catch(() => {});
      const stream = await waitForConnect(pendingStream);
      if (this.closed) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.stream = stream;
      await waitForConnect(
        this.input.audioWorklet.addModule("/voice-capture.js"),
      );
      if (this.closed) return;
      const info = await waitForConnect(
        startSession(options, options.accessCode, this.controller.signal),
      );
      if (this.closed) return;
      const pendingSession = this.connectLive(
        info.token,
        options.model,
        {
          onmessage: (message) => {
            if (!this.closed) this.handle(message);
          },
          onerror: () =>
            this.fail(
              "Geminiとの音声接続に失敗しました。無料枠の制限または通信状態をご確認ください。",
            ),
          onclose: () => {
            if (!this.closed)
              this.fail(
                "音声接続が終了しました。再接続するか通常診断で続けられます。",
              );
          },
        },
      );
      void pendingSession
        .then((lateSession) => {
          if (this.closed) lateSession.close();
        })
        .catch(() => {});
      const session = await waitForConnect(pendingSession);
      if (this.closed) {
        session.close();
        return;
      }
      this.session = session;
      if (this.connectTimer) clearTimeout(this.connectTimer);
      const source = this.input.createMediaStreamSource(stream);
      this.worklet = new AudioWorkletNode(this.input, "voice-capture");
      const silent = this.input.createGain();
      silent.gain.value = 0;
      source.connect(this.worklet);
      this.worklet.connect(silent);
      silent.connect(this.input.destination);
      this.worklet.port.onmessage = ({
        data,
      }: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
        if (this.closed || this.muted || !this.session) return;
        const bytes = new Uint8Array(data.pcm);
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        try {
          this.session.sendRealtimeInput({
            audio: {
              data: btoa(binary),
              mimeType: `audio/pcm;rate=${this.input!.sampleRate}`,
            },
          });
        } catch {
          this.fail("音声を送信できませんでした。");
        }
        // Local level timing is an estimate, never a transcription or classifier.
        if (data.rms > 0.035) {
          this.lastLoudAt = performance.now();
          this.speaking = true;
        } else if (this.speaking && performance.now() - this.lastLoudAt > 800) {
          this.speaking = false;
          this.listener({ type: "turn-end" });
          if (this.sources.size === 0)
            this.listener({ type: "status", status: "thinking" });
        }
      };
      this.setQuestion(options.questionId, options.revision);
      this.timer = setTimeout(
        () =>
          this.fail(
            "10分のデモ時間が終了しました。再接続するか通常診断で続けられます。",
          ),
        600000,
      );
    } catch (error) {
      const wasClosed = this.closed;
      this.disconnect();
      if (!wasClosed) throw error;
    } finally {
      if (this.cancelConnect === cancel) this.cancelConnect = null;
    }
  }
  private handle(message: LiveServerMessage) {
    const content = message.serverContent;
    if (content?.interrupted) {
      this.flushAudio();
      this.listener({ type: "interruption" });
      this.caption = "";
    }
    if (content?.outputTranscription?.text) {
      this.caption = (this.caption + content.outputTranscription.text).slice(
        -1000,
      );
      this.listener({ type: "caption", text: this.caption });
    }
    for (const part of content?.modelTurn?.parts ?? []) {
      if (
        part.inlineData?.data &&
        part.inlineData.mimeType?.startsWith("audio/pcm")
      )
        this.play(
          part.inlineData.data,
          Number(/rate=(\d+)/.exec(part.inlineData.mimeType)?.[1] ?? 24000),
        );
    }
    for (const call of message.toolCall?.functionCalls ?? []) {
      if (!call.id || this.seenTools.has(call.id)) continue;
      this.seenTools.add(call.id);
      this.listener({
        type: "tool",
        name: call.name ?? "",
        args: call.args,
        respond: (result) => {
          if (this.closed) return;
          this.toolResponses.push({
            id: call.id!,
            name: call.name ?? "",
            response: result,
          });
          if (this.toolFlushQueued) return;
          this.toolFlushQueued = true;
          queueMicrotask(() => {
            this.toolFlushQueued = false;
            const responses = this.toolResponses.splice(0);
            if (!this.closed && responses.length)
              this.session?.sendToolResponse({ functionResponses: responses });
          });
        },
      });
    }
    if (content?.turnComplete) {
      this.caption = "";
      if (!this.sources.size)
        this.listener({
          type: "status",
          status: this.muted ? "paused" : "listening",
        });
    }
    const u = message.usageMetadata;
    if (u)
      this.listener({
        type: "usage",
        cumulative: true,
        usage: {
          inputTokens: u.promptTokenCount ?? 0,
          outputTokens: u.responseTokenCount ?? 0,
          audioInputTokens:
            u.promptTokensDetails?.find((d) => d.modality === "AUDIO")
              ?.tokenCount ?? null,
          audioOutputTokens:
            u.responseTokensDetails?.find((d) => d.modality === "AUDIO")
              ?.tokenCount ?? null,
          cachedTokens: u.cachedContentTokenCount ?? null,
        },
      });
    if (message.goAway)
      this.fail(
        "音声セッションの期限が近づきました。再接続して続けてください。",
      );
  }
  private play(base64: string, rate: number) {
    if (!this.output || this.closed || this.muted) return;
    const binary = atob(base64);
    const buffer = new ArrayBuffer(binary.length);
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const pcm = new DataView(buffer);
    const audio = this.output.createBuffer(
      1,
      Math.floor(binary.length / 2),
      rate,
    );
    const floats = audio.getChannelData(0);
    for (let i = 0; i < floats.length; i++)
      floats[i] = pcm.getInt16(i * 2, true) / 32768;
    const source = this.output.createBufferSource();
    source.buffer = audio;
    source.connect(this.output.destination);
    this.sources.add(source);
    this.playAt = Math.max(this.output.currentTime, this.playAt);
    source.start(this.playAt);
    this.playAt += audio.duration;
    this.listener({ type: "status", status: "speaking" });
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect();
      if (!this.closed && !this.sources.size)
        this.listener({
          type: "status",
          status: this.muted ? "paused" : "listening",
        });
    };
  }
  private flushAudio() {
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        /* Already ended. */
      }
      source.disconnect();
    }
    this.sources.clear();
    this.playAt = 0;
  }
  setQuestion(id: InterviewId, revision: number) {
    this.flushAudio();
    this.caption = "";
    this.sendText(
      `[画面操作] ${questionContext(id, revision)}\nこの設問を自然な短い導入で始めてください。`,
    );
  }
  sendText(text: string) {
    if (!this.closed) {
      this.flushAudio();
      this.listener({ type: "status", status: "thinking" });
      this.session?.sendClientContent({
        turns: [{ role: "user", parts: [{ text }] }],
        turnComplete: true,
      });
    }
  }
  interrupt() {
    this.flushAudio();
  }
  setMuted(muted: boolean) {
    this.muted = muted;
    this.stream?.getAudioTracks().forEach((t) => {
      t.enabled = !muted;
    });
    if (muted) {
      this.flushAudio();
      this.session?.sendRealtimeInput({ audioStreamEnd: true });
    }
    this.listener({ type: "status", status: muted ? "paused" : "listening" });
  }
  private fail(message: string) {
    if (this.closed) return;
    this.disconnect();
    this.listener({ type: "error", message });
  }
  disconnect() {
    this.closed = true;
    const cancel = this.cancelConnect;
    this.cancelConnect = null;
    cancel?.(new Error("接続を中断しました。"));
    this.controller.abort();
    if (this.timer) clearTimeout(this.timer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.worklet?.disconnect();
    if (this.worklet) this.worklet.port.onmessage = null;
    this.flushAudio();
    this.session?.close();
    this.session = null;
    void this.input?.close().catch(() => {});
    void this.output?.close().catch(() => {});
    this.input = null;
    this.output = null;
    this.stream = null;
    this.caption = "";
    this.seenTools.clear();
    this.toolResponses = [];
    this.toolFlushQueued = false;
  }
}
