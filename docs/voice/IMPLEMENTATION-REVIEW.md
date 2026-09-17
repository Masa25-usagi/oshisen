# オシセン音声MVP 実装レビュー

対象: `/Users/Masa2/oshisen-voice-demo` の未コミット実装
レビュー日: 2026-09-16
方針: 明確に再現条件またはコード上の閉じた因果関係を示せる不具合だけを記載。

## 対応状況

2026-09-16: 以下2件とも修正・統合済み。128テスト、両ビルド、lint成功。詳細はQA.md。以下の指摘本文は修正前の監査記録。

## Findings

### 1. [P1 / High] モデル切替後も前モデルの未確定提案が残り、新モデルの評価へ混入する

- 場所: `/Users/Masa2/oshisen-voice-demo/components/voice/use-interview.ts:335`（根本）
- 関連: 同ファイル `:212`、`:282`
- 再現条件:
  1. モデルAで現設問への `suggest_answer` を受け、まだ確定しない。
  2. 通信エラー、画面非表示からの復帰、または回答一覧からの再訪などで接続を止め、モデルBへ変更する。
  3. モデルBで接続を開始し、モデルBが新しい提案を出す前に、画面に残る回答を確定する。
- 実際の結果: `changeModel()` は `stop()` と `setModel()` しか行わないため、モデルAの `record.suggested` と、AIが自動設定した `record.selected` が残る。モデルBの `newTrial()` が始まった後に確定すると、`recordAnswers()` はモデルAの提案・confidenceをモデルBの試行へ記録する。画面上でも、モデルBを選択した状態でモデルA由来の値が「AIの理解」として表示される。
- 影響: READMEの「モデル切替後の試行へ以前のモデルの回答を混ぜない」という比較評価要件に反し、モデル別の修正率・理解評価が汚染される。ユーザーが提案元を誤認する可能性もある。
- 確認: ドメイン関数とメトリクス関数で、モデルAの未確定提案を保持したままモデルBの `Trial` へ確定を記録すると、`{"suggested":"agree","confirmed":"agree","changed":false,"confidence":0.8}` がモデルB側へ入ることを再現した。現在のフックには、その間にレコードをリセットする処理がない。
- 最小修正案: モデル変更時と再接続開始時に、未確定レコードのAI由来状態を試行境界でリセットする。少なくとも `suggested` を `null` にし、`manual === false` の `selected` も `null` にする。ユーザーの手動選択と確定済み回答は維持する。比較試行単位にするなら `clarifications` もリセットする。モデルA提案→モデルB開始→モデルB提案前に確定、のフックレベルテストを追加する。

### 2. [P2 / Medium] Geminiが初期WebSocket接続に失敗すると `connect()` が未解決のまま残る

- 場所: `/Users/Masa2/oshisen-voice-demo/lib/voice/providers/gemini.ts:78`（`await ai.live.connect`）、`:85-94`（エラー/クローズ処理）、`:146-149`（到達しない後処理）
- 関連する固定依存の実装: `/Users/Masa2/oshisen-voice-demo/node_modules/@google/genai/dist/web/index.mjs:14717-14758`、`:14810-14817`
- 再現条件: Gemini開始時に、WebSocketが `open` より前、または `setupComplete` より前にエラー/クローズする。オフライン、接続拒否、短期トークン拒否、初期ハンドシェイク失敗などで起こり得る。
- 実際の結果: アプリの `onerror` / `onclose` は `fail()` を呼ぶので画面はエラーになり、マイクとAudioContextは停止する。しかし導入済みSDKの `live.connect()` は、`onopenPromise` と `setupCompletePromise` に resolve だけを持ち、`onerror` / `onclose` では reject しない。したがって `await ai.live.connect()` は未解決となり、`GeminiLiveProvider.connect()` と、それを待つ `start()` も残り続ける。再試行のたびに同様の未解決チェーンを増やせる。
- 影響: 不安定な回線で再接続を繰り返すと、完了しないPromiseとクロージャがページ寿命中に蓄積する。接続タイマーも `fail()` 内の `disconnect()` で解除されるため、この待機を後からsettleさせない。
- 確認: 実キーを使う接続は行わず、導入済み `@google/genai` 2.22.0 のブラウザ実装を静的に追跡した。`onerror` / `onclose` は呼び出し側callbackへ渡すだけで、2つの待機Promiseをrejectする経路がないことを確認した。OpenAI側にはDataChannel close・abort・25秒timeoutで `ready` をrejectする対照実装がある。
- 最小修正案: プロバイダー側で接続試行用の明示的なreject経路を作り、`onerror`、`onclose`、30秒timeout、ユーザーキャンセルを `Promise.race` へ接続する。遅れてSDK接続が解決した場合は、generation/closed確認後すぐ `session.close()` する。初期socket error/closeで `connect()` が有限時間内にsettleし、再試行しても保留接続が増えない単体テストを追加する。

## 重点項目の確認結果

- 候補者情報のAI送信: 問題なし。`lib/voice/catalog.ts` は候補者を含まない `lib/questions.ts` のみを読み、`prompt.ts` / `server.ts` の依存経路に `lib/data.ts`、候補者回答、`matching.ts` は入っていない。APIはクライアント指定の `instructions` / `tools` を無視し、サーバー所有の内容だけを構成する。
- AI提案とユーザー確定: 問題なし。ツールは `suggested` / `selected` までで、`confirmed` は画面の確定操作だけが更新する。確定済み回答への遅延提案も拒否される。
- `skip` と `neutral`: 問題なし。`neutral=2`、`skip=null`。知識不足・回答辞退basisでneutralを返す提案は拒否され、一致度ではnullが分母から除外される。
- 既存一致度ロジック: 問題なし。確定回答だけを既存session stateへmergeし、結果画面は既存 `calculateMatch()` と既存fixtureを使う。生成AIは計算経路に入らない。
- 秘密情報: 報告すべき露出なし。長期APIキーはサーバーモジュールだけで参照され、設定APIはconfigured真偽だけを返す。OpenAI上流エラー本文は返さず、Geminiは1回・10分・接続開始1分の制約付き短期トークンのみをブラウザへ返す。
- 古いイベント/設問変更: ツールイベントは現在の `questionId`・`revision`・未確定状態を照合し、再接続ごと・設問変更ごとにrevisionを進める。手動選択を遅いAI提案で上書きしない。上記2件以外に、確定値を誤更新する競合は確認できなかった。

## 検証

- 実行: `node --test tests/voice-domain.test.ts tests/voice-lifecycle.test.ts tests/voice-server.test.ts`
- 結果: 18/18成功。
- 親タスクから、全122テスト、Sites/Next両ビルド、lint成功済みとの共有を受けたため再実行していない。
- ブラウザ操作、ビルド、公開、課金、実キー利用、`.env.local` 読み取りは実施していない。
- 対象リポジトリは編集していない。
- 接続失敗のローカルモックを1回試した際、Node条件のSDK transportが選ばれてモック外の接続経路になったため、その試験は直ちに破棄した。使用値は偽トークン `auth_tokens/unit-test` のみで、実キー・音声・ユーザー内容は送っていない。Finding 2の根拠にはこの試験を使わず、固定されたブラウザSDKソースの静的追跡だけを使った。

## Coverage / limitations

`AGENTS.md`、`docs/voice/README.md`、`docs/voice/QA.md`、`lib/voice`、`components/voice`、`app/api/voice`、`app/interview`、`public/voice-capture.js`、`tests/voice-*`、および既存診断・結果・一致度への接続箇所を確認した。OpenAI実キー未取得のためOpenAI実音声は未検証。iPhone Safari、Bluetooth、実マイク、ネットワークハンドオフは対象外であり、推測による指摘にはしていない。
