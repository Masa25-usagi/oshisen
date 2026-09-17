"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { readDiagnosis, writeDiagnosis } from "../session";
import { questions } from "../../lib/questions";
import {
  interviewIds,
  interviewQuestions,
  sourcePacks,
  type InterviewId,
  type VoiceModel,
} from "../../lib/voice/catalog";
import {
  confirmAnswer,
  emptyRecords,
  finishDemo,
  mergeConfirmed,
  parseSuggestion,
  propose,
  selectAnswer,
  resetVoiceSuggestions,
  type AnswerRecord,
  type VoiceAnswer,
} from "../../lib/voice/domain";
import type {
  VoiceEvent,
  VoiceProvider,
  VoiceStatus,
} from "../../lib/voice/contract";
import { createProvider } from "../../lib/voice/providers";
import {
  newTrial,
  recordUsage,
  recordAnswers,
  exportTrials,
  type Trial,
} from "../../lib/voice/metrics";

export function useInterview() {
  const router = useRouter();
  const [records, setRecords] = useState(emptyRecords);
  const recordsRef = useRef(records);
  const [index, setIndex] = useState(0);
  const active = useRef<{ id: InterviewId; revision: number }>({
    id: interviewIds[0],
    revision: 1,
  });
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const statusRef = useRef<VoiceStatus>("idle");
  const [caption, setCaption] = useState("");
  const [notice, setNotice] = useState("");
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [done, setDone] = useState(false);
  const [model, setModel] = useState<VoiceModel>("gemini-3.8-live");
  const [muted, setMuted] = useState(false);
  const [connected, setConnected] = useState(false);
  const provider = useRef<VoiceProvider | null>(null);
  const generation = useRef(0);
  const trial = useRef<Trial | null>(null);
  const trials = useRef<Trial[]>([]);
  const lastTurnEnd = useRef<number | null>(null);
  const clarificationBaseline = useRef<Partial<Record<InterviewId, number>>>(
    {},
  );
  const [trialSnapshot, setTrialSnapshot] = useState<Trial[]>([]);
  const updateRecords = (next: Record<InterviewId, AnswerRecord>) => {
    recordsRef.current = next;
    setRecords(next);
  };
  const changeStatus = (next: VoiceStatus) => {
    statusRef.current = next;
    setStatus(next);
  };
  const stop = useCallback((outcome: Trial["outcome"] = "interrupted") => {
    generation.current++;
    provider.current?.disconnect();
    provider.current = null;
    if (trial.current) {
      trial.current.durationMs = Date.now() - trial.current.startedAt;
      trial.current.outcome = outcome;
      trials.current.push(trial.current);
      trial.current = null;
    }
    lastTurnEnd.current = null;
    setConnected(false);
    setMuted(false);
    setCaption("");
    statusRef.current = "idle";
    setStatus("idle");
    setTrialSnapshot(structuredClone(trials.current));
  }, []);
  useEffect(() => {
    const onHide = () => {
      if (document.hidden) {
        stop();
        setNotice(
          "画面を離れたためマイクを停止しました。確定した回答は残っています。",
        );
      }
    };
    const onExit = () => stop();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onExit);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onExit);
      stop();
    };
  }, [stop]);

  function onEvent(event: VoiceEvent) {
    if (event.type === "status") {
      if (
        event.status === "speaking" &&
        lastTurnEnd.current !== null &&
        trial.current
      ) {
        trial.current.responseLatencyMs.push(
          Math.round(performance.now() - lastTurnEnd.current),
        );
        lastTurnEnd.current = null;
      }
      changeStatus(event.status);
    } else if (event.type === "caption") setCaption(event.text);
    else if (event.type === "turn-end") lastTurnEnd.current = performance.now();
    else if (
      event.type === "interruption" &&
      statusRef.current === "speaking" &&
      trial.current
    )
      trial.current.interruptions++;
    else if (event.type === "usage" && trial.current)
      recordUsage(trial.current, event.usage, event.cumulative);
    else if (event.type === "error") {
      stop();
      changeStatus("error");
      setNotice(event.message);
    } else if (event.type === "tool") {
      const current = active.current;
      const args = event.args as Record<string, unknown> | null;
      if (
        !args ||
        args.questionId !== current.id ||
        args.revision !== current.revision ||
        recordsRef.current[current.id].confirmed !== null
      ) {
        event.respond({
          accepted: false,
          reason: "stale_or_confirmed",
          instruction: "現在の画面指示を待つ。",
        });
        return;
      }
      const record = recordsRef.current[current.id];
      if (event.name === "suggest_answer") {
        const suggestion = parseSuggestion(args, current.id, current.revision);
        if (!suggestion) {
          event.respond({
            accepted: false,
            instruction: "形式を確認。判断できないはskip。",
          });
          return;
        }
        updateRecords({
          ...recordsRef.current,
          [current.id]: propose(record, suggestion),
        });
        if (trial.current)
          recordAnswers(
            trial.current,
            recordsRef.current,
            [current.id],
            clarificationBaseline.current,
          );
        event.respond({
          accepted: true,
          confirmed: false,
          instruction:
            "候補を表示しました。短く受け止めて待つ。確認質問・次問への移動は不要。",
        });
      } else if (event.name === "ask_clarification") {
        if (
          record.clarifications >= 1 ||
          typeof args.question !== "string" ||
          !args.question.trim() ||
          args.question.length > 160
        ) {
          event.respond({
            allowed: false,
            instruction:
              "追加確認はしない。不明ならskipの候補を表示し、説明を求められたら応じる。",
          });
          return;
        }
        updateRecords({
          ...recordsRef.current,
          [current.id]: {
            ...record,
            clarifications: record.clarifications + 1,
          },
        });
        if (trial.current)
          recordAnswers(
            trial.current,
            recordsRef.current,
            [current.id],
            clarificationBaseline.current,
          );
        setCaption(args.question);
        event.respond({ allowed: true, question: args.question });
      } else if (event.name === "show_sources") {
        setSourcesOpen(true);
        event.respond({
          shown: true,
          sources: sourcePacks[current.id].sources,
        });
      } else event.respond({ accepted: false, reason: "unknown_tool" });
    }
  }
  async function start(accessCode: string, syntheticOnly: boolean) {
    stop();
    updateRecords(resetVoiceSuggestions(recordsRef.current));
    clarificationBaseline.current = Object.fromEntries(
      interviewIds.map((id) => [id, recordsRef.current[id].clarifications]),
    );
    setNotice("");
    changeStatus("connecting");
    const gen = generation.current;
    const started = performance.now();
    trial.current = newTrial(model);
    // Reconnecting on the same question invalidates late tool calls too.
    active.current.revision++;
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
        throw new Error(
          "このブラウザではマイクを使えません。HTTPSで開くか、通常診断をご利用ください。",
        );
      const next = await createProvider(model);
      if (gen !== generation.current) {
        next.disconnect();
        return;
      }
      provider.current = next;
      await next.connect(
        {
          model,
          questionId: active.current.id,
          revision: active.current.revision,
          accessCode,
          syntheticOnly,
        },
        (e) => {
          if (gen === generation.current) onEvent(e);
        },
      );
      if (gen !== generation.current) {
        next.disconnect();
        return;
      }
      setConnected(true);
      if (trial.current)
        trial.current.connectMs = Math.round(performance.now() - started);
    } catch (error) {
      if (gen !== generation.current) return;
      stop();
      changeStatus("error");
      setNotice(
        error instanceof DOMException &&
          ["NotAllowedError", "NotFoundError"].includes(error.name)
          ? "マイクを利用できません。選択肢で回答するか、通常診断で続けられます。"
          : error instanceof Error
            ? error.message
            : "音声を開始できませんでした。",
      );
    }
  }
  function choose(answer: VoiceAnswer) {
    const id = active.current.id;
    updateRecords({
      ...recordsRef.current,
      [id]: selectAnswer(recordsRef.current[id], answer),
    });
  }
  function confirm() {
    const id = active.current.id;
    if (!recordsRef.current[id].selected) return;
    const next = {
      ...recordsRef.current,
      [id]: confirmAnswer(recordsRef.current[id]),
    };
    updateRecords(next);
    const existing = readDiagnosis();
    const answers = mergeConfirmed(existing.answers, next);
    const firstUnanswered = questions.findIndex((q) => !(q.id in answers));
    writeDiagnosis({
      answers,
      index: firstUnanswered < 0 ? questions.length - 1 : firstUnanswered,
      complete: firstUnanswered < 0,
    });
    if (trial.current)
      recordAnswers(trial.current, next, [id], clarificationBaseline.current);
    setCaption("");
    setSourcesOpen(false);
    const nextIndex = interviewIds.indexOf(id) + 1;
    if (nextIndex >= interviewIds.length) {
      stop("completed");
      setDone(true);
      return;
    }
    active.current = {
      id: interviewIds[nextIndex],
      revision: active.current.revision + 1,
    };
    setIndex(nextIndex);
    if (connected)
      provider.current?.setQuestion(active.current.id, active.current.revision);
  }
  function revisit(i: number) {
    stop();
    const id = interviewIds[i];
    active.current = { id, revision: active.current.revision + 1 };
    // Old confirmed values remain in the existing diagnosis until explicitly replaced.
    updateRecords({
      ...recordsRef.current,
      [id]: { ...recordsRef.current[id], confirmed: null },
    });
    setIndex(i);
    setDone(false);
    setSourcesOpen(false);
    setNotice("");
  }
  function fallback() {
    stop("fallback");
    router.push("/questions");
  }
  function finish() {
    writeDiagnosis(finishDemo(readDiagnosis().answers, recordsRef.current));
    stop("completed");
    router.push("/results");
  }
  function explain() {
    setSourcesOpen(true);
    if (connected) {
      provider.current?.interrupt();
      provider.current?.sendText(
        "この質問の意味と、賛成・慎重それぞれの論点を短く説明してください。まだ私の回答ではありません。",
      );
    }
  }
  function toggleMuted() {
    provider.current?.setMuted(!muted);
    setMuted(!muted);
  }
  function changeModel(value: VoiceModel) {
    stop();
    updateRecords(resetVoiceSuggestions(recordsRef.current));
    setModel(value);
    setNotice("モデルを切り替えました。開始ボタンで接続できます。");
  }
  function download() {
    const blob = new Blob([exportTrials(trials.current)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "oshisen-voice-evaluation.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function rate(key: keyof Trial["ratings"], value: number) {
    const last = trials.current.at(-1);
    if (last) {
      last.ratings[key] = value;
      setTrialSnapshot(structuredClone(trials.current));
    }
  }
  return {
    records,
    index,
    question: interviewQuestions[index],
    status,
    caption,
    notice,
    sourcesOpen,
    setSourcesOpen,
    done,
    model,
    muted,
    connected,
    start,
    stop,
    choose,
    confirm,
    revisit,
    fallback,
    finish,
    explain,
    toggleMuted,
    changeModel,
    download,
    rate,
    trials: trialSnapshot,
  };
}
