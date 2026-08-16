import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WholeThreadCloudAnalysisResultV3 } from "../lib/cloud";
import type { ReviewSession } from "../lib/session";
import type { CapturedReply, ReviewRecord } from "../types";
import {
  sha256Hex,
  type AnalysisKey,
  type SnapshotId,
} from "../lib/threadIdentity";
import {
  createAnalysisHistoryEntry,
  type AnalysisHistoryEntry,
} from "../lib/analysisHistory";
import {
  DEMO_REVIEW_TYPICAL_RESULT,
  DEMO_REVIEW_TYPICAL_SESSION,
} from "./demo";
import { App } from "./App";

const mocks = vi.hoisted(() => ({
  activeSession: null as ReviewSession | null,
  runWholeThread: vi.fn(),
  requestPersistentPermission: vi.fn(),
  claimAnalysisStart: vi.fn(),
  loadCache: vi.fn(),
  loadBillingReceipt: vi.fn(),
  loadSnapshotCache: vi.fn(),
  loadLegacySuccess: vi.fn(),
  migrateLegacyPending: vi.fn(),
  saveCache: vi.fn(),
  clearCache: vi.fn(),
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
  loadApiKey: vi.fn(),
  clearApiKey: vi.fn(),
  loadTheme: vi.fn(),
  saveTheme: vi.fn(),
  loadUsage: vi.fn(),
  recordUsage: vi.fn(),
  loadRecords: vi.fn(),
  saveRecords: vi.fn(),
  loadHistory: vi.fn(),
  saveHistory: vi.fn(),
  deleteHistory: vi.fn(),
  replaceHistory: vi.fn(),
  sendMessage: vi.fn(),
  tabsUpdate: vi.fn(),
  tabsReload: vi.fn(),
  jumpError: null as Error | null,
}));

const DEFAULT_SETTINGS = {
  schemaVersion: 2 as const,
  provider: "alibaba" as const,
  endpoint:
    "https://ws-7ee35od4h2zs6dft.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  model: "qwen3.7-max",
  apiKey: "session-only-key",
  mode: "fast" as const,
  autoReadWholeThread: true,
  autoAnalyzeWholeThread: false,
};

function cacheIdentity(
  session: ReviewSession,
  settings: typeof DEFAULT_SETTINGS = DEFAULT_SETTINGS,
) {
  const snapshotId = sha256Hex(
    `${session.threadId}:${session.updatedAt}:${session.title}`,
  ) as SnapshotId;
  return {
    schemaVersion: 3 as const,
    snapshotId,
    analysisKey: sha256Hex([
      snapshotId,
      settings.provider,
      settings.endpoint,
      settings.model,
      settings.mode,
    ].join("|")) as AnalysisKey,
    analyzerVersion: "3.0.0",
    rulesVersion: "2026.07",
    transportVersion: "sidepanel-v3",
  };
}

vi.mock("./bridge", () => ({
  getActiveTabId: vi.fn(async () => mocks.activeSession?.tabId ?? 17),
  isPersistentCloudPermissionRequired: (value: unknown) => {
    const message = value instanceof Error ? value.message : String(value ?? "");
    return message.includes("权限");
  },
  requestPersistentCloudPermission: mocks.requestPersistentPermission,
  runManagedCloudAnalysis: vi.fn(),
  runManagedWholeThreadCloudAnalysis: mocks.runWholeThread,
  sendExtensionMessage: mocks.sendMessage,
}));

vi.mock("./recordStore", () => ({
  DEFAULT_THEME_MODE: "light",
  loadCloudApiKey: mocks.loadApiKey,
  clearCloudApiKey: mocks.clearApiKey,
  loadStoredRecords: mocks.loadRecords,
  saveStoredRecords: mocks.saveRecords,
  loadAnalysisHistory: mocks.loadHistory,
  saveAnalysisHistoryEntry: mocks.saveHistory,
  deleteAnalysisHistoryEntry: mocks.deleteHistory,
  replaceAnalysisHistory: mocks.replaceHistory,
  loadCloudSettings: mocks.loadSettings,
  saveCloudSettings: mocks.saveSettings,
  loadThemeMode: mocks.loadTheme,
  saveThemeMode: mocks.saveTheme,
  loadMonthlyCloudUsage: mocks.loadUsage,
  recordCloudUsage: mocks.recordUsage,
}));

vi.mock("../lib/threadCloudCache", () => ({
  THREAD_CLOUD_BILLING_RECEIPT_SCHEMA_VERSION: 1,
  THREAD_CLOUD_CACHE_SCHEMA_VERSION: 3,
  THREAD_CLOUD_TRANSPORT_VERSION: "sidepanel-v3",
  claimThreadCloudAnalysisStart: mocks.claimAnalysisStart,
  clearThreadCloudCache: mocks.clearCache,
  loadThreadCloudBillingReceipt: mocks.loadBillingReceipt,
  loadThreadCloudCache: mocks.loadCache,
  loadLatestThreadCloudCacheForSnapshot: mocks.loadSnapshotCache,
  loadLegacyThreadCloudSuccess: mocks.loadLegacySuccess,
  migrateLegacyThreadCloudPendingToUnknown: mocks.migrateLegacyPending,
  saveThreadCloudCache: mocks.saveCache,
  sanitizeThreadCloudResultForCache: (result: WholeThreadCloudAnalysisResultV3) => result,
  threadCloudCacheIdentity: (
    session: ReviewSession,
    settings: typeof DEFAULT_SETTINGS,
  ) => cacheIdentity(session, settings),
}));

interface ActiveTabInfo {
  tabId: number;
  windowId: number;
}

let activatedListeners: Array<(activeInfo: ActiveTabInfo) => void> = [];
let updatedListeners: Array<
  (
    tabId: number,
    changeInfo: { status?: string },
    tab: chrome.tabs.Tab,
  ) => void
> = [];
let runtimeListeners: Array<(message: unknown) => void> = [];
let uuidIndex = 0;

function chromeHarness(): void {
  activatedListeners = [];
  updatedListeners = [];
  runtimeListeners = [];
  uuidIndex = 0;
  vi.stubGlobal("chrome", {
    runtime: {
      id: "extension-test",
      onMessage: {
        addListener(listener: (message: unknown) => void) {
          runtimeListeners.push(listener);
        },
        removeListener(listener: (message: unknown) => void) {
          runtimeListeners = runtimeListeners.filter((item) => item !== listener);
        },
      },
    },
    storage: {
      local: {},
      session: {},
    },
    tabs: {
      update: mocks.tabsUpdate,
      reload: mocks.tabsReload,
      onActivated: {
        addListener(listener: (activeInfo: ActiveTabInfo) => void) {
          activatedListeners.push(listener);
        },
        removeListener(listener: (activeInfo: ActiveTabInfo) => void) {
          activatedListeners = activatedListeners.filter((item) => item !== listener);
        },
      },
      onUpdated: {
        addListener(
          listener: (
            tabId: number,
            changeInfo: { status?: string },
            tab: chrome.tabs.Tab,
          ) => void,
        ) {
          updatedListeners.push(listener);
        },
        removeListener(
          listener: (
            tabId: number,
            changeInfo: { status?: string },
            tab: chrome.tabs.Tab,
          ) => void,
        ) {
          updatedListeners = updatedListeners.filter((item) => item !== listener);
        },
      },
    },
  });
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      callback(performance.now());
      return 1;
    }),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("crypto", {
    randomUUID: vi.fn(() => {
      uuidIndex += 1;
      return `00000000-0000-4000-8000-${String(uuidIndex).padStart(12, "0")}`;
    }),
  });
}

function syntheticSession(
  tabId: number,
  threadId: string,
  title: string,
): ReviewSession {
  const reply: CapturedReply = {
    id: `${threadId}:reply:1`,
    siteReplyId: `${threadId}01`,
    floor: 1,
    parentReplyId: null,
    authorName: `${title}的合成楼主`,
    time: "2026-08-02 10:00",
    timestamp: Date.UTC(2026, 7, 2, 2),
    content: `${title}的纯合成正文`,
    sourcePage: 1,
    sourceUrl: `https://tieba.baidu.com/p/${threadId}`,
    anchor: `[data-pid="${threadId}01"]`,
    imageCount: 0,
    isNested: false,
    unexpandedNestedCount: 0,
  };
  return {
    schemaVersion: "1.0",
    sessionSchemaVersion: 3,
    tabId,
    threadId,
    threadUrl: `https://tieba.baidu.com/p/${threadId}`,
    title,
    pages: {},
    replies: [reply],
    coverage: {
      captureMode: "api",
      visibleReplyCount: 1,
      mainReplyCount: 1,
      nestedReplyCount: 0,
      imageCount: 0,
      unexpandedLzlCount: 0,
      analyzedPageNumbers: [1],
      hasUnanalyzedImages: false,
      declaredReplyCount: 0,
      dynamicContentMayRemain: false,
      reachedReplyListEnd: true,
      unstableReplyIdCount: 0,
      isComplete: true,
      apiCoverage: {
        mainPagesFetched: 1,
        mainPagesTotal: 1,
        mainRepliesFetched: 1,
        nestedParentsFetched: 0,
        nestedParentsTotal: 0,
        nestedRepliesFetched: 0,
        nestedRepliesDeclared: 0,
        failedRequestCount: 0,
        unavailableReplyCount: 0,
        readableTextComplete: true,
      },
    },
    errors: [],
    warnings: [],
    updatedAt: `2026-08-02T02:00:0${tabId}.000Z`,
  };
}

function partialApiSession(input: {
  tabId?: number;
  readableTextComplete?: boolean;
  failedRequestCount?: number;
  mainPagesFetched?: number;
  mainPagesTotal?: number;
  nestedParentsFetched?: number;
  nestedParentsTotal?: number;
  nestedRepliesFetched?: number;
  nestedRepliesDeclared?: number;
  unavailableReplyCount?: number;
  imageCount?: number;
  unexpandedLzlCount?: number;
  errors?: string[];
  warnings?: string[];
} = {}): ReviewSession {
  const base = syntheticSession(
    input.tabId ?? 27,
    "81000000888",
    "读取缺口合成帖",
  );
  const imageCount = input.imageCount ?? 0;
  return {
    ...base,
    coverage: {
      ...base.coverage,
      imageCount,
      unexpandedLzlCount:
        input.unexpandedLzlCount ?? base.coverage.unexpandedLzlCount,
      hasUnanalyzedImages: imageCount > 0,
      dynamicContentMayRemain: true,
      isComplete: false,
      apiCoverage: {
        mainPagesFetched: input.mainPagesFetched ?? 2,
        mainPagesTotal: input.mainPagesTotal ?? 3,
        mainRepliesFetched: 36,
        nestedParentsFetched: input.nestedParentsFetched ?? 1,
        nestedParentsTotal: input.nestedParentsTotal ?? 2,
        nestedRepliesFetched: input.nestedRepliesFetched ?? 3,
        nestedRepliesDeclared: input.nestedRepliesDeclared ?? 5,
        failedRequestCount: input.failedRequestCount ?? 1,
        unavailableReplyCount: input.unavailableReplyCount ?? 2,
        readableTextComplete: input.readableTextComplete ?? false,
      },
    },
    errors: input.errors ?? ["读取主回复第 3/3 页失败：请求超时。"],
    warnings: input.warnings ?? [],
  };
}

function cleanResult(
  session: ReviewSession,
  summary = `${session.title}的合成分析结果`,
): WholeThreadCloudAnalysisResultV3 {
  return {
    protocolVersion: 3,
    summary,
    findings: [],
    report: {
      overview: `${session.title}的合成讨论背景`,
      stages: [],
      interactions: [],
      notes: [],
    },
    uncertainties: [],
    analyzedReplyCount: session.replies.length,
    ruleCount: 112,
    omittedImageCount: 0,
  };
}

function successCache(
  session: ReviewSession,
  result: WholeThreadCloudAnalysisResultV3,
) {
  return {
    ...cacheIdentity(session),
    status: "success" as const,
    attemptId: `attempt:${session.threadId}`,
    startedAt: "2026-08-02T02:00:00.000Z",
    updatedAt: "2026-08-02T02:01:00.000Z",
    sentAt: "2026-08-02T02:00:01.000Z",
    deadlineAt: "2026-08-02T02:03:01.000Z",
    completedAt: "2026-08-02T02:01:00.000Z",
    error: null,
    result,
  };
}

function persistentHistoryEntry(
  session: ReviewSession,
  result: WholeThreadCloudAnalysisResultV3,
  attemptId = `attempt:${session.threadId}`,
): AnalysisHistoryEntry {
  const identity = cacheIdentity(session);
  return createAnalysisHistoryEntry({
    attemptId,
    snapshotId: identity.snapshotId,
    analysisKey: identity.analysisKey,
    threadId: session.threadId,
    threadUrl: session.threadUrl,
    threadTitle: session.title,
    provider: DEFAULT_SETTINGS.provider,
    model: DEFAULT_SETTINGS.model,
    mode: DEFAULT_SETTINGS.mode,
    analyzerVersion: identity.analyzerVersion,
    rulesVersion: identity.rulesVersion,
    transportVersion: identity.transportVersion,
    startedAt: "2026-08-02T02:00:00.000Z",
    completedAt: "2026-08-02T02:01:00.000Z",
    coverage: {
      visibleReplyCount: session.coverage.visibleReplyCount,
      imageCount: session.coverage.imageCount,
      unavailableReplyCount:
        session.coverage.apiCoverage?.unavailableReplyCount ?? 0,
    },
    result,
    replies: session.replies,
  });
}

function validTypicalFixture(): {
  session: ReviewSession;
  result: WholeThreadCloudAnalysisResultV3;
} {
  const idMap = new Map(
    DEMO_REVIEW_TYPICAL_SESSION.replies.map((reply, index) => [
      reply.id,
      String(91_001 + index),
    ]),
  );
  const mapIds = (ids: readonly string[] | undefined): string[] | undefined =>
    ids?.map((id) => idMap.get(id) ?? id);
  const session: ReviewSession = {
    ...DEMO_REVIEW_TYPICAL_SESSION,
    tabId: 117,
    threadId: "81000000991",
    threadUrl: "https://tieba.baidu.com/p/81000000991",
    replies: DEMO_REVIEW_TYPICAL_SESSION.replies.map((reply) => ({
      ...reply,
      id: idMap.get(reply.id)!,
      siteReplyId: idMap.get(reply.id)!,
      parentReplyId: reply.parentReplyId
        ? (idMap.get(reply.parentReplyId) ?? reply.parentReplyId)
        : null,
    })),
  };
  const result: WholeThreadCloudAnalysisResultV3 = {
    ...DEMO_REVIEW_TYPICAL_RESULT,
    findings: DEMO_REVIEW_TYPICAL_RESULT.findings.map((finding) => ({
      ...finding,
      replyIds: mapIds(finding.replyIds)!,
      ...(finding.contextReplyIds
        ? { contextReplyIds: mapIds(finding.contextReplyIds) }
        : {}),
      evidence: finding.evidence.map((evidence) => ({
        ...evidence,
        replyId: idMap.get(evidence.replyId) ?? evidence.replyId,
      })),
    })),
    report: {
      ...DEMO_REVIEW_TYPICAL_RESULT.report,
      stages: DEMO_REVIEW_TYPICAL_RESULT.report.stages.map((item) => ({
        ...item,
        replyIds: mapIds(item.replyIds)!,
      })),
      interactions: DEMO_REVIEW_TYPICAL_RESULT.report.interactions.map(
        (item) => ({ ...item, replyIds: mapIds(item.replyIds)! }),
      ),
      notes: DEMO_REVIEW_TYPICAL_RESULT.report.notes.map((item) => ({
        ...item,
        replyIds: mapIds(item.replyIds)!,
      })),
    },
  };
  return { session, result };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function findButton(name: string, exact = true): HTMLButtonElement {
  const found = [...(container?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
    .find((button) => {
      const text = button.textContent?.replace(/\s+/gu, " ").trim() ?? "";
      return exact ? text === name : text.includes(name);
    });
  if (!found) throw new Error(`Button not found: ${name}`);
  return found;
}

async function changeControlValue(
  control: HTMLInputElement | HTMLSelectElement,
  value: string,
): Promise<void> {
  const prototype = control instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  await act(async () => {
    setter?.call(control, value);
    control.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function renderApp(): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<App />);
  });
  await vi.waitFor(() => {
    expect(container?.textContent).toContain(mocks.activeSession?.title ?? "打开需要检查");
  });
}

async function activateSession(next: ReviewSession): Promise<void> {
  mocks.activeSession = next;
  await act(async () => {
    for (const listener of activatedListeners) {
      listener({ tabId: next.tabId, windowId: 1 });
    }
    await Promise.resolve();
  });
  await vi.waitFor(() => expect(container?.textContent).toContain(next.title));
}

beforeEach(() => {
  window.history.replaceState({}, "", "/sidepanel.html");
  chromeHarness();
  mocks.activeSession = DEMO_REVIEW_TYPICAL_SESSION;
  mocks.jumpError = null;
  mocks.loadSettings.mockReset().mockResolvedValue({ ...DEFAULT_SETTINGS });
  mocks.saveSettings.mockReset().mockResolvedValue(undefined);
  mocks.loadApiKey.mockReset().mockImplementation(async (provider: "alibaba" | "deepseek") =>
    provider === "alibaba" ? DEFAULT_SETTINGS.apiKey : "",
  );
  mocks.clearApiKey.mockReset().mockResolvedValue(undefined);
  mocks.loadTheme.mockReset().mockResolvedValue("light");
  mocks.saveTheme.mockReset().mockResolvedValue(undefined);
  mocks.loadUsage.mockReset().mockResolvedValue([]);
  mocks.recordUsage.mockReset().mockResolvedValue(undefined);
  mocks.loadRecords.mockReset().mockResolvedValue([]);
  mocks.saveRecords.mockReset().mockImplementation(async (incoming) => incoming);
  mocks.loadHistory.mockReset().mockResolvedValue([]);
  mocks.saveHistory.mockReset().mockResolvedValue(undefined);
  mocks.deleteHistory.mockReset().mockResolvedValue(undefined);
  mocks.replaceHistory.mockReset().mockImplementation(async (entries) => entries);
  mocks.claimAnalysisStart.mockReset().mockResolvedValue(null);
  mocks.loadCache.mockReset().mockResolvedValue(null);
  mocks.loadBillingReceipt.mockReset().mockResolvedValue(null);
  mocks.loadSnapshotCache.mockReset().mockResolvedValue(null);
  mocks.loadLegacySuccess.mockReset().mockResolvedValue(null);
  mocks.migrateLegacyPending.mockReset().mockResolvedValue(null);
  mocks.saveCache.mockReset().mockResolvedValue(undefined);
  mocks.clearCache.mockReset().mockResolvedValue(undefined);
  mocks.requestPersistentPermission.mockReset().mockResolvedValue(true);
  mocks.tabsUpdate.mockReset().mockResolvedValue(undefined);
  mocks.tabsReload.mockReset().mockResolvedValue(undefined);
  mocks.sendMessage.mockReset().mockImplementation(
    async (request: { type: string }) => {
      if (request.type === "GET_ACTIVE_SESSION") return mocks.activeSession;
      if (request.type === "GET_CLOUD_PERMISSION_STATUS") return null;
      if (request.type === "VALIDATE_REVIEW_SNAPSHOT") return { ok: true };
      if (request.type === "CAPTURE_WHOLE_THREAD") return mocks.activeSession;
      if (request.type === "JUMP_TO_REPLY") {
        if (mocks.jumpError) throw mocks.jumpError;
        return { ok: true };
      }
      throw new Error(`Unexpected extension request: ${request.type}`);
    },
  );
  mocks.runWholeThread.mockReset().mockImplementation(
    async (
      _title: string,
      _replies: CapturedReply[],
      options: {
        beforeStart?: () => Promise<void>;
        beforeSend?: () => Promise<void>;
      },
    ) => {
      await options.beforeStart?.();
      await options.beforeSend?.();
      return DEMO_REVIEW_TYPICAL_RESULT;
    },
  );
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("persistent provider API keys", () => {
  it("shows the saved state without putting the persisted key back into the DOM", async () => {
    await renderApp();
    await act(async () => findButton("设置").click());

    const input = container?.querySelector<HTMLInputElement>("#cloud-api-key");
    expect(input?.value).toBe("");
    expect(input?.placeholder).toBe("已保存；输入新值可替换");
    expect(container?.textContent).toContain("已按服务商保存在此 Chrome 配置文件");
    expect(container?.textContent).not.toContain(DEFAULT_SETTINGS.apiKey);
    expect(container?.innerHTML).not.toContain(DEFAULT_SETTINGS.apiKey);
  });

  it("keeps a saved key on an empty draft and clears the input after replacing it", async () => {
    await renderApp();
    await act(async () => findButton("设置").click());

    await act(async () => findButton("保存设置（只影响未来任务）").click());
    await vi.waitFor(() => expect(mocks.saveSettings).toHaveBeenCalledTimes(1));
    expect(mocks.saveSettings.mock.calls[0]?.[0].apiKey).toBe(DEFAULT_SETTINGS.apiKey);

    const input = container?.querySelector<HTMLInputElement>("#cloud-api-key");
    if (!input) throw new Error("API key input missing");
    await changeControlValue(input, "replacement-deep-secret");
    await act(async () => findButton("保存设置（只影响未来任务）").click());
    await vi.waitFor(() => expect(mocks.saveSettings).toHaveBeenCalledTimes(2));
    expect(mocks.saveSettings.mock.calls[1]?.[0].apiKey).toBe("replacement-deep-secret");
    expect(input.value).toBe("");
    expect(container?.innerHTML).not.toContain("replacement-deep-secret");
  });

  it("loads only the selected provider key and clears it only after explicit confirmation", async () => {
    mocks.loadApiKey.mockImplementation(async (provider: "alibaba" | "deepseek") =>
      provider === "deepseek" ? "persisted-deepseek-secret" : DEFAULT_SETTINGS.apiKey,
    );
    await renderApp();
    await act(async () => findButton("设置").click());

    const provider = container?.querySelector<HTMLSelectElement>(
      ".advanced-settings select",
    );
    if (!provider) throw new Error("Provider select missing");
    await changeControlValue(provider, "deepseek");
    await vi.waitFor(() => expect(mocks.loadApiKey).toHaveBeenCalledWith("deepseek"));
    await vi.waitFor(() =>
      expect(container?.textContent).toContain("已读取该 Chrome 配置文件中保存的 DeepSeek 密钥"),
    );
    expect(container?.querySelector<HTMLInputElement>("#cloud-api-key")?.value).toBe("");
    expect(container?.innerHTML).not.toContain("persisted-deepseek-secret");

    await act(async () => findButton("清除已保存的 DeepSeek 密钥").click());
    expect(mocks.clearApiKey).not.toHaveBeenCalled();
    await act(async () => findButton("确认清除").click());
    await vi.waitFor(() => expect(mocks.clearApiKey).toHaveBeenCalledWith("deepseek"));
    expect(container?.textContent).toContain("DeepSeek 密钥已从此 Chrome 配置文件清除");
  });
});

describe("appearance theme", () => {
  it("loads a persisted dark theme without writing during hydration", async () => {
    mocks.loadTheme.mockResolvedValue("dark");
    await renderApp();

    await vi.waitFor(() =>
      expect(container?.querySelector(".app-shell")?.getAttribute("data-theme"))
        .toBe("dark"),
    );
    expect(mocks.saveTheme).not.toHaveBeenCalled();
  });

  it("persists explicit night and ordinary mode changes", async () => {
    await renderApp();
    const night = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="切换到夜间模式"]',
    );
    expect(night).not.toBeNull();
    await act(async () => night?.click());
    expect(container?.querySelector(".app-shell")?.getAttribute("data-theme"))
      .toBe("dark");
    expect(mocks.saveTheme).toHaveBeenLastCalledWith("dark");

    const ordinary = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="切换到普通模式"]',
    );
    expect(ordinary).not.toBeNull();
    await act(async () => ordinary?.click());
    expect(container?.querySelector(".app-shell")?.getAttribute("data-theme"))
      .toBe("light");
    expect(mocks.saveTheme).toHaveBeenLastCalledWith("light");
  });
});

describe("paid analysis boundary", () => {
  it("defaults to manual payment and shows the explicit start action", async () => {
    await renderApp();

    await vi.waitFor(() => {
      expect(container?.textContent).toContain("可以开始 AI 初筛");
      expect(findButton("开始 AI 初筛").disabled).toBe(false);
    });
    expect(mocks.runWholeThread).not.toHaveBeenCalled();
  });

  it("runs exactly once only after auto analysis was explicitly enabled", async () => {
    mocks.loadSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      autoAnalyzeWholeThread: true,
    });
    await renderApp();

    await vi.waitFor(() => expect(mocks.runWholeThread).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(container?.textContent).toContain("AI 初筛结果"));
    expect(mocks.runWholeThread).toHaveBeenCalledTimes(1);
  });

  it("atomically refuses an occupied snapshot receipt before creating or sending a task", async () => {
    const identity = cacheIdentity(DEMO_REVIEW_TYPICAL_SESSION);
    const occupiedReceipt = {
      schemaVersion: 1 as const,
      snapshotId: identity.snapshotId,
      analysisKey: identity.analysisKey,
      attemptId: "attempt:other-context-preparing",
      status: "preparing" as const,
      startedAt: "2026-08-16T08:00:00.000Z",
      updatedAt: "2026-08-16T08:00:00.000Z",
      sentAt: null,
    };
    mocks.claimAnalysisStart.mockResolvedValue(occupiedReceipt);
    await renderApp();

    await act(async () => findButton("开始 AI 初筛").click());

    await vi.waitFor(() =>
      expect(container?.textContent).toContain(
        "已有另一项任务正在准备",
      ),
    );
    expect(mocks.claimAnalysisStart).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "preparing",
        snapshotId: identity.snapshotId,
      }),
      { force: false },
    );
    expect(mocks.runWholeThread).not.toHaveBeenCalled();
    expect(mocks.saveCache).not.toHaveBeenCalled();
    expect(container?.textContent).toContain("本次不会创建或发送新请求");
  });

  it.each([
    ["sent", "已有请求发出"],
    ["success", "已有成功分析的计费记录"],
    ["history_deleted", "防重复计费标记仍保留"],
  ] as const)(
    "blocks a durable %s receipt before automatic analysis",
    async (status, expectedMessage) => {
      const identity = cacheIdentity(DEMO_REVIEW_TYPICAL_SESSION);
      mocks.loadSettings.mockResolvedValue({
        ...DEFAULT_SETTINGS,
        autoAnalyzeWholeThread: true,
      });
      mocks.loadBillingReceipt.mockResolvedValue({
        schemaVersion: 1,
        snapshotId: identity.snapshotId,
        analysisKey: identity.analysisKey,
        attemptId: `attempt:receipt-${status}`,
        status,
        startedAt: "2026-08-16T08:00:00.000Z",
        updatedAt: "2026-08-16T08:01:00.000Z",
        sentAt:
          status === "history_deleted" || status === "success" || status === "sent"
            ? "2026-08-16T08:00:01.000Z"
            : null,
      });

      await renderApp();

      await vi.waitFor(() =>
        expect(container?.textContent).toContain(expectedMessage),
      );
      expect(mocks.claimAnalysisStart).not.toHaveBeenCalled();
      expect(mocks.loadSnapshotCache).not.toHaveBeenCalled();
      expect(mocks.runWholeThread).not.toHaveBeenCalled();
    },
  );

  it("allows a failed-before-send receipt to be atomically replaced", async () => {
    const identity = cacheIdentity(DEMO_REVIEW_TYPICAL_SESSION);
    mocks.loadBillingReceipt.mockResolvedValue({
      schemaVersion: 1,
      snapshotId: identity.snapshotId,
      analysisKey: identity.analysisKey,
      attemptId: "attempt:failed-before-send",
      status: "failed_before_send",
      startedAt: "2026-08-16T08:00:00.000Z",
      updatedAt: "2026-08-16T08:00:01.000Z",
      sentAt: null,
    });
    await renderApp();

    await act(async () => findButton("开始 AI 初筛").click());

    await vi.waitFor(() => expect(mocks.runWholeThread).toHaveBeenCalledTimes(1));
    expect(mocks.claimAnalysisStart).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "preparing",
        snapshotId: identity.snapshotId,
      }),
      { force: false },
    );
  });

  it("retries one exact failed-before-send attempt without force", async () => {
    const identity = cacheIdentity(DEMO_REVIEW_TYPICAL_SESSION);
    const attemptId = "attempt:exact-failed-before-send";
    mocks.loadCache.mockResolvedValue({
      ...identity,
      status: "failed_before_send",
      attemptId,
      startedAt: "2026-08-16T08:00:00.000Z",
      updatedAt: "2026-08-16T08:00:01.000Z",
      sentAt: null,
      deadlineAt: null,
      completedAt: "2026-08-16T08:00:01.000Z",
      error: { category: "provider", code: "failed_before_send" },
    });
    mocks.loadBillingReceipt.mockResolvedValue({
      schemaVersion: 1,
      snapshotId: identity.snapshotId,
      analysisKey: identity.analysisKey,
      attemptId,
      status: "failed_before_send",
      startedAt: "2026-08-16T08:00:00.000Z",
      updatedAt: "2026-08-16T08:00:01.000Z",
      sentAt: null,
    });
    await renderApp();
    await vi.waitFor(() =>
      expect(container?.textContent).toContain("上一次任务在发送正文前停止"),
    );

    await act(async () => findButton("重新开始（上次未发送）").click());

    await vi.waitFor(() => expect(mocks.runWholeThread).toHaveBeenCalledTimes(1));
    expect(mocks.claimAnalysisStart).toHaveBeenCalledWith(
      expect.objectContaining({ status: "preparing" }),
      { force: false },
    );
  });

  it("blocks a safe retry when another context has since sent the snapshot", async () => {
    const identity = cacheIdentity(DEMO_REVIEW_TYPICAL_SESSION);
    const attemptId = "attempt:stale-failed-before-send";
    mocks.loadCache.mockResolvedValue({
      ...identity,
      status: "failed_before_send",
      attemptId,
      startedAt: "2026-08-16T08:00:00.000Z",
      updatedAt: "2026-08-16T08:00:01.000Z",
      sentAt: null,
      deadlineAt: null,
      completedAt: "2026-08-16T08:00:01.000Z",
      error: { category: "provider", code: "failed_before_send" },
    });
    mocks.loadBillingReceipt.mockResolvedValue({
      schemaVersion: 1,
      snapshotId: identity.snapshotId,
      analysisKey: identity.analysisKey,
      attemptId: "attempt:other-context-sent",
      status: "sent",
      startedAt: "2026-08-16T08:00:02.000Z",
      updatedAt: "2026-08-16T08:00:03.000Z",
      sentAt: "2026-08-16T08:00:03.000Z",
    });
    await renderApp();
    await vi.waitFor(() =>
      expect(container?.textContent).toContain("上一次任务在发送正文前停止"),
    );

    await act(async () => findButton("重新开始（上次未发送）").click());

    await vi.waitFor(() =>
      expect(container?.textContent).toContain("已有请求发出"),
    );
    expect(mocks.claimAnalysisStart).not.toHaveBeenCalled();
    expect(mocks.runWholeThread).not.toHaveBeenCalled();
  });

  it("blocks authorization continuation when another context sends during the prompt", async () => {
    const identity = cacheIdentity(DEMO_REVIEW_TYPICAL_SESSION);
    const permission = deferred<boolean>();
    let storedCache: Record<string, unknown> | null = null;
    let receipt: Record<string, unknown> | null = null;
    mocks.requestPersistentPermission.mockReturnValue(permission.promise);
    mocks.loadCache.mockImplementation(async () => storedCache);
    mocks.loadBillingReceipt.mockImplementation(async () => receipt);
    mocks.claimAnalysisStart.mockImplementation(async (entry) => {
      storedCache = entry;
      receipt = {
        schemaVersion: 1,
        snapshotId: entry.snapshotId,
        analysisKey: entry.analysisKey,
        attemptId: entry.attemptId,
        status: "preparing",
        startedAt: entry.startedAt,
        updatedAt: entry.updatedAt,
        sentAt: null,
      };
      return null;
    });
    mocks.saveCache.mockImplementation(async (entry) => {
      storedCache = entry;
      if (entry.status === "failed_before_send") {
        receipt = {
          schemaVersion: 1,
          snapshotId: entry.snapshotId,
          analysisKey: entry.analysisKey,
          attemptId: entry.attemptId,
          status: "failed_before_send",
          startedAt: entry.startedAt,
          updatedAt: entry.updatedAt,
          sentAt: null,
        };
      }
    });
    mocks.runWholeThread.mockImplementationOnce(
      async (
        _title: string,
        _replies: CapturedReply[],
        options: { beforeStart?: () => Promise<void> },
      ) => {
        await options.beforeStart?.();
        throw new Error("需要持久网络权限");
      },
    );
    await renderApp();
    await act(async () => findButton("开始 AI 初筛").click());
    await vi.waitFor(() => expect(findButton("授权并开始")).toBeTruthy());

    await act(async () => findButton("授权并开始").click());
    await vi.waitFor(() =>
      expect(mocks.requestPersistentPermission).toHaveBeenCalledTimes(1),
    );
    receipt = {
      schemaVersion: 1,
      snapshotId: identity.snapshotId,
      analysisKey: identity.analysisKey,
      attemptId: "attempt:other-context-sent-during-permission",
      status: "sent",
      startedAt: "2026-08-16T08:00:02.000Z",
      updatedAt: "2026-08-16T08:00:03.000Z",
      sentAt: "2026-08-16T08:00:03.000Z",
    };
    await act(async () => {
      permission.resolve(true);
      await permission.promise;
    });

    await vi.waitFor(() =>
      expect(container?.textContent).toContain("已有请求发出"),
    );
    expect(mocks.claimAnalysisStart).toHaveBeenCalledTimes(1);
    expect(mocks.runWholeThread).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the exact cache is damaged", async () => {
    mocks.loadSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      autoAnalyzeWholeThread: true,
    });
    mocks.loadCache.mockRejectedValue(new TypeError("damaged cache"));

    await renderApp();

    await vi.waitFor(() =>
      expect(container?.textContent).toContain("避免重复计费"),
    );
    expect(mocks.loadBillingReceipt).not.toHaveBeenCalled();
    expect(mocks.claimAnalysisStart).not.toHaveBeenCalled();
    expect(mocks.runWholeThread).not.toHaveBeenCalled();
  });

  it("fails closed when the durable billing receipt cannot be validated", async () => {
    mocks.loadSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      autoAnalyzeWholeThread: true,
    });
    mocks.loadBillingReceipt.mockRejectedValue(
      new TypeError("damaged billing receipt"),
    );

    await renderApp();

    await vi.waitFor(() =>
      expect(container?.textContent).toContain(
        "已停止自动发送以避免重复计费",
      ),
    );
    expect(mocks.loadBillingReceipt).toHaveBeenCalled();
    expect(mocks.claimAnalysisStart).not.toHaveBeenCalled();
    expect(mocks.runWholeThread).not.toHaveBeenCalled();
  });

  it("restores a sent failure as a paid retry instead of a fresh start", async () => {
    const identity = cacheIdentity(DEMO_REVIEW_TYPICAL_SESSION);
    mocks.loadCache.mockResolvedValue({
      ...identity,
      status: "failed_after_send",
      attemptId: "sent-failure-attempt",
      startedAt: "2026-08-02T02:00:00.000Z",
      updatedAt: "2026-08-02T02:01:00.000Z",
      sentAt: "2026-08-02T02:00:01.000Z",
      deadlineAt: "2026-08-02T02:03:01.000Z",
      completedAt: "2026-08-02T02:01:00.000Z",
      error: { category: "provider", code: "failed_after_send" },
    });

    await renderApp();

    await vi.waitFor(() => {
      expect(container?.textContent).toContain("上一次请求已经发出");
      expect(findButton("核对后再次付费分析").disabled).toBe(false);
    });
    expect(mocks.runWholeThread).not.toHaveBeenCalled();

    await act(async () => findButton("核对后再次付费分析").click());
    expect(container?.querySelector('[role="dialog"]')?.textContent)
      .toContain("仍要重试");
    expect(mocks.runWholeThread).not.toHaveBeenCalled();
  });

  it("restores persistent preparing as unknown and only allows an explicit paid retry", async () => {
    const identity = cacheIdentity(DEMO_REVIEW_TYPICAL_SESSION);
    mocks.loadSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      autoAnalyzeWholeThread: true,
    });
    mocks.loadCache.mockResolvedValue({
      ...identity,
      status: "preparing",
      attemptId: "attempt:persistent-preparing",
      startedAt: "2026-08-16T08:00:00.000Z",
      updatedAt: "2026-08-16T08:00:01.000Z",
      sentAt: null,
      deadlineAt: null,
      error: null,
    });
    await renderApp();

    await vi.waitFor(() =>
      expect(container?.textContent).toContain(
        "另一上下文可能仍在准备",
      ),
    );
    expect(container?.textContent).not.toContain("重新开始（上次未发送）");
    expect(findButton("核对后再次付费分析")).toBeTruthy();
    expect(mocks.claimAnalysisStart).not.toHaveBeenCalled();
    expect(mocks.runWholeThread).not.toHaveBeenCalled();

    await act(async () => findButton("核对后再次付费分析").click());
    expect(container?.querySelector('[role="dialog"]')?.textContent)
      .toContain("仍要重试");
    expect(mocks.runWholeThread).not.toHaveBeenCalled();
    await act(async () => findButton("确认并创建新请求").click());

    await vi.waitFor(() => expect(mocks.runWholeThread).toHaveBeenCalledTimes(1));
    expect(mocks.claimAnalysisStart).toHaveBeenCalledWith(
      expect.objectContaining({ status: "preparing" }),
      { force: true },
    );
  });
});

describe("capture gap diagnosis", () => {
  it("shows exact blocking coverage before analysis and offers only a free reread", async () => {
    mocks.activeSession = partialApiSession();
    await renderApp();

    const diagnostics = container?.querySelector<HTMLDetailsElement>(
      ".capture-diagnostics",
    );
    expect(diagnostics?.open).toBe(true);
    expect(diagnostics?.textContent).toContain("主回复仍缺 1 页");
    expect(diagnostics?.textContent).toContain("2/3");
    expect(diagnostics?.textContent).toContain("1/2");
    expect(diagnostics?.textContent).toContain("3 条");
    expect(diagnostics?.textContent).toContain("贴吧标注 5 条");
    expect(diagnostics?.textContent).toContain("请求超时");
    expect(findButton("稍后重新读取整帖").disabled).toBe(false);
    expect(container?.textContent).not.toContain("核对后再次付费分析");
    expect(
      [...(container?.querySelectorAll("button") ?? [])]
        .some((button) => button.textContent?.trim() === "开始 AI 初筛"),
    ).toBe(false);
  });

  it("keeps a prior sent failure behind the free reread action while the current snapshot is incomplete", async () => {
    const partial = partialApiSession();
    const identity = cacheIdentity(partial);
    mocks.activeSession = partial;
    mocks.loadCache.mockResolvedValue({
      ...identity,
      status: "failed_after_send",
      attemptId: "older-sent-attempt",
      startedAt: "2026-08-02T02:00:00.000Z",
      updatedAt: "2026-08-02T02:01:00.000Z",
      sentAt: "2026-08-02T02:00:01.000Z",
      deadlineAt: "2026-08-02T02:03:01.000Z",
      completedAt: "2026-08-02T02:01:00.000Z",
      error: { category: "provider", code: "failed_after_send" },
    });

    await renderApp();

    expect(findButton("稍后重新读取整帖").disabled).toBe(false);
    expect(container?.textContent).not.toContain("核对后再次付费分析");
    expect(container?.textContent).not.toContain("开始 AI 初筛");
  });

  it("treats 94/99 as a non-additive site-count gap after readable text finishes", async () => {
    mocks.activeSession = partialApiSession({
      readableTextComplete: true,
      failedRequestCount: 0,
      mainPagesFetched: 3,
      mainPagesTotal: 3,
      nestedParentsFetched: 2,
      nestedParentsTotal: 2,
      nestedRepliesFetched: 94,
      nestedRepliesDeclared: 99,
      unavailableReplyCount: 6,
      imageCount: 24,
      errors: [],
    });
    await renderApp();

    const diagnostics = container?.querySelector<HTMLDetailsElement>(
      ".capture-diagnostics",
    );
    expect(diagnostics).toBeNull();
    expect(container?.textContent).not.toContain(
      "接口可见文字已读完；仍有6 条站点统计差额、24 张图片未识别",
    );
    const rangeDetails = container?.querySelector<HTMLDetailsElement>(
      ".nonblocking-coverage-details",
    );
    expect(rangeDetails?.open).toBe(false);
    expect(rangeDetails?.querySelector("summary")?.textContent).toBe("读取范围详情");
    expect(rangeDetails?.textContent).toContain("94 条");
    expect(rangeDetails?.textContent).toContain("楼中楼已读");
    expect(rangeDetails?.textContent).toContain("贴吧标注 99 条");
    expect(rangeDetails?.textContent).toContain("6 条");
    expect(rangeDetails?.textContent).toContain("站点统计差额");
    expect(rangeDetails?.textContent).toContain("24");
    expect(rangeDetails?.textContent).toContain("未识别图片");
    expect(rangeDetails?.textContent).toContain("这不是仍待抓取的回复");
    expect(rangeDetails?.textContent).toContain("可能重叠，不能相加");
    expect(rangeDetails?.previousElementSibling?.classList)
      .toContain("whole-thread-cloud-card");
    expect(container?.querySelector(".analysis-scope-note")?.textContent)
      .toContain("不会把 6 条站点统计差额当作已读取内容");
    expect(container?.querySelector(".analysis-scope-note")?.textContent)
      .toContain("不包含 24 张图片中的文字");
    expect(findButton("开始 AI 初筛").disabled).toBe(false);
  });

  it("keeps a returned node without a stable id as a red structural blocker", async () => {
    mocks.activeSession = partialApiSession({
      readableTextComplete: false,
      failedRequestCount: 0,
      mainPagesFetched: 3,
      mainPagesTotal: 3,
      nestedParentsFetched: 2,
      nestedParentsTotal: 2,
      nestedRepliesFetched: 94,
      nestedRepliesDeclared: 99,
      unavailableReplyCount: 6,
      unexpandedLzlCount: 1,
      errors: [],
      warnings: [
        "楼中楼接口有 1 个回复节点缺少稳定 ID，无法安全纳入分析。",
      ],
    });
    await renderApp();

    const diagnostics = container?.querySelector<HTMLDetailsElement>(
      ".capture-diagnostics",
    );
    expect(diagnostics?.open).toBe(true);
    expect(diagnostics?.classList).toContain("blocking");
    expect(diagnostics?.classList).toContain("structure-uncertain");
    expect(diagnostics?.querySelector("summary")?.textContent)
      .toContain("有 1 个接口回复节点无法可靠解析");
    expect(diagnostics?.textContent)
      .toContain("接口实际返回了 1 个回复节点");
    expect(diagnostics?.textContent).toContain("缺少稳定 ID");
    expect(diagnostics?.querySelector(".capture-issues")?.classList)
      .toContain("has-errors");
    expect(container?.querySelector(".capture-blocked")?.classList)
      .toContain("danger");
    expect(container?.textContent).not.toContain("开始 AI 初筛");
    expect(findButton("重新读取整帖").disabled).toBe(false);
  });

  it("treats duplicate ids and pager drift as structural blockers, not count gaps", async () => {
    mocks.activeSession = partialApiSession({
      readableTextComplete: false,
      failedRequestCount: 0,
      mainPagesFetched: 3,
      mainPagesTotal: 3,
      nestedParentsFetched: 2,
      nestedParentsTotal: 2,
      nestedRepliesFetched: 94,
      nestedRepliesDeclared: 99,
      unavailableReplyCount: 5,
      errors: [],
      warnings: [
        "楼中楼分页出现 2 次稳定 ID 重复，无法确认分页边界是否完整。",
        "楼中楼读取期间有 1 页的分页总数发生漂移，无法可靠完成逐页对账。",
      ],
    });
    await renderApp();

    const diagnostics = container?.querySelector<HTMLDetailsElement>(
      ".capture-diagnostics",
    );
    expect(diagnostics?.open).toBe(true);
    expect(diagnostics?.classList).toContain("structure-uncertain");
    expect(diagnostics?.querySelector("summary")?.textContent)
      .toContain("接口回复结构无法可靠解析");
    expect(container?.querySelector(".capture-blocked")?.classList)
      .toContain("danger");
    expect(container?.textContent).not.toContain("开始 AI 初筛");
  });

  it("keeps a DOM fallback visibly partial even when its page parser claimed complete", async () => {
    const base = partialApiSession();
    mocks.activeSession = {
      ...base,
      coverage: {
        ...base.coverage,
        captureMode: "paginated",
        apiCoverage: undefined,
        isComplete: false,
      },
      errors: ["整帖只读接口失败：同步端点超时。"],
      warnings: ["仅保留当前页面已挂载内容供人工参考；这不是完整帖子快照。"],
    };
    await renderApp();

    const diagnostics = container?.querySelector<HTMLDetailsElement>(
      ".capture-diagnostics",
    );
    expect(diagnostics?.open).toBe(true);
    expect(diagnostics?.textContent).toContain("当前只有页面局部内容");
    expect(diagnostics?.textContent).toContain("同步端点超时");
    expect(findButton("重新尝试整帖读取").disabled).toBe(false);
    expect(container?.textContent).not.toContain("开始 AI 初筛");
  });
});

describe("review decisions", () => {
  beforeEach(() => {
    mocks.loadCache.mockImplementation(async (identity: { analysisKey: string }) =>
      identity.analysisKey === cacheIdentity(DEMO_REVIEW_TYPICAL_SESSION).analysisKey
        ? successCache(DEMO_REVIEW_TYPICAL_SESSION, DEMO_REVIEW_TYPICAL_RESULT)
        : null,
    );
  });

  it("does not auto-select a finding and saves only the explicitly selected reply ids", async () => {
    const fixture = validTypicalFixture();
    mocks.activeSession = fixture.session;
    mocks.loadCache.mockImplementation(async (identity: { analysisKey: string }) =>
      identity.analysisKey === cacheIdentity(fixture.session).analysisKey
        ? successCache(fixture.session, fixture.result)
        : null,
    );
    mocks.saveRecords.mockImplementation(async (incoming: ReviewRecord[]) => [
      {
        ...incoming[0]!,
        id: "concurrent-authoritative-record",
        reviewedAt: "2026-08-16T08:00:00.000Z",
      },
      ...incoming,
    ]);
    await renderApp();
    await vi.waitFor(() => expect(container?.textContent).toContain("最高优先级线索"));

    expect(container?.querySelector(".decision-card")).toBeNull();
    const selectors = [
      ...(container?.querySelectorAll<HTMLButtonElement>(".cloud-finding-select") ?? []),
    ];
    expect(selectors).toHaveLength(2);
    await act(async () => selectors[1]!.click());

    const save = findButton("保存本地审核记录");
    expect(save.disabled).toBe(true);
    expect(mocks.saveRecords).not.toHaveBeenCalled();

    await act(async () => findButton("确认保留").click());
    expect(save.disabled).toBe(false);
    await act(async () => save.click());
    await vi.waitFor(() => expect(mocks.saveRecords).toHaveBeenCalledTimes(1));
    const records = mocks.saveRecords.mock.calls[0]![0] as Array<{
      replyIds: string[];
      decision: string;
      analysisAttemptId: string | null;
      snapshotId: string | null;
      findingId: string | null;
    }>;
    expect(records[0]).toMatchObject({
      decision: "keep",
      replyIds: fixture.result.findings[1]!.replyIds,
      analysisAttemptId: `attempt:${fixture.session.threadId}`,
      snapshotId: cacheIdentity(fixture.session).snapshotId,
      findingId: fixture.result.findings[1]!.id,
    });
    await act(async () => findButton("历史").click());
    expect(container?.textContent).toContain("已保存 2 条人工决定");
  });

  it("renders V3 as an action-first list with details collapsed", async () => {
    await renderApp();
    await vi.waitFor(() => expect(container?.querySelector(".review-overview")).not.toBeNull());

    const overview = container!.querySelector(".review-overview")!;
    const firstAction = container!.querySelector(".review-first-action")!;
    const list = container!.querySelector(".cloud-actionable-findings")!;
    const details = container!.querySelector<HTMLDetailsElement>(".analysis-details")!;
    expect(overview.compareDocumentPosition(firstAction) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    expect(firstAction.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    expect(list.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    expect(details.open).toBe(false);
    expect(container?.querySelector(".cloud-finding-detail")).toBeNull();
    expect(container?.querySelector(".legacy-report-details")).toBeNull();
  });

  it("shows the exact local reply excerpts inside human-check references", async () => {
    const fixture = validTypicalFixture();
    mocks.activeSession = fixture.session;
    mocks.loadCache.mockImplementation(async (identity: { analysisKey: string }) =>
      identity.analysisKey === cacheIdentity(fixture.session).analysisKey
        ? successCache(fixture.session, fixture.result)
        : null,
    );
    await renderApp();
    await vi.waitFor(() => expect(container?.querySelector(".cloud-overall-cautions")).not.toBeNull());

    const references = container?.querySelector<HTMLDetailsElement>(
      ".cloud-overall-cautions .narrative-reference-links",
    );
    expect(references?.classList).toContain("has-excerpts");
    await act(async () => references?.querySelector<HTMLElement>(":scope > summary")?.click());

    const note = fixture.result.report.notes.find(
      (item) => item.kind === "needs_human_check",
    )!;
    const expectedReplies = note.replyIds.map((replyId) =>
      fixture.session.replies.find((reply) => reply.id === replyId)!,
    );
    const evidenceCards = [
      ...(references?.querySelectorAll<HTMLElement>(".narrative-reference-evidence") ?? []),
    ];
    expect(evidenceCards).toHaveLength(expectedReplies.length);
    expectedReplies.forEach((reply, index) => {
      expect(evidenceCards[index]?.textContent).toContain(reply.content);
      expect(evidenceCards[index]?.textContent).toContain(reply.authorName);
      expect(evidenceCards[index]?.textContent).toContain("在原帖定位");
    });

    await act(async () => {
      evidenceCards[0]?.querySelector<HTMLButtonElement>("button")?.click();
    });
    await vi.waitFor(() =>
      expect(mocks.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "JUMP_TO_REPLY", replyId: note.replyIds[0] }),
      ),
    );
    expect(mocks.tabsUpdate).not.toHaveBeenCalled();
    expect(mocks.tabsReload).not.toHaveBeenCalled();
  });

  it("explains masked text and expands a long reply locally without leaving the report", async () => {
    const fixture = validTypicalFixture();
    const humanNote = fixture.result.report.notes.find(
      (item) => item.kind === "needs_human_check",
    )!;
    const longText = `这是一条需要在侧栏内完整核对的长回复。${"补充论述".repeat(90)}`;
    const session = {
      ...fixture.session,
      replies: fixture.session.replies.map((reply) =>
        reply.id === humanNote.replyIds[0]
          ? { ...reply, content: "※" }
          : reply.id === humanNote.replyIds[1]
            ? { ...reply, content: longText }
            : reply,
      ),
    };
    mocks.activeSession = session;
    mocks.loadCache.mockImplementation(async (identity: { analysisKey: string }) =>
      identity.analysisKey === cacheIdentity(session).analysisKey
        ? successCache(session, fixture.result)
        : null,
    );
    await renderApp();

    const references = container?.querySelector<HTMLDetailsElement>(
      ".cloud-overall-cautions .narrative-reference-links",
    );
    await act(async () => references?.querySelector<HTMLElement>(":scope > summary")?.click());
    expect(references?.textContent).toContain(
      "贴吧接口仅返回屏蔽占位符，扩展无法还原这条回复原本的文字",
    );
    const fullText = references?.querySelector<HTMLDetailsElement>(
      ".narrative-evidence-full-text",
    );
    expect(fullText?.open).toBe(false);
    expect(fullText?.querySelector(":scope > summary")?.textContent).toContain("展开完整回复");
    expect(fullText?.querySelector("blockquote")?.textContent).toBe(longText);
    await act(async () => fullText?.querySelector<HTMLElement>(":scope > summary")?.click());
    expect(fullText?.open).toBe(true);
    expect(container?.textContent).toContain("AI 初筛结果");
  });

  it("keeps the report after a page-internal location failure", async () => {
    mocks.jumpError = Object.assign(
      new Error("目标回复暂未挂载，请先在贴吧内展开对应楼层。"),
      { code: "EVIDENCE_NOT_LOADED" },
    );
    await renderApp();
    await vi.waitFor(() => expect(container?.querySelector(".cloud-primary-evidence")).not.toBeNull());

    await act(async () => {
      container?.querySelector<HTMLButtonElement>(".cloud-primary-evidence")?.click();
    });

    await vi.waitFor(() =>
      expect(container?.textContent).toContain("目标回复暂未挂载"),
    );
    expect(container?.textContent).toContain("AI 初筛结果");
    expect(container?.querySelectorAll(".cloud-finding-item")).toHaveLength(2);
    expect(mocks.tabsUpdate).not.toHaveBeenCalled();
    expect(mocks.tabsReload).not.toHaveBeenCalled();
  });

  it("focuses cancel by default and closes paid retry confirmation with Escape", async () => {
    await renderApp();
    await vi.waitFor(() => expect(container?.textContent).toContain("AI 初筛结果"));
    const trigger = findButton("重新分析这个快照");
    trigger.focus();
    await act(async () => trigger.click());

    await vi.waitFor(() => expect(container?.querySelector('[role="dialog"]')).not.toBeNull());
    const cancel = findButton("取消");
    await vi.waitFor(() => expect(document.activeElement).toBe(cancel));

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await Promise.resolve();
    });
    expect(container?.querySelector('[role="dialog"]')).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(mocks.runWholeThread).not.toHaveBeenCalled();
  });
});

describe("analysis task ownership", () => {
  it("keeps only the newest context when rapid tab responses finish out of order", async () => {
    const sessionA = syntheticSession(1, "81000000111", "快速切换帖子 A");
    const sessionB = syntheticSession(2, "81000000112", "快速切换帖子 B");
    const sessionC = syntheticSession(3, "81000000113", "快速切换帖子 C");
    const responseB = deferred<ReviewSession | null>();
    const responseC = deferred<ReviewSession | null>();
    let contextRequest = 0;
    mocks.activeSession = sessionA;
    await renderApp();

    mocks.sendMessage.mockImplementation(
      async (request: { type: string }) => {
        if (request.type === "GET_ACTIVE_SESSION") {
          contextRequest += 1;
          return contextRequest === 1 ? responseB.promise : responseC.promise;
        }
        if (request.type === "GET_CLOUD_PERMISSION_STATUS") return null;
        if (request.type === "VALIDATE_REVIEW_SNAPSHOT") return { ok: true };
        throw new Error(`Unexpected extension request: ${request.type}`);
      },
    );

    await act(async () => {
      for (const listener of activatedListeners) {
        listener({ tabId: sessionB.tabId, windowId: 1 });
      }
      await Promise.resolve();
    });
    await act(async () => {
      for (const listener of activatedListeners) {
        listener({ tabId: sessionC.tabId, windowId: 1 });
      }
      await Promise.resolve();
    });

    await act(async () => {
      responseC.resolve(sessionC);
      await responseC.promise;
    });
    await vi.waitFor(() => expect(container?.textContent).toContain(sessionC.title));

    await act(async () => {
      responseB.resolve(sessionB);
      await responseB.promise;
    });
    expect(container?.textContent).toContain(sessionC.title);
    expect(container?.textContent).not.toContain(sessionB.title);
  });

  it("continues A across a switch to B, never attaches A to B, and restores A on return", async () => {
    const sessionA = syntheticSession(1, "81000000101", "帖子 A");
    const sessionB = syntheticSession(2, "81000000102", "帖子 B");
    const resultA = cleanResult(sessionA, "A 的专属合成结果");
    const pendingA = deferred<WholeThreadCloudAnalysisResultV3>();
    let signalA: AbortSignal | undefined;
    mocks.activeSession = sessionA;
    mocks.runWholeThread.mockImplementation(
      async (
        title: string,
        _replies: CapturedReply[],
        options: {
          signal?: AbortSignal;
          beforeStart?: () => Promise<void>;
          beforeSend?: () => Promise<void>;
        },
      ) => {
        expect(title).toBe(sessionA.title);
        signalA = options.signal;
        await options.beforeStart?.();
        await options.beforeSend?.();
        return pendingA.promise;
      },
    );
    await renderApp();
    const reviewViewA = container?.querySelector(".view-stack");
    expect(reviewViewA).not.toBeNull();
    await act(async () => {
      findButton("开始 AI 初筛").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mocks.runWholeThread).toHaveBeenCalledTimes(1));

    await activateSession(sessionB);
    const reviewViewB = container?.querySelector(".view-stack");
    expect(reviewViewB).not.toBeNull();
    expect(reviewViewB).not.toBe(reviewViewA);
    expect(signalA?.aborted).toBe(false);
    expect(container?.textContent).not.toContain("A 的专属合成结果");

    await act(async () => {
      pendingA.resolve(resultA);
      await pendingA.promise;
    });
    await vi.waitFor(() => expect(container?.textContent).toContain("AI 初筛已完成"));
    expect(container?.textContent).toContain(sessionB.title);
    expect(container?.textContent).not.toContain("A 的专属合成结果");
    expect(signalA?.aborted).toBe(false);
    expect(mocks.saveCache).toHaveBeenCalledWith(
      expect.objectContaining({ status: "success", result: resultA }),
      sessionA.replies.map((reply) => reply.authorName ?? ""),
    );

    await activateSession(sessionA);
    await vi.waitFor(() => expect(container?.textContent).toContain("A 的专属合成结果"));
    expect(mocks.runWholeThread).toHaveBeenCalledTimes(1);
  });

  it("runs at most two paid analyses and never queues the third", async () => {
    const sessions = [
      syntheticSession(1, "81000000201", "并行帖子 A"),
      syntheticSession(2, "81000000202", "并行帖子 B"),
      syntheticSession(3, "81000000203", "并行帖子 C"),
    ];
    const pending = new Map(
      sessions.slice(0, 2).map((session) => [
        session.title,
        deferred<WholeThreadCloudAnalysisResultV3>(),
      ]),
    );
    mocks.activeSession = sessions[0]!;
    mocks.runWholeThread.mockImplementation(
      async (
        title: string,
        _replies: CapturedReply[],
        options: {
          beforeStart?: () => Promise<void>;
          beforeSend?: () => Promise<void>;
        },
      ) => {
        await options.beforeStart?.();
        await options.beforeSend?.();
        return pending.get(title)!.promise;
      },
    );
    await renderApp();

    await act(async () => {
      findButton("开始 AI 初筛").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mocks.runWholeThread).toHaveBeenCalledTimes(1));
    await activateSession(sessions[1]!);
    await act(async () => {
      findButton("开始 AI 初筛").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mocks.runWholeThread).toHaveBeenCalledTimes(2));
    await activateSession(sessions[2]!);
    await act(async () => {
      findButton("开始 AI 初筛").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(container?.textContent).toContain("已有两项付费分析正在运行"));
    expect(mocks.runWholeThread).toHaveBeenCalledTimes(2);

    const first = pending.get(sessions[0]!.title)!;
    await act(async () => {
      first.resolve(cleanResult(sessions[0]!));
      await first.promise;
    });
    await Promise.resolve();
    expect(mocks.runWholeThread).toHaveBeenCalledTimes(2);
    expect(container?.textContent).toContain(sessions[2]!.title);

    const second = pending.get(sessions[1]!.title)!;
    await act(async () => {
      second.resolve(cleanResult(sessions[1]!));
      await second.promise;
    });
  });

  it("does not abort an already-sent job when settings draft or saved settings change", async () => {
    const sessionA = syntheticSession(1, "81000000301", "设置期间运行的帖子");
    const pending = deferred<WholeThreadCloudAnalysisResultV3>();
    let signal: AbortSignal | undefined;
    mocks.activeSession = sessionA;
    mocks.runWholeThread.mockImplementation(
      async (
        _title: string,
        _replies: CapturedReply[],
        options: {
          signal?: AbortSignal;
          beforeStart?: () => Promise<void>;
          beforeSend?: () => Promise<void>;
        },
      ) => {
        signal = options.signal;
        await options.beforeStart?.();
        await options.beforeSend?.();
        return pending.promise;
      },
    );
    await renderApp();
    await act(async () => {
      findButton("开始 AI 初筛").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(container?.textContent).toContain("请求已经发出"));

    await act(async () => findButton("设置").click());
    const toggles = [
      ...(container?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? []),
    ];
    expect(toggles).toHaveLength(2);
    await act(async () => toggles[1]!.click());
    expect(signal?.aborted).toBe(false);

    await act(async () => findButton("保存设置（只影响未来任务）").click());
    await vi.waitFor(() => expect(mocks.saveSettings).toHaveBeenCalledTimes(1));
    expect(signal?.aborted).toBe(false);

    await act(async () => {
      pending.resolve(cleanResult(sessionA));
      await pending.promise;
    });
    expect(signal?.aborted).toBe(false);
  });

  it("persists settings-A completion without exposing it as the settings-B result", async () => {
    const sessionA = syntheticSession(
      1,
      "81000000302",
      "切换模型期间运行的帖子",
    );
    const resultA = cleanResult(sessionA, "只属于模型 A 的合成结果");
    const pending = deferred<WholeThreadCloudAnalysisResultV3>();
    const settingsB = { ...DEFAULT_SETTINGS, model: "qwen-settings-b" };
    const identityA = cacheIdentity(sessionA);
    const identityB = cacheIdentity(sessionA, settingsB);
    let receipt: {
      schemaVersion: 1;
      snapshotId: SnapshotId;
      analysisKey: AnalysisKey;
      attemptId: string;
      status: "preparing" | "sent" | "success";
      startedAt: string;
      updatedAt: string;
      sentAt: string | null;
    } | null = null;
    mocks.activeSession = sessionA;
    mocks.claimAnalysisStart.mockImplementation(async (entry) => {
      receipt = {
        schemaVersion: 1,
        snapshotId: entry.snapshotId,
        analysisKey: entry.analysisKey,
        attemptId: entry.attemptId,
        status: "preparing",
        startedAt: entry.startedAt,
        updatedAt: entry.updatedAt,
        sentAt: null,
      };
      return null;
    });
    mocks.loadBillingReceipt.mockImplementation(async () => receipt);
    mocks.saveCache.mockImplementation(async (entry) => {
      if (!receipt || entry.attemptId !== receipt.attemptId) return;
      if (entry.status === "running") {
        receipt = {
          ...receipt,
          status: "sent",
          updatedAt: entry.updatedAt,
          sentAt: entry.sentAt,
        };
      } else if (entry.status === "success") {
        receipt = {
          ...receipt,
          status: "success",
          updatedAt: entry.updatedAt,
          sentAt: entry.sentAt,
        };
      }
    });
    mocks.runWholeThread.mockImplementation(
      async (
        _title: string,
        _replies: CapturedReply[],
        options: {
          beforeStart?: () => Promise<void>;
          beforeSend?: () => Promise<void>;
        },
      ) => {
        await options.beforeStart?.();
        await options.beforeSend?.();
        return pending.promise;
      },
    );
    await renderApp();
    await act(async () => {
      findButton("开始 AI 初筛").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mocks.runWholeThread).toHaveBeenCalledTimes(1));

    await act(async () => findButton("设置").click());
    const modelInput = container?.querySelector<HTMLInputElement>(
      'input[placeholder="模型 ID"]',
    );
    if (!modelInput) throw new Error("Model input missing");
    await changeControlValue(modelInput, settingsB.model);
    await act(async () => findButton("保存设置（只影响未来任务）").click());
    await vi.waitFor(() =>
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ model: settingsB.model }),
      ),
    );
    await act(async () => findButton("风险").click());
    await vi.waitFor(() =>
      expect(container?.textContent).toContain("已有请求发出"),
    );

    await act(async () => {
      pending.resolve(resultA);
      await pending.promise;
    });
    await vi.waitFor(() => expect(mocks.saveHistory).toHaveBeenCalledTimes(1));

    const saved = mocks.saveHistory.mock.calls[0]![0] as AnalysisHistoryEntry;
    expect(saved).toMatchObject({
      analysisKey: identityA.analysisKey,
      snapshotId: identityA.snapshotId,
      model: DEFAULT_SETTINGS.model,
      result: resultA,
    });
    expect(identityB.analysisKey).not.toBe(identityA.analysisKey);
    expect(container?.textContent).not.toContain("只属于模型 A 的合成结果");
    expect(container?.textContent).not.toContain("AI 初筛结果");
    expect(mocks.runWholeThread).toHaveBeenCalledTimes(1);
  });
});

describe("persistent AI analysis history", () => {
  it("shows loading and recoverable error states instead of a false empty history", async () => {
    const pending = deferred<AnalysisHistoryEntry[]>();
    mocks.loadHistory.mockReturnValueOnce(pending.promise);
    await renderApp();
    await act(async () => findButton("历史").click());

    expect(container?.textContent).toContain("正在读取本机 AI 分析历史");
    expect(container?.textContent).toContain("正在核对 AI 分析历史");
    expect(container?.textContent).not.toContain("已保存 0 次完整分析");
    expect(container?.textContent).not.toContain("还没有 AI 分析历史");

    await act(async () => {
      pending.reject(new Error("本机历史读取失败"));
      await pending.promise.catch(() => undefined);
    });
    await vi.waitFor(() =>
      expect(container?.textContent).toContain("无法确认本机 AI 分析历史"),
    );
    expect(container?.textContent).toContain("本机历史读取失败");
    expect(container?.textContent).toContain("AI 分析历史数量未知");
    expect(container?.textContent).not.toContain("已保存 0 次完整分析");
    expect(container?.textContent).not.toContain("还没有 AI 分析历史");

    mocks.loadHistory.mockResolvedValueOnce([]);
    await act(async () => findButton("重新读取历史").click());
    await vi.waitFor(() =>
      expect(container?.textContent).toContain("还没有 AI 分析历史"),
    );
  });

  it("never reports zero artificial decisions before record storage is confirmed", async () => {
    const pending = deferred<ReviewRecord[]>();
    mocks.loadRecords.mockReturnValueOnce(pending.promise);
    await renderApp();
    await act(async () => findButton("历史").click());

    expect(container?.textContent).toContain("正在核对人工决定");
    expect(container?.textContent).not.toContain("已保存 0 条人工决定");

    await act(async () => {
      pending.reject(new Error("人工决定存储损坏"));
      await pending.promise.catch(() => undefined);
    });
    await vi.waitFor(() =>
      expect(container?.textContent).toContain("人工决定数量未知"),
    );
    expect(container?.textContent).not.toContain("已保存 0 条人工决定");
  });

  it("keeps each history card undecided while manual decisions are still loading", async () => {
    const fixture = validTypicalFixture();
    const entry = persistentHistoryEntry(fixture.session, fixture.result);
    const pending = deferred<ReviewRecord[]>();
    mocks.activeSession = fixture.session;
    mocks.loadHistory.mockResolvedValue([entry]);
    mocks.loadRecords.mockReturnValueOnce(pending.promise);
    await renderApp();
    await act(async () => findButton("历史").click());
    await vi.waitFor(() =>
      expect(container?.querySelector(".history-entry")).not.toBeNull(),
    );

    const historyEntry = container?.querySelector<HTMLDetailsElement>(
      ".history-entry",
    );
    expect(historyEntry?.querySelector("summary")?.textContent).toContain(
      "人工决定核对中",
    );
    expect(historyEntry?.querySelector("summary")?.textContent).not.toContain(
      "0 条人工决定",
    );
    await act(async () => historyEntry?.querySelector("summary")?.click());
    expect(historyEntry?.querySelector(".history-decisions")?.textContent)
      .toContain("正在核对本机人工决定");
    expect(historyEntry?.textContent).not.toContain("这次分析尚未保存人工决定");

    await act(async () => {
      pending.resolve([]);
      await pending.promise;
    });
  });

  it("keeps each history card unknown when manual decision storage fails", async () => {
    const fixture = validTypicalFixture();
    const entry = persistentHistoryEntry(fixture.session, fixture.result);
    mocks.activeSession = fixture.session;
    mocks.loadHistory.mockResolvedValue([entry]);
    mocks.loadRecords.mockRejectedValue(new Error("人工决定存储损坏"));
    await renderApp();
    await act(async () => findButton("历史").click());
    await vi.waitFor(() =>
      expect(container?.querySelector(".history-entry")).not.toBeNull(),
    );

    const historyEntry = container?.querySelector<HTMLDetailsElement>(
      ".history-entry",
    );
    await vi.waitFor(() =>
      expect(historyEntry?.querySelector("summary")?.textContent).toContain(
        "人工决定数量未知",
      ),
    );
    expect(historyEntry?.querySelector("summary")?.textContent).not.toContain(
      "0 条人工决定",
    );
    await act(async () => historyEntry?.querySelector("summary")?.click());
    expect(historyEntry?.querySelector(".history-decisions")?.textContent)
      .toContain("无法确认本机人工决定");
    expect(historyEntry?.textContent).not.toContain("这次分析尚未保存人工决定");
  });

  it("preserves the history quota error and tells the user to export before deleting", async () => {
    mocks.saveHistory.mockRejectedValue(
      new Error(
        "分析历史已达到 100 条上限；请先删除不需要的历史后再保存。不会自动删除旧历史。",
      ),
    );
    await renderApp();

    await act(async () => findButton("开始 AI 初筛").click());

    await vi.waitFor(() =>
      expect(container?.textContent).toContain("分析历史已达到 100 条上限"),
    );
    expect(container?.textContent).toContain("可先在“历史”页导出备份");
    expect(container?.textContent).not.toContain("请检查扩展存储空间");
  });

  it("keeps an imported history authoritative when the initial load finishes late", async () => {
    const fixture = validTypicalFixture();
    const entry = persistentHistoryEntry(fixture.session, fixture.result);
    const pending = deferred<AnalysisHistoryEntry[]>();
    mocks.activeSession = fixture.session;
    mocks.loadHistory.mockReturnValueOnce(pending.promise);
    await renderApp();
    await act(async () => findButton("历史").click());
    expect(findButton("导入历史").disabled).toBe(true);

    const input = container?.querySelector<HTMLInputElement>(
      ".history-page > .header-actions input[type=file]",
    );
    Object.defineProperty(input!, "files", {
      configurable: true,
      value: [{
        size: 1024,
        text: vi.fn().mockResolvedValue(JSON.stringify({
          schemaVersion: 1,
          exportedAt: "2026-08-16T08:00:00.000Z",
          entries: [entry],
        })),
      }],
    });
    await act(async () =>
      input!.dispatchEvent(new Event("change", { bubbles: true })),
    );
    await vi.waitFor(() =>
      expect(container?.textContent).toContain(entry.result.summary),
    );
    expect(findButton("导入历史").disabled).toBe(false);

    await act(async () => {
      pending.resolve([]);
      await pending.promise;
    });
    expect(container?.textContent).toContain(entry.result.summary);
    expect(container?.textContent).not.toContain("还没有 AI 分析历史");
  });

  it("recovers the history view from a load error after a successful import", async () => {
    const fixture = validTypicalFixture();
    const entry = persistentHistoryEntry(fixture.session, fixture.result);
    mocks.activeSession = fixture.session;
    mocks.loadHistory.mockRejectedValueOnce(new Error("历史读取暂时失败"));
    await renderApp();
    await act(async () => findButton("历史").click());
    await vi.waitFor(() =>
      expect(container?.textContent).toContain("无法确认本机 AI 分析历史"),
    );
    expect(findButton("导入历史").disabled).toBe(false);

    const input = container?.querySelector<HTMLInputElement>(
      ".history-page > .header-actions input[type=file]",
    );
    Object.defineProperty(input!, "files", {
      configurable: true,
      value: [{
        size: 1024,
        text: vi.fn().mockResolvedValue(JSON.stringify({
          schemaVersion: 1,
          exportedAt: "2026-08-16T08:00:00.000Z",
          entries: [entry],
        })),
      }],
    });
    await act(async () =>
      input!.dispatchEvent(new Event("change", { bubbles: true })),
    );

    await vi.waitFor(() =>
      expect(container?.textContent).toContain(entry.result.summary),
    );
    expect(container?.textContent).not.toContain("无法确认本机 AI 分析历史");
    expect(container?.textContent).not.toContain("历史读取暂时失败");
  });

  it("reads an 8 MiB history import but rejects the first byte above that boundary", async () => {
    mocks.activeSession = validTypicalFixture().session;
    await renderApp();
    await act(async () => findButton("历史").click());
    const input = container?.querySelector<HTMLInputElement>(
      ".history-page > .header-actions input[type=file]",
    );
    expect(input).not.toBeNull();

    const allowedText = vi.fn().mockResolvedValue(JSON.stringify({
      schemaVersion: 1,
      exportedAt: "2026-08-16T08:00:00.000Z",
      entries: [],
    }));
    Object.defineProperty(input!, "files", {
      configurable: true,
      value: [{ size: 8 * 1024 * 1024, text: allowedText }],
    });
    await act(async () =>
      input!.dispatchEvent(new Event("change", { bubbles: true })),
    );
    await vi.waitFor(() => expect(mocks.replaceHistory).toHaveBeenCalledWith([]));
    expect(allowedText).toHaveBeenCalledTimes(1);

    const oversizedText = vi.fn().mockResolvedValue("should not be read");
    Object.defineProperty(input!, "files", {
      configurable: true,
      value: [{ size: 8 * 1024 * 1024 + 1, text: oversizedText }],
    });
    await act(async () =>
      input!.dispatchEvent(new Event("change", { bubbles: true })),
    );
    await vi.waitFor(() =>
      expect(container?.textContent).toContain("超过 8 MiB"),
    );
    expect(oversizedText).not.toHaveBeenCalled();
  });

  it("restores an exact saved result without another model call and renders its details", async () => {
    const fixture = validTypicalFixture();
    const entry = persistentHistoryEntry(fixture.session, fixture.result);
    mocks.activeSession = fixture.session;
    mocks.loadHistory.mockResolvedValue([entry]);
    await renderApp();

    await vi.waitFor(() =>
      expect(container?.textContent).toContain("最高优先级线索"),
    );
    expect(mocks.runWholeThread).not.toHaveBeenCalled();

    await act(async () => findButton("历史").click());
    expect(container?.textContent).toContain("AI 分析历史");
    expect(container?.textContent).toContain(fixture.session.title);
    expect(container?.textContent).toContain(`${fixture.result.findings.length} 条待复核`);
    expect(container?.textContent).toContain("扩展更新、重新加载或重启 Chrome 后仍可恢复");

    const details = container?.querySelector<HTMLDetailsElement>(".history-entry");
    expect(details).not.toBeNull();
    await act(async () => details?.querySelector("summary")?.click());
    expect(details?.open).toBe(true);
    expect(details?.textContent).toContain(entry.result.summary);
    expect(details?.textContent).toContain("可能涉及规范");
    expect(details?.querySelector<HTMLAnchorElement>('a[target="_blank"]')?.href)
      .toBe(entry.threadUrl);
    expect(findButton("导入人工决定")).not.toBeNull();
    expect(findButton("导出人工决定").disabled).toBe(true);
  });

  it("keeps every legacy report section and separates V3 note kinds", async () => {
    const fixture = validTypicalFixture();
    const v3Entry = persistentHistoryEntry(fixture.session, fixture.result);
    const legacyEntry: AnalysisHistoryEntry = {
      ...v3Entry,
      attemptId: "attempt:legacy-report-sections",
      analysisKey: sha256Hex("legacy-report-sections") as AnalysisKey,
      result: {
        summary: "旧版摘要",
        findings: [],
        uncertainties: [],
        analyzedReplyCount: fixture.session.replies.length,
        ruleCount: 112,
        omittedImageCount: 0,
        protocolVersion: 2,
        report: {
          discussionOverview: "旧版讨论总览",
          discussionMap: ["旧版讨论阶段内容"],
          participantDynamics: ["旧版关键互动内容"],
          borderlineCases: ["旧版边界内容"],
          normalHeatedDiscussion: ["旧版允许激烈内容"],
          coverageNotes: ["旧版覆盖说明内容"],
          reviewPriorities: ["旧版复核顺序内容"],
        },
      },
    };
    mocks.activeSession = fixture.session;
    mocks.loadHistory.mockResolvedValue([v3Entry, legacyEntry]);
    await renderApp();
    await act(async () => findButton("历史").click());

    const entries = [
      ...(container?.querySelectorAll<HTMLDetailsElement>(".history-entry") ?? []),
    ];
    await act(async () => entries[0]?.querySelector("summary")?.click());
    await act(async () =>
      entries[0]?.querySelector<HTMLDetailsElement>(".history-report > summary")?.click(),
    );
    expect(entries[0]?.textContent).toContain("待人工确认");
    expect(entries[0]?.textContent).toContain("激烈但允许的讨论");

    await act(async () => entries[1]?.querySelector("summary")?.click());
    await act(async () =>
      entries[1]?.querySelector<HTMLDetailsElement>(".history-report > summary")?.click(),
    );
    for (const text of [
      "旧版讨论阶段内容",
      "旧版关键互动内容",
      "旧版边界内容",
      "旧版允许激烈内容",
      "旧版覆盖说明内容",
      "旧版复核顺序内容",
    ]) {
      expect(entries[1]?.textContent).toContain(text);
    }
  });

  it("persists each completed analysis without source replies or usernames", async () => {
    const target = syntheticSession(81, "81000000881", "会被写入历史的帖子");
    const completed = cleanResult(target);
    mocks.activeSession = target;
    mocks.runWholeThread.mockImplementation(
      async (
        _title: string,
        _replies: CapturedReply[],
        options: {
          beforeStart?: () => Promise<void>;
          beforeSend?: () => Promise<void>;
        },
      ) => {
        await options.beforeStart?.();
        await options.beforeSend?.();
        return completed;
      },
    );
    await renderApp();

    await act(async () => findButton("开始 AI 初筛").click());
    await vi.waitFor(() => expect(mocks.saveHistory).toHaveBeenCalledTimes(1));
    const saved = mocks.saveHistory.mock.calls[0]![0] as AnalysisHistoryEntry;
    expect(saved.threadId).toBe(target.threadId);
    expect(saved.threadTitle).toBe(target.title);
    expect(saved.result.summary).toBe(completed.summary);
    expect(JSON.stringify(saved)).not.toContain(target.replies[0]!.content);
    expect(JSON.stringify(saved)).not.toContain(target.replies[0]!.authorName);
    const successCacheCall = mocks.saveCache.mock.calls.find(
      ([candidate]) => candidate.status === "success",
    );
    expect(successCacheCall?.[1]).toEqual(
      target.replies.map((reply) => reply.authorName ?? ""),
    );
    expect(container?.textContent).toContain("AI 初筛完成并已保存到历史");
  });

  it("associates a restored success cache with its own attempt when older history persistence fails", async () => {
    const fixture = validTypicalFixture();
    const olderHistory = persistentHistoryEntry(
      fixture.session,
      cleanResult(fixture.session, "旧历史结果"),
      "attempt:older-history",
    );
    const cached = {
      ...successCache(fixture.session, fixture.result),
      attemptId: "attempt:new-success-cache",
      completedAt: "2026-08-02T02:02:00.000Z",
      updatedAt: "2026-08-02T02:02:00.000Z",
    };
    mocks.activeSession = fixture.session;
    mocks.loadHistory.mockResolvedValue([olderHistory]);
    mocks.loadCache.mockResolvedValue(cached);
    mocks.saveHistory.mockRejectedValue(new Error("历史容量已满"));

    await renderApp();
    await vi.waitFor(() =>
      expect(container?.textContent).toContain("最高优先级线索"),
    );
    await act(async () => findButton("开始复核").click());
    await act(async () => findButton("确认保留").click());
    await act(async () => findButton("保存本地审核记录").click());
    await vi.waitFor(() => expect(mocks.saveRecords).toHaveBeenCalledTimes(1));

    const savedRecords = mocks.saveRecords.mock.calls[0]![0] as ReviewRecord[];
    expect(savedRecords[0]).toMatchObject({
      analysisAttemptId: cached.attemptId,
      snapshotId: cached.snapshotId,
      findingId: fixture.result.findings[0]!.id,
    });
    expect(savedRecords[0]?.analysisAttemptId).not.toBe(olderHistory.attemptId);
  });

  it("keeps a legacy cache result unlinked even when matching modern history exists", async () => {
    const fixture = validTypicalFixture();
    const modernHistory = persistentHistoryEntry(
      fixture.session,
      cleanResult(fixture.session, "现有现代历史"),
      "attempt:modern-history",
    );
    mocks.activeSession = fixture.session;
    mocks.loadHistory.mockResolvedValue([modernHistory]);
    mocks.loadLegacySuccess.mockResolvedValue({
      status: "success",
      result: fixture.result,
    });

    await renderApp();
    await vi.waitFor(() =>
      expect(container?.textContent).toContain("最高优先级线索"),
    );
    await act(async () => findButton("开始复核").click());
    await act(async () => findButton("确认保留").click());
    await act(async () => findButton("保存本地审核记录").click());
    await vi.waitFor(() => expect(mocks.saveRecords).toHaveBeenCalledTimes(1));

    const savedRecords = mocks.saveRecords.mock.calls[0]![0] as ReviewRecord[];
    expect(savedRecords[0]).toMatchObject({
      analysisAttemptId: null,
      snapshotId: null,
      findingId: null,
    });
    expect(container?.textContent).toContain("旧版独立记录");
  });

  it("never restores snapshot history belonging to another canonical thread", async () => {
    const fixture = validTypicalFixture();
    const otherSession = syntheticSession(
      118,
      "81000000118",
      "另一个内容碰撞的帖子",
    );
    const activeIdentity = cacheIdentity(fixture.session);
    const collidingHistory: AnalysisHistoryEntry = {
      ...persistentHistoryEntry(
        otherSession,
        cleanResult(otherSession, "不应挂到当前帖的历史结果"),
        "attempt:other-thread-collision",
      ),
      snapshotId: activeIdentity.snapshotId,
      analysisKey: activeIdentity.analysisKey,
    };
    mocks.activeSession = fixture.session;
    mocks.loadHistory.mockResolvedValue([collidingHistory]);
    mocks.loadSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      autoAnalyzeWholeThread: true,
    });
    mocks.runWholeThread.mockImplementation(
      async (
        _title: string,
        _replies: CapturedReply[],
        options: {
          beforeStart?: () => Promise<void>;
          beforeSend?: () => Promise<void>;
        },
      ) => {
        await options.beforeStart?.();
        await options.beforeSend?.();
        return cleanResult(fixture.session, "当前帖子的新结果");
      },
    );

    await renderApp();

    await vi.waitFor(() => expect(mocks.runWholeThread).toHaveBeenCalledTimes(1));
    expect(container?.textContent).not.toContain("不应挂到当前帖的历史结果");
    expect(container?.textContent).toContain("当前帖子的新结果");
  });

  it("rejects history restoration when the session thread id and canonical URL disagree", async () => {
    const fixture = validTypicalFixture();
    const mismatchedSession: ReviewSession = {
      ...fixture.session,
      threadUrl: "https://tieba.baidu.com/p/81000000119?pn=2",
    };
    mocks.activeSession = mismatchedSession;
    mocks.loadHistory.mockResolvedValue([
      persistentHistoryEntry(fixture.session, fixture.result),
    ]);
    mocks.loadSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      autoAnalyzeWholeThread: true,
    });

    await renderApp();

    await vi.waitFor(() =>
      expect(container?.textContent).toContain(
        "缺少匹配的稳定帖子编号与规范地址",
      ),
    );
    expect(mocks.runWholeThread).not.toHaveBeenCalled();
    expect(container?.textContent).not.toContain("最高优先级线索");
  });

  it("restores same-snapshot older-version history and never auto-pays for an upgrade", async () => {
    const fixture = validTypicalFixture();
    const olderVersion: AnalysisHistoryEntry = {
      ...persistentHistoryEntry(fixture.session, fixture.result),
      analysisKey: sha256Hex("older-analysis-version") as AnalysisKey,
      analyzerVersion: "2.9.0",
      transportVersion: "sidepanel-v2",
    };
    mocks.activeSession = fixture.session;
    mocks.loadHistory.mockResolvedValue([olderVersion]);
    mocks.loadSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      autoAnalyzeWholeThread: true,
    });

    await renderApp();

    await vi.waitFor(() =>
      expect(container?.textContent).toContain(
        "正在显示同一快照的旧版 AI 初筛结果",
      ),
    );
    expect(container?.textContent).toContain("不会自行重跑");
    expect(mocks.runWholeThread).not.toHaveBeenCalled();

    await act(async () => findButton("重新分析这个快照").click());
    await act(async () => findButton("确认并创建新请求").click());
    await vi.waitFor(() => expect(mocks.runWholeThread).toHaveBeenCalledTimes(1));
  });

  it("honors a snapshot-wide deletion marker after analysis settings change", async () => {
    const fixture = validTypicalFixture();
    const identity = cacheIdentity(fixture.session);
    mocks.activeSession = fixture.session;
    mocks.loadSettings.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      autoAnalyzeWholeThread: true,
    });
    mocks.loadSnapshotCache.mockResolvedValue({
      ...identity,
      analysisKey: sha256Hex("deleted-under-an-older-analysis-key"),
      status: "unknown_after_disconnect",
      attemptId: "deleted-history-attempt",
      startedAt: "2026-08-16T08:00:00.000Z",
      updatedAt: "2026-08-16T08:05:00.000Z",
      sentAt: "2026-08-16T08:00:01.000Z",
      deadlineAt: "2026-08-16T08:10:01.000Z",
      completedAt: "2026-08-16T08:05:00.000Z",
      error: { category: "storage", code: "history_deleted" },
    });

    await renderApp();

    await vi.waitFor(() =>
      expect(container?.textContent).toContain("防重复计费标记仍保留"),
    );
    expect(mocks.loadSnapshotCache).toHaveBeenCalledWith(identity.snapshotId);
    expect(mocks.runWholeThread).not.toHaveBeenCalled();
  });

  it("does not display or bind a snapshot-wide success cache without thread identity", async () => {
    const fixture = validTypicalFixture();
    const marker = {
      ...successCache(fixture.session, fixture.result),
      analysisKey: sha256Hex("success-under-an-older-analysis-key") as AnalysisKey,
      attemptId: "attempt:snapshot-success-marker",
    };
    mocks.activeSession = fixture.session;
    mocks.loadSnapshotCache
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(marker);
    await renderApp();
    await vi.waitFor(() => expect(mocks.loadSnapshotCache).toHaveBeenCalledTimes(1));

    await act(async () => findButton("开始 AI 初筛").click());
    await vi.waitFor(() =>
      expect(container?.textContent).toContain("没有可核对的帖子身份"),
    );
    expect(mocks.runWholeThread).not.toHaveBeenCalled();
    expect(container?.textContent).not.toContain("最高优先级线索");
    expect(container?.textContent).not.toContain(fixture.result.summary);
    expect(findButton("核对后再次付费分析")).not.toBeNull();
    expect(mocks.saveRecords).not.toHaveBeenCalled();
  });

  it("does not attach decisions when snapshot, thread, or finding identity differs", async () => {
    const fixture = validTypicalFixture();
    const entry = persistentHistoryEntry(fixture.session, fixture.result);
    const base: ReviewRecord = {
      schemaVersion: "1.0",
      id: "00000000-0000-4000-8000-000000000910",
      threadId: entry.threadId,
      threadUrl: entry.threadUrl,
      replyIds: entry.result.findings[0]?.replyIds ?? [],
      decision: "watch",
      primaryReasonId: null,
      internalTags: [],
      reviewedAt: "2026-08-16T08:30:00.000Z",
      analysisAttemptId: entry.attemptId,
      snapshotId: entry.snapshotId,
      findingId: entry.result.findings[0]?.id ?? null,
      analyzerVersions: {
        local: "disabled",
        cloud: "3.0.0",
        rules: "2026.07",
      },
    };
    const decisions: ReviewRecord[] = [
      base,
      {
        ...base,
        id: "00000000-0000-4000-8000-000000000911",
        snapshotId: sha256Hex("different-snapshot"),
      },
      {
        ...base,
        id: "00000000-0000-4000-8000-000000000912",
        threadId: "99999999999",
        threadUrl: "https://tieba.baidu.com/p/99999999999",
      },
      {
        ...base,
        id: "00000000-0000-4000-8000-000000000913",
        findingId: "AI-not-in-this-result",
      },
    ];
    mocks.activeSession = fixture.session;
    mocks.loadHistory.mockResolvedValue([entry]);
    mocks.loadRecords.mockResolvedValue(decisions);

    await renderApp();
    await act(async () => findButton("历史").click());

    expect(container?.textContent).toContain("1 条人工决定");
    expect(container?.textContent).toContain("未关联报告的人工决定（3）");
  });

  it("restores delete focus to the triggering report when several reports are open", async () => {
    const fixture = validTypicalFixture();
    const first = persistentHistoryEntry(
      fixture.session,
      fixture.result,
      "attempt:first-focus-report",
    );
    const second: AnalysisHistoryEntry = {
      ...persistentHistoryEntry(
        fixture.session,
        fixture.result,
        "attempt:second-focus-report",
      ),
      completedAt: "2026-08-02T02:02:00.000Z",
    };
    mocks.activeSession = fixture.session;
    mocks.loadHistory.mockResolvedValue([first, second]);
    await renderApp();
    await act(async () => findButton("历史").click());

    const entries = [
      ...(container?.querySelectorAll<HTMLDetailsElement>(".history-entry") ?? []),
    ];
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      await act(async () => entry.querySelector("summary")?.click());
    }
    const firstDelete = entries[0]!.querySelector<HTMLButtonElement>(
      ".history-actions > button",
    );
    expect(firstDelete).not.toBeNull();
    await act(async () => firstDelete!.click());
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("取消"));
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      await Promise.resolve();
    });

    const restoredFirstDelete = entries[0]!.querySelector<HTMLButtonElement>(
      ".history-actions > button",
    );
    const secondDelete = entries[1]!.querySelector<HTMLButtonElement>(
      ".history-actions > button",
    );
    expect(document.activeElement).toBe(restoredFirstDelete);
    expect(document.activeElement).not.toBe(secondDelete);
  });

  it("deletes only the selected local report without navigation or a model request", async () => {
    const fixture = validTypicalFixture();
    const entry = persistentHistoryEntry(fixture.session, fixture.result);
    let cached: ReturnType<typeof successCache> | Record<string, unknown> | null =
      successCache(fixture.session, fixture.result);
    let storedHistory = [entry];
    const linkedDecision: ReviewRecord = {
      schemaVersion: "1.0",
      id: "00000000-0000-4000-8000-000000000901",
      threadId: entry.threadId,
      threadUrl: entry.threadUrl,
      replyIds: entry.result.findings[0]?.replyIds ?? [],
      decision: "watch",
      primaryReasonId: null,
      internalTags: [],
      reviewedAt: "2026-08-16T08:30:00.000Z",
      analysisAttemptId: entry.attemptId,
      snapshotId: entry.snapshotId,
      findingId: entry.result.findings[0]?.id ?? null,
      analyzerVersions: {
        local: "disabled",
        cloud: "3.0.0",
        rules: "2026.07",
      },
    };
    mocks.activeSession = fixture.session;
    mocks.loadHistory.mockImplementation(async () => storedHistory);
    mocks.loadRecords.mockResolvedValue([linkedDecision]);
    mocks.loadCache.mockImplementation(async () => cached);
    mocks.clearCache.mockImplementation(async () => {
      cached = null;
    });
    mocks.saveCache.mockImplementation(async (entryToSave) => {
      cached = entryToSave as Record<string, unknown>;
    });
    mocks.deleteHistory.mockImplementation(async (attemptId: string) => {
      storedHistory = storedHistory.filter(
        (candidate) => candidate.attemptId !== attemptId,
      );
    });
    await renderApp();
    await act(async () => findButton("历史").click());

    const details = container?.querySelector<HTMLDetailsElement>(".history-entry");
    await act(async () => details?.querySelector("summary")?.click());
    const deleteTrigger = findButton("删除本机报告");
    expect(deleteTrigger.getAttribute("aria-label")).toContain(entry.threadTitle);
    await act(async () => deleteTrigger.click());
    expect(container?.textContent).toContain("不会删除贴吧内容");
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("取消"));
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      await Promise.resolve();
    });
    expect(container?.textContent).not.toContain("确认删除本机 AI 报告");
    const restoredDeleteTrigger = findButton("删除本机报告");
    expect(document.activeElement).toBe(restoredDeleteTrigger);
    await act(async () => restoredDeleteTrigger.click());
    await act(async () => findButton("确认删除").click());
    await vi.waitFor(() =>
      expect(mocks.deleteHistory).toHaveBeenCalledWith(entry.attemptId),
    );
    expect(container?.textContent).toContain("还没有 AI 分析历史");
    expect(container?.textContent).toContain("未关联报告的人工决定（1）");
    expect(mocks.clearCache).toHaveBeenCalledWith(entry.analysisKey);
    expect(cached).toMatchObject({
      status: "unknown_after_disconnect",
      attemptId: entry.attemptId,
      error: { category: "storage", code: "history_deleted" },
    });
    expect(cached).not.toHaveProperty("result");
    const historySaveCallsAfterDelete = mocks.saveHistory.mock.calls.length;
    await act(async () => Promise.resolve());
    expect(mocks.saveHistory).toHaveBeenCalledTimes(historySaveCallsAfterDelete);
    expect(mocks.runWholeThread).not.toHaveBeenCalled();
    expect(mocks.tabsUpdate).not.toHaveBeenCalled();
    expect(mocks.tabsReload).not.toHaveBeenCalled();
  });
});

describe("reason library", () => {
  it("keeps every category attached to its own panel and opens only one", async () => {
    await renderApp();
    await act(async () => findButton("理由库").click());

    const categories = [
      ...(container?.querySelectorAll<HTMLButtonElement>(".reason-category-trigger") ?? []),
    ];
    expect(categories).toHaveLength(16);
    expect(container?.querySelectorAll(".reason-category-panel")).toHaveLength(16);
    expect(container?.querySelectorAll(".reason-row").length).toBeLessThanOrEqual(20);
    expect(categories.filter((button) => button.getAttribute("aria-expanded") === "true"))
      .toHaveLength(1);
    for (const category of categories) {
      const panelId = category.getAttribute("aria-controls");
      const panel = panelId ? document.getElementById(panelId) : null;
      expect(panel).not.toBeNull();
      expect(panel?.getAttribute("aria-labelledby")).toBe(category.id);
      expect(category.nextElementSibling).toBe(panel);
    }

    const firstPanel = document.getElementById(categories[0]!.getAttribute("aria-controls")!);
    expect(firstPanel?.hidden).toBe(false);
    expect(firstPanel?.querySelectorAll(".reason-row").length).toBeGreaterThan(0);
    expect(firstPanel?.querySelector(".reason-category-group")).toBeNull();
    for (const row of firstPanel?.querySelectorAll(".reason-row") ?? []) {
      expect(row.textContent).not.toContain("违法违规信息");
    }

    await act(async () => categories[1]!.click());
    expect(categories[0]?.getAttribute("aria-expanded")).toBe("false");
    expect(categories[1]?.getAttribute("aria-expanded")).toBe("true");
    expect(categories.filter((button) => button.getAttribute("aria-expanded") === "true"))
      .toHaveLength(1);
    expect(firstPanel?.hidden).toBe(true);
    const secondPanel = document.getElementById(categories[1]!.getAttribute("aria-controls")!);
    expect(secondPanel?.hidden).toBe(false);
    expect(container?.querySelectorAll(".reason-row").length).toBeLessThanOrEqual(20);
  });

  it("groups global search results by category without repeating the heading per row", async () => {
    await renderApp();
    await act(async () => findButton("理由库").click());

    const search = container?.querySelector<HTMLInputElement>(
      'input[placeholder="搜索规范原文或分类"]',
    );
    expect(search).not.toBeNull();
    await changeControlValue(search!, "引战");

    expect(container?.querySelectorAll(".reason-category-trigger")).toHaveLength(0);
    expect(container?.querySelectorAll(".reason-row")).toHaveLength(9);
    expect(container?.querySelector(".reason-result-count")?.textContent)
      .toContain("找到 9 条规范，来自 2 个分类");
    const groupHeadings = [
      ...(container?.querySelectorAll<HTMLElement>(
        ".reason-category-group > header strong",
      ) ?? []),
    ].map((heading) => heading.textContent);
    expect(groupHeadings).toEqual([
      "挑衅、钓鱼、骚扰与引战",
      "作品、角色、演员与平台相关不当讨论",
    ]);
    expect(container?.querySelectorAll(".reason-category-group")).toHaveLength(2);
    for (const row of container?.querySelectorAll(".reason-row") ?? []) {
      expect(row.querySelector(".reason-number")?.textContent).toMatch(/^第 \d+ 条$/u);
      expect(row.querySelector(".reason-text")?.textContent).not.toBe("");
      expect(row.querySelector(".reason-category-title")).toBeNull();
    }
  });
});
