"use client";
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import {
  modelOptions,
  isVoiceModel,
  interviewIds,
} from "../../lib/voice/catalog";
import { answerLabels, answers } from "../../lib/voice/domain";
import type { VoiceStatus } from "../../lib/voice/contract";
import { useInterview } from "./use-interview";
import styles from "./interview.module.css";

const statusLabels: Record<VoiceStatus, string> = {
  idle: "あなたのペースで、話してみよう",
  connecting: "音声をつないでいます",
  listening: "お話を聞いています",
  thinking: "考えを整理しています",
  speaking: "AIがお話ししています",
  paused: "マイクを一時停止しています",
  error: "音声をお休みしています",
};
function Icon({ name }: { name: "mic" | "book" | "chat" | "arrow" }) {
  return (
    <svg
      width="21"
      height="21"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === "mic" ? (
        <>
          <rect x="9" y="2" width="6" height="13" rx="3" />
          <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
        </>
      ) : name === "book" ? (
        <>
          <path d="M5 3h10l4 4v14H5zM14 3v5h5M8 12h8M8 16h6" />
        </>
      ) : name === "chat" ? (
        <>
          <path d="M21 11a9 8 0 0 1-9 8H8l-5 3 1-6a8 8 0 0 1-1-5 9 8 0 0 1 18 0Z" />
          <path d="M8 11h.01M12 11h.01M16 11h.01" />
        </>
      ) : (
        <path d="m9 5 7 7-7 7" />
      )}
    </svg>
  );
}
interface Config {
  models: { id: string; configured: boolean }[];
  geminiFreeTier: boolean;
  requiresAccessCode: boolean;
}

export function VoiceInterview() {
  const flow = useInterview();
  const [config, setConfig] = useState<Config | null>(null);
  const [configFailed, setConfigFailed] = useState(false);
  const [consent, setConsent] = useState(false);
  const [syntheticOnly, setSyntheticOnly] = useState(false);
  const [accessCode, setAccessCode] = useState("");
  const [editing, setEditing] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const sourceHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/voice/config", { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error();
        return (await r.json()) as Config;
      })
      .then(setConfig)
      .catch(() => {
        if (!controller.signal.aborted) setConfigFailed(true);
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    heading.current?.focus();
  }, [flow.index, flow.done]);
  useEffect(() => {
    if (flow.sourcesOpen) sourceHeading.current?.focus();
  }, [flow.sourcesOpen]);
  const q = flow.question;
  const id = interviewIds[flow.index];
  const record = flow.records[id];
  const freeGemini =
    flow.model.startsWith("gemini") && config?.geminiFreeTier !== false;
  const configured =
    config?.models.some((m) => m.id === flow.model && m.configured) ?? false;
  const busy = flow.status === "connecting";
  const showChoices = editing || (flow.status === "error" && !record.selected);

  return (
    <div className={styles.surface}>
      <a className="skip-link" href="#main">
        本文へ移動
      </a>
      <header className={styles.header}>
        <Image
          src="/brand-logo.png"
          alt="オシセン！"
          width={108}
          height={36}
          unoptimized
          priority
        />
        <button className={styles.textButton} onClick={flow.fallback}>
          通常診断へ <Icon name="arrow" />
        </button>
      </header>
      <main id="main" className={styles.main}>
        {flow.done ? (
          <>
            <div className={styles.completeMark} aria-hidden="true">
              ✓
            </div>
            <h1 ref={heading} tabIndex={-1}>
              あなたの考えが、
              <br />
              まとまりました。
            </h1>
            <p className={styles.description}>
              確定した3つの回答です。あとから変えても大丈夫。
            </p>
            <div className={styles.review}>
              {interviewIds.map((key, i) => (
                <div key={key}>
                  <span>{["公共交通", "子育て", "防災・インフラ"][i]}</span>
                  <strong>{answerLabels[flow.records[key].confirmed!]}</strong>
                  <button
                    className={styles.textButton}
                    onClick={() => {
                      setEditing(true);
                      flow.revisit(i);
                    }}
                  >
                    変更
                  </button>
                </div>
              ))}
            </div>
            <p className={styles.note}>
              音声デモは全8問のうち3問です。未回答の残りの質問は計算から除外します。通常診断ですでに確定した回答は引き継ぎます。
            </p>
            <button className={styles.primary} onClick={flow.finish}>
              残りの未回答を見送って結果へ <Icon name="arrow" />
            </button>
            <button className={styles.secondary} onClick={flow.fallback}>
              通常診断で残りも答える
            </button>
            <p className={styles.privacy}>
              結果は既存の計算式によるデモ用数値です。AIが候補者を推薦するものではありません。
            </p>
            <Evaluation flow={flow} />
          </>
        ) : (
          <>
            <div
              className={styles.progress}
              aria-label={`${flow.index + 1}問目、全3問`}
            >
              <strong>
                {String(flow.index + 1).padStart(2, "0")} <span>/ 03</span>
              </strong>
              <div aria-hidden="true">
                {interviewIds.map((key, i) => (
                  <i key={key} data-filled={i <= flow.index} />
                ))}
              </div>
            </div>
            <h1 ref={heading} tabIndex={-1}>
              {q.pack.title}
            </h1>
            <p className={styles.statement}>{q.text}</p>
            <section className={styles.conversation} aria-label="AIとの会話">
              <div
                className={styles.orb}
                data-status={flow.status}
                aria-hidden="true"
              >
                <div>
                  {[18, 30, 46, 30, 18].map((height, i) => (
                    <span
                      key={i}
                      style={{ height, animationDelay: `${i * 0.12}s` }}
                    />
                  ))}
                </div>
              </div>
              <p className={styles.status} role="status">
                {statusLabels[flow.status]}
              </p>
              <p className={styles.caption}>
                {flow.caption ||
                  "普段の暮らしで感じていることから、聞かせてください。"}
              </p>
            </section>
            {flow.notice && (
              <div className={styles.notice} role="alert">
                {flow.notice}
              </div>
            )}
            {!flow.connected && !busy && (
              <section className={styles.setup} aria-label="音声の設定">
                <label className={styles.modelLabel}>
                  話すAI
                  <select
                    value={flow.model}
                    onChange={(event) => {
                      if (isVoiceModel(event.target.value)) {
                        flow.changeModel(event.target.value);
                        setConsent(false);
                      }
                    }}
                  >
                    {modelOptions.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                        {config &&
                        !config.models.some(
                          (c) => c.id === m.id && c.configured,
                        )
                          ? "（未接続）"
                          : ""}
                      </option>
                    ))}
                  </select>
                </label>
                {configFailed ? (
                  <p className={styles.note}>
                    音声の設定を取得できません。選択肢での回答と通常診断は利用できます。
                  </p>
                ) : (
                  config &&
                  !configured && (
                    <p className={styles.note}>
                      このモデルのAPIは未接続です。
                      {config.models.some((m) => m.configured)
                        ? "接続済みのAIを選ぶか、選択肢で回答できます。"
                        : "選択肢での回答と通常診断は利用できます。"}
                    </p>
                  )
                )}
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    checked={consent}
                    onChange={(e) => setConsent(e.target.checked)}
                  />
                  <span>
                    音声を選択したAI提供元へ送信することに同意して始める。運営側は生音声・会話全文を保存しません。
                  </span>
                </label>
                {freeGemini && (
                  <>
                    <p className={styles.freeNotice}>
                      Gemini無料枠は開発テスト用です。入力・応答がGoogleの改善に利用されるため、実際の政治的意見や個人情報は話さず、架空の発言でお試しください。
                      <a
                        href="https://ai.google.dev/gemini-api/terms#unpaid-services"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        提供元のデータ利用方針
                      </a>
                    </p>
                    <label className={styles.check}>
                      <input
                        type="checkbox"
                        checked={syntheticOnly}
                        onChange={(e) => setSyntheticOnly(e.target.checked)}
                      />
                      <span>架空の発言を使う開発テストとして利用する</span>
                    </label>
                  </>
                )}
                {!freeGemini && (
                  <p className={styles.note}>
                    提供元での保持はAPIの契約・設定に従います。このデモはZDRを保証しません。
                  </p>
                )}
                {config?.requiresAccessCode && (
                  <label className={styles.modelLabel}>
                    デモのアクセスコード
                    <input
                      type="password"
                      value={accessCode}
                      autoComplete="off"
                      onChange={(e) => setAccessCode(e.target.value)}
                    />
                  </label>
                )}
                <button
                  className={styles.primary}
                  disabled={
                    !configured || !consent || (freeGemini && !syntheticOnly)
                  }
                  onClick={() => void flow.start(accessCode, syntheticOnly)}
                >
                  <Icon name="mic" /> AIと話しはじめる
                </button>
              </section>
            )}
            {busy && (
              <button className={styles.secondary} onClick={() => flow.stop()}>
                接続をキャンセル
              </button>
            )}
            <div className={styles.tools}>
              <button onClick={flow.explain}>
                <Icon name="chat" />
                質問の意味を{flow.connected ? "聞く" : "読む"}
              </button>
              <button
                aria-expanded={flow.sourcesOpen}
                aria-controls="voice-sources"
                onClick={() => flow.setSourcesOpen(!flow.sourcesOpen)}
              >
                <Icon name="book" />
                参考資料
              </button>
            </div>
            {flow.sourcesOpen && (
              <section className={styles.sources} id="voice-sources">
                <div className={styles.sectionHeading}>
                  <h2 ref={sourceHeading} tabIndex={-1}>
                    この質問を知る
                  </h2>
                  <button
                    className={styles.textButton}
                    onClick={() => flow.setSourcesOpen(false)}
                  >
                    閉じる
                  </button>
                </div>
                <p>{q.pack.overview}</p>
                <h3>賛成側の主な論点</h3>
                <p>{q.pack.supporting}</p>
                <h3>慎重・反対側の主な論点</h3>
                <p>{q.pack.cautious}</p>
                <p className={styles.note}>
                  {q.pack.limitation} 論点はデモの編集上の整理です。
                </p>
                {q.pack.sources.map((s) => (
                  <a
                    className={styles.sourceLink}
                    href={s.url}
                    key={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <strong>{s.title} ↗</strong>
                    <span>
                      {s.publisher} · 確認日 {s.checkedOn}
                    </span>
                    <span>{s.supports}</span>
                    <small>{s.url}</small>
                  </a>
                ))}
              </section>
            )}
            <section className={styles.answer} aria-label="回答候補">
              <div className={styles.sectionHeading}>
                <h2>{record.manual ? "あなたの選択" : "AIの理解"}</h2>
                <span>まだ確定していません</span>
              </div>
              <p className={styles.answerValue} aria-live="polite">
                {record.selected
                  ? answerLabels[record.selected]
                  : "お話を聞いてから、整理します"}
              </p>
              {record.manual && record.suggested && (
                <p className={styles.note}>
                  AIの提案：{answerLabels[record.suggested.answer]}
                </p>
              )}
              <button
                className={styles.textButton}
                aria-expanded={showChoices}
                onClick={() => setEditing(!showChoices)}
              >
                {record.selected ? "変更する" : "自分で回答を選ぶ"}
              </button>
              {showChoices && (
                <fieldset className={styles.choices}>
                  <legend className="sr-only">あなたの考えに近い回答</legend>
                  {answers.map((a) => (
                    <label key={a} data-selected={a === record.selected}>
                      <input
                        type="radio"
                        name="voice-answer"
                        checked={a === record.selected}
                        onChange={() => flow.choose(a)}
                      />
                      <span>{answerLabels[a]}</span>
                    </label>
                  ))}
                  <p className={styles.note}>
                    知識が足りず決められないときは「判断できない・見送る」。中立とは区別します。
                  </p>
                </fieldset>
              )}
            </section>
            <div className={styles.actions}>
              <button
                className={styles.primary}
                disabled={!record.selected || busy}
                onClick={() => {
                  setEditing(false);
                  flow.confirm();
                }}
              >
                {flow.index === 2
                  ? "この回答を確定して一覧へ"
                  : "この回答で次へ"}
                <Icon name="arrow" />
              </button>
              {flow.connected && (
                <button className={styles.secondary} onClick={flow.toggleMuted}>
                  <Icon name="mic" />
                  {flow.muted ? "マイクを再開する" : "マイクを一時停止"}
                </button>
              )}
              <button
                className={styles.textButton}
                onClick={() => {
                  flow.choose("skip");
                  setEditing(false);
                }}
              >
                今回は判断を見送る
              </button>
            </div>
            <p className={styles.privacy}>
              生音声・会話全文を運営側で保存しません。
              <br />
              確定回答はこのタブ内に保持します。
            </p>
            <details className={styles.details}>
              <summary>このデモについて</summary>
              <p>
                既存の8問から3問を試します。AIの提案は、あなたが確定するまで診断に反映しません。候補者情報をインタビューAIへ渡さず、一致度は既存の式で計算します。
              </p>
              <p>
                音声モデルは接続のたびに選べます。通信エラーでも通常診断で続けられます。画面を離れるとマイクは停止します。
              </p>
              <p>
                評価用の記録は画面のメモリ内だけに保持し、自動送信しません。会話本文の記録はありません。
              </p>
              {flow.trials.length > 0 && <Evaluation flow={flow} />}
            </details>
          </>
        )}
      </main>
    </div>
  );
}

function Evaluation({ flow }: { flow: ReturnType<typeof useInterview> }) {
  const trial = flow.trials.at(-1);
  if (!trial) return null;
  return (
    <details className={styles.evaluation}>
      <summary>音声体験の評価（任意）</summary>
      <p className={styles.note}>
        この画面だけの記録です。書き出したときだけファイルに残ります。回答の修正率と理解の正確さは別々に評価します。
      </p>
      {(
        [
          ["understanding", "考えを正しく理解していた"],
          ["naturalness", "会話が自然だった"],
          ["interruption", "割り込みが自然だった"],
        ] as const
      ).map(([key, label]) => (
        <label className={styles.rating} key={key}>
          {label}
          <select
            value={trial.ratings[key] ?? ""}
            onChange={(e) => flow.rate(key, Number(e.target.value))}
          >
            <option value="" disabled>
              未評価
            </option>
            {[1, 2, 3, 4, 5].map((n) => (
              <option value={n} key={n}>
                {n} / 5
              </option>
            ))}
          </select>
        </label>
      ))}
      <p className={styles.note}>
        {flow.trials.length}回の接続試行 · 直近{" "}
        {Math.round(trial.durationMs / 1000)}秒<br />
        利用トークン：
        {trial.usageObserved
          ? `${trial.usage.inputTokens}入力 / ${trial.usage.outputTokens}出力`
          : "未取得"}
        <br />
        費用：未算定（提供元の利用額で照合）
      </p>
      <button className={styles.secondary} onClick={flow.download}>
        本文を含まない評価記録を書き出す
      </button>
    </details>
  );
}
