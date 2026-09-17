import type { AnswerMap, AnswerValue } from "../questions.ts";
import { questions } from "../questions.ts";
import { interviewIds, isInterviewId, type InterviewId } from "./catalog.ts";

export const answers = [
  "strongly_agree",
  "agree",
  "neutral",
  "disagree",
  "strongly_disagree",
  "skip",
] as const;
export type VoiceAnswer = (typeof answers)[number];
export const answerLabels: Record<VoiceAnswer, string> = {
  strongly_agree: "強く賛成",
  agree: "やや賛成",
  neutral: "どちらともいえない",
  disagree: "やや反対",
  strongly_disagree: "強く反対",
  skip: "判断できない・見送る",
};
export const answerValues: Record<VoiceAnswer, AnswerValue | null> = {
  strongly_agree: 4,
  agree: 3,
  neutral: 2,
  disagree: 1,
  strongly_disagree: 0,
  skip: null,
};
export const isVoiceAnswer = (v: unknown): v is VoiceAnswer =>
  answers.some((a) => a === v);
export const bases = [
  "clear",
  "conditional",
  "balanced",
  "insufficient_knowledge",
  "declined",
] as const;
export type AnswerBasis = (typeof bases)[number];
export interface Suggestion {
  questionId: InterviewId;
  revision: number;
  answer: VoiceAnswer;
  confidence: number;
  basis: AnswerBasis;
}
export interface AnswerRecord {
  suggested: Suggestion | null;
  selected: VoiceAnswer | null;
  confirmed: VoiceAnswer | null;
  manual: boolean;
  clarifications: number;
}
export const emptyRecord = (): AnswerRecord => ({
  suggested: null,
  selected: null,
  confirmed: null,
  manual: false,
  clarifications: 0,
});
export const emptyRecords = (): Record<InterviewId, AnswerRecord> =>
  Object.fromEntries(interviewIds.map((id) => [id, emptyRecord()])) as Record<
    InterviewId,
    AnswerRecord
  >;
// A new voice trial owns only its own suggestions. User choices survive it.
export function resetVoiceSuggestions(
  records: Record<InterviewId, AnswerRecord>,
) {
  return Object.fromEntries(
    interviewIds.map((id) => {
      const record = records[id];
      return [
        id,
        record.confirmed !== null
          ? record
          : {
              ...record,
              suggested: null,
              selected: record.manual ? record.selected : null,
            },
      ];
    }),
  ) as Record<InterviewId, AnswerRecord>;
}
export function parseSuggestion(
  v: unknown,
  id: InterviewId,
  revision: number,
): Suggestion | null {
  if (!v || typeof v !== "object") return null;
  const a = v as Record<string, unknown>;
  if (
    !isInterviewId(a.questionId) ||
    a.questionId !== id ||
    a.revision !== revision ||
    !isVoiceAnswer(a.answer) ||
    typeof a.confidence !== "number" ||
    !Number.isFinite(a.confidence) ||
    a.confidence < 0 ||
    a.confidence > 1 ||
    !bases.some((b) => b === a.basis)
  )
    return null;
  // Lack of knowledge must never silently become a neutral position.
  if (
    (a.basis === "insufficient_knowledge" || a.basis === "declined") &&
    a.answer !== "skip"
  )
    return null;
  return {
    questionId: id,
    revision,
    answer: a.answer,
    confidence: a.confidence,
    basis: a.basis as AnswerBasis,
  };
}
export function propose(
  record: AnswerRecord,
  suggestion: Suggestion,
): AnswerRecord {
  if (record.confirmed !== null) return record;
  return {
    ...record,
    suggested: suggestion,
    selected: record.manual ? record.selected : suggestion.answer,
  };
}
export function selectAnswer(
  record: AnswerRecord,
  answer: VoiceAnswer,
): AnswerRecord {
  return { ...record, selected: answer, manual: true, confirmed: null };
}
export function confirmAnswer(record: AnswerRecord): AnswerRecord {
  if (!record.selected) throw new Error("An explicit selection is required");
  return { ...record, confirmed: record.selected };
}
/** Only confirmed records cross into the existing diagnosis. Preserve other answers. */
export function mergeConfirmed(
  base: AnswerMap,
  records: Record<InterviewId, AnswerRecord>,
) {
  const merged: Record<string, AnswerValue | null> = {};
  for (const q of questions) {
    const a = base[q.id];
    if (
      a === null ||
      (typeof a === "number" && Number.isInteger(a) && a >= 0 && a <= 4)
    )
      merged[q.id] = a;
  }
  for (const id of interviewIds) {
    const a = records[id].confirmed;
    if (a) merged[id] = answerValues[a];
  }
  return merged;
}
/** Called only by the user's explicitly labelled finish-with-remaining-skipped action. */
export function finishDemo(
  base: AnswerMap,
  records: Record<InterviewId, AnswerRecord>,
) {
  if (interviewIds.some((id) => !records[id].confirmed))
    throw new Error("Unconfirmed interview");
  const merged = mergeConfirmed(base, records);
  for (const q of questions) if (!(q.id in merged)) merged[q.id] = null;
  return { answers: merged, index: questions.length - 1, complete: true };
}
