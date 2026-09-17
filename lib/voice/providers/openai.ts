import type { VoiceProvider, VoiceListener } from "../contract.ts";
import { questionContext, type InterviewId } from "../catalog.ts";
import { startSession } from "./http.ts";

export class OpenAIRealtimeProvider implements VoiceProvider {
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private stream: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private controller: AbortController | null = null;
  private listener: VoiceListener = () => {};
  private closed = true;
  private muted = false;
  private generating = false;
  private followup = false;
  private caption = "";
  private seenTools = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  async connect(
    options: Parameters<VoiceProvider["connect"]>[0],
    listener: VoiceListener,
  ) {
    this.listener = listener;
    this.closed = false;
    this.connectTimer = setTimeout(
      () =>
        this.fail(
          "音声の接続が時間切れになりました。再接続または通常診断をご利用ください。",
        ),
      30000,
    );
    this.controller = new AbortController();
    listener({ type: "status", status: "connecting" });
    this.audio = new Audio();
    this.audio.autoplay = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (this.closed) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.stream = stream;
      const pc = (this.pc = new RTCPeerConnection());
      pc.ontrack = (event) => {
        if (!this.audio || this.closed) return;
        this.audio.srcObject = new MediaStream([event.track]);
        this.audio
          .play()
          .catch(() =>
            this.fail("音声の再生がブロックされました。再接続してください。"),
          );
      };
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      const channel = (this.channel = pc.createDataChannel("oai-events"));
      channel.onmessage = (event) => {
        if (!this.closed) this.handle(event.data);
      };
      pc.onconnectionstatechange = () => {
        if (
          !this.closed &&
          ["failed", "disconnected"].includes(pc.connectionState)
        )
          this.fail("音声接続が途切れました。確定した回答は残っています。");
      };
      const ready = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("音声の接続が時間切れになりました。")),
          25000,
        );
        channel.onopen = () => {
          clearTimeout(timeout);
          resolve();
        };
        channel.onclose = () => {
          clearTimeout(timeout);
          reject(new Error("音声接続が閉じられました。"));
          if (!this.closed) this.fail("音声接続が閉じられました。");
        };
        this.controller?.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timeout);
            reject(new Error("接続を中断しました。"));
          },
          { once: true },
        );
      });
      // Attach a rejection observer before HTTP can fail.
      void ready.catch(() => {});
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const response = await startSession(
        { ...options, sdp: offer.sdp },
        options.accessCode,
        this.controller.signal,
      );
      if (this.closed) return;
      await pc.setRemoteDescription({ type: "answer", sdp: response.sdp });
      await ready;
      if (this.closed) return;
      if (this.connectTimer) clearTimeout(this.connectTimer);
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
    }
  }
  private send(event: object) {
    if (!this.closed && this.channel?.readyState === "open")
      this.channel.send(JSON.stringify(event));
  }
  private handle(data: string) {
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(data);
    } catch {
      return;
    }
    switch (e.type) {
      case "input_audio_buffer.speech_started":
        this.listener({ type: "interruption" });
        this.listener({ type: "status", status: "listening" });
        break;
      case "input_audio_buffer.speech_stopped":
        this.listener({ type: "turn-end" });
        this.listener({ type: "status", status: "thinking" });
        break;
      case "response.created":
        this.generating = true;
        this.caption = "";
        this.listener({
          type: "status",
          status: this.muted ? "paused" : "thinking",
        });
        break;
      case "output_audio_buffer.started":
        this.listener({ type: "status", status: "speaking" });
        break;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        this.listener({
          type: "status",
          status: this.muted ? "paused" : "listening",
        });
        break;
      case "response.output_audio_transcript.delta":
        this.caption = (this.caption + String(e.delta ?? "")).slice(-1000);
        this.listener({ type: "caption", text: this.caption });
        break;
      case "response.function_call_arguments.done": {
        const id = String(e.call_id ?? "");
        if (!id || this.seenTools.has(id)) return;
        this.seenTools.add(id);
        let args: unknown;
        try {
          args = JSON.parse(String(e.arguments));
        } catch {
          args = null;
        }
        this.listener({
          type: "tool",
          name: String(e.name),
          args,
          respond: (result) => {
            this.send({
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: id,
                output: JSON.stringify(result),
              },
            });
            if (this.generating) this.followup = true;
            else this.send({ type: "response.create" });
          },
        });
        break;
      }
      case "response.done": {
        this.generating = false;
        const r = e.response as
          | {
              usage?: {
                input_tokens?: number;
                output_tokens?: number;
                input_token_details?: {
                  audio_tokens?: number;
                  cached_tokens?: number;
                };
                output_token_details?: { audio_tokens?: number };
              };
            }
          | undefined;
        const u = r?.usage;
        if (u)
          this.listener({
            type: "usage",
            cumulative: false,
            usage: {
              inputTokens: u.input_tokens ?? 0,
              outputTokens: u.output_tokens ?? 0,
              audioInputTokens: u.input_token_details?.audio_tokens ?? null,
              audioOutputTokens: u.output_token_details?.audio_tokens ?? null,
              cachedTokens: u.input_token_details?.cached_tokens ?? null,
            },
          });
        if (this.followup) {
          this.followup = false;
          this.send({ type: "response.create" });
        }
        break;
      }
      case "error": {
        const code = (e.error as { code?: string })?.code;
        if (code === "response_cancel_not_active") return;
        this.fail(
          "音声サービスからエラーが返りました。再接続または通常診断で続けてください。",
        );
      }
    }
  }
  setQuestion(id: InterviewId, revision: number) {
    this.interrupt();
    this.sendText(
      `[画面操作] ${questionContext(id, revision)}\nこの設問を自然な短い導入で始めてください。`,
    );
  }
  sendText(text: string) {
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    if (this.generating) this.followup = true;
    else this.send({ type: "response.create" });
  }
  setMuted(muted: boolean) {
    this.muted = muted;
    this.stream?.getAudioTracks().forEach((t) => {
      t.enabled = !muted;
    });
    if (muted) this.interrupt();
    this.listener({ type: "status", status: muted ? "paused" : "listening" });
  }
  interrupt() {
    if (this.generating) this.send({ type: "response.cancel" });
    this.send({ type: "output_audio_buffer.clear" });
    this.followup = false;
    this.send({ type: "input_audio_buffer.clear" });
  }
  private fail(message: string) {
    if (this.closed) return;
    this.disconnect();
    this.listener({ type: "error", message });
  }
  disconnect() {
    this.closed = true;
    this.controller?.abort();
    if (this.timer) clearTimeout(this.timer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.channel?.close();
    this.pc?.close();
    if (this.audio) {
      this.audio.pause();
      this.audio.srcObject = null;
    }
    this.channel = null;
    this.pc = null;
    this.stream = null;
    this.audio = null;
    this.seenTools.clear();
    this.caption = "";
  }
}
