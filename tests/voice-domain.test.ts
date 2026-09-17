import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  answerValues,
  emptyRecord,
  emptyRecords,
  parseSuggestion,
  propose,
  selectAnswer,
  confirmAnswer,
  mergeConfirmed,
  finishDemo,
  resetVoiceSuggestions,
  type Suggestion,
} from "../lib/voice/domain.ts";
import { calculateMatch } from "../lib/matching.ts";
import { demoAnswerFixtures, candidates } from "../lib/data.ts";
import { interviewInstructions, interviewTools } from "../lib/voice/prompt.ts";
import {
  interviewIds,
  sourcePacks,
  modelOptions,
} from "../lib/voice/catalog.ts";
import {
  newTrial,
  recordAnswers,
  recordUsage,
  exportTrials,
} from "../lib/voice/metrics.ts";

const suggestion: Suggestion = {
  questionId: "transport",
  revision: 2,
  answer: "agree",
  confidence: 0.85,
  basis: "conditional",
};

test("new voice trial drops old AI choices but preserves user decisions and clarification limit", () => {
  const old = emptyRecords();
  old.transport = { ...propose(old.transport, suggestion), clarifications: 1 };
  old.childcare = selectAnswer(
    propose(old.childcare, {
      ...suggestion,
      questionId: "childcare",
    }),
    "neutral",
  );
  old.disaster = confirmAnswer(selectAnswer(old.disaster, "strongly_agree"));
  const next = resetVoiceSuggestions(old);
  assert.equal(next.transport.suggested, null);
  assert.equal(next.transport.selected, null);
  assert.equal(next.transport.clarifications, 1);
  assert.equal(next.childcare.suggested, null);
  assert.equal(next.childcare.selected, "neutral");
  assert.equal(next.childcare.manual, true);
  assert.deepEqual(next.disaster, old.disaster);
  assert.equal(old.transport.suggested?.answer, "agree");

  const trialB = newTrial("gpt-realtime-2.1-mini");
  next.childcare = confirmAnswer(next.childcare);
  recordAnswers(trialB, next, ["transport", "childcare"], { transport: 1 });
  assert.equal(trialB.answers.transport?.clarifications, 0);
  assert.equal(trialB.answers.transport?.confirmed, null);
  assert.equal(trialB.answers.childcare?.confirmed, "neutral");
  assert.equal(trialB.answers.childcare?.suggested, null);
  assert.equal(trialB.answers.childcare?.confidence, null);
  assert.equal(trialB.answers.childcare?.changed, null);
});

test("AI suggestion cannot become a confirmed diagnosis without user action", () => {
  const records = emptyRecords();
  records.transport = propose(records.transport, suggestion);
  assert.equal(records.transport.selected, "agree");
  assert.equal(records.transport.confirmed, null);
  assert.deepEqual(mergeConfirmed({}, records), {});
  assert.throws(() => finishDemo({}, records));
  records.transport = confirmAnswer(records.transport);
  assert.deepEqual(mergeConfirmed({}, records), { transport: 3 });
});
test("late suggestions cannot overwrite manual or confirmed choices", () => {
  const manual = selectAnswer(propose(emptyRecord(), suggestion), "disagree");
  const late = propose(manual, { ...suggestion, answer: "strongly_agree" });
  assert.equal(late.selected, "disagree");
  assert.equal(late.confirmed, null);
  const confirmed = confirmAnswer(late);
  assert.deepEqual(propose(confirmed, suggestion), confirmed);
});
test("skip and neutral have distinct meaning and calculation behavior", () => {
  assert.equal(answerValues.neutral, 2);
  assert.equal(answerValues.skip, null);
  assert.equal(
    parseSuggestion(
      { ...suggestion, answer: "neutral", basis: "insufficient_knowledge" },
      "transport",
      2,
    ),
    null,
  );
  assert.equal(
    parseSuggestion(
      { ...suggestion, answer: "skip", basis: "insufficient_knowledge" },
      "transport",
      2,
    )?.answer,
    "skip",
  );
  assert.equal(
    calculateMatch({ transport: null }, { transport: 4 }).score,
    null,
  );
  assert.equal(calculateMatch({ transport: 2 }, { transport: 4 }).score, 50);
});
test("stale revisions, other questions, invalid enums, and malformed confidence are rejected", () => {
  for (const s of [
    null,
    {},
    { ...suggestion, revision: 1 },
    { ...suggestion, questionId: "disaster" },
    { ...suggestion, answer: "yes" },
    { ...suggestion, confidence: NaN },
    { ...suggestion, confidence: 1.01 },
    { ...suggestion, confidence: "0.8" },
    { ...suggestion, basis: "candidate_match" },
  ])
    assert.equal(parseSuggestion(s, "transport", 2), null);
  assert.deepEqual(
    parseSuggestion(
      { ...suggestion, transcript: "must not persist", candidate: "untrusted" },
      "transport",
      2,
    ),
    suggestion,
  );
});
test("3-question finish preserves existing answers; explicit finish skips only missing ones", () => {
  const r = emptyRecords();
  r.transport = confirmAnswer(selectAnswer(r.transport, "agree"));
  r.childcare = confirmAnswer(selectAnswer(r.childcare, "neutral"));
  r.disaster = confirmAnswer(selectAnswer(r.disaster, "skip"));
  const result = finishDemo({ education: 4 }, r);
  assert.equal(result.answers.education, 4);
  assert.equal(result.answers.transport, 3);
  assert.equal(result.answers.childcare, 2);
  assert.equal(result.answers.disaster, null);
  assert.equal(Object.keys(result.answers).length, 8);
  assert.equal(result.complete, true);
  const match = calculateMatch(
    result.answers,
    demoAnswerFixtures["sato-misaki"],
  );
  assert.equal(match.comparedCount, 3);
  assert.equal(match.score, 67);
});
test("interview context and capabilities never contain candidate data or confirmation tools", () => {
  const prompt = interviewInstructions("transport", 4);
  for (const c of candidates) {
    assert.ok(!prompt.includes(c.name));
    assert.ok(!prompt.includes(c.id));
  }
  assert.deepEqual(
    interviewTools.map((t) => t.name),
    ["suggest_answer", "ask_clarification", "show_sources"],
  );
  assert.match(prompt, /revision=4/);
  assert.match(prompt, /1回まで/);
  assert.deepEqual(
    modelOptions.slice(0, 2).map((m) => m.id),
    ["gpt-realtime-2.1", "gpt-realtime-2.1-mini"],
  );
  for (const file of ["catalog.ts", "domain.ts", "prompt.ts", "server.ts"])
    assert.doesNotMatch(
      readFileSync(new URL(`../lib/voice/${file}`, import.meta.url), "utf8"),
      /from\s+["'][^"']*\/(?:data|matching|policy-evidence)(?:\.ts)?["']/,
    );
});
test("each source pack carries primary publisher, date, URL, balanced framing, and scope", () => {
  for (const id of interviewIds) {
    const p = sourcePacks[id];
    for (const value of [p.overview, p.supporting, p.cautious, p.limitation])
      assert.ok(value.length > 10);
    for (const s of p.sources) {
      assert.equal(new URL(s.url).protocol, "https:");
      assert.ok(s.publisher && s.checkedOn && s.supports);
    }
  }
});
test("metrics omit free text and distinguish manual answers, modification, and unknown cost", () => {
  const trial = newTrial("gpt-realtime-2.1");
  const r = emptyRecords();
  r.transport = confirmAnswer(
    selectAnswer(propose(r.transport, suggestion), "disagree"),
  );
  r.childcare = confirmAnswer(selectAnswer(r.childcare, "skip"));
  recordAnswers(trial, r);
  assert.equal(trial.answers.transport?.changed, true);
  assert.equal(trial.answers.childcare?.changed, null);
  const usage = {
    inputTokens: 20,
    outputTokens: 10,
    audioInputTokens: null,
    audioOutputTokens: 8,
    cachedTokens: 0,
  };
  recordUsage(trial, usage, false);
  recordUsage(trial, usage, false);
  assert.equal(trial.usage.inputTokens, 40);
  recordUsage(trial, { ...usage, inputTokens: 50 }, true);
  recordUsage(trial, usage, true);
  assert.equal(trial.usage.inputTokens, 50);
  assert.equal(trial.estimatedCostUsd, null);
  const text = exportTrials([trial]);
  assert.doesNotMatch(
    text,
    /"(?:transcript|caption|audio|recording|utterance)"\s*:/,
  );
});

test("model trials retain unconfirmed proposals without inheriting other models answers", () => {
  const trial = newTrial("gpt-realtime-2.1-mini");
  const records = emptyRecords();
  records.transport = confirmAnswer(selectAnswer(records.transport, "agree"));
  records.childcare = propose(records.childcare, {
    questionId: "childcare",
    revision: 1,
    answer: "skip",
    confidence: 0.8,
    basis: "insufficient_knowledge",
  });
  recordAnswers(trial, records, ["childcare"]);
  assert.equal(trial.answers.transport, undefined);
  assert.equal(trial.answers.childcare?.suggested, "skip");
  assert.equal(trial.answers.childcare?.confirmed, null);
  assert.equal(trial.answers.childcare?.changed, null);
});
