import { StrictMode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getReasonById } from "../data/reasons";
import type { ReviewSession } from "../lib/session";
import type { CapturedReply } from "../types";
import { App } from "./App";

const mocks = vi.hoisted(() => ({
  activeSession: null as ReviewSession | null,
  runWholeThread: vi.fn(),
  requestPersistentPermission: vi.fn(),
  loadCache: vi.fn(),
  saveCache: vi.fn(),
  clearCache: vi.fn(),
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock("./bridge", () => ({
  getActiveTabId: vi.fn(async () => mocks.activeSession?.tabId ?? 17),
  isPersistentCloudPermissionRequired: (value: unknown) => {
    const message = value instanceof Error ? value.message : String(value ?? "");
    return (
      message.includes("固定 AI 端点权限尚未生效") ||
      message.includes("Chrome 尚未授予当前 AI 服务商")
    );
  },
  requestPersistentCloudPermission: mocks.requestPersistentPermission,
  runManagedCloudAnalysis: vi.fn(),
  runManagedWholeThreadCloudAnalysis: mocks.runWholeThread,
  sendExtensionMessage: mocks.sendMessage,
}));

vi.mock("./recordStore", () => ({
  loadStoredRecords: vi.fn(async () => []),
  saveStoredRecords: vi.fn(async () => undefined),
  loadCloudSettings: mocks.loadSettings,
  saveCloudSettings: mocks.saveSettings,
}));

vi.mock("../lib/threadCloudCache", () => ({
  clearThreadCloudCache: mocks.clearCache,
  loadThreadCloudCache: mocks.loadCache,
  saveThreadCloudCache: mocks.saveCache,
  threadCloudCacheIdentity: vi.fn(
    (
      session: ReviewSession,
      settings: { endpoint: string; model: string; mode: string },
    ) => ({
      tabId: session.tabId,
      threadId: session.threadId,
      sessionUpdatedAt: session.updatedAt,
      endpoint: settings.endpoint,
      model: settings.model,
      mode: settings.mode,
    }),
  ),
}));

function capturedReply(): CapturedReply {
  return {
    id: "main:1001",
    siteReplyId: "1001",
    floor: 1,
    parentReplyId: null,
    authorName: "测试用户",
    time: "2026-07-28 18:00",
    timestamp: Date.parse("2026-07-28T18:00:00+08:00"),
    content: "主楼正文",
    sourcePage: 1,
    sourceUrl: "https://tieba.baidu.com/p/99000000001?pid=1001",
    anchor: "[data-id='1001']",
    imageCount: 0,
    isNested: false,
    unexpandedNestedCount: 0,
  };
}

function completeSession(readableTextComplete = true): ReviewSession {
  const reply = capturedReply();
  return {
    schemaVersion: "1.0",
    sessionSchemaVersion: 3,
    tabId: 17,
    threadId: "99000000001",
    threadUrl: "https://tieba.baidu.com/p/99000000001",
    title: "测试长帖",
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
      dynamicContentMayRemain: !readableTextComplete,
      reachedReplyListEnd: readableTextComplete,
      unstableReplyIdCount: 0,
      apiCoverage: {
        mainPagesFetched: 1,
        mainPagesTotal: 1,
        mainRepliesFetched: 1,
        nestedParentsFetched: 0,
        nestedParentsTotal: 0,
        nestedRepliesFetched: 0,
        nestedRepliesDeclared: 0,
        failedRequestCount: readableTextComplete ? 0 : 1,
        unavailableReplyCount: 0,
        readableTextComplete,
      },
      isComplete: readableTextComplete,
    },
    errors: [],
    warnings: [],
    updatedAt: "2026-07-28T10:00:00.000Z",
  };
}

function replyAt({
  id,
  floor,
  authorName,
  content,
  parentReplyId = null,
}: {
  id: string;
  floor: number | null;
  authorName: string;
  content: string;
  parentReplyId?: string | null;
}): CapturedReply {
  return {
    ...capturedReply(),
    id,
    siteReplyId: id,
    floor,
    parentReplyId,
    authorName,
    content,
    sourceUrl: `https://tieba.baidu.com/p/99000000001?pid=${id}`,
    anchor: `[data-id='${id}']`,
    isNested: parentReplyId !== null,
  };
}

function sessionWithCloudEvidence(): ReviewSession {
  const replies = [
    replyAt({
      id: "main:3100",
      floor: 31,
      authorName: "橘子汽水",
      content: "你根本没有思考能力。",
    }),
    replyAt({
      id: "nested:3101",
      floor: 31,
      authorName: "葡萄软糖",
      content: "这是在说剧情，不是在说你。",
      parentReplyId: "main:3100",
    }),
    replyAt({
      id: "main:6000",
      floor: 60,
      authorName: "月下骑士",
      content: "相同内容",
    }),
    replyAt({
      id: "main:unknown-floor",
      floor: null,
      authorName: "风铃",
      content: "相同内容",
    }),
    replyAt({
      id: "nested:unknown-parent-floor",
      floor: null,
      authorName: "青空",
      content: "相同内容",
      parentReplyId: "main:unknown-floor",
    }),
    replyAt({
      id: "main:thread-op",
      floor: 1,
      authorName: "楼主",
      content: "相同内容",
    }),
  ];
  const session = completeSession();
  return {
    ...session,
    replies,
    coverage: {
      ...session.coverage,
      visibleReplyCount: replies.length,
      mainReplyCount: 4,
      nestedReplyCount: 2,
      apiCoverage: {
        ...session.coverage.apiCoverage!,
        mainRepliesFetched: 4,
        nestedParentsFetched: 2,
        nestedParentsTotal: 2,
        nestedRepliesFetched: 2,
        nestedRepliesDeclared: 2,
      },
    },
  };
}

let tabUpdatedListeners: Array<
  (
    tabId: number,
    changeInfo: { status?: string },
    tab: chrome.tabs.Tab,
  ) => void
> = [];
let runtimeMessageListeners: Array<(message: unknown) => void> = [];

function chromeHarness(): void {
  tabUpdatedListeners = [];
  runtimeMessageListeners = [];
  const passiveEvent = {
    addListener: vi.fn(),
    removeListener: vi.fn(),
  };
  vi.stubGlobal("chrome", {
    runtime: {
      id: "extension-test",
      onMessage: {
        addListener(listener: (message: unknown) => void) {
          runtimeMessageListeners.push(listener);
        },
        removeListener: vi.fn(),
      },
    },
    tabs: {
      onActivated: passiveEvent,
      onUpdated: {
        addListener(
          listener: (
            tabId: number,
            changeInfo: { status?: string },
            tab: chrome.tabs.Tab,
          ) => void,
        ) {
          tabUpdatedListeners.push(listener);
        },
        removeListener: vi.fn(),
      },
    },
  });
  vi.stubGlobal("scrollTo", vi.fn());
}

let root: Root | null = null;

beforeEach(() => {
  chromeHarness();
  mocks.activeSession = completeSession();
  mocks.loadSettings.mockReset().mockResolvedValue({
    provider: "alibaba",
    endpoint:
      "https://ws-7ee35od4h2zs6dft.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    model: "qwen3.7-max",
    apiKey: "session-only-key",
    mode: "fast",
    autoAnalyzeWholeThread: true,
  });
  mocks.requestPersistentPermission.mockReset().mockResolvedValue(true);
  mocks.saveSettings.mockReset().mockResolvedValue(undefined);
  mocks.loadCache.mockReset().mockResolvedValue(null);
  mocks.saveCache.mockReset().mockResolvedValue(undefined);
  mocks.clearCache.mockReset().mockResolvedValue(undefined);
  mocks.sendMessage.mockReset().mockImplementation(
    async (request: { type: string }) => {
      if (request.type === "GET_ACTIVE_SESSION") return mocks.activeSession;
      if (request.type === "GET_CLOUD_PERMISSION_STATUS") return null;
      if (request.type === "JUMP_TO_REPLY") return { ok: true };
      throw new Error(`unexpected request: ${request.type}`);
    },
  );
  mocks.runWholeThread.mockReset().mockImplementation(
    async (
      _title: string,
      _replies: CapturedReply[],
      options: { beforeStart?: () => Promise<void> },
    ) => {
      await options.beforeStart?.();
      return {
        summary: "没有发现有证据支持的违规",
        findings: [],
        uncertainties: [],
        analyzedReplyCount: 1,
        ruleCount: 112,
        omittedImageCount: 0,
      };
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
    root = null;
  }
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("automatic whole-thread review", () => {
  it("switches to fixed DeepSeek defaults and clears the previous provider key", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<App />);
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain("设置");
    });

    const settingsButton = [
      ...container.querySelectorAll<HTMLButtonElement>("nav button"),
    ].find(
      (button) => button.textContent?.includes("设置"),
    );
    await act(async () => settingsButton?.click());

    const providerSelect = container.querySelector(
      ".settings-card select",
    ) as HTMLSelectElement;
    const apiKeyInput = container.querySelector(
      'input[type="password"]',
    ) as HTMLInputElement;
    expect(apiKeyInput.value).toBe("session-only-key");

    await act(async () => {
      providerSelect.value = "deepseek";
      providerSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const readonlyEndpoint = container.querySelector(
      'input[aria-readonly="true"]',
    ) as HTMLInputElement;
    const modelInput = [...container.querySelectorAll("input")].find(
      (input) => input.value === "deepseek-v4-pro",
    );
    const modeSelect = container.querySelectorAll(
      ".settings-card select",
    )[1] as HTMLSelectElement;
    expect(readonlyEndpoint.value).toBe(
      "https://api.deepseek.com/chat/completions",
    );
    expect(readonlyEndpoint.readOnly).toBe(true);
    expect(modelInput).toBeDefined();
    expect(modeSelect.value).toBe("deep");
    expect(apiKeyInput.value).toBe("");
  });

  it("starts exactly one paid request for a complete API snapshot even under StrictMode", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <StrictMode>
          <App />
        </StrictMode>,
      );
    });
    await vi.waitFor(() => {
      expect(mocks.runWholeThread).toHaveBeenCalledTimes(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(mocks.runWholeThread).toHaveBeenCalledTimes(1);
    expect(mocks.saveCache).toHaveBeenCalledTimes(2);
    expect(mocks.saveCache.mock.calls[0]?.[0]).toMatchObject({
      status: "pending",
      startedAt: expect.any(String),
    });
    expect(mocks.saveCache.mock.calls[1]?.[0]).toMatchObject({
      status: "success",
    });
    expect(mocks.runWholeThread).toHaveBeenCalledWith(
      "测试长帖",
      mocks.activeSession?.replies,
      expect.objectContaining({
        endpoint:
          "https://ws-7ee35od4h2zs6dft.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        model: "qwen3.7-max",
        apiKey: "session-only-key",
        mode: "fast",
      }),
    );
  });

  it("does not send a DOM fallback or incomplete API snapshot", async () => {
    mocks.activeSession = completeSession(false);
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<App />);
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(mocks.runWholeThread).not.toHaveBeenCalled();
    expect(container.textContent).toContain("已禁止自动外发");
  });

  it("invalidates an automatic run when provider settings change while its cache read is pending", async () => {
    let resolveCache!: (value: null) => void;
    mocks.loadCache.mockImplementation(
      () =>
        new Promise<null>((resolve) => {
          resolveCache = resolve;
        }),
    );
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<App />));
    await vi.waitFor(() => expect(mocks.loadCache).toHaveBeenCalledTimes(1));

    const settingsButton = [
      ...container.querySelectorAll<HTMLButtonElement>("nav button"),
    ].find((button) => button.textContent?.includes("设置"));
    await act(async () => settingsButton?.click());
    const providerSelect = container.querySelector(
      ".settings-card select",
    ) as HTMLSelectElement;
    await act(async () => {
      providerSelect.value = "deepseek";
      providerSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => resolveCache(null));

    expect(mocks.runWholeThread).not.toHaveBeenCalled();
    expect(mocks.saveCache).not.toHaveBeenCalled();
  });

  it("locks an ordinary retry synchronously so a double click starts only one paid run", async () => {
    mocks.loadCache.mockResolvedValue({
      status: "failed",
      error: "模型服务返回 HTTP 500",
    });
    let resolveClear!: () => void;
    mocks.clearCache.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveClear = resolve;
        }),
    );
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<App />));
    await vi.waitFor(() => {
      expect(container.textContent).toContain("重新分析整帖");
    });
    const retry = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("重新分析整帖"));

    act(() => retry?.click());
    act(() => retry?.click());
    expect(mocks.clearCache).toHaveBeenCalledTimes(1);
    expect(mocks.runWholeThread).not.toHaveBeenCalled();
    await act(async () => resolveClear());
    await vi.waitFor(() => expect(mocks.runWholeThread).toHaveBeenCalledTimes(1));

    expect(mocks.clearCache).toHaveBeenCalledTimes(1);
    expect(mocks.saveCache.mock.calls.map(([entry]) => entry.status)).toEqual([
      "pending",
      "success",
    ]);
  });

  it("invalidates an ordinary retry when settings change during cache clearing", async () => {
    mocks.loadCache.mockResolvedValue({
      status: "failed",
      error: "模型服务返回 HTTP 500",
    });
    let resolveClear!: () => void;
    mocks.clearCache.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveClear = resolve;
        }),
    );
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<App />));
    await vi.waitFor(() => {
      expect(container.textContent).toContain("重新分析整帖");
    });
    const retry = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("重新分析整帖"));
    act(() => retry?.click());
    expect(mocks.clearCache).toHaveBeenCalledTimes(1);

    const settingsButton = [
      ...container.querySelectorAll<HTMLButtonElement>("nav button"),
    ].find((button) => button.textContent?.includes("设置"));
    await act(async () => settingsButton?.click());
    const modeSelect = container.querySelectorAll(
      ".settings-card select",
    )[1] as HTMLSelectElement;
    await act(async () => {
      modeSelect.value = "deep";
      modeSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => resolveClear());

    expect(mocks.runWholeThread).not.toHaveBeenCalled();
    expect(mocks.saveCache).not.toHaveBeenCalled();
  });

  it("does not mark a stale settings save ready or auto-send its newer unsaved draft", async () => {
    mocks.loadSettings.mockResolvedValue({
      provider: "alibaba",
      endpoint:
        "https://ws-7ee35od4h2zs6dft.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      model: "qwen3.7-max",
      apiKey: "session-only-key",
      mode: "fast",
      autoAnalyzeWholeThread: false,
    });
    let resolveSave!: () => void;
    mocks.saveSettings.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<App />));
    const settingsButton = [
      ...container.querySelectorAll<HTMLButtonElement>("nav button"),
    ].find((button) => button.textContent?.includes("设置"));
    await act(async () => settingsButton?.click());

    const toggle = container.querySelector(
      '.settings-card input[type="checkbox"]',
    ) as HTMLInputElement;
    await act(async () => {
      toggle.click();
    });
    const save = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "保存设置");
    act(() => save?.click());
    expect(mocks.saveSettings).toHaveBeenCalledTimes(1);

    const modeSelect = container.querySelectorAll(
      ".settings-card select",
    )[1] as HTMLSelectElement;
    await act(async () => {
      modeSelect.value = "deep";
      modeSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => resolveSave());
    await vi.waitFor(() => {
      expect(container.textContent).toContain("新设置尚未启用，请重新保存");
    });

    expect(mocks.runWholeThread).not.toHaveBeenCalled();
    expect(mocks.saveCache).not.toHaveBeenCalled();
  });

  it("does not expose local heuristic judgments while the whole-thread model has no result", async () => {
    const session = completeSession();
    mocks.activeSession = {
      ...session,
      replies: [{ ...session.replies[0]!, content: "你就是个傻逼，滚出去。" }],
    };
    mocks.loadSettings.mockResolvedValue({
      provider: "deepseek",
      endpoint: "https://api.deepseek.com/chat/completions",
      model: "deepseek-v4-pro",
      apiKey: "session-only-key",
      mode: "deep",
      autoAnalyzeWholeThread: false,
    });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(<App />));
    await vi.waitFor(() => {
      expect(container.textContent).toContain("尚无模型审阅结论");
    });

    expect(container.textContent).toContain(
      "本地只负责读取、覆盖校验和脱敏",
    );
    expect(container.textContent).not.toContain("本地发现");
    expect(container.textContent).not.toContain("本地线索");
    expect(container.textContent).not.toContain("风险队列");
    expect(container.querySelector(".finding-card")).toBeNull();
    expect(
      [...container.querySelectorAll("nav button")].some(
        (button) => button.textContent === "时间线",
      ),
    ).toBe(false);
    expect(mocks.runWholeThread).not.toHaveBeenCalled();
  });

  it("renders model findings as actionable floor and author groups", async () => {
    mocks.activeSession = sessionWithCloudEvidence();
    mocks.runWholeThread.mockImplementation(
      async (
        _title: string,
        _replies: CapturedReply[],
        options: { beforeStart?: () => Promise<void> },
      ) => {
        await options.beforeStart?.();
        return {
          summary:
            "多数讨论正常。1) U1在P1贬损U2；2) P3至P6可能属于重复回复；U99提到P99。CPU31型号不是匿名编号。",
          findings: [
            {
              id: "AI-1-personal_attack-main:3100",
              type: "personal_attack",
              severity: "high",
              score: 91,
              summary: "U1在P1对U2作出智力贬损。",
              replyIds: ["main:3100"],
              contextReplyIds: ["nested:3101"],
              participantNames: ["橘子汽水"],
              evidence: [
                {
                  replyId: "main:3100",
                  excerpt: "你根本没有思考能力。",
                  signals: ["AI：直接评价对方智力"],
                  score: 91,
                },
              ],
              reasonCandidates: [
                {
                  reasonId: "R03.04",
                  confidence: 0.94,
                  rationale: "将观点分歧上升到智力评价",
                },
              ],
              uncertainties: ["需要结合P2确认U2是否为被攻击对象。"],
            },
            {
              id: "AI-2-spam-main:6000",
              type: "spam",
              severity: "medium",
              score: 63,
              summary: "P3至P6的内容可能重复。",
              replyIds: [
                "main:6000",
                "main:unknown-floor",
                "nested:unknown-parent-floor",
                "main:thread-op",
              ],
              participantNames: ["月下骑士", "风铃", "青空", "楼主"],
              evidence: [
                {
                  replyId: "main:6000",
                  excerpt: "相同内容",
                  signals: ["AI：疑似重复内容"],
                  score: 63,
                },
                {
                  replyId: "main:unknown-floor",
                  excerpt: "相同内容",
                  signals: ["AI：疑似重复内容"],
                  score: 63,
                },
              ],
              reasonCandidates: [
                {
                  reasonId: "R06.05",
                  confidence: 0.7,
                  rationale: "需要核对发布时间与重复次数",
                },
              ],
              uncertainties: [],
            },
          ],
          uncertainties: [
            "P2可能是在引用他人；需人工查看上下文。",
            "P3和P4的重复次数仍需确认。",
          ],
          report: {
            discussionOverview:
              "整帖主要讨论角色塑造，U1与U2在P1附近出现争论。",
            discussionMap: [
              "前半段集中讨论剧情逻辑。",
              "P3之后转向角色表现力。",
            ],
            participantDynamics: ["U1回复U2，U3后来加入讨论。"],
            borderlineCases: [
              "P2的语气较重，但更像引用而不是直接攻击。",
            ],
            normalHeatedDiscussion: [
              "P3对虚构角色的激烈批评包含具体理由，不建议处罚。",
            ],
            coverageNotes: ["P99无法定位，15张图片未发送。"],
            reviewPriorities: [
              "先复核P1与P2的直接上下文。",
              "再核对P3至P6的重复频次。",
            ],
          },
          narrativeReferences: {
            summary: {
              text: "多数讨论正常。",
              replyIds: ["main:3100"],
            },
            findings: {
              "AI-1-personal_attack-main:3100": {
                summary: {
                  text: "U1在P1对U2作出智力贬损。",
                  replyIds: ["main:3100", "nested:3101"],
                },
                rationale: {
                  text: "将观点分歧上升到智力评价",
                  replyIds: ["main:3100", "nested:3101"],
                },
                uncertainties: [
                  {
                    text: "需要结合P2确认U2是否为被攻击对象。",
                    replyIds: ["nested:3101"],
                  },
                ],
                evidence: {
                  "main:3100": {
                    text: "AI：直接评价对方智力",
                    replyIds: ["nested:3101"],
                  },
                },
              },
              "AI-2-spam-main:6000": {
                summary: {
                  text: "P3至P6的内容可能重复。",
                  replyIds: ["main:6000", "main:unknown-floor"],
                },
                rationale: {
                  text: "需要核对发布时间与重复次数",
                  replyIds: ["main:6000"],
                },
                uncertainties: [],
                evidence: {
                  "main:6000": {
                    text: "AI：疑似重复内容",
                    replyIds: ["main:unknown-floor"],
                  },
                  "main:unknown-floor": {
                    text: "AI：疑似重复内容",
                    replyIds: ["main:6000"],
                  },
                },
              },
            },
            uncertainties: [
              {
                text: "P2可能是在引用他人；需人工查看上下文。",
                replyIds: ["nested:3101"],
              },
              {
                text: "P3和P4的重复次数仍需确认。",
                replyIds: ["main:6000", "main:unknown-floor"],
              },
            ],
            report: {
              discussionOverview: {
                text: "整帖主要讨论角色塑造。",
                replyIds: ["main:3100", "nested:3101"],
              },
              discussionMap: [
                { text: "前半段集中讨论剧情逻辑。", replyIds: [] },
                { text: "P3之后转向角色表现力。", replyIds: ["main:6000"] },
              ],
              participantDynamics: [
                {
                  text: "U1回复U2，U3后来加入讨论。",
                  replyIds: ["main:3100", "nested:3101", "main:6000"],
                },
              ],
              borderlineCases: [
                {
                  text: "P2的语气较重。",
                  replyIds: ["nested:3101"],
                },
              ],
              normalHeatedDiscussion: [
                {
                  text: "P3是正常激烈讨论。",
                  replyIds: ["main:6000"],
                },
              ],
              coverageNotes: [
                { text: "图片未发送。", replyIds: [] },
              ],
              reviewPriorities: [
                {
                  text: "先复核P1与P2。",
                  replyIds: ["main:3100", "nested:3101"],
                },
                {
                  text: "再核对P3至P6。",
                  replyIds: ["main:6000", "main:unknown-floor"],
                },
              ],
            },
          },
          analyzedReplyCount: 6,
          ruleCount: 112,
          omittedImageCount: 15,
        };
      },
    );
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<App />);
    });
    await vi.waitFor(() => {
      expect(container.querySelectorAll(".cloud-finding-item")).toHaveLength(2);
    });

    expect(container.textContent).toContain("2 组违规线索");
    expect(container.textContent).toContain("第 31 楼");
    expect(container.textContent).toContain("第 31 楼的楼中楼");
    expect(container.textContent).toContain("橘子汽水");
    expect(container.textContent).toContain("葡萄软糖");
    expect(container.textContent).toContain("第 60 楼");
    expect(container.textContent).toContain("月下骑士");
    expect(container.textContent).toContain("主楼（1楼）");
    expect(container.textContent).toContain("主回复（楼层未知）");
    expect(container.textContent).toContain("楼中楼（父楼未知）");
    expect(container.textContent).toContain("无法定位的用户");
    expect(container.textContent).toContain("无法定位的回复");
    expect(container.textContent).not.toContain("U99");
    expect(container.textContent).not.toContain("P99");
    expect(container.textContent).toContain("CPU31型号不是匿名编号");
    expect(container.textContent).toContain("建议规范 · R03.04");
    expect(container.textContent).toContain(getReasonById("R03.04")?.text);
    expect(container.textContent).toContain("可能产生一次新的费用");
    expect(container.textContent).not.toMatch(/\b[PU][123]\b/u);
    expect(container.textContent).toContain("讨论主题与整体走向");
    expect(container.textContent).toContain("议题与讨论脉络");
    expect(container.textContent).toContain("参与者与回复关系");
    expect(container.textContent).toContain("吧务复核优先级");
    expect(container.textContent).toContain("边界案例（暂不列为违规）");
    expect(container.textContent).toContain("激烈但正常的讨论");
    expect(container.textContent).toContain("覆盖范围与未审内容");
    expect(container.textContent).toContain(
      "第 31 楼（橘子汽水）附近出现争论",
    );
    expect(container.textContent).toContain("月下骑士后来加入讨论");
    expect(container.textContent).not.toContain("P99");
    expect(container.textContent).not.toContain("U1");
    expect(container.textContent).not.toMatch(
      /(^|[^A-Za-z0-9_])[PU]\d+(?=$|[^A-Za-z0-9_])/u,
    );
    expect(container.querySelectorAll(".cloud-report-section")).toHaveLength(7);
    expect(
      container.querySelectorAll(
        ".cloud-overview .narrative-reference-links button",
      ),
    ).toHaveLength(1);
    expect(
      container.querySelectorAll(
        ".cloud-report-sections .narrative-reference-links button",
      ).length,
    ).toBeGreaterThanOrEqual(10);
    const actionableFindings = container.querySelector(
      ".cloud-actionable-findings",
    );
    expect(
      actionableFindings?.querySelectorAll(".cloud-finding-item"),
    ).toHaveLength(2);
    expect(actionableFindings?.textContent).not.toContain(
      "更像引用而不是直接攻击",
    );
    expect(actionableFindings?.textContent).not.toContain("不建议处罚");
    expect(container.querySelectorAll(".cloud-overview p").length).toBeGreaterThan(1);
    expect(
      container.querySelectorAll(".cloud-overall-cautions li"),
    ).toHaveLength(2);
    expect(container.querySelector(".cloud-overall-cautions")?.textContent).toContain(
      "第 31 楼的楼中楼（葡萄软糖）可能是在引用他人",
    );
    expect(container.querySelector(".cloud-reply-link time")?.textContent).toBe(
      "2026-07-28 18:00",
    );
    expect(container.querySelector(".cloud-reply-excerpt")?.textContent).toContain(
      "你根本没有思考能力",
    );
    const firstFinding = container.querySelector(".cloud-finding-item");
    expect(
      firstFinding?.querySelectorAll(
        ".cloud-reply-links[aria-label='涉及的原帖回复'] .cloud-reply-link",
      ),
    ).toHaveLength(1);
    expect(
      firstFinding?.querySelectorAll(
        ".cloud-reply-links[aria-label='相关上下文（非违规证据）'] .cloud-reply-link",
      ),
    ).toHaveLength(1);
    expect(firstFinding?.textContent).toContain("相关上下文（非违规证据）");
    expect(
      firstFinding?.querySelectorAll(
        ".cloud-finding-summary .narrative-reference-links button",
      ),
    ).toHaveLength(2);
    expect(
      firstFinding?.querySelectorAll(
        ".cloud-finding-rationale .narrative-reference-links button",
      ),
    ).toHaveLength(2);
    expect(
      firstFinding?.querySelectorAll(
        ".cloud-evidence-entry .narrative-reference-links button",
      ),
    ).toHaveLength(1);
    expect(
      firstFinding?.querySelectorAll(
        ".cloud-finding-cautions .narrative-reference-links button",
      ),
    ).toHaveLength(1);
    expect(
      container.querySelectorAll(
        ".cloud-overall-cautions .narrative-reference-links button",
      ),
    ).toHaveLength(3);

    const firstReplyLink = container.querySelector<HTMLButtonElement>(
      "button[aria-label='查看原文：第 31 楼，作者 橘子汽水']",
    );
    expect(firstReplyLink).not.toBeNull();
    await act(async () => {
      firstReplyLink?.click();
    });
    expect(mocks.sendMessage).toHaveBeenCalledWith({
      type: "JUMP_TO_REPLY",
      replyId: "main:3100",
    });

    const contextReplyLink = container.querySelector<HTMLButtonElement>(
      "button[aria-label='查看相关上下文：第 31 楼的楼中楼，作者 葡萄软糖']",
    );
    expect(contextReplyLink).not.toBeNull();
    expect(contextReplyLink?.textContent).toContain("2026-07-28 18:00");
    await act(async () => {
      contextReplyLink?.click();
    });
    expect(mocks.sendMessage).toHaveBeenCalledWith({
      type: "JUMP_TO_REPLY",
      replyId: "nested:3101",
    });

    const rationaleReference = firstFinding?.querySelector<HTMLButtonElement>(
      ".cloud-finding-rationale button[aria-label='定位引用：第 31 楼的楼中楼，作者 葡萄软糖']",
    );
    expect(rationaleReference).not.toBeNull();
    await act(async () => rationaleReference?.click());
    expect(mocks.sendMessage).toHaveBeenLastCalledWith({
      type: "JUMP_TO_REPLY",
      replyId: "nested:3101",
    });
  });

  it("does not automatically resend a snapshot with a pending billing marker", async () => {
    mocks.loadCache.mockResolvedValue({
      status: "pending",
      startedAt: "2026-07-28T10:00:01.000Z",
    });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<App />);
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain("避免重复计费");
    });

    expect(mocks.runWholeThread).not.toHaveBeenCalled();
    expect(mocks.saveCache).not.toHaveBeenCalled();
  });

  it("recovers a cached withheld DeepSeek host with one explicit persistent grant and one forced analysis", async () => {
    mocks.loadSettings.mockResolvedValue({
      provider: "deepseek",
      endpoint: "https://api.deepseek.com/chat/completions",
      model: "deepseek-v4-pro",
      apiKey: "deepseek-session-key",
      mode: "deep",
      autoAnalyzeWholeThread: true,
    });
    mocks.loadCache.mockResolvedValue({
      status: "failed",
      error:
        "固定 AI 端点权限尚未生效，请在扩展管理页重新加载扩展。",
    });
    let resolvePermission!: (granted: boolean) => void;
    mocks.requestPersistentPermission.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolvePermission = resolve;
        }),
    );
    const events: string[] = [];
    mocks.requestPersistentPermission.mockImplementationOnce((endpoint) => {
      events.push(`request:${endpoint}`);
      return new Promise<boolean>((resolve) => {
        resolvePermission = resolve;
      });
    });
    mocks.clearCache.mockImplementation(async () => {
      events.push("clear-cache");
    });
    mocks.runWholeThread.mockImplementation(
      async (
        _title: string,
        _replies: CapturedReply[],
        options: { beforeStart?: () => Promise<void> },
      ) => {
        events.push("analyze");
        await options.beforeStart?.();
        return {
          summary: "授权后的单次分析完成",
          findings: [],
          uncertainties: [],
          analyzedReplyCount: 1,
          ruleCount: 112,
          omittedImageCount: 0,
        };
      },
    );

    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <StrictMode>
          <App />
        </StrictMode>,
      );
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain("授权 DeepSeek 并分析");
    });
    expect(container.textContent).toContain("需要授权 DeepSeek 网络权限");
    expect(container.textContent).not.toContain("等待完整整帖快照");
    expect(container.textContent).toContain("仅授权 api.deepseek.com");
    expect(container.textContent).toContain("直到你在 Chrome 扩展设置中撤销");
    expect(container.textContent).not.toContain("可能产生一次新的费用");
    expect(mocks.runWholeThread).not.toHaveBeenCalled();

    const authorize = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("授权 DeepSeek 并分析"));
    act(() => authorize?.click());
    act(() => authorize?.click());

    // The browser prompt begins in the synchronous click stack. No cache or
    // reviewed-text operation may happen while the choice is still pending.
    expect(events).toEqual([
      "request:https://api.deepseek.com/chat/completions",
    ]);
    expect(mocks.clearCache).not.toHaveBeenCalled();
    expect(mocks.runWholeThread).not.toHaveBeenCalled();
    expect(container.textContent).toContain("在允许前不会发送任何帖子正文");

    await act(async () => {
      resolvePermission(true);
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain("授权后的单次分析完成");
    });

    expect(events).toEqual([
      "request:https://api.deepseek.com/chat/completions",
      "clear-cache",
      "analyze",
    ]);
    expect(mocks.requestPersistentPermission).toHaveBeenCalledTimes(1);
    expect(mocks.clearCache).toHaveBeenCalledTimes(1);
    expect(mocks.runWholeThread).toHaveBeenCalledTimes(1);
    expect(mocks.saveCache.mock.calls.map(([entry]) => entry.status)).toEqual([
      "pending",
      "success",
    ]);
  });

  it("keeps the failed marker and sends no thread when DeepSeek permission is denied", async () => {
    mocks.loadSettings.mockResolvedValue({
      provider: "deepseek",
      endpoint: "https://api.deepseek.com/chat/completions",
      model: "deepseek-v4-pro",
      apiKey: "deepseek-session-key",
      mode: "deep",
      autoAnalyzeWholeThread: true,
    });
    mocks.loadCache.mockResolvedValue({
      status: "failed",
      error: "Chrome 尚未授予当前 AI 服务商的固定域名权限。",
    });
    mocks.requestPersistentPermission.mockResolvedValue(false);

    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<App />));
    await vi.waitFor(() => {
      expect(container.textContent).toContain("授权 DeepSeek 并分析");
    });

    const authorize = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("授权 DeepSeek 并分析"));
    await act(async () => authorize?.click());
    await vi.waitFor(() => {
      expect(container.textContent).toContain("帖子正文尚未发送");
    });

    expect(mocks.requestPersistentPermission).toHaveBeenCalledTimes(1);
    expect(mocks.clearCache).not.toHaveBeenCalled();
    expect(mocks.runWholeThread).not.toHaveBeenCalled();
    expect(mocks.saveCache).not.toHaveBeenCalled();
    expect(container.textContent).toContain("授权 DeepSeek 并分析");
  });

  it("keeps the authorization recovery path when Chrome rejects the permission promise", async () => {
    mocks.loadSettings.mockResolvedValue({
      provider: "deepseek",
      endpoint: "https://api.deepseek.com/chat/completions",
      model: "deepseek-v4-pro",
      apiKey: "deepseek-session-key",
      mode: "deep",
      autoAnalyzeWholeThread: true,
    });
    mocks.loadCache.mockResolvedValue({
      status: "failed",
      error: "Chrome 尚未授予当前 AI 服务商的固定域名权限。",
    });
    mocks.requestPersistentPermission.mockRejectedValue(
      new Error("This function must be called during a user gesture"),
    );

    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<App />));
    await vi.waitFor(() => {
      expect(container.textContent).toContain("授权 DeepSeek 并分析");
    });
    const authorize = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("授权 DeepSeek 并分析"));
    await act(async () => authorize?.click());
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Chrome 未能完成 DeepSeek 授权");
    });

    expect(container.textContent).toContain("帖子正文尚未发送");
    expect(container.textContent).toContain("需要授权 DeepSeek 网络权限");
    expect(container.textContent).not.toContain("可能产生一次新的费用");
    expect(mocks.clearCache).not.toHaveBeenCalled();
    expect(mocks.runWholeThread).not.toHaveBeenCalled();
    expect(mocks.saveCache).not.toHaveBeenCalled();
  });

  it("does not send the old thread if the active session changes while the permission prompt is open", async () => {
    mocks.loadSettings.mockResolvedValue({
      provider: "deepseek",
      endpoint: "https://api.deepseek.com/chat/completions",
      model: "deepseek-v4-pro",
      apiKey: "deepseek-session-key",
      mode: "deep",
      autoAnalyzeWholeThread: true,
    });
    mocks.loadCache.mockResolvedValue({
      status: "failed",
      error: "Chrome 尚未授予当前 AI 服务商的固定域名权限。",
    });
    let resolvePermission!: (granted: boolean) => void;
    mocks.requestPersistentPermission.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolvePermission = resolve;
        }),
    );

    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<App />));
    await vi.waitFor(() => {
      expect(container.textContent).toContain("授权 DeepSeek 并分析");
    });
    const authorize = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("授权 DeepSeek 并分析"));
    act(() => authorize?.click());

    const differentThread = completeSession();
    mocks.activeSession = {
      ...differentThread,
      threadId: "99999999999",
      threadUrl: "https://tieba.baidu.com/p/99999999999",
    };
    await act(async () => {
      resolvePermission(true);
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain("已经离开原帖子");
    });

    expect(mocks.requestPersistentPermission).toHaveBeenCalledTimes(1);
    expect(mocks.clearCache).not.toHaveBeenCalled();
    expect(mocks.runWholeThread).not.toHaveBeenCalled();
    expect(mocks.saveCache).not.toHaveBeenCalled();
  });

  it("does not use a granted DeepSeek prompt after the provider settings change", async () => {
    mocks.loadSettings.mockResolvedValue({
      provider: "deepseek",
      endpoint: "https://api.deepseek.com/chat/completions",
      model: "deepseek-v4-pro",
      apiKey: "deepseek-session-key",
      mode: "deep",
      autoAnalyzeWholeThread: true,
    });
    mocks.loadCache.mockResolvedValue({
      status: "failed",
      error: "Chrome 尚未授予当前 AI 服务商的固定域名权限。",
    });
    let resolvePermission!: (granted: boolean) => void;
    mocks.requestPersistentPermission.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolvePermission = resolve;
        }),
    );

    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<App />));
    await vi.waitFor(() => {
      expect(container.textContent).toContain("授权 DeepSeek 并分析");
    });
    const authorize = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("授权 DeepSeek 并分析"));
    act(() => authorize?.click());

    const settingsButton = [
      ...container.querySelectorAll<HTMLButtonElement>("nav button"),
    ].find((button) => button.textContent?.includes("设置"));
    await act(async () => settingsButton?.click());
    const providerSelect = container.querySelector(
      ".settings-card select",
    ) as HTMLSelectElement;
    await act(async () => {
      providerSelect.value = "alibaba";
      providerSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      resolvePermission(true);
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain("帖子或 AI 设置已经变化");
    });

    expect(mocks.requestPersistentPermission).toHaveBeenCalledTimes(1);
    expect(mocks.clearCache).not.toHaveBeenCalled();
    expect(mocks.runWholeThread).not.toHaveBeenCalled();
    expect(mocks.saveCache).not.toHaveBeenCalled();
  });

  it("keeps ordinary provider failures on the paid retry path", async () => {
    mocks.loadCache.mockResolvedValue({
      status: "failed",
      error: "模型服务返回 HTTP 500",
    });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<App />));

    await vi.waitFor(() => {
      expect(container.textContent).toContain("模型服务返回 HTTP 500");
    });
    expect(container.textContent).toContain("整帖 AI 审阅未完成");
    expect(container.textContent).not.toContain("等待完整整帖快照");
    expect(container.textContent).toContain("重新分析整帖");
    expect(container.textContent).toContain("可能产生一次新的费用");
    expect(container.textContent).not.toContain("授权 DeepSeek 并分析");
    expect(mocks.requestPersistentPermission).not.toHaveBeenCalled();
  });

  it("does not cancel the current analysis when an unrelated tab starts loading", async () => {
    let resolveAnalysis!: (value: {
      summary: string;
      findings: [];
      uncertainties: [];
      analyzedReplyCount: number;
      ruleCount: number;
      omittedImageCount: number;
    }) => void;
    mocks.runWholeThread.mockImplementation(
      async (
        _title: string,
        _replies: CapturedReply[],
        options: { beforeStart?: () => Promise<void> },
      ) => {
        await options.beforeStart?.();
        return new Promise((resolve) => {
          resolveAnalysis = resolve;
        });
      },
    );
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<App />);
    });
    await vi.waitFor(() => {
      expect(mocks.runWholeThread).toHaveBeenCalledTimes(1);
    });
    const options = mocks.runWholeThread.mock.calls[0]?.[2] as {
      signal: AbortSignal;
    };

    for (const listener of tabUpdatedListeners) {
      listener(999, { status: "loading" }, { id: 999, active: false } as chrome.tabs.Tab);
    }
    expect(options.signal.aborted).toBe(false);

    await act(async () => {
      resolveAnalysis({
        summary: "完成",
        findings: [],
        uncertainties: [],
        analyzedReplyCount: 1,
        ruleCount: 112,
        omittedImageCount: 0,
      });
    });
  });

  it("does not invalidate the current analysis for unrelated session clear or suspend messages", async () => {
    let resolveAnalysis!: (value: {
      summary: string;
      findings: [];
      uncertainties: [];
      analyzedReplyCount: number;
      ruleCount: number;
      omittedImageCount: number;
    }) => void;
    mocks.runWholeThread.mockImplementation(
      async (
        _title: string,
        _replies: CapturedReply[],
        options: { beforeStart?: () => Promise<void> },
      ) => {
        await options.beforeStart?.();
        return new Promise((resolve) => {
          resolveAnalysis = resolve;
        });
      },
    );
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<App />));
    await vi.waitFor(() => {
      expect(mocks.runWholeThread).toHaveBeenCalledTimes(1);
    });
    const options = mocks.runWholeThread.mock.calls[0]?.[2] as {
      signal: AbortSignal;
    };

    for (const listener of runtimeMessageListeners) {
      listener({ type: "SESSION_CLEARED", tabId: 999, reason: "navigation" });
      listener({ type: "SESSION_SUSPENDED", tabId: 999, reason: "url_unavailable" });
    }
    expect(options.signal.aborted).toBe(false);
    expect(container.textContent).toContain("测试长帖");

    await act(async () => {
      resolveAnalysis({
        summary: "未受其他标签页消息影响",
        findings: [],
        uncertainties: [],
        analyzedReplyCount: 1,
        ruleCount: 112,
        omittedImageCount: 0,
      });
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain("未受其他标签页消息影响");
    });
    expect(mocks.saveCache.mock.calls.at(-1)?.[0]).toMatchObject({
      status: "success",
    });
  });
});
