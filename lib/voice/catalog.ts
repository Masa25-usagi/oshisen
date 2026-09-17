import { questions } from "../questions.ts";

export const interviewIds = ["transport", "childcare", "disaster"] as const;
export type InterviewId = (typeof interviewIds)[number];
export const modelOptions = [
  { id: "gpt-realtime-2.1", label: "GPT-Realtime-2.1", provider: "openai" },
  {
    id: "gpt-realtime-2.1-mini",
    label: "GPT-Realtime-2.1 Mini",
    provider: "openai",
  },
  {
    id: "gemini-3.8-live",
    label: "Gemini 3.8 Live",
    provider: "gemini",
  },
] as const;
export type VoiceModel = (typeof modelOptions)[number]["id"];
export const isVoiceModel = (v: unknown): v is VoiceModel =>
  modelOptions.some((m) => m.id === v);
export const isInterviewId = (v: unknown): v is InterviewId =>
  interviewIds.some((id) => id === v);

export interface SourcePack {
  title: string;
  opener: string;
  overview: string;
  supporting: string;
  cautious: string;
  limitation: string;
  sources: {
    title: string;
    publisher: string;
    url: string;
    checkedOn: string;
    supports: string;
  }[];
}

// Reviewed against the linked primary pages on this date. Discussion points
// are editorial framing, never attributed to the publisher as endorsements.
export const sourcePacks: Record<InterviewId, SourcePack> = {
  transport: {
    title: "暮らしの移動、どう支える？",
    opener:
      "普段の移動で、困ることはありますか。バスや電車への行政の支援を今より増やすことについて、暮らしで感じていることから聞かせてください。",
    overview:
      "バスや地域の鉄道などを続けたり、利用しやすくしたりするために、行政がお金などで支えることです。国にも生活交通の維持やバリアフリー化などを支援する事業があります。",
    supporting:
      "車を使えない人の通学・通院・買い物の足を守れる、という考え方があります。",
    cautious:
      "使う人の数や費用を見て、ほかの施策との予算配分も考えるべきだ、という考え方があります。",
    limitation:
      "特定の路線や増税額を決める質問ではありません。支援増と増税は同じ意味ではありません。",
    sources: [
      {
        title: "地域公共交通確保維持改善事業",
        publisher: "国土交通省",
        url: "https://www.mlit.go.jp/sogoseisaku/transport/sosei_transport_tk_000041.html",
        checkedOn: "2026-09-15",
        supports: "生活交通の維持・利用環境改善を支援する国の事業の概要",
      },
    ],
  },
  childcare: {
    title: "子育ての支援、どう届ける？",
    opener:
      "子育てにかかる費用を支えるとき、所得に関係なく広く届けることと、負担が大きい家庭に手厚くすること。どんな配分がよいと感じますか。",
    overview:
      "県の限られた子育て支援の予算を、所得にかかわらず広く届けることを優先するか、という質問です。関連する国の制度に、家庭の生活の安定と子どもの成長を支える児童手当があります。",
    supporting:
      "所得にかかわらず子育てを社会で支え、支援対象の境目を減らせる、という考え方があります。",
    cautious:
      "同じ予算なら、経済的な負担が大きい家庭へ支援を集中したい、という考え方があります。",
    limitation:
      "資料は国の児童手当の説明です。県の予算案やこの設問の正解を示すものではありません。",
    sources: [
      {
        title: "児童手当",
        publisher: "こども家庭庁",
        url: "https://www.cfa.go.jp/policies/kokoseido/jidouteate",
        checkedOn: "2026-09-15",
        supports:
          "関連する国の制度の目的・概要。県の支援策を直接裏付ける資料ではない",
      },
    ],
  },
  disaster: {
    title: "まちの設備、何を優先する？",
    opener:
      "道路や橋などに使う予算について、今あるものの点検や修繕と、新しくつくること。あなたの地域では、どちらを優先したいと感じますか。",
    overview:
      "道路や橋などに使う予算で、新しい施設をつくるより、今ある施設の点検や修繕を優先するか、という質問です。適切な維持管理は、施設をよい状態に保ち、使える期間を延ばすことにつながります。",
    supporting:
      "今ある設備を安全に長く使うため、傷みを早く見つけて直すことを優先したい、という考え方があります。",
    cautious:
      "設備が足りない地域や新たな需要にも応える必要があり、新設の予算も確保したい、という考え方があります。",
    limitation:
      "新設を一切やめるかという質問ではありません。施設ごとの安全性や必要性は個別に判断する必要があります。",
    sources: [
      {
        title: "社会資本の維持管理・更新",
        publisher: "国土交通省",
        url: "https://www.mlit.go.jp/sogoseisaku/maintenance/01maintenance/index.html",
        checkedOn: "2026-09-15",
        supports: "点検・修繕・交換・更新の役割",
      },
    ],
  },
};

export const interviewQuestions = interviewIds.map((id) => ({
  ...questions.find((q) => q.id === id)!,
  pack: sourcePacks[id],
}));

export function questionContext(id: InterviewId, revision: number) {
  const q = interviewQuestions.find((q) => q.id === id)!;
  return `画面の現在の設問は ${id}、revision=${revision}。この設問だけを扱う。設問: ${q.text}\n導入: ${q.pack.opener}`;
}
