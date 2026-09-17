import type { VoiceModel } from "./catalog.ts";
import { interviewIds, type InterviewId } from "./catalog.ts";
import type { AnswerRecord } from "./domain.ts";
import type { Usage } from "./contract.ts";
import { promptVersion } from "./prompt.ts";

export interface Trial {
  model: VoiceModel;
  promptVersion: string;
  startedAt: number;
  durationMs: number;
  outcome: "active" | "completed" | "fallback" | "interrupted";
  connectMs: number | null;
  responseLatencyMs: number[];
  interruptions: number;
  usage: Usage;
  usageObserved: boolean;
  estimatedCostUsd: number | null;
  answers: Partial<
    Record<
      InterviewId,
      {
        suggested: string | null;
        confirmed: string | null;
        changed: boolean | null;
        confidence: number | null;
        clarifications: number;
      }
    >
  >;
  ratings: {
    understanding: number | null;
    naturalness: number | null;
    interruption: number | null;
  };
}
export function newTrial(model: VoiceModel): Trial {
  return {
    model,
    promptVersion,
    startedAt: Date.now(),
    durationMs: 0,
    outcome: "active",
    connectMs: null,
    responseLatencyMs: [],
    interruptions: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      audioInputTokens: null,
      audioOutputTokens: null,
      cachedTokens: null,
    },
    usageObserved: false,
    estimatedCostUsd: null,
    answers: {},
    ratings: { understanding: null, naturalness: null, interruption: null },
  };
}
export function recordUsage(trial: Trial, usage: Usage, cumulative: boolean) {
  trial.usageObserved = true;
  for (const key of Object.keys(trial.usage) as (keyof Usage)[]) {
    const value = usage[key];
    if (value !== null && Number.isFinite(value) && value >= 0)
      trial.usage[key] = cumulative
        ? Math.max(trial.usage[key] ?? 0, value)
        : (trial.usage[key] ?? 0) + value;
  }
}
export function recordAnswers(
  trial: Trial,
  records: Record<InterviewId, AnswerRecord>,
  ids: readonly InterviewId[] = interviewIds,
  clarificationBaseline: Partial<Record<InterviewId, number>> = {},
) {
  for (const id of ids) {
    const record = records[id];
    trial.answers[id] = {
      suggested: record.suggested?.answer ?? null,
      confirmed: record.confirmed,
      changed:
        record.suggested && record.confirmed
          ? record.suggested.answer !== record.confirmed
          : null,
      confidence: record.suggested?.confidence ?? null,
      clarifications: Math.max(
        0,
        record.clarifications - (clarificationBaseline[id] ?? 0),
      ),
    };
  }
}
export function exportTrials(trials: Trial[]) {
  return JSON.stringify(
    {
      schemaVersion: 1,
      note: "本人の修正率は正解率ではありません。応答時間は音声終了から再生開始までのブラウザ概測。Geminiはローカル音量で発話終了を推定。費用nullは未算定（無料の意味ではない）。会話本文・音声・文字起こしは含みません。",
      trials,
    },
    null,
    2,
  );
}
