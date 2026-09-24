import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { createAgentSessionFromServices, createAgentSessionServices, getAgentDir, initTheme, SessionManager, SettingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai/utils/transcript";
import { KeybindingsManager as TuiKeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { randomUUID } from "crypto";
import { existsSync, realpathSync, writeFileSync } from "fs";
import { resolve } from "path";
import { validateAgentImages } from "./image-attachments";
import { invalidateModelsCache } from "./models-cache";
import { resolveVisibleModels, selectInitialModelScope } from "./model-scope";
import {
  createProjectCommandBashExtension,
  createProjectCommandBashOperations,
  preferUserBashExtension,
} from "./project-command-env";
import { createTodoExtension } from "./todo-extension";
import { createSubagentExtension, preferPiWebSubagentExtension } from "./subagent-extension";
import { listSubagentProfiles, readSubagentRun, readSubagentSessionResources, SUBAGENT_CONTROL_TOOL_NAMES } from "./subagents";
import { createSubagentController } from "./subagent-runtime";
import { isBuiltInSubagentsEnabled } from "./subagent-settings";
import { resolveShellTools } from "./powershell-settings";
import { CHAT_ONLY_RESOURCE_LOADER_OPTIONS } from "./chat-only";
import { cacheSessionPath, invalidateSessionListCache, resolveSessionPath } from "./session-reader";
import { indexSessionFileNow } from "./session-index-scanner";
import { createSessionActivityTracker, type AgentLikeMessage } from "./session-activity";
import { FIRST_MESSAGE_PREVIEW_LENGTH } from "./session-scanner";
import { projectIdentityKey } from "./project-identity";
import { resolveProject } from "./worktree";
import {
  ensureSessionMetaRow,
  fillFirstMessageIfEmpty,
  recordSessionOutcome,
  setSessionTitle,
  taskForSession,
  touchSessionActivity,
} from "./task-store";
import { reconcileForkBoard } from "./board-reconcile";
import { getProjectTrustStatus, projectTrustReloadOptions } from "./project-trust";
import { persistExplicitStartupPreferences } from "./startup-preferences";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { AgentSessionLike, ExtensionUiContextLike, ToolInfo } from "./pi-types";
import type { RunningPhase, RunningSessionState } from "./board-types";
import type {
  ExtensionUiRequest,
  ExtensionUiResponse,
  ExtensionWidgetItem,
  SessionEntry,
  SessionInfo,
  SessionMessageEntry,
} from "./types";
import { createHeadlessCustomUiTui, DEFAULT_CUSTOM_UI_COLUMNS, type HeadlessCustomUiTui } from "./custom-ui-terminal";

// ============================================================================
// Types
// ============================================================================

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

type EventListener = (event: AgentEvent) => void;

type PendingUiResponse = {
  resolve: (response: ExtensionUiResponse) => void;
  cancel: () => void;
};

type CustomUiComponent = {
  render: (width: number) => string[];
  handleInput?: (data: string) => void;
  dispose?: () => void;
  invalidate?: () => void;
};

type ExtensionWidgetComponent = {
  render: (width: number) => unknown;
  dispose?: () => void;
};

type ExtensionWidgetFactory = (tui: HeadlessCustomUiTui, theme: Theme) => unknown;

type ActiveExtensionWidget = {
  key: string;
  component: ExtensionWidgetComponent;
  placement: "aboveEditor" | "belowEditor";
  generation: number;
  clearEmitted: boolean;
  rendered: boolean;
};

type ActiveCustomUi = {
  component: CustomUiComponent;
  width: number;
  resolve: (value: unknown) => void;
  settled: boolean;
};

type ExtensionUiRequestBody = Record<string, unknown> & {
  method: ExtensionUiRequest["method"];
  timeout?: number;
  expiresAt?: number;
};

type ExtensionCommandContextActionsLike = {
  waitForIdle: () => Promise<void>;
  newSession: () => Promise<{ cancelled: boolean }>;
  fork: () => Promise<{ cancelled: boolean }>;
  navigateTree: (targetId: string, options?: { summarize?: boolean }) => Promise<{ cancelled: boolean }>;
  switchSession: () => Promise<{ cancelled: boolean }>;
  reload: () => Promise<void>;
};

type ExtensionBindingOptions = {
  forceEmptySystemPrompt?: boolean;
};

type AgentSessionWrapperOptions = {
  exactSystemPrompt?: () => string;
  chatOnly?: boolean;
};

const IDLE_RESET_EVENT_TYPES = new Set([
  "agent_end",
  "agent_settled",
  "auto_compaction_end",
  "compaction_end",
]);

const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Resolves the PI_WEB_IDLE_TIMEOUT_MS environment variable into a session idle
 * timeout in milliseconds. An unset/blank value returns the 10-minute default,
 * `0` disables idle shutdown, and positive values up to Node's timer limit
 * (2147483647 ms) are used as-is. Invalid or out-of-range values fall back to
 * the default with a console warning.
 */
export function resolveSessionIdleTimeoutMs(
  rawValue: string | undefined = process.env.PI_WEB_IDLE_TIMEOUT_MS,
): number {
  if (rawValue !== undefined && rawValue.trim() !== "") {
    const parsed = Number(rawValue);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 2_147_483_647) return parsed;
    console.warn(`[pi-web] invalid PI_WEB_IDLE_TIMEOUT_MS "${rawValue}", falling back to 10 minutes`);
  }
  return DEFAULT_SESSION_IDLE_TIMEOUT_MS;
}

const SESSION_IDLE_TIMEOUT_MS = resolveSessionIdleTimeoutMs();

export interface RpcSessionStartOptions {
  toolNames?: string[];
  initialModel?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
}

const CODING_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"];

// Extensions require a complete Theme, while the web UI applies its own styling.
const PLAIN_THEME_FG: ConstructorParameters<typeof Theme>[0] = {
  accent: "", border: "", borderAccent: "", borderMuted: "", success: "", error: "",
  warning: "", muted: "", dim: "", text: "", thinkingText: "", scrollbarTrack: "",
  scrollbarThumb: "", searchMatchText: "", userMessageText: "", customMessageText: "",
  customMessageLabel: "", toolTitle: "", toolOutput: "", mdHeading: "", mdLink: "",
  mdLinkUrl: "", mdCode: "", mdCodeBlock: "", mdCodeBlockBorder: "", mdQuote: "",
  mdQuoteBorder: "", mdHr: "", mdListBullet: "", toolDiffAdded: "", toolDiffRemoved: "",
  toolDiffContext: "", syntaxComment: "", syntaxKeyword: "", syntaxFunction: "",
  syntaxVariable: "", syntaxString: "", syntaxNumber: "", syntaxType: "",
  syntaxOperator: "", syntaxPunctuation: "", thinkingOff: "", thinkingMinimal: "",
  thinkingLow: "", thinkingMedium: "", thinkingHigh: "", thinkingXhigh: "",
  thinkingMax: "", bashMode: "",
};
const PLAIN_THEME_BG: ConstructorParameters<typeof Theme>[1] = {
  selectedBg: "", searchMatchBg: "", userMessageBg: "", customMessageBg: "",
  toolPendingBg: "", toolSuccessBg: "", toolErrorBg: "",
};
class PlainTextTheme extends Theme {
  constructor() {
    super(PLAIN_THEME_FG, PLAIN_THEME_BG, "truecolor");
  }

  override fg(...[, text]: Parameters<Theme["fg"]>): string { return text; }
  override bg(...[, text]: Parameters<Theme["bg"]>): string { return text; }
  override bold(text: string): string { return text; }
  override italic(text: string): string { return text; }
  override underline(text: string): string { return text; }
  override inverse(text: string): string { return text; }
  override strikethrough(text: string): string { return text; }
  override getFgAnsi(): string { return ""; }
  override getBgAnsi(): string { return ""; }
  override getThinkingBorderColor(): (text: string) => string {
    return (text) => text;
  }
  override getBashModeBorderColor(): (text: string) => string { return (text) => text; }
}

const PLAIN_TEXT_THEME = new PlainTextTheme();
const CUSTOM_UI_KEYBINDINGS = new TuiKeybindingsManager(TUI_KEYBINDINGS);

function withExtensionTools(session: AgentSessionLike, toolNames: string[]): string[] {
  if (toolNames.length === 0) return [];

  const codingToolNames = new Set(CODING_TOOL_NAMES);
  const extensionToolNames = session
    .getAllTools()
    .map((t) => t.name)
    .filter((name) => !codingToolNames.has(name));

  return [...new Set([...toolNames, ...extensionToolNames])];
}

// ============================================================================
// AgentSessionWrapper
// Wraps AgentSession with the same interface the rest of the app expects
// ============================================================================

export class AgentSessionWrapper {
  private listeners: EventListener[] = [];
  private pendingUiResponses = new Map<string, PendingUiResponse>();
  private pendingUiRequests = new Map<string, AgentEvent>();
  private activeCustomUis = new Map<string, ActiveCustomUi>();
  private extensionStatuses = new Map<string, string>();
  private extensionWidgets = new Map<string, ExtensionWidgetItem>();
  private activeExtensionWidgets = new Map<string, ActiveExtensionWidget>();
  private extensionWidgetGenerations = new Map<string, number>();
  private extensionWidgetsResetting = false;
  private pendingPromptCount = 0;
  private promptAdmissionTail: Promise<void> = Promise.resolve();
  private extensionsBound = false;
  private extensionBindingPromise: Promise<void> | null = null;
  private extensionBindingError: unknown = null;
  private forceEmptySystemPrompt = false;
  private unsubscribe: (() => void) | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private onDestroyCallback: (() => void) | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private _alive = true;
  /** 最近一次 agent_start 的时间（看板“运行时长”用）；0 = 未知 */
  private lastAgentStart = 0;
  /** 会话活跃事件 → 落库（last_reply / modified）；按 wrapper 实例持有防并发串台 */
  private readonly activityTracker = createSessionActivityTracker();
  private readonly exactSystemPrompt?: () => string;
  private readonly chatOnly: boolean;

  constructor(public readonly inner: AgentSessionLike, options: AgentSessionWrapperOptions = {}) {
    this.exactSystemPrompt = options.exactSystemPrompt;
    this.chatOnly = options.chatOnly ?? false;
    this.installForcedPromptProjection();
  }

  /** 是否有等待用户响应的扩展 UI 请求（waiting_input 判定用） */
  hasPendingUiRequest(): boolean {
    return this.pendingUiRequests.size > 0;
  }

  /** 最近一次 agent 运行开始时间（ms epoch），无则 0 */
  lastAgentStartAt(): number {
    return this.lastAgentStart;
  }

  get sessionId(): string {
    return this.inner.sessionId;
  }

  get sessionFile(): string {
    return this.inner.sessionFile ?? "";
  }

  get cwd(): string {
    return this.inner.sessionManager.getCwd();
  }

  get streamingMessage() {
    return this.inner.agent.state?.streamingMessage;
  }

  get isStreaming(): boolean {
    return this.inner.isStreaming;
  }

  isAlive(): boolean {
    return this._alive;
  }

  isChatOnly(): boolean {
    return this.chatOnly;
  }

  isRunning(): boolean {
    return this._alive && (this.pendingPromptCount > 0 || this.inner.isStreaming || this.inner.isCompacting || this.inner.isBashRunning);
  }

  start(): void {
    this.unsubscribe = this.inner.subscribe((event: AgentEvent) => {
      if (event.type === "agent_start") {
        this.lastAgentStart = Date.now();
      }
      if (event.type === "agent_end") {
        invalidateSessionListCache();
      }
      if (IDLE_RESET_EVENT_TYPES.has(event.type)) this.resetIdleTimer();
      // 会话活跃落库（last_reply / modified）。包在 try/catch 里：库是旁路索引，
      // 写失败必须可见（console.error），但绝不能打断上面几件事与事件分发。
      try {
        this.persistSessionActivity(event);
      } catch (error) {
        console.error(
          `[pi-web] 会话活跃写库失败（${event.type}）:`,
          error instanceof Error ? error.message : String(error),
        );
      }
      this.emit(event);
    });
    this.resetIdleTimer();
  }

  /**
   * 事件 → session_meta 写入（只 UPDATE；行由创建/扫描链路建立）：
   *   · agent_start   → modified 前移（运行中会话浮顶）
   *   · message_end   → 本轮最后一条 assistant 文本（缓存，不落库）
   *   · agent_settled → last_reply + modified（一轮循环真正结束；用户取消走同一路径）
   * 用 agent_settled 而非 agent_end：后者一轮里可能多次（重试/compaction/queue 续跑）。
   */
  private persistSessionActivity(event: AgentEvent): void {
    const effect = this.activityTracker.handle(event as { type: string; message?: AgentLikeMessage });
    if (!effect) return;
    const sessionId = this.inner.sessionId;
    if (!sessionId) return;
    if (effect.kind === "touch") {
      touchSessionActivity(sessionId);
      return;
    }
    recordSessionOutcome(sessionId, effect);
    // 首条用户消息此刻已在内存 entries 里（不读文件，读取路径零扫盘）。
    // 正常链路上它更早就写好了（prompt 一被接受就写，见 send 的 prompt 分支）；
    // 这里兑底扩展/外部注入的首条用户消息（那一轮的起点不是 RPC prompt）。
    fillFirstMessageIfEmpty(sessionId, firstUserMessageOf(this.inner.sessionManager.getEntries()));
  }

  setForceEmptySystemPrompt(force: boolean): void {
    this.forceEmptySystemPrompt = force;
    this.ensureForcedPromptProjection();
  }

  beginExtensionBinding(options: ExtensionBindingOptions = {}): void {
    void this.ensureExtensionsBound(options).catch((err) => {
      console.error("[pi-web] failed to dispatch session_start to extensions:", err instanceof Error ? err.message : err);
    });
  }

  async waitUntilReady(): Promise<void> {
    await this.waitForExtensionsBound();
  }

  /**
   * 0.86.0 中 AgentState.systemPrompt 是 getter-only（由 transcript 推导），
   * prepareNextTurn 返回的 context.systemPrompt 已被忽略。官方精确替换 prompt 的
   * 机制是 forceSystemPrompt → transformContext 投影（见 SDK 的
   * _installAgentForcedPromptProjection）。这里用同一机制实现：
   *  - exactSystemPrompt 存在 → 每轮请求的 system prompt 精确等于它；
   *  - forceEmptySystemPrompt → 每轮请求的 system prompt 为空。
   * 两者都不满足时透传，不影响普通会话。
   */
  private forcedPromptProjectionInstalled = false;

  private installForcedPromptProjection(): void {
    if (this.forcedPromptProjectionInstalled) return;
    const agent = this.inner.agent;
    if (!agent) return;
    this.forcedPromptProjectionInstalled = true;
    const previousTransformContext = agent.transformContext;
    agent.transformContext = async (messages, signal) => {
      const transformed = previousTransformContext
        ? await previousTransformContext(messages, signal)
        : messages;
      const forced = this.forceEmptySystemPrompt ? "" : this.exactSystemPrompt?.();
      if (forced === undefined) return transformed;
      const current = getCurrentSystemMessage(transformed as never);
      const head = {
        role: "system" as const,
        content: forced,
        ...(current?.toolsAdded ? { toolsAdded: current.toolsAdded } : {}),
        timestamp: current?.timestamp ?? Date.now(),
      };
      return [head, ...transformed.filter((message) => message.role !== "system")];
    };
  }

  private ensureForcedPromptProjection(): void {
    this.installForcedPromptProjection();
  }

  private ensureExtensionsBound(options: ExtensionBindingOptions = {}): Promise<void> {
    if (options.forceEmptySystemPrompt) this.forceEmptySystemPrompt = true;
    if (this.extensionsBound) {
      this.ensureForcedPromptProjection();
      return Promise.resolve();
    }
    if (this.extensionBindingPromise) return this.extensionBindingPromise;

    this.extensionBindingError = null;
    this.extensionBindingPromise = (async () => {
      if (!this._alive) return;
      const uiContext = this.createExtensionUiContext();
      if (typeof this.inner.bindExtensions === "function") {
        const bindExtensions = this.inner.bindExtensions as (bindings: {
          uiContext?: ExtensionUiContextLike;
          mode?: "rpc";
          commandContextActions?: ExtensionCommandContextActionsLike;
          shutdownHandler?: () => void;
          onError?: (error: { extensionPath: string; event: string; error: string }) => void;
        }) => Promise<void>;
        await bindExtensions.call(this.inner, {
          uiContext,
          mode: "rpc",
          commandContextActions: this.createExtensionCommandContextActions(),
          shutdownHandler: () => this.emit({
            type: "extension_ui_request",
            id: randomUUID(),
            method: "notify",
            notifyType: "warning",
            message: "Extension requested shutdown, but shutdown is not supported in Pi Web.",
          } as ExtensionUiRequest as AgentEvent),
          onError: (error) => this.emit({
            type: "extension_error",
            extensionPath: error.extensionPath,
            event: error.event,
            error: error.error,
          }),
        });
      } else {
        this.inner.extensionRunner.setUIContext?.(uiContext, "rpc");
      }
      this.extensionsBound = true;
      this.ensureForcedPromptProjection();
      console.log(`[pi-web] session_start dispatched to extensions for session ${this.inner.sessionId}`);
    })().catch((err) => {
      this.extensionBindingError = err;
      throw err;
    });

    return this.extensionBindingPromise;
  }

  private async waitForExtensionsBound(): Promise<void> {
    try {
      if (this.extensionBindingPromise) await this.extensionBindingPromise;
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (this.extensionBindingError) {
      throw this.extensionBindingError instanceof Error
        ? this.extensionBindingError
        : new Error(String(this.extensionBindingError));
    }
  }

  private shouldWaitForExtensions(type: string): boolean {
    return type === "prompt"
      || type === "steer"
      || type === "follow_up"
      || type === "get_commands"
      || type === "get_state";
  }

  private async withFinalRunningNotification<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } finally {
      this.resetIdleTimer();
    }
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error(
          `[pi-web] failed to deliver ${event.type} event:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  private async acquirePromptAdmission(): Promise<() => void> {
    const previous = this.promptAdmissionTail;
    let release!: () => void;
    this.promptAdmissionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }

  private resetIdleTimer(): void {
    // A resolved timeout of 0 disables idle shutdown entirely.
    if (SESSION_IDLE_TIMEOUT_MS === 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.isRunning()) {
        this.resetIdleTimer();
        return;
      }
      void this.shutdown().catch((error) => {
        console.error("[pi-web] failed to shut down idle session:", error instanceof Error ? error.message : error);
      });
    }, SESSION_IDLE_TIMEOUT_MS);
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.push(listener);
    for (const event of this.pendingUiRequests.values()) listener(event);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) this.listeners.splice(i, 1);
    };
  }

  onDestroy(cb: () => void): void {
    this.onDestroyCallback = cb;
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    this.resetIdleTimer();
    const type = command.type as string;
    if (this.shouldWaitForExtensions(type)) await this.waitForExtensionsBound();

    if (type === "prompt" || type === "steer" || type === "follow_up") {
      const imageError = validateAgentImages(command.images);
      if (imageError) throw new Error(imageError);
    }

    switch (type) {
      case "prompt": {
        // Serialize only admission. Once the preceding prompt has either
        // passed or failed preflight, the SDK can atomically decide whether
        // this submission starts a run or joins its streaming queue.
        const releaseAdmission = await this.acquirePromptAdmission();
        try {
          if (this.inner.isBashRunning) {
            throw new Error("Cannot send a prompt while a shell command is running");
          }
          const promptImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
          const streamingBehavior = command.streamingBehavior as "steer" | "followUp" | undefined;
          let preflightAccepted = false;
          let preflightSettled = false;
          let promptSettled = false;
          let acceptPreflight!: () => void;
          let rejectPreflight!: (error: unknown) => void;
          const preflight = new Promise<void>((resolve, reject) => {
            acceptPreflight = () => {
              preflightAccepted = true;
              if (preflightSettled) return;
              preflightSettled = true;
              resolve();
            };
            rejectPreflight = (error) => {
              if (preflightSettled) return;
              preflightSettled = true;
              reject(error);
            };
          });
          const finishPrompt = () => {
            if (promptSettled) return;
            promptSettled = true;
            this.pendingPromptCount = Math.max(0, this.pendingPromptCount - 1);
            this.resetIdleTimer();
          };

          this.pendingPromptCount += 1;
          let prompt: Promise<void>;
          try {
            prompt = this.inner.prompt(command.message as string, {
              ...(promptImages?.length ? { images: promptImages } : {}),
              ...(streamingBehavior ? { streamingBehavior } : {}),
              source: "rpc",
              // Match pi's RPC contract: acknowledge only after synchronous prompt
              // validation and extension preflight have accepted the submission.
              preflightResult: (success) => {
                if (success) acceptPreflight();
              },
            });
          } catch (error) {
            finishPrompt();
            throw error;
          }

          void prompt.then(() => {
            // Compatibility fallback if a future SDK resolves without invoking
            // the internal callback. This waits for the run, but never acks early.
            acceptPreflight();
            finishPrompt();
            if (!streamingBehavior) this.emit({ type: "prompt_done" });
          }, (error) => {
            rejectPreflight(error);
            finishPrompt();
            invalidateSessionListCache();
            // A preflight rejection is returned by the POST itself. Only an
            // unexpected failure after acceptance needs the asynchronous event.
            if (preflightAccepted) {
              this.emit({
                type: "prompt_error",
                errorMessage: error instanceof Error ? error.message : String(error),
              });
              if (!streamingBehavior) this.emit({ type: "prompt_done" });
            }
          }).catch((error) => {
            console.error(
              "[pi-web] prompt completion handler failed:",
              error instanceof Error ? error.message : error,
            );
          });

          await preflight;
          // 首条用户消息：prompt 一被接受就落库，**不等整轮跑完**。标题/列表的默认
          // 展示就是「用户发送的第一句话」（title || first_message），只在 agent_settled
          // 写的话，长首轮（几分钟~几十分钟）期间刷新页面/换客户端/看板卡上标题一直空着
          // （-> "(no messages)"）。也不能指望 agent_start：实测那一刻用户消息还没进
          // 内存 entries（拿不到文本）。
          // 只在「transcript 里还没有用户消息」时写（= 这才是真首条）：已有历史的会话
          // （CLI 建的、first_message 还空着）走 agent_settled/扫描器按真实首条回填，
          // prompt 路径写「这一条最新消息」会被 fill-empty 钉死成永久错值。
          const promptText = typeof command.message === "string" ? command.message.trim() : "";
          const sessionId = this.inner.sessionId;
          if (promptText && sessionId && !firstUserMessageOf(this.inner.sessionManager.getEntries())) {
            try {
              fillFirstMessageIfEmpty(sessionId, promptText.slice(0, FIRST_MESSAGE_PREVIEW_LENGTH));
            } catch (error) {
              // 库写失败绝不能冒泡：send() 抛出会让路由把「已经接受的 prompt」报成
              // prompt_rejected（客户端回填草稿、诱导重发，而 agent 其实在跑）。
              // 这条写只是旁路索引，失败记账即可（同 persistSessionActivity 口径）。
              console.error(
                `[pi-web] 首条消息写库失败 session=${sessionId}:`,
                error instanceof Error ? error.message : String(error),
              );
            }
          }
          return null;
        } finally {
          releaseAdmission();
        }
      }

      case "abort":
        await this.withFinalRunningNotification(() => this.inner.abort());
        return null;

      case "get_state": {
        const model = this.inner.model;
        const contextUsage = this.inner.getContextUsage();
        return {
          sessionId: this.inner.sessionId,
          sessionFile: this.inner.sessionFile ?? "",
          isStreaming: this.inner.isStreaming,
          isPromptRunning: this.pendingPromptCount > 0,
          isBashRunning: this.inner.isBashRunning,
          isCompacting: this.inner.isCompacting,
          autoCompactionEnabled: this.inner.autoCompactionEnabled,
          autoRetryEnabled: this.inner.autoRetryEnabled,
          model: model ? { id: model.id, provider: model.provider } : undefined,
          messageCount: 0,
          pendingMessageCount: this.inner.pendingMessageCount,
          queuedMessages: {
            steering: [...this.inner.getSteeringMessages()],
            followUp: [...this.inner.getFollowUpMessages()],
          },
          contextUsage: contextUsage
            ? { percent: contextUsage.percent, contextWindow: contextUsage.contextWindow, tokens: contextUsage.tokens }
            : null,
          systemPrompt: this.inner.agent.state?.systemPrompt ?? "",
          thinkingLevel: this.inner.agent.state?.thinkingLevel ?? "off",
          extensionStatuses: this.getExtensionStatuses(),
          extensionWidgets: this.getExtensionWidgets(),
        };
      }

      case "set_model": {
        const { provider, modelId } = command as { provider: string; modelId: string };
        let model = this.inner.modelRuntime.getModel(provider, modelId);
        if (!model) {
          await this.inner.modelRuntime.refresh({ allowNetwork: false });
          model = this.inner.modelRuntime.getModel(provider, modelId);
        }
        if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
        await this.inner.setModel(model);
        invalidateModelsCache();
        invalidateSessionListCache();
        return { id: model.id, provider: model.provider };
      }

      case "fork_branch": {
        if (this.isRunning()) {
          throw new Error("Cannot fork while the session is running");
        }
        const entryId = command.entryId as string;
        const sessionManager = this.inner.sessionManager;
        const currentSessionFile = this.inner.sessionFile;
        if (!sessionManager.isPersisted()) return { cancelled: true };
        if (!currentSessionFile) throw new Error("Persisted session is missing a session file");
        if (!sessionManager.getEntry(entryId)) throw new Error("Invalid entry ID for forking");

        const sessionDir = sessionManager.getSessionDir();
        const sourceManager = SessionManager.open(currentSessionFile, sessionDir);
        const forkedPath = sourceManager.createBranchedSession(entryId);
        if (!forkedPath) throw new Error("Failed to create forked session");
        // SDK 惰性落盘契约：fork 点之前无 assistant 消息时不写文件（flushed=false），
        // 只返回路径字符串。不强制落盘则后续 open 不存在文件会 newSession 生成新 id，
        // 索引/列表/看板全部读不到——必须和 fork case 一样手动写盘。
        if (!existsSync(forkedPath)) {
          const content = [sourceManager.getHeader(), ...sourceManager.getEntries()]
            .map((entry) => JSON.stringify(entry))
            .join("\n") + "\n";
          writeFileSync(forkedPath, content, { encoding: "utf8", flag: "wx" });
          (sourceManager as unknown as { flushed: boolean }).flushed = true;
        }

        const newSessionId = SessionManager.open(forkedPath, sessionDir).getSessionId();
        cacheSessionPath(newSessionId, forkedPath);
        invalidateSessionListCache();
        // 立即进 session_meta 索引（否则要等 30s 后台扫描才出现在会话列表）；
        // 归属继承：引用分支与源会话同任务（否则只会在聊天区当孤儿根出现）。
        const sourceSessionId = sessionManager.getSessionId();
        await indexSessionFileNow(forkedPath, sourceSessionId, taskForSession(sourceSessionId));
        return { cancelled: false, newSessionId };
      }

      case "fork": {
        if (this.inner.isBashRunning) {
          throw new Error("Cannot fork while a shell command is running");
        }
        // fork 前先取源会话 id：SDK fork 会原地改 inner.sessionId（见 AGENTS.md 铁律）
        const sourceSessionId = this.inner.sessionId;
        const entryId = command.entryId as string;
        const sessionManager = this.inner.sessionManager;
        const currentSessionFile = this.inner.sessionFile;

        if (!sessionManager.isPersisted()) return { cancelled: true };
        if (!currentSessionFile) throw new Error("Persisted session is missing a session file");

        const entry = sessionManager.getEntry(entryId);
        if (!entry) throw new Error("Invalid entry ID for forking");

        const sessionDir = sessionManager.getSessionDir();
        let newSessionFile: string;

        if (!entry.parentId) {
          // Fork before the first message: create an empty session linked to this one.
          // SessionManager.create + newSession only reserve the in-memory path — the
          // file is materialized lazily on the first assistant message. pi keeps the
          // in-memory manager alive for this, but pi-web reads sessions from disk, so
          // persist the empty header now or the returned session resolves nowhere.
          const newManager = SessionManager.create(sessionManager.getCwd(), sessionDir);
          newManager.newSession({ parentSession: currentSessionFile });
          if (newManager.getSessionFile()) {
            (newManager as unknown as { _rewriteFile(): void })._rewriteFile();
          }
          newSessionFile = newManager.getSessionFile() as string;
        } else {
          // Fork after some history: copy path up to (but not including) the fork point
          const sourceManager = SessionManager.open(currentSessionFile, sessionDir);
          const forkedPath = sourceManager.createBranchedSession(entry.parentId);
          if (!forkedPath) throw new Error("Failed to create forked session");
          newSessionFile = forkedPath;
          // SDK 惰性落盘契约：fork 点之前无 assistant 消息时不写文件（flushed=false），
          // 只返回路径字符串。若不强制落盘，后续 open 不存在文件会 newSession 生成新 id，
          // meta 行指向不存在的文件——列表/看板卡片读不到，30s 扫描器删行 → “会话不存在”。
          if (!existsSync(newSessionFile)) {
            const content = [sourceManager.getHeader(), ...sourceManager.getEntries()]
              .map((entry) => JSON.stringify(entry))
              .join("\n") + "\n";
            writeFileSync(newSessionFile, content, { encoding: "utf8", flag: "wx" });
            (sourceManager as unknown as { flushed: boolean }).flushed = true;
          }
        }

        const newSessionId = SessionManager.open(newSessionFile, sessionDir).getSessionId();
        cacheSessionPath(newSessionId, newSessionFile);
        invalidateSessionListCache();
        // fork 即建全列索引行（与 persistNewSessionFile 对齐）：文件已落盘，
        // 行建好后刷新/切走不依赖扫描器补行（否则 fork 新会话最多 30s 不在列表）。
        // parent_id 传源会话 id（列语义统一为会话 id，与扫描器反查结果一致）。
        // 建行在 shutdown 之后：fork 后 inner 状态已变（铁律要求立即销毁 wrapper），
        // resolveProject 的 await 不能发生在 registry 还挂着已 fork wrapper 的窗口里；
        // 建行只用局部变量（cwd/newSessionFile/sourceSessionId），不依赖 wrapper。
        const cwd = sessionManager.getCwd();
        const sourceTaskId = taskForSession(sourceSessionId); // 归属继承：fork 子会话与父同任务
        await this.shutdown();
        try {
          const project = await resolveProject(cwd ?? "");
          ensureSessionMetaRow(newSessionId, {
            path: newSessionFile,
            cwd: cwd ?? "",
            projectKey: projectIdentityKey(project?.projectRoot ?? cwd ?? ""),
            parentId: sourceSessionId,
            taskId: sourceTaskId, // 建行即带归属，否则子会话先以临时会话落在聊天区（V1）
          });
        } catch (error) {
          // 不阻塞 fork（文件已经在了，pi 侧已成功），但必须可见：静默失败会让子会话
          // 以「无归属临时会话」出现在聊天区（也是本次要修的 V1 病灶）；扫描器的归属
          // 收敛是第二道网，不能当成唯一防线。
          console.error(
            `[pi-web] fork 建行失败 session=${newSessionId}:`,
            error instanceof Error ? error.message : String(error),
          );
        }
        try {
          // fork 卡即时入板：源会话归属任务 → 精准 reconcile 该任务看板。
          // await 保证卡先落 yjs 再返回（前端响应到达时卡已存在，无并发写窗口）；
          // 失败不阻塞 fork，10s 定时兜底。单独一个 try：与建行失败分开报错，避免
          // 入板失败被误报成「建行失败」。
          await reconcileForkBoard(sourceSessionId);
        } catch (error) {
          console.error(
            `[pi-web] fork 入板失败 source=${sourceSessionId}:`,
            error instanceof Error ? error.message : String(error),
          );
        }
        return { cancelled: false, newSessionId };
      }

      case "navigate_tree": {
        if (this.inner.isBashRunning) {
          throw new Error("Cannot navigate while a shell command is running");
        }
        const result = await this.inner.navigateTree(command.targetId as string, {});
        return { cancelled: result.cancelled };
      }

      case "set_thinking_level": {
        const level = command.level as string;
        this.inner.setThinkingLevel(level);
        // setThinkingLevel clamps xhigh→high for models where supportsXhigh()===false.
        // If the model has DeepSeek thinking compat (reasoningEffortMap maps xhigh→max),
        // force the state back so the compat layer can use it correctly.
        if (level === "xhigh" && (this.inner.model as { compat?: { thinkingFormat?: string } } | null)?.compat?.thinkingFormat === "deepseek" && this.inner.agent?.state) {
          this.inner.agent.state.thinkingLevel = "xhigh";
        }
        invalidateSessionListCache();
        return null;
      }

      case "compact": {
        try {
          return await this.withFinalRunningNotification(() =>
            this.inner.compact(command.customInstructions as string | undefined)
          );
        } finally {
          invalidateSessionListCache();
        }
      }

      case "set_session_name": {
        const name = (command.name as string | undefined)?.trim();
        if (!name) throw new Error("Session name cannot be empty");
        this.inner.setSessionName(name);
        // 列表索引同步：pi 侧改名成功即写 session_meta.title（前端侧栏/看板卡
        // 改名走这条 RPC，不落库则刷新后退回旧标题）。失败处理与路由层同源但
        // 语义有别：这里只记日志、不抛——RPC 已经改了文件名，抛错对调用方没有
        // 可恢复动作，还会断掉命令响应/事件流。
        try {
          await setSessionTitle(this.inner.sessionId, name);
        } catch (error) {
          console.error("[pi-web] 会话标题写库失败:", error);
        }
        invalidateSessionListCache();
        return null;
      }

      case "get_session_stats": {
        return {
          ...this.inner.getSessionStats(),
          sessionName: this.inner.sessionManager.getSessionName(),
        };
      }

      case "get_last_assistant_text": {
        return { text: this.inner.getLastAssistantText() ?? "" };
      }

      case "set_auto_compaction": {
        this.inner.setAutoCompactionEnabled(command.enabled as boolean);
        return null;
      }

      case "clear_queue": {
        // Full clear only: pi has no single-item dequeue, and clear+requeue
        // races against the agent loop pulling messages mid-flight.
        return this.inner.clearQueue();
      }

      case "steer": {
        const steerImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        await this.inner.steer(command.message as string, steerImages?.length ? steerImages : undefined);
        return null;
      }

      case "follow_up": {
        const followImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        await this.inner.followUp(command.message as string, followImages?.length ? followImages : undefined);
        return null;
      }

      case "get_tools": {
        const all: ToolInfo[] = this.inner.getAllTools();
        const active = new Set<string>(this.inner.getActiveToolNames());
        // 对齐上游：展开整个 ToolInfo（含 parameters / promptGuidelines），
        // 之前只挑 name/description/active 会把参数 schema 丢掉 → 面板参数全是“无”。
        return all.map((t) => ({
          ...t,
          active: active.has(t.name),
        }));
      }

      case "get_commands": {
        const commands: SlashCommandInfo[] = [];
        for (const registered of this.inner.extensionRunner.getRegisteredCommands()) {
          commands.push({
            name: registered.invocationName,
            description: registered.description,
            source: "extension",
            sourceInfo: registered.sourceInfo,
          });
        }
        for (const template of this.inner.promptTemplates) {
          commands.push({
            name: template.name,
            description: template.description,
            source: "prompt",
            sourceInfo: template.sourceInfo,
          });
        }
        for (const skill of this.inner.resourceLoader.getSkills().skills) {
          commands.push({
            name: `skill:${skill.name}`,
            description: skill.description,
            source: "skill",
            sourceInfo: skill.sourceInfo,
          });
        }
        return { commands };
      }

      case "set_tools": {
        const toolNames = command.toolNames as string[];
        if (readSubagentSessionResources(this.inner.sessionManager.getEntries() as unknown as SessionEntry[])) {
          throw new Error("Subagent tool selection is fixed by its profile");
        }
        this.setForceEmptySystemPrompt(toolNames.length === 0);
        this.inner.setActiveToolsByName(withExtensionTools(this.inner, toolNames));
        return null;
      }

      case "reload": {
        await this.waitForExtensionsBound();
        this.extensionStatuses.clear();
        this.resetExtensionWidgetsForReload();
        this.syncProjectTrust();
        await this.inner.reload();
        if (typeof this.inner.bindExtensions !== "function") {
          this.inner.extensionRunner.setUIContext?.(this.createExtensionUiContext(), "rpc");
        }
        invalidateModelsCache();
        return { success: true };
      }

      case "abort_compaction": {
        this.inner.abortCompaction();
        return null;
      }

      case "extension_ui_response": {
        this.resolveExtensionUiResponse(command as ExtensionUiResponse);
        return null;
      }

      case "extension_ui_input": {
        this.handleExtensionUiInput(command.id as string, command.data as string);
        return null;
      }

      case "set_auto_retry": {
        this.inner.setAutoRetryEnabled(command.enabled as boolean);
        return null;
      }

      case "bash": {
        if (this.pendingPromptCount > 0 || this.inner.isStreaming || this.inner.isCompacting || this.inner.isBashRunning) {
          throw new Error("Cannot run a shell command while the session is busy");
        }
        const execution = this.inner.executeBash(
          command.command as string,
          undefined,
          {
            excludeFromContext: command.excludeFromContext as boolean | undefined,
            operations: createProjectCommandBashOperations({
              shellPath: this.inner.settingsManager.getShellPath(),
            }),
          },
        );
        try {
          const result = await execution;
          return result;
        } finally {
          this.resetIdleTimer();
          invalidateSessionListCache();
        }
      }

      case "abort_bash": {
        this.inner.abortBash();
        return null;
      }

      default:
        throw new Error(`Unsupported command: ${type}`);
    }
  }

  destroy(): void {
    if (!this._alive) return;
    this._alive = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.inner.isBashRunning) this.inner.abortBash();
    this.unsubscribe?.();
    for (const pending of this.pendingUiResponses.values()) pending.cancel();
    for (const id of Array.from(this.activeCustomUis.keys())) this.closeCustomUi(id, undefined);
    this.pendingUiResponses.clear();
    this.pendingUiRequests.clear();
    this.clearExtensionWidgets(false);
    try {
      this.inner.dispose();
    } finally {
      this.onDestroyCallback?.();
    }
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (!this._alive) return;

    this.shutdownPromise = (async () => {
      try {
        try {
          await this.waitForExtensionsBound();
        } catch (error) {
          console.error(
            "[pi-web] extension binding failed before session shutdown:",
            error instanceof Error ? error.message : error,
          );
        }
        await this.inner.extensionRunner.emit?.({ type: "session_shutdown", reason: "quit" });
      } finally {
        this.destroy();
      }
    })();
    return this.shutdownPromise;
  }

  private resolveExtensionUiResponse(response: ExtensionUiResponse): void {
    const pending = this.pendingUiResponses.get(response.id);
    if (!pending) return;
    pending.resolve(response);
  }

  private getExtensionStatuses(): Array<{ key: string; text: string }> {
    return Array.from(this.extensionStatuses, ([key, text]) => ({ key, text }));
  }

  private getExtensionWidgets(): ExtensionWidgetItem[] {
    return Array.from(this.extensionWidgets.values());
  }

  private nextExtensionWidgetGeneration(key: string): number {
    const generation = (this.extensionWidgetGenerations.get(key) ?? 0) + 1;
    this.extensionWidgetGenerations.set(key, generation);
    return generation;
  }

  private disposeExtensionWidgetComponent(component: unknown): void {
    if (!component || (typeof component !== "object" && typeof component !== "function")) return;
    const dispose = (component as { dispose?: unknown }).dispose;
    if (typeof dispose !== "function") return;
    try {
      dispose.call(component);
    } catch {
      // Ignore dispose errors from extension widgets.
    }
  }

  private emitExtensionWidgetClear(key: string): void {
    this.emit({
      type: "extension_ui_request",
      id: randomUUID(),
      method: "setWidget",
      widgetKey: key,
      widgetLines: undefined,
      widgetPlacement: undefined,
    } as ExtensionUiRequest as AgentEvent);
  }

  private clearExtensionWidget(key: string, emitClear = true): number {
    const generation = this.nextExtensionWidgetGeneration(key);

    const active = this.activeExtensionWidgets.get(key);
    this.activeExtensionWidgets.delete(key);
    this.extensionWidgets.delete(key);
    if (active) this.disposeExtensionWidgetComponent(active.component);
    if (this.extensionWidgetGenerations.get(key) !== generation) return generation;
    if (emitClear) this.emitExtensionWidgetClear(key);
    return generation;
  }

  private clearExtensionWidgets(emitClear: boolean): void {
    const keys = new Set([
      ...this.extensionWidgets.keys(),
      ...this.activeExtensionWidgets.keys(),
    ]);
    for (const key of keys) this.clearExtensionWidget(key, emitClear);
  }

  private resetExtensionWidgetsForReload(): void {
    this.extensionWidgetsResetting = true;
    try {
      const factoryKeys = [...this.activeExtensionWidgets.keys()];
      for (const key of factoryKeys) this.clearExtensionWidget(key);
      // Keep the existing array-widget reload behavior: snapshots are reset and
      // the next extension session_start repopulates them.
      this.extensionWidgets.clear();
    } finally {
      this.extensionWidgetsResetting = false;
    }
  }

  private emitExtensionWidgetError(key: string, error: unknown): void {
    this.emit({
      type: "extension_error",
      extensionPath: `extension-widget:${key}`,
      event: "setWidget",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private failExtensionWidget(
    key: string,
    generation: number,
    error: unknown,
    clearEmitted: boolean,
    component?: unknown,
  ): void {
    if (this.extensionWidgetGenerations.get(key) !== generation) {
      this.disposeExtensionWidgetComponent(component);
      return;
    }

    const active = this.activeExtensionWidgets.get(key);
    let shouldEmitClear = !clearEmitted;
    if (active?.generation === generation) {
      shouldEmitClear = active.rendered || !active.clearEmitted;
      this.activeExtensionWidgets.delete(key);
      this.disposeExtensionWidgetComponent(active.component);
    } else {
      this.disposeExtensionWidgetComponent(component);
    }
    if (this.extensionWidgetGenerations.get(key) !== generation) {
      this.emitExtensionWidgetError(key, error);
      return;
    }
    this.extensionWidgets.delete(key);
    if (shouldEmitClear) this.emitExtensionWidgetClear(key);
    this.emitExtensionWidgetError(key, error);
  }

  private renderExtensionWidget(active: ActiveExtensionWidget): void {
    if (
      this.activeExtensionWidgets.get(active.key) !== active
      || this.extensionWidgetGenerations.get(active.key) !== active.generation
    ) return;

    let lines: unknown;
    try {
      lines = active.component.render(DEFAULT_CUSTOM_UI_COLUMNS);
    } catch (error) {
      this.failExtensionWidget(active.key, active.generation, error, active.clearEmitted);
      return;
    }
    if (!Array.isArray(lines) || !lines.every((line) => typeof line === "string")) {
      this.failExtensionWidget(
        active.key,
        active.generation,
        new Error("Extension widget render must return string[]"),
        active.clearEmitted,
      );
      return;
    }
    if (
      this.activeExtensionWidgets.get(active.key) !== active
      || this.extensionWidgetGenerations.get(active.key) !== active.generation
    ) return;

    const widgetLines = lines as string[];
    this.extensionWidgets.set(active.key, {
      key: active.key,
      lines: widgetLines,
      placement: active.placement,
    });
    active.rendered = true;
    this.emit({
      type: "extension_ui_request",
      id: randomUUID(),
      method: "setWidget",
      widgetKey: active.key,
      widgetLines,
      widgetPlacement: active.placement,
    } as ExtensionUiRequest as AgentEvent);
  }

  private setExtensionWidgetFactory(
    key: string,
    factory: ExtensionWidgetFactory,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void {
    const hadPrevious = this.extensionWidgets.has(key) || this.activeExtensionWidgets.has(key);
    const generation = this.clearExtensionWidget(key, hadPrevious);
    if (this.extensionWidgetGenerations.get(key) !== generation) return;
    const tui = createHeadlessCustomUiTui(() => {
      const active = this.activeExtensionWidgets.get(key);
      if (active?.generation === generation) this.renderExtensionWidget(active);
    }, DEFAULT_CUSTOM_UI_COLUMNS);

    let component: unknown;
    try {
      component = factory(tui, PLAIN_TEXT_THEME);
    } catch (error) {
      this.failExtensionWidget(key, generation, error, hadPrevious);
      return;
    }
    if (this.extensionWidgetGenerations.get(key) !== generation) {
      this.disposeExtensionWidgetComponent(component);
      return;
    }
    if (
      !component
      || (typeof component !== "object" && typeof component !== "function")
      || typeof (component as { render?: unknown }).render !== "function"
    ) {
      this.failExtensionWidget(
        key,
        generation,
        new Error("Extension widget factory must return a component with render(width)"),
        hadPrevious,
        component,
      );
      return;
    }

    const active: ActiveExtensionWidget = {
      key,
      component: component as ExtensionWidgetComponent,
      placement: options?.placement ?? "aboveEditor",
      generation,
      clearEmitted: hadPrevious,
      rendered: false,
    };
    this.activeExtensionWidgets.set(key, active);
    this.renderExtensionWidget(active);
  }

  private getCustomUiWidth(options: unknown): number {
    if (!options || typeof options !== "object") return DEFAULT_CUSTOM_UI_COLUMNS;
    const overlayOptions = (options as { overlayOptions?: unknown }).overlayOptions;
    const resolved = typeof overlayOptions === "function" ? overlayOptions() : overlayOptions;
    if (!resolved || typeof resolved !== "object") return DEFAULT_CUSTOM_UI_COLUMNS;
    const width = (resolved as { width?: unknown }).width;
    return typeof width === "number" && Number.isFinite(width)
      ? Math.max(40, Math.min(140, Math.round(width)))
      : 92;
  }

  private emitCustomUiRender(id: string, custom: ActiveCustomUi): void {
    let lines: string[];
    try {
      lines = custom.component.render(custom.width);
    } catch (error) {
      lines = [`Extension custom UI render failed: ${error instanceof Error ? error.message : String(error)}`];
    }
    const event = {
      type: "extension_ui_request",
      id,
      method: "custom",
      lines,
    } as ExtensionUiRequest as AgentEvent;
    this.pendingUiRequests.set(id, event);
    this.emit(event);
  }

  private closeCustomUi(id: string, value: unknown): void {
    const custom = this.activeCustomUis.get(id);
    if (!custom || custom.settled) return;
    custom.settled = true;
    this.activeCustomUis.delete(id);
    this.pendingUiRequests.delete(id);
    try {
      custom.component.dispose?.();
    } catch {
      // Ignore dispose errors from extension UI components.
    }
    this.emit({
      type: "extension_ui_request",
      id,
      method: "custom",
      lines: [],
      closed: true,
    } as ExtensionUiRequest as AgentEvent);
    custom.resolve(value);
  }

  private handleExtensionUiInput(id: string, data: string): void {
    const custom = this.activeCustomUis.get(id);
    if (!custom || typeof data !== "string") return;
    try {
      custom.component.handleInput?.(data);
      if (this.activeCustomUis.has(id)) this.emitCustomUiRender(id, custom);
    } catch (error) {
      this.closeCustomUi(id, undefined);
      this.emit({
        type: "extension_error",
        extensionPath: `custom-ui:${id}`,
        event: "custom_ui_input",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private requestExtensionCustomUi<T>(
    factory: unknown,
    options?: unknown,
  ): Promise<T> {
    if (typeof factory !== "function") return Promise.resolve(undefined as T);

    const id = randomUUID();
    const width = this.getCustomUiWidth(options);

    return new Promise<T>((resolve) => {
      let completed = false;
      const tui = createHeadlessCustomUiTui(
        () => {
          const custom = this.activeCustomUis.get(id);
          if (custom) this.emitCustomUiRender(id, custom);
        },
        width,
      );
      const finish = (value: T) => {
        if (completed) return;
        completed = true;
        resolve(value);
      };
      const done = (value: T) => {
        if (this.activeCustomUis.has(id)) {
          this.closeCustomUi(id, value);
        } else {
          finish(value);
        }
      };

      Promise.resolve()
        .then(() => factory(tui, PLAIN_TEXT_THEME, CUSTOM_UI_KEYBINDINGS, done))
        .then((component) => {
          if (completed) {
            try {
              (component as CustomUiComponent | undefined)?.dispose?.();
            } catch {
              // Ignore dispose errors from a component completed before mounting.
            }
            return;
          }
          if (!component || typeof component !== "object" || typeof (component as CustomUiComponent).render !== "function") {
            finish(undefined as T);
            return;
          }
          const custom: ActiveCustomUi = {
            component: component as CustomUiComponent,
            width,
            resolve: (value) => finish(value as T),
            settled: false,
          };
          this.activeCustomUis.set(id, custom);
          this.emitCustomUiRender(id, custom);
        })
        .catch((error) => {
          if (completed) return;
          this.emit({
            type: "extension_error",
            extensionPath: `custom-ui:${id}`,
            event: "custom_ui",
            error: error instanceof Error ? error.message : String(error),
          });
          finish(undefined as T);
        });
    });
  }

  private requestExtensionUi<T>(
    request: ExtensionUiRequestBody,
    defaultValue: T,
    parseResponse: (response: ExtensionUiResponse) => T,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.resolve(defaultValue);

    const id = randomUUID();
    const fullRequest = {
      type: "extension_ui_request",
      id,
      ...request,
      ...(timeout ? { timeout, expiresAt: Date.now() + timeout } : {}),
    };

    return new Promise((resolve) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onAbort);
        this.pendingUiRequests.delete(id);
        this.pendingUiResponses.delete(id);
      };
      const settle = (value: T) => {
        cleanup();
        resolve(value);
      };
      const onAbort = () => settle(defaultValue);

      if (timeout) timeoutId = setTimeout(() => settle(defaultValue), timeout);
      signal?.addEventListener("abort", onAbort, { once: true });

      this.pendingUiRequests.set(id, fullRequest as AgentEvent);
      this.pendingUiResponses.set(id, {
        resolve: (response) => settle(parseResponse(response)),
        cancel: () => settle(defaultValue),
      });
      this.emit(fullRequest as AgentEvent);
    });
  }

  private createExtensionUiContext(): ExtensionUiContextLike {
    return {
      select: (title, options, opts) => this.requestExtensionUi(
        { method: "select", title, options, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      confirm: (title, message, opts) => this.requestExtensionUi(
        { method: "confirm", title, message, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        false,
        (response) => "confirmed" in response ? response.confirmed : false,
        opts?.timeout,
        opts?.signal,
      ),
      input: (title, placeholder, opts) => this.requestExtensionUi(
        { method: "input", title, ...(placeholder !== undefined ? { placeholder } : {}), ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      editor: (title, prefill, opts) => this.requestExtensionUi(
        { method: "editor", title, ...(prefill !== undefined ? { prefill } : {}), ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      notify: (message, type) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "notify",
          message,
          notifyType: type,
        } as ExtensionUiRequest as AgentEvent);
      },
      onTerminalInput: () => () => {},
      setStatus: (key, text) => {
        if (text === undefined) this.extensionStatuses.delete(key);
        else this.extensionStatuses.set(key, text);
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setStatus",
          statusKey: key,
          statusText: text,
        } as ExtensionUiRequest as AgentEvent);
      },
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: (key, content, options) => {
        if (!this._alive || this.extensionWidgetsResetting) return;
        if (typeof content === "function") {
          this.setExtensionWidgetFactory(
            key,
            content as unknown as ExtensionWidgetFactory,
            options,
          );
          return;
        }
        if (content !== undefined && !Array.isArray(content)) return;
        if (content === undefined) {
          this.clearExtensionWidget(key);
          return;
        }
        const generation = this.activeExtensionWidgets.has(key)
          ? this.clearExtensionWidget(key)
          : this.nextExtensionWidgetGeneration(key);
        if (this.extensionWidgetGenerations.get(key) !== generation) return;
        this.extensionWidgets.set(key, {
          key,
          lines: content,
          placement: options?.placement ?? "aboveEditor",
        });
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setWidget",
          widgetKey: key,
          widgetLines: content,
          widgetPlacement: options?.placement,
        } as ExtensionUiRequest as AgentEvent);
      },
      setFooter: () => {},
      setHeader: () => {},
      setTitle: (title) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setTitle",
          title,
        } as ExtensionUiRequest as AgentEvent);
      },
      custom: <T = unknown>(factory: unknown, options?: unknown) => this.requestExtensionCustomUi<T>(factory, options),
      pasteToEditor: (text) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "set_editor_text",
          text,
        } as ExtensionUiRequest as AgentEvent);
      },
      setEditorText: (text) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "set_editor_text",
          text,
        } as ExtensionUiRequest as AgentEvent);
      },
      getEditorText: () => "",
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      get theme() { return PLAIN_TEXT_THEME; },
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "Theme switching is not supported in Pi Web extension UI yet" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    };
  }

  private createExtensionCommandContextActions(): ExtensionCommandContextActionsLike {
    return {
      waitForIdle: async () => {
        const agent = this.inner.agent as { waitForIdle?: () => Promise<void> };
        await agent.waitForIdle?.();
      },
      newSession: async () => ({ cancelled: true }),
      fork: async () => ({ cancelled: true }),
      navigateTree: async (targetId, options) => {
        const result = await this.inner.navigateTree(targetId, { summarize: options?.summarize });
        return { cancelled: result.cancelled };
      },
      switchSession: async () => ({ cancelled: true }),
      reload: async () => {
        this.extensionStatuses.clear();
        this.resetExtensionWidgetsForReload();
        this.syncProjectTrust();
        await this.inner.reload({
          beforeSessionStart: () => {
            this.inner.extensionRunner.setUIContext?.(this.createExtensionUiContext(), "rpc");
          },
        });
      },
    };
  }

  private syncProjectTrust(): void {
    const status = getProjectTrustStatus(this.cwd, getAgentDir());
    this.inner.settingsManager.setProjectTrusted(status.trusted);
  }
}

// ============================================================================
// Session registry
// ============================================================================

declare global {
  var __piSessions: Map<string, AgentSessionWrapper> | undefined;
  var __piStartLocks: Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> | undefined;
  var __piStartingSessionCwds: Map<string, number> | undefined;
}

function getRegistry(): Map<string, AgentSessionWrapper> {
  if (!globalThis.__piSessions) {
    globalThis.__piSessions = new Map();
    const cleanup = () => globalThis.__piSessions?.forEach((s) => s.destroy());
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__piSessions;
}

function getLocks(): Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> {
  if (!globalThis.__piStartLocks) globalThis.__piStartLocks = new Map();
  return globalThis.__piStartLocks;
}

function normalizeRpcCwd(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  try {
    return realpathSync(resolvedCwd);
  } catch {
    return resolvedCwd;
  }
}

function getStartingSessionCwds(): Map<string, number> {
  if (!globalThis.__piStartingSessionCwds) globalThis.__piStartingSessionCwds = new Map();
  return globalThis.__piStartingSessionCwds;
}

function trackStartingSession(cwd: string): () => void {
  const startingCwds = getStartingSessionCwds();
  const key = normalizeRpcCwd(cwd);
  startingCwds.set(key, (startingCwds.get(key) ?? 0) + 1);
  return () => {
    const remaining = (startingCwds.get(key) ?? 1) - 1;
    if (remaining > 0) startingCwds.set(key, remaining);
    else startingCwds.delete(key);
  };
}

/**
 * 新建会话创建即落盘：写空 header 文件并标记 flushed。
 * pi 默认延迟到第一条 assistant 消息才 flush（避免生成空会话文件），但
 * pi-web 的会话 ID 由创建方指定（任务/看板绑定在创建时就写库），若文件不
 * 落盘，刷新后 /api/sessions 读不到该会话，绑定就会“丢失”。
 * 调用后 manager 的后续 append 走 appendFileSync（见 SDK _persist）。
 */
async function persistNewSessionFile(manager: SessionManager, sessionId: string): Promise<void> {
  const sessionFile = manager.getSessionFile();
  if (!sessionFile || existsSync(sessionFile)) return;
  const header = manager.getHeader();
  if (!header) return;
  const content = [header, ...manager.getEntries()]
    .map((entry) => JSON.stringify(entry))
    .join("\n") + "\n";
  writeFileSync(sessionFile, content, { encoding: "utf8", flag: "wx" });
  (manager as unknown as { flushed: boolean }).flushed = true;
  cacheSessionPath(sessionId, sessionFile);

  // 落盘即建全列索引行：会话从出生就是完整索引（先于会话真正运行）。
  // project_key 需 resolveProject（可能 git 调用），在落盘后异步补齐；
  // 行已落库，期间列表读取由 runtime union 覆盖，不退化扫盘。
  // first_message 此刻恒空（刚创建无消息），由扫描器下一轮补。
  // parent_id 不在此传：新建会话无父（header.parentSession 恒空），
  // 有父的场景（fork）由 fork 分支显式传源会话 id——列语义统一为会话 id。
  const cwd = manager.getCwd();
  try {
    const project = await resolveProject(cwd ?? "");
    ensureSessionMetaRow(sessionId, {
      path: sessionFile,
      cwd: cwd ?? "",
      // 与扫描器同源归一化（Windows 大小写折叠等），防新建会话 project_key 与列表查询键不一致
      projectKey: projectIdentityKey(project?.projectRoot ?? cwd ?? ""),
    });
  } catch (error) {
    // 建行失败不阻塞开会话（文件已落盘，运行时列表由 runtime union 覆盖），但必须可见：
    // 静默会让该会话最多 30s 不在列表/任务区（扫描器会补行，但不能当成唯一防线）。
    console.error(
      `[pi-web] 新会话建行失败 session=${sessionId}:`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function getRpcSession(sessionId: string): AgentSessionWrapper | undefined {
  return getRegistry().get(sessionId);
}

function runtimeMessageText(entry: SessionMessageEntry): string {
  if (entry.message.role === "bashExecution") return "";
  const content = entry.message.content;
  if (typeof content === "string") return content;
  return content
    .map((block) => block.type === "text" ? block.text : "")
    .filter(Boolean)
    .join(" ");
}

/**
 * 内存 entries 里首条用户消息的简述（截断与扫描器同一上限）。
 * 会话活跃事件落库时用它回填 first_message——读取路径不再读文件。
 */
function firstUserMessageOf(entries: unknown[]): string {
  for (const entry of entries as SessionMessageEntry[]) {
    if (entry?.type !== "message" || entry.message?.role !== "user") continue;
    const text = runtimeMessageText(entry).trim();
    if (text) return text.slice(0, FIRST_MESSAGE_PREVIEW_LENGTH);
  }
  return "";
}

function runtimeMessageActivityMs(entry: SessionMessageEntry): number | undefined {
  if (entry.message.role !== "user" && entry.message.role !== "assistant") return undefined;
  if (typeof entry.message.timestamp === "number") return entry.message.timestamp;
  const timestamp = new Date(entry.timestamp).getTime();
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

/**
 * Return live sessions that should be visible in the session list. Pi delays
 * the first JSONL flush until an assistant message exists, so an accepted new
 * prompt must temporarily be described from its in-memory SessionManager.
 */
export function getRpcSessionInfos(): SessionInfo[] {
  const sessions: SessionInfo[] = [];
  for (const session of getRegistry().values()) {
    if (!session.isAlive()) continue;

    const manager = session.inner.sessionManager;
    const header = manager.getHeader();
    const entries = manager.getEntries() as unknown as Array<
      { type: string; timestamp: string } | SessionMessageEntry
    >;
    const messages = entries.filter((entry): entry is SessionMessageEntry => entry.type === "message");
    const firstUserMessage = messages.find((entry) => entry.message.role === "user");
    const sessionFile = manager.getSessionFile() ?? session.sessionFile;
    const persisted = Boolean(sessionFile && existsSync(sessionFile));

    // An ensure_session call creates an idle, empty runtime while the composer
    // loads commands. Do not leak it into history before a prompt is accepted.
    if (!persisted && (!session.isRunning() || !firstUserMessage)) continue;

    const subagent = readSubagentRun(entries as unknown as SessionEntry[], header?.id ?? session.sessionId, sessionFile ?? "");

    const created = header?.timestamp
      ?? entries[0]?.timestamp
      ?? new Date().toISOString();
    const headerTimestamp = new Date(created).getTime();
    let lastActivityMs = Number.isNaN(headerTimestamp) ? Date.now() : headerTimestamp;
    for (const message of messages) {
      const activityMs = runtimeMessageActivityMs(message);
      if (activityMs !== undefined) lastActivityMs = Math.max(lastActivityMs, activityMs);
    }

    sessions.push({
      path: sessionFile ?? "",
      id: header?.id ?? session.sessionId,
      cwd: header?.cwd ?? session.cwd,
      name: manager.getSessionName(),
      created,
      modified: new Date(lastActivityMs).toISOString(),
      messageCount: messages.length,
      firstMessage: firstUserMessage ? runtimeMessageText(firstUserMessage) || "(no messages)" : "(no messages)",
      ...(subagent ? {
        parentSessionId: subagent.parentSessionId,
        relation: {
          kind: "subagent" as const,
          parentSessionId: subagent.parentSessionId,
          profile: subagent.profile,
          description: subagent.description,
          status: session.isRunning() ? "running" as const : subagent.status,
        },
      } : {}),
      transient: !persisted,
    });
  }
  return sessions;
}

export function hasBusyRpcSessionForCwd(cwd: string): boolean {
  const targetCwd = normalizeRpcCwd(cwd);
  if (getStartingSessionCwds().has(targetCwd)) return true;
  return Array.from(getRegistry().values()).some(
    (session) => normalizeRpcCwd(session.cwd) === targetCwd && session.isRunning(),
  );
}

export async function destroyRpcSessionsForCwd(cwd: string): Promise<number> {
  const targetCwd = normalizeRpcCwd(cwd);
  const sessions = Array.from(getRegistry().values()).filter(
    (session) => normalizeRpcCwd(session.cwd) === targetCwd,
  );
  await Promise.all(sessions.map((session) => session.shutdown()));
  return sessions.length;
}

export function getRunningRpcSessionIds(): string[] {
  const ids = new Set<string>();
  for (const [sessionId, session] of getRegistry()) {
    if (session.isRunning()) ids.add(session.sessionId || sessionId);
  }
  return [...ids];
}

/**
 * 运行中会话的细分状态快照（看板状态系统用）。
 * 状态判定优先级（与 pi 既有语义对齐）：
 * 1. 等待模型：isStreaming 且无待执行工具调用（thinking / 生成中）
 * 2. 执行工具：pendingToolCalls 非空（running_tools）
 * 3. 执行命令：isBashRunning（running_command）
 * 4. 等待输入：扩展 UI 请求（select/confirm/input/editor）挂起（waiting_input）
 * startedAt 用最近一次 agent_start 事件时间（wrapper 内订阅缓存），未知为 0。
 */
export function getRunningSessionStates(): Record<string, RunningSessionState> {
  const states: Record<string, RunningSessionState> = {};
  for (const [sessionId, session] of getRegistry()) {
    const id = session.sessionId || sessionId;
    if (!session.isRunning()) continue;
    const inner = session.inner;
    const state = inner.agent.state as { pendingToolCalls?: ReadonlySet<string> } | undefined;
    const pendingToolCalls = state?.pendingToolCalls;
    let phase: RunningPhase;
    if (inner.isStreaming && pendingToolCalls && pendingToolCalls.size > 0) {
      phase = "running_tools";
    } else if (inner.isBashRunning) {
      phase = "running_command";
    } else if (inner.isStreaming) {
      phase = "waiting_model";
    } else if (session.hasPendingUiRequest()) {
      phase = "waiting_input";
    } else {
      phase = "waiting_model";
    }
    states[id] = {
      phase,
      model: inner.model ? `${inner.model.provider}/${inner.model.id}` : null,
      startedAt: session.lastAgentStartAt(),
    };
  }
  return states;
}

/**
 * Get or create an AgentSession for the given session.
 * For new sessions (sessionFile === ""), pi generates its own id.
 * New sessions resolve enabledModels before construction so the initial model,
 * thinking pin, and SDK scopedModels share one settings snapshot.
 * Pass options.toolNames to pre-configure active tools (empty = all disabled).
 */
export async function startRpcSession(
  sessionId: string,
  sessionFile: string,
  cwd: string | undefined,
  options: RpcSessionStartOptions = {},
): Promise<{ session: AgentSessionWrapper; realSessionId: string }> {
  const { toolNames, initialModel, thinkingLevel } = options;
  const registry = getRegistry();
  const locks = getLocks();

  const existing = registry.get(sessionId);
  if (existing?.isAlive()) return { session: existing, realSessionId: sessionId };

  const inflight = locks.get(sessionId);
  if (inflight) return inflight;

  let sessionManager: SessionManager;
  if (sessionFile) {
    sessionManager = SessionManager.open(sessionFile, undefined);
  } else {
    if (!cwd) throw new Error("cwd is required for a new session");
    // 指定会话 ID：合法的 sessionId 参数即最终会话 ID（SDK 原生支持 NewSessionOptions.id）。
    // 新建会话的 ID 在发起时即可知，任务/看板绑定不再依赖等待 realSessionId 返回。
    // 内部占位 key（如 route.ts 的 `__new__<uuid>`，双下划线前缀）不算指定 ID——
    // 它们只作并发锁 key，真实 ID 仍由 pi 生成（向后兼容无 id 的调用方）。
    const isExplicitId = sessionId.length > 0 && !sessionId.startsWith("__");
    sessionManager = SessionManager.create(cwd, undefined, isExplicitId ? { id: sessionId } : undefined);
    // 创建即落盘：会话文件从出生就在磁盘，刷新后绑定不丢（见 persistNewSessionFile）。
    if (isExplicitId) await persistNewSessionFile(sessionManager, sessionId);
  }
  const sessionCwd = sessionManager.getCwd();
  const finishStartingSession = trackStartingSession(sessionCwd);
  const starting = (async () => {
    // subagent 会话（含恢复）按 profile 的资源/工具加载选项重建；普通会话不命中。
    const subagentResources = sessionFile
      ? readSubagentSessionResources(sessionManager.getEntries() as unknown as SessionEntry[])
      : null;
    const subagentLoadsResources = Boolean(subagentResources?.loadExtensions || subagentResources?.loadSkills);
    // chatOnly 仅当“显式空工具列表”时为真：subagent 会话按 profile 的 tools 判定，
    // 普通会话按调用方传入的 toolNames（undefined = 默认全量，[] = 全关）。
    const chatOnly = subagentResources
      ? subagentResources.tools.length === 0 && !subagentLoadsResources
      : toolNames?.length === 0;

    // Some extensions access the SDK's global theme even outside the terminal UI.
    if (!chatOnly) initTheme();
    const agentDir = getAgentDir();

    // Determine which tools to pass based on requested toolNames.
    // Since v0.68.0, session creation expects string[] tool names instead of Tool[] instances.
    let toolsOption: string[] | undefined = subagentResources?.tools;
    if (!subagentResources && toolNames !== undefined) {
      // toolNames === [] -> "all off" (an empty allow-list disables every tool).
      // Otherwise DO NOT pass a builtin-only allow-list: passing CODING_TOOL_NAMES
      // set allowedToolNames to coding builtins only, which filtered every
      // extension/package-provided tool (e.g. subagents, web access) out of the
      // tool registry — so they were unavailable in Pi Web sessions even though the
      // `pi` CLI keeps them. Leaving the allow-list unset lets the SDK register all
      // tools (and activate extension tools); we narrow the ACTIVE set below.
      toolsOption = toolNames.length === 0 ? [] : undefined;
    }

    // Build services first so extension-registered providers are available
    // before the SDK restores the saved model from the session file.
    // Gate untrusted project extensions so opening a repository does not run
    // its .pi/extensions code automatically (see lib/project-trust.ts, #236).
    const trustReloadOptions = projectTrustReloadOptions(sessionCwd, agentDir);
    const settingsManager = SettingsManager.create(sessionCwd, agentDir);
    const services = await createAgentSessionServices({
      cwd: sessionCwd,
      agentDir,
      settingsManager,
      resourceLoaderOptions: subagentResources
        ? {
            noExtensions: !subagentResources.loadExtensions,
            noSkills: !subagentResources.loadSkills,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            systemPrompt: " ",
            appendSystemPrompt: subagentResources.appendSystemPrompt,
          }
        : chatOnly
          ? CHAT_ONLY_RESOURCE_LOADER_OPTIONS
          : {
              extensionFactories: [
                createProjectCommandBashExtension({
                  cwd: sessionCwd,
                  settings: settingsManager,
                }),
                // 内建会话 TODO（工具 + pi-todo.state 快照），装 pi-web-sky 即自带，
                // 无需用户安装任何 pi 包。工具重名时用户扩展优先（见 pi-todo 文档）。
                createTodoExtension(),
                // 内置 subagent（Agent/steer_subagent/get_subagent_result 工具），
                // 开关见 agents 设置（isBuiltInSubagentsEnabled）。
                createSubagentExtension(
                  SUBAGENT_CONTROLLER.extensionRuntime,
                  () => listSubagentProfiles(sessionCwd),
                  isBuiltInSubagentsEnabled,
                ),
              ],
              extensionsOverride: (base) => preferUserBashExtension(preferPiWebSubagentExtension(base)),
            },
      ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
    });
    const scope = await resolveVisibleModels(
      services.modelRuntime,
      services.settingsManager.getEnabledModels(),
    );
    const defaultProvider = services.settingsManager.getDefaultProvider();
    const defaultModelId = services.settingsManager.getDefaultModel();
    const hasExistingMessages = sessionManager.getBranch().some((entry) => entry.type === "message");
    const initial = hasExistingMessages
      ? { scopedModels: [...scope.scopedModels] }
      : selectInitialModelScope(scope, {
        ...(initialModel ? { requestedModel: initialModel } : {}),
        ...(defaultProvider && defaultModelId
          ? { defaultModel: { provider: defaultProvider, modelId: defaultModelId } }
          : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
      });
    const { session: inner } = await createAgentSessionFromServices({
      services,
      sessionManager,
      ...(initial.model ? { model: initial.model } : {}),
      ...(initial.thinkingLevel ? { thinkingLevel: initial.thinkingLevel } : {}),
      ...(initial.scopedModels.length > 0 ? { scopedModels: initial.scopedModels } : {}),
      ...(toolsOption !== undefined ? { tools: toolsOption } : {}),
    });

    const persistedPreferences = await persistExplicitStartupPreferences(
      services.settingsManager,
      {
        ...(initialModel ? { model: initialModel } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
      },
      {
        ...(inner.model
          ? { model: { provider: inner.model.provider, modelId: inner.model.id } }
          : {}),
        thinkingLevel: inner.thinkingLevel,
        supportsThinking: inner.supportsThinking(),
      },
    );
    if (persistedPreferences.modelDefaultChanged) invalidateModelsCache();

    // If specific tool names were requested (non-empty), set the active tools to the
    // requested builtin coding tools PLUS all extension/package tools, so installed
    // extensions stay usable in Pi Web just like in the `pi` CLI.
    if (toolNames && toolNames.length > 0) {
      inner.setActiveToolsByName(withExtensionTools(inner, toolNames));
    }

    const wrapper = new AgentSessionWrapper(inner);
    // When all tools are disabled, clear the system prompt entirely.
    // pi's buildSystemPrompt always produces a non-empty prompt even with no tools;
    // keep this forced after extension resource discovery and reloads as well.
    if (toolNames?.length === 0) {
      wrapper.setForceEmptySystemPrompt(true);
    }
    wrapper.start();

    const realSessionId = inner.sessionId as string;
    const realSessionFile = inner.sessionFile as string | undefined;
    if (realSessionFile) cacheSessionPath(realSessionId, realSessionFile);

    wrapper.onDestroy(() => registry.delete(realSessionId));
    registry.set(realSessionId, wrapper);
    if (!chatOnly) wrapper.beginExtensionBinding({ forceEmptySystemPrompt: toolNames?.length === 0 });

    return { session: wrapper, realSessionId };
  })().finally(() => {
    locks.delete(sessionId);
    finishStartingSession();
  });

  locks.set(sessionId, starting);
  return starting;
}

const SUBAGENT_CONTROLLER = createSubagentController({
  getSession: (sessionId) => getRegistry().get(sessionId),
  registerSession: (inner, options) => {
    const wrapper = new AgentSessionWrapper(inner, {
      ...(options?.exactSystemPrompt !== undefined
        ? { exactSystemPrompt: () => options.exactSystemPrompt! }
        : {}),
      chatOnly: options?.chatOnly,
    });
    const realSessionId = inner.sessionId as string;
    const realSessionFile = inner.sessionFile as string | undefined;
    if (realSessionFile) cacheSessionPath(realSessionId, realSessionFile);
    wrapper.onDestroy(() => getRegistry().delete(realSessionId));
    getRegistry().set(realSessionId, wrapper);
    wrapper.start();
    if (!wrapper.isChatOnly()) wrapper.beginExtensionBinding();
  },
  reopenSession: async (sessionId, sessionFile) =>
    (await startRpcSession(sessionId, sessionFile, undefined)).session,
  resolveSessionPath,
  invalidateSessionList: invalidateSessionListCache,
  isBuiltInSubagentsEnabled,
});

export function getSubagentRun(sessionId: string) {
  return SUBAGENT_CONTROLLER.get(sessionId);
}

export function steerSubagent(sessionId: string, message: string) {
  return SUBAGENT_CONTROLLER.steer(sessionId, message);
}

export function abortSubagent(sessionId: string) {
  return SUBAGENT_CONTROLLER.abort(sessionId);
}
