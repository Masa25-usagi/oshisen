export * from "./questions.ts";
import { questions, type AnswerMap } from "./questions.ts";

export type CandidateId =
  "sato-misaki" | "takahashi-ken" | "tanaka-aya" | "yamada-taro";

export interface Candidate {
  readonly id: CandidateId;
  readonly name: string;
  readonly kana: string;
  readonly isFictional: true;
  readonly age: null;
  readonly party: null;
  readonly status: null;
  readonly district: null;
  /** Actual candidate answers are deliberately unavailable. */
  readonly answers: AnswerMap;
}

const unanswered: AnswerMap = Object.freeze(
  Object.fromEntries(questions.map((question) => [question.id, null])),
);

export const candidates: readonly Candidate[] = [
  { id: "sato-misaki", name: "佐藤 美咲", kana: "さとう みさき" },
  { id: "takahashi-ken", name: "高橋 健", kana: "たかはし けん" },
  { id: "tanaka-aya", name: "田中 彩", kana: "たなか あや" },
  { id: "yamada-taro", name: "山田 太郎", kana: "やまだ たろう" },
].map((entry) => ({
  ...entry,
  id: entry.id as CandidateId,
  isFictional: true,
  age: null,
  party: null,
  status: null,
  district: null,
  answers: unanswered,
}));

/**
 * Numerical fixtures used exclusively to demonstrate the comparison UI.
 * They are not candidate responses, policy information, or public-source data.
 * Keep this separate from candidates[].answers so unavailable facts remain null.
 */
export const demoAnswerFixtures: Readonly<Record<CandidateId, AnswerMap>> = {
  "sato-misaki": {
    transport: 4,
    education: 3,
    childcare: 4,
    healthcare: 2,
    disaster: 3,
    environment: 1,
    agriculture: 2,
    administration: 3,
  },
  "takahashi-ken": {
    transport: 2,
    education: 4,
    childcare: 1,
    healthcare: 1,
    disaster: 3,
    environment: 2,
    agriculture: 1,
    administration: 2,
  },
  "tanaka-aya": {
    transport: 3,
    education: 2,
    childcare: 3,
    healthcare: 4,
    disaster: 2,
    environment: 4,
    agriculture: 3,
    administration: 4,
  },
  "yamada-taro": {
    transport: 1,
    education: 1,
    childcare: 2,
    healthcare: 3,
    disaster: 4,
    environment: 3,
    agriculture: 4,
    administration: 1,
  },
};

export const demoNotice =
  "体験用のデモです。掲載名はすべて架空で、回答は計算方法を試すためのサンプルです。実在の候補者・政策・本人の回答を示すものではありません。";

export const questionDraftNotice =
  "全8問は体験用の設問案です。公開版では質問の妥当性・中立性を確認し、候補者本人への同一質問と一次情報の確認を経て掲載します。";
