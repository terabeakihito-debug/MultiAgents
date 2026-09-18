"use client";

import { type FormEvent, useState } from "react";
import styles from "./p2-mock.module.css";

type View = "overview" | "clarify" | "configure" | "run" | "review";
type FlowMode = "recommended" | "focused" | "investigation";

type Agent = {
  id: string;
  name: string;
  role: string;
  model: string;
  state: "done" | "working" | "queued" | "waiting";
  detail: string;
  progress: number;
};

const navItems: Array<{ id: View; label: string; description: string }> = [
  { id: "overview", label: "タスク一覧", description: "全体の状況" },
  { id: "clarify", label: "要件整理", description: "会話から計画へ" },
  { id: "configure", label: "実行計画", description: "フローとモデル" },
  { id: "run", label: "実行状況", description: "進捗と質問" },
  { id: "review", label: "成果物と承認", description: "差分と次の操作" },
];

const agents: Agent[] = [
  {
    id: "planner",
    name: "Codex",
    role: "計画・実装",
    model: "gpt-5.6-sol",
    state: "done",
    detail: "変更方針と受け入れ条件を整理しました",
    progress: 100,
  },
  {
    id: "reviewer",
    name: "Cursor",
    role: "実装レビュー",
    model: "auto",
    state: "working",
    detail: "変更ファイルを確認中 · 最終更新 12秒前",
    progress: 64,
  },
  {
    id: "risk",
    name: "Claude",
    role: "リスクレビュー",
    model: "claude-sonnet-4.5",
    state: "working",
    detail: "Cursorと独立してリスクを確認中",
    progress: 42,
  },
];

const flowPresets: Record<FlowMode, { label: string; description: string; steps: Array<{ number: string; title: string; detail: string }> }> = {
  recommended: {
    label: "画面改善 · 実装＋並列レビュー",
    description: "変更範囲が限定されているため、実装後に独立したレビューを並列実行します。",
    steps: [
      { number: "01", title: "要件の確認", detail: "会話から受け入れ条件を確定" },
      { number: "02", title: "実装", detail: "隔離された作業領域で変更" },
      { number: "03", title: "並列レビュー", detail: "安全性と品質を独立に確認" },
      { number: "04", title: "検証と承認", detail: "結果を確認してGit操作へ" },
    ],
  },
  focused: {
    label: "小さな修正 · 実装＋対象検証",
    description: "変更が小さい場合は、レビューを増やさず対象範囲の検証に集中します。",
    steps: [
      { number: "01", title: "要件の確認", detail: "目的と完了条件を確定" },
      { number: "02", title: "実装", detail: "隔離された作業領域で変更" },
      { number: "03", title: "対象検証と承認", detail: "変更箇所を確認してGit操作へ" },
    ],
  },
  investigation: {
    label: "原因調査 · 調査＋証拠整理",
    description: "原因を先に絞り込み、変更を加えずに調査結果と次の判断材料をまとめます。",
    steps: [
      { number: "01", title: "問いの確認", detail: "調査範囲と観測条件を確定" },
      { number: "02", title: "並列調査", detail: "ログ・コード・再現条件を分担" },
      { number: "03", title: "証拠整理と判断", detail: "一致点を比較して次の対応を選択" },
    ],
  },
};

function statusLabel(state: Agent["state"]) {
  return {
    done: "完了",
    working: "実行中",
    queued: "待機中",
    waiting: "回答待ち",
  }[state];
}

export default function P2MockPage() {
  const [view, setView] = useState<View>("overview");
  const [parallel, setParallel] = useState(true);
  const [flowMode, setFlowMode] = useState<FlowMode>("recommended");
  const [taskStarted, setTaskStarted] = useState(false);
  const [notice, setNotice] = useState("この画面はP2の情報設計を確認するためのモックです。");
  const [modelSelection, setModelSelection] = useState<Record<string, string>>({
    planner: "gpt-5.6-sol",
    reviewer: "auto",
    risk: "claude-sonnet-4.5",
  });

  const moveTo = (nextView: View, message?: string) => {
    setView(nextView);
    if (message) setNotice(message);
  };

  const startTask = () => {
    setTaskStarted(true);
    moveTo("run", "タスクを開始しました。実行状況をこの画面で確認できます。");
  };

  const updateModel = (agentId: string, model: string) => {
    setModelSelection((current) => ({ ...current, [agentId]: model }));
    setNotice(`${agentId === "planner" ? "Codex" : agentId === "reviewer" ? "Cursor" : "Claude"} のモデルを変更しました。`);
  };

  return (
    <main className={styles.shell}>
      <aside className={styles.sidebar} aria-label="P2モックのナビゲーション">
        <div className={styles.brand}>
          <span className={styles.brandMark}>M</span>
          <div>
            <strong>MultiAgents</strong>
            <span>P2 workbench</span>
          </div>
        </div>

        <div className={styles.mockBadge}>UIモック · 実データ未接続</div>

        <nav className={styles.nav} aria-label="画面">
          {navItems.map((item) => (
            <button
              className={`${styles.navItem} ${view === item.id ? styles.navItemActive : ""}`}
              key={item.id}
              type="button"
              onClick={() => moveTo(item.id)}
              aria-current={view === item.id ? "page" : undefined}
            >
              <span>{item.label}</span>
              <small>{item.description}</small>
            </button>
          ))}
        </nav>

        <div className={styles.sidebarFooter}>
          <div className={styles.capacityLabel}>
            <span>ローカル実行枠</span>
            <strong>2 / 3</strong>
          </div>
          <div className={styles.capacityBar} aria-label="ローカル実行枠 3件中2件を使用">
            <span />
          </div>
          <p>実行枠はタスク単位で管理します。別タスクも並行して実行できます。</p>
        </div>
      </aside>

      <section className={styles.content}>
        <header className={styles.topbar}>
          <div>
            <p className={styles.eyebrow}>P2 WORKBENCH / プロジェクト · MultiAgents</p>
            <h1>{navItems.find((item) => item.id === view)?.label}</h1>
          </div>
          <div className={styles.topbarActions}>
            <span className={styles.connection}><i /> ローカル接続中</span>
            <button className={styles.secondaryButton} type="button" onClick={() => moveTo("clarify", "新しいタスクの要件整理を始めます。")}>＋ 新しいタスク</button>
          </div>
        </header>

        <div className={styles.notice} role="status" aria-live="polite">
          <span className={styles.noticeIcon}>i</span>
          <span>{notice}</span>
        </div>

        {view === "overview" && (
          <OverviewView onClarify={() => moveTo("clarify", "新しいタスクの要件整理を始めます。")} onRun={() => moveTo("run")} onReview={() => moveTo("review")} />
        )}
        {view === "clarify" && <ClarifyView onPlan={() => moveTo("configure", "要件を保存しました。実行計画を確認してください。")} />}
        {view === "configure" && (
          <ConfigureView
            parallel={parallel}
            setParallel={setParallel}
            flowMode={flowMode}
            setFlowMode={setFlowMode}
            modelSelection={modelSelection}
            onModelChange={updateModel}
            onStart={startTask}
          />
        )}
        {view === "run" && <RunView started={taskStarted} parallel={parallel} flowMode={flowMode} onReview={() => moveTo("review", "成果物と承認の画面を開きました。")} />}
        {view === "review" && <ReviewView onRun={() => moveTo("run")} />}
      </section>
    </main>
  );
}

function PageTitle({ kicker, title, description }: { kicker: string; title: string; description: string }) {
  return (
    <div className={styles.pageTitle}>
      <p className={styles.sectionKicker}>{kicker}</p>
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  );
}

function ConceptVisual() {
  return (
    <div className={styles.conceptVisual}>
      <svg className={styles.conceptSvg} viewBox="0 0 440 190" role="img" aria-labelledby="concept-title concept-description">
        <title id="concept-title">P2タスク実行の流れ</title>
        <desc id="concept-description">要件整理、実装、並列レビュー、人の承認を順に進める流れを表した図</desc>
        <path className={styles.visualPath} d="M48 95H145M145 95H255M255 95H392" />
        <path className={styles.visualPathMuted} d="M200 95V143H318V95" />
        <circle className={styles.visualNodeMuted} cx="48" cy="95" r="18" />
        <circle className={styles.visualNode} cx="145" cy="95" r="22" />
        <circle className={styles.visualNode} cx="255" cy="95" r="22" />
        <circle className={styles.visualNodeMuted} cx="318" cy="143" r="18" />
        <circle className={styles.visualNode} cx="392" cy="95" r="22" />
        <text className={styles.visualNumber} x="48" y="99" textAnchor="middle">01</text>
        <text className={styles.visualNumberDark} x="145" y="99" textAnchor="middle">02</text>
        <text className={styles.visualNumberDark} x="255" y="99" textAnchor="middle">03</text>
        <text className={styles.visualNumber} x="318" y="147" textAnchor="middle">03</text>
        <text className={styles.visualNumberDark} x="392" y="99" textAnchor="middle">04</text>
        <text className={styles.visualLabel} x="48" y="39" textAnchor="middle">要件整理</text>
        <text className={styles.visualLabel} x="145" y="158" textAnchor="middle">実装</text>
        <text className={styles.visualLabel} x="255" y="39" textAnchor="middle">レビュー</text>
        <text className={styles.visualLabelSmall} x="318" y="178" textAnchor="middle">並列</text>
        <text className={styles.visualLabel} x="392" y="158" textAnchor="middle">承認</text>
      </svg>
      <div className={styles.visualCaption}><span className={styles.visualPulse} /> 状態が変わるたびに、次の操作を表示</div>
    </div>
  );
}

function ParallelLanes({ parallel, flowMode }: { parallel: boolean; flowMode: FlowMode }) {
  const flow = flowPresets[flowMode];
  const isParallel = parallel && flowMode !== "focused";
  const middleLabel = flowMode === "investigation" ? "調査" : flowMode === "focused" ? "対象検証" : "レビュー";

  return (
    <section className={styles.parallelPanel} aria-label={`${flow.label}の実行状況`}>
      <div className={styles.panelHeader}>
        <div><p className={styles.sectionKicker}>{isParallel ? "並列処理の見取り図" : "実行手順の見取り図"}</p><h3>{isParallel ? "独立した作業を同時に実行" : "選択した手順に沿って実行"}</h3></div>
        <span className={styles.lastEvent}>依存関係を表示</span>
      </div>
      <div className={styles.laneMap}>
        <div className={styles.laneStart}><span>Codex</span><small>実装済み</small></div>
        <div className={isParallel ? styles.laneFork : styles.laneForkMuted} aria-hidden="true"><i /><i /></div>
        <div className={styles.laneColumn}>
          {isParallel ? <>
            <div className={`${styles.laneNode} ${styles.laneNodeActive}`}><span>{flowMode === "investigation" ? "コード調査" : "Cursor"}</span><small>{middleLabel}中</small></div>
            <div className={styles.laneNode}><span>{flowMode === "investigation" ? "ログ調査" : "Claude"}</span><small>{middleLabel}中</small></div>
          </> : <div className={`${styles.laneNode} ${styles.laneNodeActive}`}><span>{middleLabel}</span><small>実行中</small></div>}
        </div>
        <div className={isParallel ? styles.laneJoin : styles.laneJoinMuted} aria-hidden="true" />
        <div className={styles.laneEnd}><span>Codex</span><small>最終確認</small></div>
      </div>
      <p className={styles.visualHint}>{isParallel ? "独立した作業は同時に進み、両方の結果がそろってから最終確認へ進みます。" : "並列処理は使わず、対象範囲の完了後に最終確認へ進みます。"}</p>
    </section>
  );
}

function OverviewView({ onClarify, onRun, onReview }: { onClarify: () => void; onRun: () => void; onReview: () => void }) {
  return (
    <div className={styles.viewStack}>
      <PageTitle kicker="ワークスペース" title="いま必要な操作がすぐ見つかる" description="タスクを作る、進捗を見る、成果物を承認する。目的ごとに画面を分けています。" />

      <section className={styles.heroCard}>
        <div className={styles.heroCopy}>
          <span className={styles.cardOverline}>新しいタスク</span>
          <h3>まず、やりたいことを会話で整理します</h3>
          <p>いきなり実行せず、目的・範囲・完了条件をエージェントと確認してから、最適なフローを提案します。</p>
          <button className={styles.primaryButton} type="button" onClick={onClarify}>要件整理を始める <span>→</span></button>
        </div>
        <ConceptVisual />
      </section>

      <div className={styles.sectionHeader}>
        <div><p className={styles.sectionKicker}>進行中</p><h3>実行中のタスク</h3></div>
        <button className={styles.textButton} type="button" onClick={onRun}>すべて見る →</button>
      </div>
      <div className={styles.taskGrid}>
        <article className={styles.taskCard}>
          <div className={styles.taskCardHeader}><span className={`${styles.statusPill} ${styles.statusWorking}`}>実行中</span><span className={styles.taskTime}>12分前に更新</span></div>
          <h3>ログイン画面のエラー表示を改善</h3>
          <p>実装 · 並列レビュー</p>
          <div className={styles.miniProgress}><span style={{ width: "64%" }} /></div>
          <div className={styles.taskCardFooter}><span>2 / 3 エージェント</span><button className={styles.cardLink} type="button" onClick={onRun}>実行状況を見る</button></div>
        </article>
        <article className={styles.taskCard}>
          <div className={styles.taskCardHeader}><span className={`${styles.statusPill} ${styles.statusWaiting}`}>回答待ち</span><span className={styles.taskTime}>1時間前に更新</span></div>
          <h3>APIのエラーログを調査する</h3>
          <p>調査 · 人への質問</p>
          <div className={styles.questionLine}><span className={styles.questionDot}>?</span> 接続先の環境を選んでください</div>
          <div className={styles.taskCardFooter}><span>次の操作が必要です</span><button className={styles.cardLink} type="button" onClick={onRun}>回答する</button></div>
        </article>
      </div>

      <div className={styles.sectionHeader}><div><p className={styles.sectionKicker}>完了済み</p><h3>成果物の確認が必要</h3></div></div>
      <article className={styles.reviewRow}>
        <div className={styles.reviewIcon}>✓</div>
        <div className={styles.reviewMain}><strong>READMEの起動手順を更新</strong><span>Codex Final 完了 · 変更 1ファイル · 18分前</span></div>
        <span className={`${styles.statusPill} ${styles.statusApproval}`}>承認待ち</span>
        <button className={styles.secondaryButton} type="button" onClick={onReview}>成果物を確認</button>
      </article>
    </div>
  );
}

function ClarifyView({ onPlan }: { onPlan: () => void }) {
  const [draft, setDraft] = useState("");
  const [addedMessage, setAddedMessage] = useState("");

  const submitMessage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = draft.trim();
    if (!message) return;
    setAddedMessage(message);
    setDraft("");
  };

  return (
    <div className={styles.viewStack}>
      <PageTitle kicker="STEP 01 / 要件整理" title="実行前に、完成の形をそろえる" description="会話の内容を要件スナップショットとして保存します。あとから実行条件を確認できます。" />
      <div className={styles.twoColumn}>
        <section className={styles.panel}>
          <div className={styles.panelHeader}><div><p className={styles.sectionKicker}>エージェントとの会話</p><h3>ログイン画面のエラー表示を改善</h3></div><span className={styles.savedLabel}>保存済み</span></div>
          <div className={styles.conversation}>
            <div className={styles.message}><span className={styles.avatar}>あなた</span><p>ログイン画面のエラーを、利用者が次に何をすればよいかわかる表示にしたい。</p></div>
            <div className={`${styles.message} ${styles.messageAgent}`}><span className={styles.avatarAgent}>M</span><p>対象は画面文言と状態表示ですか？ APIのエラー処理やログも変更範囲に含めますか？</p></div>
            <div className={styles.message}><span className={styles.avatar}>あなた</span><p>画面文言と状態表示を優先。既存のAPI仕様は変えない。</p></div>
            {addedMessage && <div className={styles.message}><span className={styles.avatar}>あなた</span><p>{addedMessage}</p></div>}
          </div>
          <form className={styles.chatInput} onSubmit={submitMessage}>
            <input aria-label="要件を追加する" placeholder="要件を追加する…" value={draft} onChange={(event) => setDraft(event.target.value)} />
            <button type="submit" aria-label="メッセージを送信" disabled={!draft.trim()}>↑</button>
          </form>
        </section>
        <section className={styles.panel}>
          <div className={styles.panelHeader}><div><p className={styles.sectionKicker}>要件スナップショット</p><h3>実行前に確認してください</h3></div><span className={styles.versionLabel}>v0.1</span></div>
          <dl className={styles.requirementList}>
            <div><dt>目的</dt><dd>利用者がエラー原因と次の操作を理解できる</dd></div>
            <div><dt>対象</dt><dd>ログイン画面の文言、状態、再試行導線</dd></div>
            <div><dt>対象外</dt><dd>API仕様の変更、認証方式の変更</dd></div>
            <div><dt>完了条件</dt><dd>エラー・再試行・回答待ちを区別して表示する</dd></div>
          </dl>
          <div className={styles.recommendation}><span className={styles.recommendationIcon}>✦</span><div><strong>おすすめのフロー</strong><p>実装 → 並列レビュー → 対象範囲の検証</p><small>画面変更が中心のため、全エージェントを順番に実行する必要はありません。</small></div></div>
          <button className={styles.primaryButtonFull} type="button" onClick={onPlan}>この内容で実行計画へ <span>→</span></button>
        </section>
      </div>
    </div>
  );
}

function ConfigureView({ parallel, setParallel, flowMode, setFlowMode, modelSelection, onModelChange, onStart }: { parallel: boolean; setParallel: (value: boolean) => void; flowMode: FlowMode; setFlowMode: (value: FlowMode) => void; modelSelection: Record<string, string>; onModelChange: (agentId: string, model: string) => void; onStart: () => void }) {
  const flow = flowPresets[flowMode];

  return (
    <div className={styles.viewStack}>
      <PageTitle kicker="STEP 02 / 実行計画" title="フローを選び、実行条件を確認する" description="おすすめをそのまま使うことも、エージェントとモデルを変更することもできます。" />
      <section className={styles.recommendedFlow}>
        <div className={styles.flowHeader}><div><span className={styles.recommendedTag}>{flowMode === "recommended" ? "おすすめ" : "選択中"}</span><h3>{flow.label}</h3><p>{flow.description}</p></div><label className={styles.flowSelectorLabel}>フロー<select className={styles.flowSelector} aria-label="実行フローを選択" value={flowMode} onChange={(event) => setFlowMode(event.target.value as FlowMode)}><option value="recommended">おすすめ</option><option value="focused">小さな修正</option><option value="investigation">原因調査</option></select></label></div>
        <div className={styles.flowSteps}>{flow.steps.map((step, index) => <div className={styles.flowStep} key={step.number}><span className={styles.flowNumber}>{step.number}</span><div><strong>{step.title}</strong><span>{step.detail}</span></div>{index < flow.steps.length - 1 && <span className={styles.flowArrow}>→</span>}</div>)}</div>
      </section>
      <div className={styles.twoColumn}>
        <section className={styles.panel}><div className={styles.panelHeader}><div><p className={styles.sectionKicker}>エージェントとモデル</p><h3>担当を確認</h3></div><span className={styles.allowlistLabel}>許可リストから選択</span></div><div className={styles.agentSettings}>{agents.map((agent) => <div className={styles.agentSetting} key={agent.id}><div className={styles.agentIdentity}><span className={styles.agentBadge}>{agent.name.slice(0, 1)}</span><div><strong>{agent.name}</strong><span>{agent.role}</span></div></div><select aria-label={`${agent.name}のモデル`} value={modelSelection[agent.id]} onChange={(event) => onModelChange(agent.id, event.target.value)}><option value="gpt-5.6-sol">GPT-5.6 Sol</option><option value="gpt-5.6-luna">GPT-5.6 Luna</option><option value="auto">Auto（Cursor）</option><option value="claude-sonnet-4.5">Claude Sonnet 4.5</option></select></div>)}</div></section>
        <section className={styles.panel}><div className={styles.panelHeader}><div><p className={styles.sectionKicker}>実行オプション</p><h3>安全な実行条件</h3></div></div><label className={styles.toggleRow}><span><strong>独立したレビューを並列実行</strong><small>完了した実装を共有し、待ち時間を短縮</small></span><input type="checkbox" checked={parallel} onChange={(event) => setParallel(event.target.checked)} /><i /></label><div className={styles.optionRow}><span>同時実行するタスク</span><strong>最大 2 件</strong></div><div className={styles.optionRow}><span>変更作業領域</span><strong>隔離されたworktree</strong></div><div className={styles.optionRow}><span>Git操作</span><strong>人の承認後のみ</strong></div><div className={styles.resourceNote}>時間制限で途中終了させず、進捗停止の監視とチェックポイントで安全に再開します。</div></section>
      </div>
      <div className={styles.bottomAction}><div><strong>開始前の確認は完了しています</strong><span>実行後も、各エージェントの状態と質問を確認できます。</span></div><button className={styles.primaryButton} type="button" onClick={onStart}>タスクを開始 <span>→</span></button></div>
    </div>
  );
}

function RunView({ started, parallel, flowMode, onReview }: { started: boolean; parallel: boolean; flowMode: FlowMode; onReview: () => void }) {
  const runAgents = agents.map((agent) => {
    if (flowMode === "focused" && agent.id === "risk") return { ...agent, state: "queued" as const, detail: "このフローでは実行しません", progress: 0 };
    if (!parallel && agent.id === "risk") return { ...agent, state: "queued" as const, detail: "Cursor完了後に開始", progress: 0 };
    return agent;
  });

  return (
    <div className={styles.viewStack}>
      <div className={styles.taskHeader}><div><p className={styles.sectionKicker}>TASK-024 · 実行状況</p><h2>ログイン画面のエラー表示を改善</h2><span>{flowPresets[flowMode].label} · 更新 12秒前</span></div><span className={`${styles.statusPill} ${styles.statusWorking}`}>{started ? "実行中" : "再開可能"}</span></div>
      <div className={styles.progressSummary}><div><span className={styles.summaryLabel}>全体の状態</span><strong>{started ? (parallel && flowMode !== "focused" ? "並列実行中" : "順番に実行中") : "再開可能"}</strong></div><div><span className={styles.summaryLabel}>経過時間</span><strong>04:18</strong></div><div><span className={styles.summaryLabel}>変更ファイル</span><strong>3</strong></div><div><span className={styles.summaryLabel}>実行枠</span><strong>1 / 2</strong></div></div>
      <ParallelLanes parallel={parallel} flowMode={flowMode} />
      <section className={styles.panel}><div className={styles.panelHeader}><div><p className={styles.sectionKicker}>エージェントの進捗</p><h3>何が起きているか</h3></div><span className={styles.lastEvent}>最終イベント 12秒前</span></div><div className={styles.agentProgressList}>{runAgents.map((agent) => <article className={styles.agentProgress} key={agent.id}><div className={styles.agentProgressTop}><div className={styles.agentIdentity}><span className={styles.agentBadge}>{agent.name.slice(0, 1)}</span><div><strong>{agent.name} <em>{agent.role}</em></strong><span>{agent.detail}</span></div></div><span className={`${styles.stateText} ${styles[`state_${agent.state}`]}`}>{statusLabel(agent.state)}</span></div><div className={styles.progressTrack} role="progressbar" aria-label={`${agent.name}の進捗 ${agent.progress}%`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={agent.progress}><span style={{ width: `${agent.progress}%` }} /></div><div className={styles.progressMeta}><span>{agent.progress}%</span>{agent.state === "working" ? <span>ツール: ファイル差分を確認中</span> : <span>{agent.state === "done" ? "結果を保存済み" : "前のステップ完了後に開始"}</span>}</div></article>)}</div></section>
      <div className={styles.twoColumn}><section className={styles.panel}><div className={styles.panelHeader}><div><p className={styles.sectionKicker}>実行ログ</p><h3>直近のイベント</h3></div><button className={styles.textButton} type="button">すべて表示</button></div><ol className={styles.eventList}><li><span className={styles.eventTime}>15:42:18</span><span className={styles.eventDot} /><p><strong>Cursor</strong> がレビューを開始しました</p></li><li><span className={styles.eventTime}>15:41:56</span><span className={styles.eventDot} /><p>Codex の変更を <strong>3ファイル</strong> 保存しました</p></li><li><span className={styles.eventTime}>15:38:02</span><span className={styles.eventDotMuted} /><p>要件スナップショットを確定しました</p></li></ol></section><section className={styles.panel}><div className={styles.panelHeader}><div><p className={styles.sectionKicker}>操作</p><h3>必要なときだけ介入</h3></div></div><div className={styles.actionStack}><button className={styles.secondaryButton} type="button">一時停止</button><button className={styles.secondaryButton} type="button" onClick={onReview}>成果物を確認</button><button className={styles.dangerButton} type="button">タスクをキャンセル</button></div><p className={styles.actionHint}>ブラウザを閉じても、チェックポイントから再開できます。</p></section></div>
    </div>
  );
}

function ReviewView({ onRun }: { onRun: () => void }) {
  const [approved, setApproved] = useState(false);
  const [committed, setCommitted] = useState(false);
  const [pushed, setPushed] = useState(false);
  const [prCreated, setPrCreated] = useState(false);

  return (
    <div className={styles.viewStack}>
      <PageTitle kicker="STEP 04 / 成果物と承認" title="結果を確認してから、Git操作へ進む" description="変更・検証・レビューの根拠を一つの画面で確認し、必要な操作だけを選びます。" />
      <section className={styles.approvalBanner}><div><span className={styles.recommendedTag}>{approved ? "承認済み" : "人の確認が必要"}</span><h3>{approved ? "承認済み。Git操作へ進めます" : "レビューは完了しました"}</h3><p>{approved ? "変更内容を承認しました。コミットを作成してから、PR作成へ進めます。" : "重大な指摘はありません。まず変更内容を確認して承認してください。"}</p></div><span className={styles.approvalMark}>{approved ? "✓" : "!"}</span></section>
      <div className={styles.twoColumn}><section className={styles.panel}><div className={styles.panelHeader}><div><p className={styles.sectionKicker}>変更ファイル</p><h3>3ファイルが変更されています</h3></div><button className={styles.textButton} type="button">差分を開く</button></div><ul className={styles.fileList}><li><span className={styles.fileStatus}>M</span><code>src/app/login-error.tsx</code><span>+24 −8</span></li><li><span className={styles.fileStatus}>M</span><code>src/app/globals.css</code><span>+18 −3</span></li><li><span className={styles.fileStatus}>A</span><code>src/app/error-copy.ts</code><span>+42</span></li></ul><div className={styles.checkList}><p><span>✓</span> TypeScript 型チェック</p><p><span>✓</span> 対象画面のブラウザ確認</p><p><span>✓</span> Cursor / Claude レビュー</p></div><div className={styles.repositoryMeta}><div><span>ブランチ</span><code>codex/p2-login-errors</code></div><div><span>リモート</span><code>github / MultiAgents</code></div></div></section><section className={styles.panel}><div className={styles.panelHeader}><div><p className={styles.sectionKicker}>レビュー結果</p><h3>一致した判断と未解決事項</h3></div></div><div className={styles.resultRow}><span className={styles.resultGood}>✓</span><div><strong>Codex / Cursor / Claude</strong><span>エラー状態を明確に分ける変更に合意</span></div></div><div className={styles.resultRow}><span className={styles.resultWarn}>!</span><div><strong>確認が必要</strong><span>実際のブラウザで文言と導線を最終確認</span></div></div></section></div>
      <div className={styles.bottomAction}><div><strong>次にできること</strong><span>{prCreated ? "PRを作成しました。GitHubで内容を確認できます。" : "承認 → コミット → push → PR作成の順に進みます。"}</span></div><div className={styles.buttonGroup}><button className={styles.secondaryButton} type="button" onClick={onRun}>実行状況に戻る</button><button className={styles.secondaryButton} type="button" onClick={() => setApproved(true)} disabled={approved}>{approved ? "承認済み" : "レビューを承認"}</button><button className={styles.secondaryButton} type="button" onClick={() => setCommitted(true)} disabled={!approved || committed}>{committed ? "コミット済み" : "コミットを作成"}</button><button className={styles.secondaryButton} type="button" onClick={() => setPushed(true)} disabled={!committed || pushed}>{pushed ? "push済み" : "pushを実行"}</button><button className={styles.primaryButton} type="button" onClick={() => setPrCreated(true)} disabled={!pushed || prCreated}>{prCreated ? "PR作成済み" : "PRを作成"} <span>→</span></button></div></div>
    </div>
  );
}
