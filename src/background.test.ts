import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ContentRequest,
  DynamicContentChangedMessage,
  ExtensionRequest,
  ExtensionResponse,
  PageIdentityChangedMessage,
} from "./messages";
import { mergeCapture, sessionStorageKey } from "./lib/session";
import type { ReviewSession } from "./lib/session";
import type { TiebaReadRequest } from "./lib/tiebaApi";
import { SCHEMA_VERSION } from "./types";
import type { ThreadCapture } from "./types";

type RuntimeListener = (
  message:
    | ExtensionRequest
    | DynamicContentChangedMessage
    | PageIdentityChangedMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: ExtensionResponse<unknown>) => void,
) => boolean | void;

type UpdatedListener = (
  tabId: number,
  changeInfo: { status?: "loading" | "complete"; url?: string },
  tab: chrome.tabs.Tab,
) => void;

interface ChromeHarness {
  activeTab: chrome.tabs.Tab;
  executeScript: ReturnType<typeof vi.fn>;
  runtimeSendMessage: ReturnType<typeof vi.fn>;
  storage: Map<string, unknown>;
  storageGet: ReturnType<typeof vi.fn>;
  storageRemove: ReturnType<typeof vi.fn>;
  storageSet: ReturnType<typeof vi.fn>;
  tabsSendMessage: ReturnType<typeof vi.fn>;
  tabsQuery: ReturnType<typeof vi.fn>;
  tabsReload: ReturnType<typeof vi.fn>;
  tabsUpdate: ReturnType<typeof vi.fn>;
  dispatch(message: ExtensionRequest): Promise<ExtensionResponse<unknown>>;
  notifyDynamic(
    message: DynamicContentChangedMessage,
    sender?: chrome.runtime.MessageSender,
  ): Promise<ExtensionResponse<unknown>>;
  notifyIdentity(
    message: PageIdentityChangedMessage,
    sender?: chrome.runtime.MessageSender,
  ): Promise<ExtensionResponse<unknown>>;
  updated(
    tab: chrome.tabs.Tab,
    status?: "loading" | "complete" | null,
    url?: string,
  ): void;
}

function capture(
  pageNumber = 1,
  threadId = "123",
  replyId = `reply-${pageNumber}`,
): ThreadCapture {
  const url = `https://tieba.baidu.com/p/${threadId}?pn=${pageNumber}`;
  return {
    schemaVersion: SCHEMA_VERSION,
    parserVariant: "legacy",
    documentInstanceId: null,
    threadId,
    url,
    title: "Tabbit 实机测试帖",
    pageNumber,
    replies: [
      {
        id: replyId,
        siteReplyId: replyId,
        floor: pageNumber,
        parentReplyId: null,
        authorName: `用户${pageNumber}`,
        time: null,
        timestamp: null,
        content: `第 ${pageNumber} 页内容`,
        sourcePage: pageNumber,
        sourceUrl: url,
        anchor: `[data-pid="${replyId}"]`,
        imageCount: 0,
        isNested: false,
        unexpandedNestedCount: 0,
      },
    ],
    coverage: {
      captureMode: "paginated",
      visibleReplyCount: 1,
      mainReplyCount: 1,
      nestedReplyCount: 0,
      imageCount: 0,
      unexpandedLzlCount: 0,
      analyzedPageNumbers: [pageNumber],
      hasUnanalyzedImages: false,
      declaredReplyCount: 1,
      dynamicContentMayRemain: false,
      reachedReplyListEnd: false,
      unstableReplyIdCount: 0,
      isComplete: true,
    },
    errors: [],
    warnings: [],
    capturedAt: `2026-07-${String(pageNumber).padStart(2, "0")}T00:00:00.000Z`,
  };
}

function session(tabId = 42): ReviewSession {
  return mergeCapture(null, capture(), tabId);
}

function spaCapture(
  replyIds: string[] = ["101"],
  documentInstanceId = "document-1",
): ThreadCapture {
  const url = "https://tieba.baidu.com/p/123";
  return {
    ...capture(),
    parserVariant: "spa",
    documentInstanceId,
    url,
    replies: replyIds.map((replyId, index) => ({
      ...capture(1, "123", replyId).replies[0],
      id: replyId,
      siteReplyId: replyId,
      floor: index + 2,
      sourceUrl: url,
      anchor: `[data-id="${replyId}"]`,
    })),
    coverage: {
      ...capture().coverage,
      captureMode: "dynamic",
      visibleReplyCount: replyIds.length,
      mainReplyCount: replyIds.length,
      declaredReplyCount: 212,
      dynamicContentMayRemain: true,
      isComplete: false,
    },
  };
}

function apiResponse(request: TiebaReadRequest, text: string) {
  return {
    ok: true as const,
    data: { text, status: 200, url: request.url },
  };
}

function apiMainPageBody(): string {
  return JSON.stringify({
    error_code: 0,
    thread: { id: "123", title: "整帖接口测试", reply_num: 2 },
    forum: { id: "456", name: "测试吧" },
    page: { current_page: 1, total_page: 1, has_more: false },
    first_floor: {
      id: "100",
      floor: 1,
      time: 1_750_000_000,
      author_id: "1",
      content: [{ type: 0, text: "主楼" }],
      sub_post_number: 0,
    },
    post_list: [
      {
        id: "101",
        floor: 2,
        time: 1_750_000_100,
        author_id: "2",
        content: [{ type: 0, text: "二楼" }],
        sub_post_number: 1,
      },
    ],
    user_list: [
      { id: "1", name_show: "楼主" },
      { id: "2", name_show: "回复者" },
    ],
  });
}

async function createHarness(
  tabOverrides: Partial<chrome.tabs.Tab> = {},
): Promise<ChromeHarness> {
  const activeTab = {
    id: 42,
    active: true,
    highlighted: true,
    incognito: false,
    index: 0,
    pinned: false,
    selected: true,
    status: "complete",
    windowId: 1,
    ...tabOverrides,
  } as chrome.tabs.Tab;
  const storage = new Map<string, unknown>();
  let runtimeListener: RuntimeListener | undefined;
  let updatedListener: UpdatedListener | undefined;

  const executeScript = vi.fn();
  const tabsSendMessage = vi.fn();
  const tabsQuery = vi.fn().mockResolvedValue([activeTab]);
  const tabsReload = vi.fn().mockResolvedValue(undefined);
  const tabsUpdate = vi.fn().mockResolvedValue(activeTab);
  const runtimeSendMessage = vi.fn().mockResolvedValue(undefined);
  const storageGet = vi.fn(async (key: string) => ({
    [key]: storage.get(key),
  }));
  const storageSet = vi.fn(async (values: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(values)) storage.set(key, value);
  });
  const storageRemove = vi.fn(async (key: string) => {
    storage.delete(key);
  });

  const chromeMock = {
    runtime: {
      onInstalled: { addListener: vi.fn() },
      onMessage: {
        addListener: vi.fn((listener: RuntimeListener) => {
          runtimeListener = listener;
        }),
      },
      sendMessage: runtimeSendMessage,
    },
    sidePanel: {
      setPanelBehavior: vi.fn().mockResolvedValue(undefined),
    },
    scripting: { executeScript },
    storage: {
      session: {
        get: storageGet,
        set: storageSet,
        remove: storageRemove,
      },
    },
    tabs: {
      query: tabsQuery,
      sendMessage: tabsSendMessage,
      reload: tabsReload,
      update: tabsUpdate,
      onUpdated: {
        addListener: vi.fn((listener: UpdatedListener) => {
          updatedListener = listener;
        }),
      },
      onRemoved: { addListener: vi.fn() },
    },
  };

  vi.stubGlobal("chrome", chromeMock as unknown as typeof chrome);
  await import("./background");
  if (!runtimeListener || !updatedListener) {
    throw new Error("后台脚本未注册必要的 Chrome 事件监听器");
  }

  return {
    activeTab,
    executeScript,
    runtimeSendMessage,
    storage,
    storageGet,
    storageRemove,
    storageSet,
    tabsSendMessage,
    tabsQuery,
    tabsReload,
    tabsUpdate,
    dispatch(message) {
      return new Promise((resolve, reject) => {
        const timeout = window.setTimeout(
          () => reject(new Error("后台脚本未回复消息")),
          1_000,
        );
        const keepChannelOpen = runtimeListener!(
          message,
          {} as chrome.runtime.MessageSender,
          (response) => {
            window.clearTimeout(timeout);
            resolve(response);
          },
        );
        if (keepChannelOpen !== true) {
          window.clearTimeout(timeout);
          reject(new Error("后台脚本未保持异步消息通道"));
        }
      });
    },
    notifyDynamic(message, sender) {
      return new Promise((resolve, reject) => {
        const timeout = window.setTimeout(
          () => reject(new Error("后台脚本未回复动态通知")),
          1_000,
        );
        runtimeListener!(
          message,
          sender ??
            ({
              tab: activeTab,
              url: activeTab.url,
              frameId: 0,
            } as chrome.runtime.MessageSender),
          (response) => {
            window.clearTimeout(timeout);
            resolve(response);
          },
        );
      });
    },
    notifyIdentity(message, sender) {
      return new Promise((resolve, reject) => {
        const timeout = window.setTimeout(
          () => reject(new Error("后台脚本未回复页面身份通知")),
          1_000,
        );
        runtimeListener!(
          message,
          sender ??
            ({
              tab: activeTab,
              url: activeTab.url,
              frameId: 0,
            } as chrome.runtime.MessageSender),
          (response) => {
            window.clearTimeout(timeout);
            resolve(response);
          },
        );
      });
    },
    updated(tab, status = "complete", url) {
      updatedListener!(
        tab.id!,
        { ...(status ? { status } : {}), ...(url ? { url } : {}) },
        tab,
      );
    },
  };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Tabbit URL and capture compatibility", () => {
  it("reads window.location when Tabbit omits tab.url, then captures the page", async () => {
    const harness = await createHarness({ url: undefined });
    const page = capture();
    harness.executeScript.mockImplementation(
      async (details: Record<string, unknown>) =>
        "func" in details
          ? [{ frameId: 0, result: page.url }]
          : [{ frameId: 0 }],
    );
    harness.tabsSendMessage.mockResolvedValue({ ok: true, data: page });

    const response = await harness.dispatch({ type: "CAPTURE_ACTIVE_PAGE" });

    expect(response).toMatchObject({
      ok: true,
      data: { threadId: "123", tabId: 42 },
    });
    expect(harness.executeScript).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        target: { tabId: 42 },
        func: expect.any(Function),
      }),
    );
    expect(harness.executeScript).toHaveBeenNthCalledWith(2, {
      target: { tabId: 42 },
      files: ["content.js"],
    });
    expect(harness.storage.has(sessionStorageKey(42))).toBe(true);
  });

  it("falls back to GET_PAGE_URL when inline execution returns no URL", async () => {
    const harness = await createHarness({ url: undefined });
    const page = capture();
    harness.executeScript.mockImplementation(
      async (details: Record<string, unknown>) =>
        "func" in details ? [] : [{ frameId: 0 }],
    );
    harness.tabsSendMessage.mockImplementation(
      async (_tabId: number, message: { type: string }) =>
        message.type === "GET_PAGE_URL"
          ? { ok: true, data: page.url }
          : { ok: true, data: page },
    );

    const response = await harness.dispatch({ type: "CAPTURE_ACTIVE_PAGE" });

    expect(response).toMatchObject({ ok: true, data: { threadId: "123" } });
    expect(harness.tabsSendMessage).toHaveBeenNthCalledWith(1, 42, {
      type: "GET_PAGE_URL",
    });
    expect(harness.tabsSendMessage).toHaveBeenNthCalledWith(2, 42, {
      type: "PARSE_TIEBA_PAGE",
    });
  });

  it("maps Tabbit's missing-host error to a stable permission code", async () => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com/p/123",
    });
    harness.executeScript.mockRejectedValue(
      new Error(
        "Cannot access contents of the page. Extension manifest must request permission to access the respective host.",
      ),
    );

    const response = await harness.dispatch({ type: "CAPTURE_ACTIVE_PAGE" });

    expect(response).toMatchObject({
      ok: false,
      code: "TIEBA_PERMISSION_MISSING",
    });
    expect(harness.tabsSendMessage).not.toHaveBeenCalled();
  });

  it("preserves the permission error code when tab.url is also unavailable", async () => {
    const harness = await createHarness({ url: undefined });
    harness.executeScript.mockRejectedValue(
      new Error(
        "Cannot access contents of the page. Extension manifest must request permission to access the respective host.",
      ),
    );

    const response = await harness.dispatch({ type: "CAPTURE_ACTIVE_PAGE" });

    expect(response).toMatchObject({
      ok: false,
      code: "TIEBA_PERMISSION_MISSING",
    });
    expect(harness.tabsSendMessage).not.toHaveBeenCalled();
  });

  it("distinguishes an ordinary injection failure from a missing permission", async () => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com/p/123",
    });
    harness.executeScript.mockRejectedValue(new Error("The frame was removed"));

    const response = await harness.dispatch({ type: "CAPTURE_ACTIVE_PAGE" });

    expect(response).toMatchObject({
      ok: false,
      code: "SCRIPT_INJECTION_FAILED",
    });
  });

  it("rejects restricted browser pages before attempting injection", async () => {
    const harness = await createHarness({ url: "chrome://extensions" });

    const response = await harness.dispatch({ type: "CAPTURE_ACTIVE_PAGE" });

    expect(response).toMatchObject({ ok: false, code: "RESTRICTED_PAGE" });
    expect(harness.executeScript).not.toHaveBeenCalled();
  });

  it("rejects a lookalike Tieba hostname before injection", async () => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com.evil.example/p/123",
    });

    const response = await harness.dispatch({ type: "CAPTURE_ACTIVE_PAGE" });

    expect(response).toMatchObject({ ok: false, code: "INVALID_TIEBA_PAGE" });
    expect(harness.executeScript).not.toHaveBeenCalled();
  });

  it("revalidates the parsed page URL before saving a capture", async () => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com/p/123",
    });
    harness.executeScript.mockResolvedValue([{ frameId: 0 }]);
    harness.tabsSendMessage.mockResolvedValue({
      ok: true,
      data: {
        ...capture(),
        url: "https://tieba.baidu.com.evil.example/p/123",
      },
    });

    const response = await harness.dispatch({ type: "CAPTURE_ACTIVE_PAGE" });

    expect(response).toMatchObject({ ok: false, code: "INVALID_TIEBA_PAGE" });
    expect(harness.storageSet).not.toHaveBeenCalled();
  });

  it("rejects a parsed capture from another otherwise-valid Tieba thread", async () => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com/p/123",
    });
    harness.executeScript.mockResolvedValue([{ frameId: 0 }]);
    harness.tabsSendMessage.mockResolvedValue({
      ok: true,
      data: capture(1, "999", "wrong-thread-reply"),
    });

    const response = await harness.dispatch({ type: "CAPTURE_ACTIVE_PAGE" });

    expect(response).toMatchObject({ ok: false, code: "INVALID_TIEBA_PAGE" });
    expect(harness.storageSet).not.toHaveBeenCalled();
  });

  it("classifies a content parser rejection as a page-parse failure", async () => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com/p/123",
    });
    harness.executeScript.mockResolvedValue([{ frameId: 0 }]);
    harness.tabsSendMessage.mockResolvedValue({
      ok: false,
      error: "当前 DOM 中未找到可识别的帖子内容",
    });

    const response = await harness.dispatch({ type: "CAPTURE_ACTIVE_PAGE" });

    expect(response).toMatchObject({ ok: false, code: "PAGE_PARSE_FAILED" });
    expect(harness.storageSet).not.toHaveBeenCalled();
  });

  it.each([
    ["PAGE_NOT_READY", "贴吧帖子仍在加载"],
    ["PAGE_LAYOUT_UNSUPPORTED", "当前帖子结构尚不支持"],
  ] as const)("preserves %s and never saves an empty capture", async (code, error) => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com/p/123",
    });
    harness.executeScript.mockResolvedValue([{ frameId: 0 }]);
    harness.tabsSendMessage.mockResolvedValue({ ok: false, code, error });

    const response = await harness.dispatch({ type: "CAPTURE_ACTIVE_PAGE" });

    expect(response).toEqual({ ok: false, code, error });
    expect(harness.storageSet).not.toHaveBeenCalled();
  });

  it("does not save an SPA capture when its dynamic observer cannot be installed", async () => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com/p/123",
    });
    harness.executeScript.mockResolvedValue([{ frameId: 0 }]);
    harness.tabsSendMessage.mockImplementation(
      async (_tabId: number, message: { type: string }) =>
        message.type === "PARSE_TIEBA_PAGE"
          ? { ok: true, data: spaCapture() }
          : {
              ok: false,
              code: "PAGE_LAYOUT_UNSUPPORTED",
              error: "未找到动态回复容器",
            },
    );

    const response = await harness.dispatch({ type: "CAPTURE_ACTIVE_PAGE" });

    expect(response).toMatchObject({
      ok: false,
      code: "PAGE_LAYOUT_UNSUPPORTED",
    });
    expect(harness.storageSet).not.toHaveBeenCalled();
  });

  it("discards a manual parse when navigation starts before parsing finishes", async () => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com/p/123",
    });
    harness.executeScript.mockResolvedValue([{ frameId: 0 }]);
    let finishParse!: (response: ExtensionResponse<ThreadCapture>) => void;
    harness.tabsSendMessage.mockReturnValue(
      new Promise<ExtensionResponse<ThreadCapture>>((resolve) => {
        finishParse = resolve;
      }),
    );

    const capturePromise = harness.dispatch({ type: "CAPTURE_ACTIVE_PAGE" });
    await vi.waitFor(() => expect(harness.tabsSendMessage).toHaveBeenCalled());
    harness.updated(harness.activeTab, "loading");
    finishParse({ ok: true, data: capture() });

    await expect(capturePromise).resolves.toMatchObject({
      ok: false,
      code: "SESSION_STALE",
    });
    expect(harness.storage.has(sessionStorageKey(42))).toBe(false);
  });

  it("keeps a newer reload suspended when an older capture is clearing suspension", async () => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com/p/123",
    });
    harness.executeScript.mockResolvedValue([{ frameId: 0 }]);
    harness.tabsSendMessage.mockImplementation(
      async (_tabId: number, message: { type: string }) =>
        message.type === "PARSE_TIEBA_PAGE"
          ? { ok: true, data: spaCapture(["101"], "document-1") }
          : { ok: true, data: true },
    );

    let releaseRemoval!: () => void;
    let reportRemovalStarted!: () => void;
    const removalStarted = new Promise<void>((resolve) => {
      reportRemovalStarted = resolve;
    });
    const removalBlocked = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    harness.storageRemove.mockImplementation(async (key: string) => {
      if (key === "kr_tieba_session_suspended_42") {
        reportRemovalStarted();
        await removalBlocked;
      }
      harness.storage.delete(key);
    });

    const capturePromise = harness.dispatch({ type: "CAPTURE_ACTIVE_PAGE" });
    await removalStarted;
    harness.activeTab.status = "loading";
    harness.updated(harness.activeTab, "loading");
    releaseRemoval();

    await expect(capturePromise).resolves.toMatchObject({
      ok: false,
      code: "SESSION_STALE",
    });
    await vi.waitFor(() =>
      expect(harness.storage.has("kr_tieba_session_suspended_42")).toBe(true),
    );
    expect(harness.runtimeSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "SESSION_SUSPENDED", tabId: 42 }),
    );
    expect(harness.runtimeSendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "SESSION_UPDATED" }),
    );
  });
});

describe("explicit whole-thread API capture", () => {
  it("reads every exposed main and nested page once, then saves one API snapshot", async () => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com/p/123",
    });
    harness.executeScript.mockResolvedValue([{ frameId: 0 }]);
    harness.tabsSendMessage.mockImplementation(
      async (_tabId: number, message: ContentRequest) => {
        if (message.type === "FETCH_TIEBA_READ_API") {
          if (message.request.endpoint === "/c/s/pc/sync") {
            return apiResponse(
              message.request,
              JSON.stringify({
                error_code: 0,
                anti: { tbs: "0123456789abcdef0123456789abcdef" },
              }),
            );
          }
          if (message.request.endpoint === "/c/f/pb/page_pc") {
            return apiResponse(message.request, apiMainPageBody());
          }
          return apiResponse(
            message.request,
            "<li class=\"lzl_single_post\">楼中楼</li>",
          );
        }
        if (message.type === "PARSE_TIEBA_NESTED_HTML") {
          return {
            ok: true,
            data: {
              threadId: "123",
              parentReplyId: "101",
              parentSiteReplyId: "101",
              currentPage: 1,
              totalPages: 1,
              totalNum: 1,
              hasMore: false,
              unparsedReplyCount: 0,
              replies: [
                {
                  id: "201",
                  siteReplyId: "201",
                  floor: 2,
                  parentReplyId: "101",
                  authorName: "楼中楼用户",
                  time: null,
                  timestamp: null,
                  content: "楼中楼内容",
                  sourcePage: 1,
                  sourceUrl: "https://tieba.baidu.com/p/123",
                  anchor: `[data-spid="201"]`,
                  imageCount: 0,
                  isNested: true,
                  unexpandedNestedCount: 0,
                },
              ],
            },
          };
        }
        if (message.type === "GET_PAGE_URL") {
          return { ok: true, data: "https://tieba.baidu.com/p/123" };
        }
        throw new Error(`unexpected content message: ${message.type}`);
      },
    );

    const response = await harness.dispatch({
      type: "CAPTURE_WHOLE_THREAD",
    });

    expect(response).toMatchObject({
      ok: true,
      data: {
        threadId: "123",
        coverage: {
          captureMode: "api",
          mainReplyCount: 2,
          nestedReplyCount: 1,
          isComplete: true,
          apiCoverage: {
            mainPagesFetched: 1,
            mainPagesTotal: 1,
            nestedRepliesFetched: 1,
            nestedRepliesDeclared: 1,
            failedRequestCount: 0,
          },
        },
      },
    });
    const readRequests = harness.tabsSendMessage.mock.calls
      .map(([, message]) => message as ContentRequest)
      .filter(
        (
          message,
        ): message is Extract<
          ContentRequest,
          { type: "FETCH_TIEBA_READ_API" }
        > => message.type === "FETCH_TIEBA_READ_API",
      );
    expect(readRequests.map((message) => message.request.endpoint)).toEqual([
      "/c/s/pc/sync",
      "/c/f/pb/page_pc",
      "/p/comment",
    ]);
    expect(
      readRequests.every((message) =>
        [
          "/c/s/pc/sync",
          "/c/f/pb/page_pc",
          "/p/comment",
        ].includes(message.request.endpoint),
      ),
    ).toBe(true);
    expect(
      (harness.storage.get(sessionStorageKey(42)) as ReviewSession).pages.api
        .parserVariant,
    ).toBe("api");

    const callsAfterCapture = harness.tabsSendMessage.mock.calls.length;
    await expect(
      harness.dispatch({ type: "GET_ACTIVE_SESSION" }),
    ).resolves.toMatchObject({
      ok: true,
      data: { coverage: { captureMode: "api" } },
    });
    expect(harness.tabsSendMessage).toHaveBeenCalledTimes(callsAfterCapture);
  });

  it("cancels a pending API run on navigation and never falls back or saves stale data", async () => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com/p/123",
    });
    harness.executeScript.mockResolvedValue([{ frameId: 0 }]);
    let finishSync!: (response: ExtensionResponse) => void;
    harness.tabsSendMessage.mockImplementation(
      async (_tabId: number, message: ContentRequest) => {
        if (message.type !== "FETCH_TIEBA_READ_API") {
          throw new Error("stale capture must not enter DOM fallback");
        }
        return new Promise<ExtensionResponse>((resolve) => {
          finishSync = resolve;
        });
      },
    );

    const pending = harness.dispatch({ type: "CAPTURE_WHOLE_THREAD" });
    await vi.waitFor(() => expect(harness.tabsSendMessage).toHaveBeenCalled());
    harness.updated(harness.activeTab, "loading");
    const request = (
      harness.tabsSendMessage.mock.calls[0][1] as Extract<
        ContentRequest,
        { type: "FETCH_TIEBA_READ_API" }
      >
    ).request;
    finishSync(
      apiResponse(
        request,
        JSON.stringify({
          error_code: 0,
          anti: { tbs: "0123456789abcdef0123456789abcdef" },
        }),
      ),
    );

    await expect(pending).resolves.toMatchObject({
      ok: false,
      code: "CAPTURE_CANCELLED",
    });
    expect(harness.storage.has(sessionStorageKey(42))).toBe(false);
    expect(
      harness.tabsSendMessage.mock.calls.some(
        ([, message]) =>
          (message as ContentRequest).type === "PARSE_TIEBA_PAGE",
      ),
    ).toBe(false);
  });

  it("falls back once to visible DOM content when the first read endpoint fails", async () => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com/p/123",
    });
    harness.executeScript.mockResolvedValue([{ frameId: 0 }]);
    harness.tabsSendMessage.mockImplementation(
      async (_tabId: number, message: ContentRequest) => {
        if (message.type === "FETCH_TIEBA_READ_API") {
          return {
            ok: false,
            code: "TIEBA_READ_API_FAILED",
            error: "只读接口暂不可用",
          };
        }
        if (message.type === "PARSE_TIEBA_PAGE") {
          return { ok: true, data: capture() };
        }
        throw new Error(`unexpected fallback message: ${message.type}`);
      },
    );

    const response = await harness.dispatch({
      type: "CAPTURE_WHOLE_THREAD",
    });

    expect(response).toMatchObject({
      ok: true,
      data: {
        coverage: { captureMode: "paginated" },
        warnings: [
          expect.stringContaining("当前结果仅来自页面已挂载内容"),
        ],
      },
    });
    expect(
      harness.tabsSendMessage.mock.calls.filter(
        ([, message]) =>
          (message as ContentRequest).type === "FETCH_TIEBA_READ_API",
      ),
    ).toHaveLength(1);
  });
});

describe("session URL state machine", () => {
  it("returns the saved session on another page of the same thread", async () => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com/p/123?pn=8",
    });
    const saved = session();
    harness.storage.set(sessionStorageKey(42), saved);

    const response = await harness.dispatch({ type: "GET_ACTIVE_SESSION" });

    expect(response).toMatchObject({
      ok: true,
      data: { threadId: "123", tabId: 42 },
    });
    expect(harness.storageRemove).not.toHaveBeenCalled();
  });

  it("clears the saved session after a confirmed navigation to another thread", async () => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com/p/999",
    });
    harness.storage.set(sessionStorageKey(42), session());

    const response = await harness.dispatch({ type: "GET_ACTIVE_SESSION" });

    expect(response).toEqual({ ok: true, data: null });
    expect(harness.storageRemove).toHaveBeenCalledWith(sessionStorageKey(42));
    expect(harness.runtimeSendMessage).toHaveBeenCalledWith({
      type: "SESSION_CLEARED",
      tabId: 42,
      reason: "navigation",
    });
  });

  it("hides but preserves the session while the tab is loading", async () => {
    const harness = await createHarness({
      status: "loading",
      url: "https://tieba.baidu.com/p/999",
    });
    const saved = session();
    harness.storage.set(sessionStorageKey(42), saved);

    const response = await harness.dispatch({ type: "GET_ACTIVE_SESSION" });

    expect(response).toEqual({ ok: true, data: null });
    expect(harness.storage.get(sessionStorageKey(42))).toBe(saved);
    expect(harness.storageRemove).not.toHaveBeenCalled();
  });

  it("immediately suspends a saved session when navigation starts", async () => {
    const harness = await createHarness({
      status: "loading",
      // Chrome may still expose the previous URL during the loading event.
      url: "https://tieba.baidu.com/p/123?pn=1",
    });
    const saved = session();
    harness.storage.set(sessionStorageKey(42), saved);

    harness.updated(harness.activeTab, "loading");

    expect(harness.runtimeSendMessage).toHaveBeenCalledWith({
      type: "SESSION_SUSPENDED",
      tabId: 42,
      reason: "url_unavailable",
    });
    expect(harness.storage.get(sessionStorageKey(42))).toBe(saved);
    expect(harness.storageRemove).not.toHaveBeenCalled();
    expect(harness.executeScript).not.toHaveBeenCalled();
    expect(harness.tabsSendMessage).not.toHaveBeenCalled();
  });

  it("restores normal same-thread accumulation after loading completes", async () => {
    const harness = await createHarness({
      status: "loading",
      url: "https://tieba.baidu.com/p/123?pn=1",
    });
    harness.storage.set(sessionStorageKey(42), session());

    harness.updated(harness.activeTab, "loading");
    expect(harness.runtimeSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "SESSION_SUSPENDED", tabId: 42 }),
    );

    harness.activeTab.status = "complete";
    harness.activeTab.url = "https://tieba.baidu.com/p/123?pn=2";
    harness.executeScript.mockResolvedValue([{ frameId: 0 }]);
    harness.tabsSendMessage.mockResolvedValue({ ok: true, data: capture(2) });
    harness.updated(harness.activeTab, "complete");

    await vi.waitFor(() =>
      expect(
        (harness.storage.get(sessionStorageKey(42)) as ReviewSession).coverage
          .analyzedPageNumbers,
      ).toEqual([1, 2]),
    );
  });

  it("keeps a same-thread reload suspended after parsing fails, then reactivates only after a successful capture", async () => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com/p/123?pn=1",
    });
    const original = session();
    harness.storage.set(sessionStorageKey(42), original);

    harness.updated(harness.activeTab, "loading");
    await vi.waitFor(() =>
      expect(harness.storage.has("kr_tieba_session_suspended_42")).toBe(true),
    );
    harness.executeScript.mockResolvedValue([{ frameId: 0 }]);
    harness.tabsSendMessage.mockResolvedValue({
      ok: false,
      error: "重载后结构尚未可识别",
      code: "PAGE_LAYOUT_UNSUPPORTED",
    });
    harness.updated(harness.activeTab, "complete");
    await vi.waitFor(() => expect(harness.tabsSendMessage).toHaveBeenCalled());

    expect(await harness.dispatch({ type: "GET_ACTIVE_SESSION" })).toEqual({
      ok: true,
      data: null,
    });
    expect(harness.storage.get(sessionStorageKey(42))).toBe(original);

    harness.tabsSendMessage.mockResolvedValue({
      ok: true,
      data: capture(1, "123", "replacement"),
    });
    expect(await harness.dispatch({ type: "CAPTURE_ACTIVE_PAGE" })).toMatchObject({
      ok: true,
      data: { replies: [{ id: "replacement" }] },
    });
    expect(harness.storage.has("kr_tieba_session_suspended_42")).toBe(false);
    expect(await harness.dispatch({ type: "GET_ACTIVE_SESSION" })).toMatchObject({
      ok: true,
      data: { replies: [{ id: "replacement" }] },
    });
  });

  it("hides but preserves the session when the current URL is unavailable", async () => {
    const harness = await createHarness({ url: undefined });
    const saved = session();
    harness.storage.set(sessionStorageKey(42), saved);
    harness.executeScript.mockRejectedValue(new Error("URL unavailable"));

    const response = await harness.dispatch({ type: "GET_ACTIVE_SESSION" });

    expect(response).toEqual({ ok: true, data: null });
    expect(harness.storage.get(sessionStorageKey(42))).toBe(saved);
    expect(harness.storageRemove).not.toHaveBeenCalled();
  });

  it("automatically accumulates a newly completed page of the same thread", async () => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com/p/123?pn=2",
    });
    harness.storage.set(sessionStorageKey(42), session());
    harness.executeScript.mockResolvedValue([{ frameId: 0 }]);
    harness.tabsSendMessage.mockResolvedValue({ ok: true, data: capture(2) });

    harness.updated(harness.activeTab);

    await vi.waitFor(() => expect(harness.storageSet).toHaveBeenCalled());
    const saved = harness.storage.get(sessionStorageKey(42)) as ReviewSession;
    expect(saved.coverage.analyzedPageNumbers).toEqual([1, 2]);
    expect(saved.replies.map((reply) => reply.id)).toEqual([
      "reply-1",
      "reply-2",
    ]);
  });

  it("suspends without deleting when an updated tab has no usable URL", async () => {
    const harness = await createHarness({ url: undefined });
    const saved = session();
    harness.storage.set(sessionStorageKey(42), saved);
    harness.executeScript.mockRejectedValue(new Error("URL unavailable"));

    harness.updated(harness.activeTab);

    await vi.waitFor(() =>
      expect(harness.runtimeSendMessage).toHaveBeenCalledWith({
        type: "SESSION_SUSPENDED",
        tabId: 42,
        reason: "url_unavailable",
      }),
    );
    expect(harness.storage.get(sessionStorageKey(42))).toBe(saved);
    expect(harness.storageRemove).not.toHaveBeenCalled();
  });
});

describe("SPA dynamic capture", () => {
  it("starts the DOM observer only after a successful explicit SPA parse", async () => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com/p/123",
    });
    const page = spaCapture();
    harness.executeScript.mockResolvedValue([{ frameId: 0 }]);
    harness.tabsSendMessage.mockImplementation(
      async (_tabId: number, message: { type: string }) =>
        message.type === "PARSE_TIEBA_PAGE"
          ? { ok: true, data: page }
          : { ok: true, data: true },
    );

    const response = await harness.dispatch({ type: "CAPTURE_ACTIVE_PAGE" });

    expect(response).toMatchObject({
      ok: true,
      data: { coverage: { captureMode: "dynamic" } },
    });
    expect(harness.tabsSendMessage).toHaveBeenNthCalledWith(1, 42, {
      type: "PARSE_TIEBA_PAGE",
    });
    expect(harness.tabsSendMessage).toHaveBeenNthCalledWith(2, 42, {
      type: "START_DYNAMIC_CAPTURE",
      threadId: "123",
      documentInstanceId: "document-1",
      allowMissingContainer: false,
    });
  });

  it("revalidates a body-free mutation hint, merges once, and ignores its duplicate signature", async () => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com/p/123",
    });
    harness.storage.set(
      sessionStorageKey(42),
      mergeCapture(null, spaCapture(["101"]), 42),
    );
    harness.executeScript.mockResolvedValue([{ frameId: 0 }]);
    harness.tabsSendMessage.mockResolvedValue({
      ok: true,
      data: spaCapture(["101", "102"]),
    });
    const notification: DynamicContentChangedMessage = {
      type: "TIEBA_DYNAMIC_CONTENT_CHANGED",
      threadId: "123",
      url: "https://tieba.baidu.com/p/123",
      documentInstanceId: "document-1",
      signature: "2:0123456789abcdef",
    };

    expect(await harness.notifyDynamic(notification)).toEqual({
      ok: true,
      data: null,
    });
    await vi.waitFor(() => expect(harness.storageSet).toHaveBeenCalledTimes(1));
    const merged = harness.storage.get(sessionStorageKey(42)) as ReviewSession;
    expect(merged.replies.map((reply) => reply.id)).toEqual(["101", "102"]);
    expect(harness.tabsSendMessage).toHaveBeenCalledWith(42, {
      type: "PARSE_TIEBA_PAGE",
    });

    const callsAfterFirstCapture = harness.tabsSendMessage.mock.calls.length;
    await harness.notifyDynamic(notification);
    await Promise.resolve();
    expect(harness.tabsSendMessage).toHaveBeenCalledTimes(callsAfterFirstCapture);
  });

  it("ignores mutation hints whose sender, thread, or document instance does not match the session", async () => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com/p/123",
    });
    harness.storage.set(
      sessionStorageKey(42),
      mergeCapture(null, spaCapture(["101"]), 42),
    );
    const base: DynamicContentChangedMessage = {
      type: "TIEBA_DYNAMIC_CONTENT_CHANGED",
      threadId: "123",
      url: "https://tieba.baidu.com/p/123",
      documentInstanceId: "wrong-document",
      signature: "1:fedcba9876543210",
    };

    await harness.notifyDynamic(base);
    await harness.notifyDynamic(
      { ...base, documentInstanceId: "document-1" },
      {
        tab: { ...harness.activeTab, url: "https://tieba.baidu.com/p/999" },
        url: "https://tieba.baidu.com/p/999",
        frameId: 0,
      } as chrome.runtime.MessageSender,
    );
    await Promise.resolve();

    expect(harness.tabsSendMessage).not.toHaveBeenCalled();
    expect(harness.storageSet).not.toHaveBeenCalled();
  });

  it("does not reuse a replay signature across full document reloads", async () => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com/p/123",
    });
    harness.storage.set(
      sessionStorageKey(42),
      mergeCapture(null, spaCapture(["101"], "document-1"), 42),
    );
    harness.executeScript.mockResolvedValue([{ frameId: 0 }]);
    harness.tabsSendMessage.mockResolvedValue({
      ok: true,
      data: spaCapture(["101"], "document-1"),
    });
    const signature = "1:0123456789abcdef";
    await harness.notifyDynamic({
      type: "TIEBA_DYNAMIC_CONTENT_CHANGED",
      threadId: "123",
      url: "https://tieba.baidu.com/p/123",
      documentInstanceId: "document-1",
      signature,
    });
    await vi.waitFor(() => expect(harness.storageSet).toHaveBeenCalled());

    harness.updated(harness.activeTab, "loading");
    harness.storage.set(
      sessionStorageKey(42),
      mergeCapture(null, spaCapture(["201"], "document-2"), 42),
    );
    harness.tabsSendMessage.mockClear();
    harness.storageSet.mockClear();
    harness.tabsSendMessage.mockResolvedValue({
      ok: true,
      data: spaCapture(["201", "202"], "document-2"),
    });

    await harness.notifyDynamic({
      type: "TIEBA_DYNAMIC_CONTENT_CHANGED",
      threadId: "123",
      url: "https://tieba.baidu.com/p/123",
      documentInstanceId: "document-2",
      signature,
    });
    await vi.waitFor(() => expect(harness.storageSet).toHaveBeenCalled());
    expect(harness.tabsSendMessage).toHaveBeenCalledWith(42, {
      type: "PARSE_TIEBA_PAGE",
    });
  });

  it("cannot resurrect a session cleared while a queued dynamic parse is in flight", async () => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com/p/123",
    });
    harness.storage.set(
      sessionStorageKey(42),
      mergeCapture(null, spaCapture(["101"]), 42),
    );
    harness.executeScript.mockResolvedValue([{ frameId: 0 }]);
    let finishParse!: (response: ExtensionResponse<ThreadCapture>) => void;
    harness.tabsSendMessage.mockReturnValue(
      new Promise<ExtensionResponse<ThreadCapture>>((resolve) => {
        finishParse = resolve;
      }),
    );

    await harness.notifyDynamic({
      type: "TIEBA_DYNAMIC_CONTENT_CHANGED",
      threadId: "123",
      url: "https://tieba.baidu.com/p/123",
      documentInstanceId: "document-1",
      signature: "1:abcdef0123456789",
    });
    await vi.waitFor(() => expect(harness.tabsSendMessage).toHaveBeenCalled());
    expect(await harness.dispatch({ type: "CLEAR_ACTIVE_SESSION" })).toEqual({
      ok: true,
      data: null,
    });
    finishParse({ ok: true, data: spaCapture(["101", "102"]) });
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(harness.storage.has(sessionStorageKey(42))).toBe(false);
    expect(harness.runtimeSendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "SESSION_UPDATED" }),
    );
  });
});

describe("SPA page identity changes", () => {
  const identityMessage = (
    overrides: Partial<PageIdentityChangedMessage> = {},
  ): PageIdentityChangedMessage => ({
    type: "TIEBA_PAGE_IDENTITY_CHANGED",
    previousThreadId: "123",
    currentUrl: "https://tieba.baidu.com/p/999",
    documentInstanceId: "document-1",
    ...overrides,
  });

  it("clears an old session after independently confirming a pushState switch to another thread", async () => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com/p/123",
    });
    harness.storage.set(
      sessionStorageKey(42),
      mergeCapture(null, spaCapture(["101"]), 42),
    );
    harness.executeScript.mockResolvedValue([
      { frameId: 0, result: "https://tieba.baidu.com/p/999" },
    ]);

    expect(await harness.notifyIdentity(identityMessage())).toEqual({
      ok: true,
      data: null,
    });
    await vi.waitFor(() =>
      expect(harness.storage.has(sessionStorageKey(42))).toBe(false),
    );
    expect(harness.runtimeSendMessage).toHaveBeenCalledWith({
      type: "SESSION_CLEARED",
      tabId: 42,
      reason: "navigation",
    });
  });

  it("ignores same-thread identity hints and forged document instances", async () => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com/p/123",
    });
    const saved = mergeCapture(null, spaCapture(["101"]), 42);
    harness.storage.set(sessionStorageKey(42), saved);
    harness.executeScript.mockResolvedValue([
      { frameId: 0, result: "https://tieba.baidu.com/p/123?sort=1" },
    ]);

    await harness.notifyIdentity(
      identityMessage({ currentUrl: "https://tieba.baidu.com/p/123?sort=1" }),
    );
    await harness.notifyIdentity(
      identityMessage({ documentInstanceId: "forged-document" }),
    );
    await Promise.resolve();

    expect(harness.storage.get(sessionStorageKey(42))).toBe(saved);
    expect(harness.storageRemove).not.toHaveBeenCalledWith(
      sessionStorageKey(42),
    );
  });

  it("ignores a cross-thread claim when the live tab still reports the reviewed thread", async () => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com/p/123",
    });
    const saved = mergeCapture(null, spaCapture(["101"]), 42);
    harness.storage.set(sessionStorageKey(42), saved);
    harness.executeScript.mockResolvedValue([
      { frameId: 0, result: "https://tieba.baidu.com/p/123" },
    ]);

    await harness.notifyIdentity(identityMessage());
    await new Promise((resolve) => window.setTimeout(resolve, 10));

    expect(harness.storage.get(sessionStorageKey(42))).toBe(saved);
    expect(harness.storageRemove).not.toHaveBeenCalledWith(
      sessionStorageKey(42),
    );
  });

  it("also clears on a status-free tabs.onUpdated URL change", async () => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com/p/123",
    });
    harness.storage.set(
      sessionStorageKey(42),
      mergeCapture(null, spaCapture(["101"]), 42),
    );

    harness.updated(
      harness.activeTab,
      null,
      "https://tieba.baidu.com/p/999",
    );
    await vi.waitFor(() =>
      expect(harness.storage.has(sessionStorageKey(42))).toBe(false),
    );
  });
});

describe("evidence jump routing", () => {
  it("rejects a legacy session without an explicit thread id before messaging content", async () => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com/p/123",
    });
    harness.storage.set(sessionStorageKey(42), {
      ...session(),
      threadId: null,
    });

    const response = await harness.dispatch({
      type: "JUMP_TO_REPLY",
      replyId: "reply-1",
    });

    expect(response).toMatchObject({
      ok: false,
      code: "SESSION_STALE",
    });
    expect(harness.tabsSendMessage).not.toHaveBeenCalled();
    expect(harness.tabsUpdate).not.toHaveBeenCalled();
    expect(harness.tabsReload).not.toHaveBeenCalled();
  });

  it("builds the minimal locator from the session", async () => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com/p/123?pn=1",
    });
    harness.storage.set(sessionStorageKey(42), session());
    harness.executeScript.mockResolvedValue([{ frameId: 0 }]);
    harness.tabsSendMessage.mockResolvedValue({ ok: true, data: true });

    const response = await harness.dispatch({
      type: "JUMP_TO_REPLY",
      replyId: "reply-1",
    });

    expect(response).toEqual({ ok: true, data: true });
    expect(harness.tabsSendMessage).toHaveBeenCalledWith(42, {
      type: "JUMP_TO_REPLY",
      expectedThreadId: "123",
      waitForOfficialRoute: false,
      locator: expect.objectContaining({
        replyId: "reply-1",
        siteReplyId: "reply-1",
        floor: 1,
        anchor: `[data-pid="reply-1"]`,
        isNested: false,
      }),
    });
    expect(harness.tabsUpdate).not.toHaveBeenCalled();
    expect(harness.tabsReload).not.toHaveBeenCalled();
    expect(harness.storage.has("kr_tieba_pending_jump_42")).toBe(false);
  });

  it("adds the SPA root-card fallback for an API-captured first floor", async () => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com/p/123",
    });
    const page = spaCapture(["100"]);
    page.parserVariant = "api";
    page.coverage.captureMode = "api";
    page.replies[0] = {
      ...page.replies[0],
      floor: 1,
      anchor: '.pb-comment-item[data-id="100"], .l_post[data-pid="100"]',
    };
    harness.storage.set(sessionStorageKey(42), mergeCapture(null, page, 42));
    harness.executeScript.mockResolvedValue([{ frameId: 0 }]);
    harness.tabsSendMessage.mockResolvedValue({ ok: true, data: true });

    expect(
      await harness.dispatch({ type: "JUMP_TO_REPLY", replyId: "100" }),
    ).toEqual({ ok: true, data: true });
    expect(harness.tabsSendMessage).toHaveBeenCalledWith(42, {
      type: "JUMP_TO_REPLY",
      expectedThreadId: "123",
      waitForOfficialRoute: false,
      locator: expect.objectContaining({
        replyId: "100",
        anchor: expect.stringContaining(".image-text"),
      }),
    });
  });

  it("navigates an unloaded official main reply and persists only its minimal pending locator", async () => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com/p/123",
    });
    harness.storage.set(
      sessionStorageKey(42),
      mergeCapture(null, spaCapture(["101"]), 42),
    );
    harness.executeScript.mockResolvedValue([{ frameId: 0 }]);
    harness.tabsSendMessage.mockResolvedValue({
      ok: false,
      error: "尚未加载",
      code: "EVIDENCE_NOT_LOADED",
    });

    const response = await harness.dispatch({
      type: "JUMP_TO_REPLY",
      replyId: "101",
    });

    expect(response).toEqual({ ok: true, data: true });
    expect(harness.tabsUpdate).toHaveBeenCalledWith(42, {
      url: "https://tieba.baidu.com/p/123?pid=101#101",
    });
    const pending = harness.storage.get("kr_tieba_pending_jump_42");
    expect(pending).toMatchObject({
      threadId: "123",
      locator: { replyId: "101", siteReplyId: "101" },
    });
    expect(JSON.stringify(pending)).not.toContain("第 1 页内容");
    expect(JSON.stringify(pending)).not.toContain("用户1");
    expect(JSON.stringify(pending)).not.toContain("waitForOfficialRoute");
    expect(JSON.stringify(pending)).not.toContain("expectedThreadId");
  });

  it("reloads the same official PID so an in-memory sort change cannot make the jump a no-op", async () => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com/p/123?pid=101",
    });
    harness.storage.set(
      sessionStorageKey(42),
      mergeCapture(null, spaCapture(["101"]), 42),
    );
    harness.executeScript.mockResolvedValue([{ frameId: 0 }]);
    harness.tabsSendMessage.mockResolvedValue({
      ok: false,
      error: "倒序列表尚未挂载八楼",
      code: "EVIDENCE_NOT_LOADED",
    });

    const response = await harness.dispatch({
      type: "JUMP_TO_REPLY",
      replyId: "101",
    });

    expect(response).toEqual({ ok: true, data: true });
    expect(harness.tabsSendMessage).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        type: "JUMP_TO_REPLY",
        expectedThreadId: "123",
        waitForOfficialRoute: false,
      }),
    );
    expect(harness.tabsReload).toHaveBeenCalledWith(42);
    expect(harness.tabsUpdate).not.toHaveBeenCalled();
    expect(harness.storage.get("kr_tieba_pending_jump_42")).toMatchObject({
      threadId: "123",
      locator: { replyId: "101", siteReplyId: "101" },
    });
  });

  it.each([
    "PAGE_NOT_READY",
    "PAGE_LAYOUT_UNSUPPORTED",
    "PAGE_PARSE_FAILED",
    "SCRIPT_INJECTION_FAILED",
    "SESSION_STALE",
    "UNKNOWN",
  ] as const)("does not navigate for non-recoverable content error %s", async (code) => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com/p/123",
    });
    harness.storage.set(
      sessionStorageKey(42),
      mergeCapture(null, spaCapture(["101"]), 42),
    );
    harness.executeScript.mockResolvedValue([{ frameId: 0 }]);
    harness.tabsSendMessage.mockResolvedValue({
      ok: false,
      error: `content error: ${code}`,
      code,
    });

    const response = await harness.dispatch({
      type: "JUMP_TO_REPLY",
      replyId: "101",
    });

    expect(response).toEqual({
      ok: false,
      error: `content error: ${code}`,
      code,
    });
    expect(harness.tabsUpdate).not.toHaveBeenCalled();
    expect(harness.tabsReload).not.toHaveBeenCalled();
    expect(harness.storage.has("kr_tieba_pending_jump_42")).toBe(false);
  });

  it("lets only the newest concurrent jump navigate", async () => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com/p/123",
    });
    harness.storage.set(
      sessionStorageKey(42),
      mergeCapture(null, spaCapture(["101", "102"]), 42),
    );
    harness.executeScript.mockResolvedValue([{ frameId: 0 }]);
    let resolveFirst!: (response: ExtensionResponse<boolean>) => void;
    const firstContentResponse = new Promise<ExtensionResponse<boolean>>(
      (resolve) => {
        resolveFirst = resolve;
      },
    );
    harness.tabsSendMessage.mockImplementation(
      async (_tabId: number, request: ContentRequest) => {
        if (
          request.type === "JUMP_TO_REPLY" &&
          request.locator.replyId === "101"
        ) {
          return firstContentResponse;
        }
        return {
          ok: false,
          error: "当前列表未挂载目标",
          code: "EVIDENCE_NOT_LOADED",
        };
      },
    );

    const first = harness.dispatch({
      type: "JUMP_TO_REPLY",
      replyId: "101",
    });
    await vi.waitFor(() => expect(harness.tabsSendMessage).toHaveBeenCalled());
    const second = await harness.dispatch({
      type: "JUMP_TO_REPLY",
      replyId: "102",
    });
    resolveFirst({
      ok: false,
      error: "旧列表未挂载目标",
      code: "EVIDENCE_NOT_LOADED",
    });

    expect(second).toEqual({ ok: true, data: true });
    await expect(first).resolves.toMatchObject({
      ok: false,
      code: "SESSION_STALE",
    });
    expect(harness.tabsUpdate).toHaveBeenCalledTimes(1);
    expect(harness.tabsUpdate).toHaveBeenCalledWith(42, {
      url: "https://tieba.baidu.com/p/123?pid=102#102",
    });
    expect(harness.tabsReload).not.toHaveBeenCalled();
  });

  it("cancels a stale jump paused in pending storage without overwriting the newer pending locator", async () => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com/p/123",
    });
    harness.storage.set(
      sessionStorageKey(42),
      mergeCapture(null, spaCapture(["101", "102"]), 42),
    );
    harness.executeScript.mockResolvedValue([{ frameId: 0 }]);
    harness.tabsSendMessage.mockResolvedValue({
      ok: false,
      error: "当前列表未挂载目标",
      code: "EVIDENCE_NOT_LOADED",
    });

    let releaseOldPendingWrite!: () => void;
    const oldPendingWriteGate = new Promise<void>((resolve) => {
      releaseOldPendingWrite = resolve;
    });
    harness.storageSet.mockImplementationOnce(
      async (values: Record<string, unknown>) => {
        await oldPendingWriteGate;
        for (const [key, value] of Object.entries(values)) {
          harness.storage.set(key, value);
        }
      },
    );

    const first = harness.dispatch({
      type: "JUMP_TO_REPLY",
      replyId: "101",
    });
    await vi.waitFor(() => expect(harness.storageSet).toHaveBeenCalledTimes(1));

    const second = harness.dispatch({
      type: "JUMP_TO_REPLY",
      replyId: "102",
    });
    await vi.waitFor(() =>
      expect(harness.tabsSendMessage).toHaveBeenCalledTimes(2),
    );
    expect(harness.tabsUpdate).not.toHaveBeenCalled();
    expect(harness.tabsReload).not.toHaveBeenCalled();

    releaseOldPendingWrite();

    await expect(first).resolves.toMatchObject({
      ok: false,
      code: "SESSION_STALE",
    });
    await expect(second).resolves.toEqual({ ok: true, data: true });
    expect(harness.tabsUpdate).toHaveBeenCalledTimes(1);
    expect(harness.tabsUpdate).toHaveBeenCalledWith(42, {
      url: "https://tieba.baidu.com/p/123?pid=102#102",
    });
    expect(harness.tabsReload).not.toHaveBeenCalled();
    expect(harness.storage.get("kr_tieba_pending_jump_42")).toMatchObject({
      threadId: "123",
      locator: { replyId: "102", siteReplyId: "102" },
    });
  });

  it("does not return to the old thread when loading suspends a jump paused in pending storage", async () => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com/p/123",
    });
    harness.storage.set(
      sessionStorageKey(42),
      mergeCapture(null, spaCapture(["101"]), 42),
    );
    harness.executeScript.mockResolvedValue([{ frameId: 0 }]);
    harness.tabsSendMessage.mockResolvedValue({
      ok: false,
      error: "当前列表未挂载目标",
      code: "EVIDENCE_NOT_LOADED",
    });
    let releasePendingWrite!: () => void;
    const pendingWriteGate = new Promise<void>((resolve) => {
      releasePendingWrite = resolve;
    });
    harness.storageSet.mockImplementationOnce(
      async (values: Record<string, unknown>) => {
        await pendingWriteGate;
        for (const [key, value] of Object.entries(values)) {
          harness.storage.set(key, value);
        }
      },
    );

    const jump = harness.dispatch({
      type: "JUMP_TO_REPLY",
      replyId: "101",
    });
    await vi.waitFor(() => expect(harness.storageSet).toHaveBeenCalledTimes(1));
    harness.updated(harness.activeTab, "loading");
    releasePendingWrite();

    await expect(jump).resolves.toMatchObject({
      ok: false,
      code: "SESSION_STALE",
    });
    expect(harness.tabsUpdate).not.toHaveBeenCalled();
    expect(harness.tabsReload).not.toHaveBeenCalled();
    expect(harness.storage.has("kr_tieba_pending_jump_42")).toBe(false);
  });

  it("does not return to the old thread when navigation clears a jump paused in pending storage", async () => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com/p/123",
    });
    harness.storage.set(
      sessionStorageKey(42),
      mergeCapture(null, spaCapture(["101"]), 42),
    );
    harness.executeScript.mockResolvedValue([{ frameId: 0 }]);
    harness.tabsSendMessage.mockResolvedValue({
      ok: false,
      error: "当前列表未挂载目标",
      code: "EVIDENCE_NOT_LOADED",
    });
    let releasePendingWrite!: () => void;
    const pendingWriteGate = new Promise<void>((resolve) => {
      releasePendingWrite = resolve;
    });
    harness.storageSet.mockImplementationOnce(
      async (values: Record<string, unknown>) => {
        await pendingWriteGate;
        for (const [key, value] of Object.entries(values)) {
          harness.storage.set(key, value);
        }
      },
    );

    const jump = harness.dispatch({
      type: "JUMP_TO_REPLY",
      replyId: "101",
    });
    await vi.waitFor(() => expect(harness.storageSet).toHaveBeenCalledTimes(1));
    harness.updated(
      harness.activeTab,
      null,
      "https://tieba.baidu.com/p/999",
    );
    await vi.waitFor(() =>
      expect(harness.storageRemove).toHaveBeenCalledWith(
        "kr_tieba_pending_jump_42",
      ),
    );
    releasePendingWrite();

    await expect(jump).resolves.toMatchObject({
      ok: false,
      code: "SESSION_STALE",
    });
    expect(harness.tabsUpdate).not.toHaveBeenCalled();
    expect(harness.tabsReload).not.toHaveBeenCalled();
    expect(harness.storage.has("kr_tieba_pending_jump_42")).toBe(false);
    expect(harness.storage.has(sessionStorageKey(42))).toBe(false);
  });

  it("does not navigate when the active tab changes while in-page lookup is running", async () => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com/p/123",
    });
    harness.storage.set(
      sessionStorageKey(42),
      mergeCapture(null, spaCapture(["101"]), 42),
    );
    harness.executeScript.mockResolvedValue([{ frameId: 0 }]);
    let resolveContent!: (response: ExtensionResponse<boolean>) => void;
    harness.tabsSendMessage.mockReturnValue(
      new Promise<ExtensionResponse<boolean>>((resolve) => {
        resolveContent = resolve;
      }),
    );

    const jump = harness.dispatch({
      type: "JUMP_TO_REPLY",
      replyId: "101",
    });
    await vi.waitFor(() => expect(harness.tabsSendMessage).toHaveBeenCalled());
    harness.tabsQuery.mockResolvedValue([
      { ...harness.activeTab, id: 99, url: "https://tieba.baidu.com/p/999" },
    ]);
    resolveContent({
      ok: false,
      error: "当前列表未挂载目标",
      code: "EVIDENCE_NOT_LOADED",
    });

    await expect(jump).resolves.toMatchObject({
      ok: false,
      code: "SESSION_STALE",
    });
    expect(harness.tabsUpdate).not.toHaveBeenCalled();
    expect(harness.tabsReload).not.toHaveBeenCalled();
    expect(harness.storage.has("kr_tieba_pending_jump_42")).toBe(false);
  });

  it("uses the parent PID and child CID for an unloaded API nested reply", async () => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com/p/123",
    });
    const page = spaCapture(["101"]);
    page.parserVariant = "api";
    page.coverage.captureMode = "api";
    page.replies.push({
      ...page.replies[0],
      id: "201",
      siteReplyId: "201",
      parentReplyId: "101",
      isNested: true,
      anchor: `[data-spid="201"]`,
      content: "楼中楼证据正文不会进入 pending locator",
      authorName: "楼中楼用户",
    });
    harness.storage.set(sessionStorageKey(42), mergeCapture(null, page, 42));
    harness.executeScript.mockResolvedValue([{ frameId: 0 }]);
    harness.tabsSendMessage.mockResolvedValue({
      ok: false,
      error: "楼中楼尚未挂载",
      code: "EVIDENCE_NOT_LOADED",
    });

    const response = await harness.dispatch({
      type: "JUMP_TO_REPLY",
      replyId: "201",
    });

    expect(response).toEqual({ ok: true, data: true });
    expect(harness.tabsUpdate).toHaveBeenCalledWith(42, {
      url: "https://tieba.baidu.com/p/123?pid=101&cid=201#201",
    });
    const pending = harness.storage.get("kr_tieba_pending_jump_42");
    expect(pending).toMatchObject({
      threadId: "123",
      locator: {
        replyId: "201",
        siteReplyId: "201",
        parentReplyId: "101",
        parentSiteReplyId: "101",
        isNested: true,
      },
    });
    expect(JSON.stringify(pending)).not.toContain("楼中楼证据正文");
    expect(JSON.stringify(pending)).not.toContain("楼中楼用户");
  });

  it("never navigates or expands an unloaded nested reply", async () => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com/p/123",
    });
    const page = spaCapture(["101"]);
    page.replies.push({
      ...page.replies[0],
      id: "kr-lzl-document-1-opaque",
      siteReplyId: null,
      parentReplyId: "101",
      isNested: true,
      anchor: `[data-kr-review-reply-id="kr-lzl-document-1-opaque"]`,
    });
    harness.storage.set(sessionStorageKey(42), mergeCapture(null, page, 42));
    harness.executeScript.mockResolvedValue([{ frameId: 0 }]);
    harness.tabsSendMessage.mockResolvedValue({
      ok: false,
      error: "请手动展开后再试",
      code: "EVIDENCE_NOT_LOADED",
    });

    const response = await harness.dispatch({
      type: "JUMP_TO_REPLY",
      replyId: "kr-lzl-document-1-opaque",
    });

    expect(response).toEqual({
      ok: false,
      error: "请手动展开后再试",
      code: "EVIDENCE_NOT_LOADED",
    });
    expect(harness.tabsUpdate).not.toHaveBeenCalled();
  });

  it("keeps a pending official jump when the target is still not mounted, then clears it after a retry succeeds", async () => {
    const harness = await createHarness({
      url: "https://tieba.baidu.com/p/123",
    });
    harness.storage.set(
      sessionStorageKey(42),
      mergeCapture(null, spaCapture(["101"], "document-1"), 42),
    );
    harness.executeScript.mockResolvedValue([{ frameId: 0 }]);
    harness.tabsSendMessage.mockResolvedValue({
      ok: false,
      error: "尚未挂载",
      code: "EVIDENCE_NOT_LOADED",
    });
    await harness.dispatch({ type: "JUMP_TO_REPLY", replyId: "101" });
    expect(harness.storage.has("kr_tieba_pending_jump_42")).toBe(true);
    harness.tabsSendMessage.mockClear();

    harness.updated(harness.activeTab, "loading");
    harness.tabsSendMessage.mockImplementation(
      async (_tabId: number, message: { type: string }) => {
        if (message.type === "PARSE_TIEBA_PAGE") {
          return { ok: true, data: spaCapture(["101"], "document-2") };
        }
        if (message.type === "START_DYNAMIC_CAPTURE") {
          return { ok: true, data: true };
        }
        return {
          ok: false,
          error: "尚未挂载",
          code: "EVIDENCE_NOT_LOADED",
        };
      },
    );
    harness.updated(harness.activeTab, "complete");
    await vi.waitFor(() =>
      expect(
        harness.tabsSendMessage.mock.calls.some(
          ([, message]) => (message as { type: string }).type === "JUMP_TO_REPLY",
        ),
      ).toBe(true),
    );
    const pendingResume = harness.tabsSendMessage.mock.calls.find(
      ([, message]) => (message as { type: string }).type === "JUMP_TO_REPLY",
    )?.[1] as ContentRequest | undefined;
    expect(pendingResume).toMatchObject({
      type: "JUMP_TO_REPLY",
      expectedThreadId: "123",
      waitForOfficialRoute: true,
    });
    expect(harness.storage.has("kr_tieba_pending_jump_42")).toBe(true);

    harness.tabsSendMessage.mockResolvedValue({ ok: true, data: true });
    expect(
      await harness.dispatch({ type: "JUMP_TO_REPLY", replyId: "101" }),
    ).toEqual({ ok: true, data: true });
    expect(harness.tabsSendMessage).toHaveBeenLastCalledWith(
      42,
      expect.objectContaining({
        type: "JUMP_TO_REPLY",
        expectedThreadId: "123",
        waitForOfficialRoute: true,
      }),
    );
    expect(harness.storage.has("kr_tieba_pending_jump_42")).toBe(false);
  });
});
