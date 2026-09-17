import type { InterviewId, VoiceModel } from "./catalog.ts";
export type VoiceStatus =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "paused"
  | "error";
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  audioInputTokens: number | null;
  audioOutputTokens: number | null;
  cachedTokens: number | null;
}
export type VoiceEvent =
  | { type: "status"; status: VoiceStatus }
  | { type: "caption"; text: string }
  | {
      type: "tool";
      name: string;
      args: unknown;
      respond: (result: Record<string, unknown>) => void;
    }
  | { type: "usage"; usage: Usage; cumulative: boolean }
  | { type: "turn-end" }
  | { type: "interruption" }
  | { type: "error"; message: string };
export type VoiceListener = (event: VoiceEvent) => void;
export interface VoiceProvider {
  connect(
    options: {
      model: VoiceModel;
      questionId: InterviewId;
      revision: number;
      accessCode?: string;
      syntheticOnly: boolean;
    },
    listener: VoiceListener,
  ): Promise<void>;
  setQuestion(id: InterviewId, revision: number): void;
  sendText(text: string): void;
  setMuted(muted: boolean): void;
  interrupt(): void;
  disconnect(): void;
}
