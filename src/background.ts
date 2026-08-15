import type {
  ContentRequest,
  DynamicContentChangedMessage,
  EvidenceLocator,
  ExtensionRequest,
  ExtensionResponse,
  ExtensionErrorCode,
  ParseResponse,
  PageIdentityChangedMessage,
  SessionClearedMessage,
  SessionSuspendedMessage,
  SessionUpdatedMessage,
} from "./messages";
import {
  classifySessionUrl,
  mergeCapture,
  sessionStorageKey,
  tiebaThreadIdFromUrl,
  type ReviewSession,
} from "./lib/session";
import {
  ExtensionOperationError,
  normalizeExtensionError,
} from "./lib/extensionError";
import type { ThreadCapture } from "./types";
import { threadCloudCacheStorageKey } from "./lib/threadCloudCache";
import { installCloudAnalysisBroker } from "./cloudBroker";
import {
  captureTiebaThread,
  type TiebaApiCaptureOptions,
} from "./tiebaApiCapture";
import {
  TiebaApiError,
  type TiebaNestedPageProjection,
  type TiebaReadRequest,
} from "./lib/tiebaApi";
import type { TiebaTransportResponse } from "./lib/tiebaTransport";

const cloudBroker =
  typeof chrome.permissions?.remove === "function" &&
  typeof chrome.permissions?.contains === "function" &&
  Boolean(chrome.runtime.onConnect?.addListener)
    ? installCloudAnalysisBroker({
        runtime: chrome.runtime,
        permissions: chrome.permissions,
        // Optional host grants survive a browser restart, so the lease marker
        // must also be durable. It contains no API key, username or reply body.
        storage: chrome.storage.local,
      })
    : null;

const PENDING_JUMP_MAX_AGE_MS = 2 * 60 * 1_000;
const dynamicCaptureQueues = new Map<number, Promise<void>>();
const lastDynamicSignatures = new Map<
  number,
  { documentInstanceId: string; signature: string }
>();
const captureGenerations = new Map<number, number>();
const suspendedTabs = new Set<number>();
const apiCaptureTokens = new Map<number, symbol>();
const jumpRoutingTokens = new Map<number, symbol>();
const jumpNavigationQueues = new Map<number, Promise<void>>();

interface PendingJump {
  threadId: string;
  locator: EvidenceLocator;
  createdAt: number;
}

const pendingJumpStorageKey = (tabId: number): string =>
  `kr_tieba_pending_jump_${tabId}`;
const suspendedSessionStorageKey = (tabId: number): string =>
  `kr_tieba_session_suspended_${tabId}`;

function captureGeneration(tabId: number): number {
  return captureGenerations.get(tabId) ?? 0;
}

function bumpCaptureGeneration(tabId: number): void {
  captureGenerations.set(tabId, captureGeneration(tabId) + 1);
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

async function activeTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new ExtensionOperationError("找不到当前标签页", "UNKNOWN");
  }
  return tab;
}

function assertTiebaThreadUrl(url: string | null): asserts url is string {
  if (url) {
    try {
      const parsed = new URL(url);
      if (
        [
          "about:",
          "chrome:",
          "chrome-extension:",
          "edge:",
          "file:",
          "tabbit:",
        ].includes(parsed.protocol)
      ) {
        throw new ExtensionOperationError(
          "当前页面属于浏览器受限页面，扩展无法读取；请回到百度贴吧帖子后再试。",
          "RESTRICTED_PAGE",
        );
      }
    } catch (error) {
      if (error instanceof ExtensionOperationError) throw error;
    }
  }
  if (!url || !tiebaThreadIdFromUrl(url)) {
    throw new ExtensionOperationError(
      "请先打开一个百度贴吧帖子页面（tieba.baidu.com/p/...）",
      "INVALID_TIEBA_PAGE",
    );
  }
}

async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  } catch (error) {
    throw normalizeExtensionError(error, "SCRIPT_INJECTION_FAILED");
  }
}

async function contentMessage<T>(
  tabId: number,
  message: ContentRequest,
  options: { ensureInjected?: boolean } = {},
): Promise<ExtensionResponse<T>> {
  if (options.ensureInjected !== false) {
    await ensureContentScript(tabId);
  }
  try {
    const response = (await chrome.tabs.sendMessage(
      tabId,
      message,
    )) as ExtensionResponse<T> | undefined;
    if (!response) {
      throw new Error("content script returned no response");
    }
    return response;
  } catch (error) {
    throw normalizeExtensionError(error, "SCRIPT_INJECTION_FAILED");
  }
}

async function resolveTabUrl(
  tab: chrome.tabs.Tab,
  options: { throwOnFailure?: boolean; preferLiveLocation?: boolean } = {},
): Promise<string | null> {
  if (tab.status === "loading") return null;
  if (tab.url && !options.preferLiveLocation) return tab.url;
  if (!tab.id) return null;
  let lastError: unknown;

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.location.href,
    });
    const value = results[0]?.result;
    if (typeof value === "string" && value) return value;
  } catch (error) {
    lastError = error;
    // Some Chromium variants omit results for inline functions. Fall back to
    // the same explicitly injected content script used for page parsing.
  }

  try {
    const response = await contentMessage<string>(tab.id, {
      type: "GET_PAGE_URL",
    });
    return response.ok ? response.data : null;
  } catch (error) {
    lastError = error;
  }
  if (tab.url && options.preferLiveLocation) return tab.url;
  if (options.throwOnFailure && lastError) {
    throw normalizeExtensionError(lastError, "SCRIPT_INJECTION_FAILED");
  }
  return null;
}

async function loadSession(tabId: number): Promise<ReviewSession | null> {
  const key = sessionStorageKey(tabId);
  const stored = await chrome.storage.session.get(key);
  return (stored[key] as ReviewSession | undefined) ?? null;
}

async function saveSession(
  session: ReviewSession,
  expectedGeneration?: number,
): Promise<void> {
  if (
    expectedGeneration !== undefined &&
    captureGeneration(session.tabId) !== expectedGeneration
  ) {
    throw new ExtensionOperationError(
      "审阅会话已清除或页面已重新加载，本次动态结果未保存。",
      "SESSION_STALE",
    );
  }
  await chrome.storage.session.set({
    [sessionStorageKey(session.tabId)]: session,
  });
  if (
    expectedGeneration !== undefined &&
    captureGeneration(session.tabId) !== expectedGeneration
  ) {
    const stored = await loadSession(session.tabId);
    if (
      stored?.updatedAt === session.updatedAt &&
      stored.threadId === session.threadId &&
      sessionDocumentInstanceId(stored) === sessionDocumentInstanceId(session)
    ) {
      await chrome.storage.session.remove(sessionStorageKey(session.tabId));
    }
    throw new ExtensionOperationError(
      "审阅会话已清除或页面已重新加载，本次动态结果未保存。",
      "SESSION_STALE",
    );
  }
}

function broadcastSessionUpdated(session: ReviewSession): void {
  const update: SessionUpdatedMessage = { type: "SESSION_UPDATED", session };
  void chrome.runtime.sendMessage(update).catch(() => undefined);
}

async function clearSession(
  tabId: number,
  reason: SessionClearedMessage["reason"],
): Promise<void> {
  // Invalidate an in-flight official fallback synchronously, before the first
  // storage await. Otherwise a delayed pending write could resume after the
  // user has left and navigate the tab back to the previous thread.
  jumpRoutingTokens.delete(tabId);
  apiCaptureTokens.delete(tabId);
  bumpCaptureGeneration(tabId);
  await chrome.storage.session.remove(sessionStorageKey(tabId));
  await chrome.storage.session.remove(threadCloudCacheStorageKey(tabId));
  await chrome.storage.session.remove(pendingJumpStorageKey(tabId));
  await chrome.storage.session.remove(suspendedSessionStorageKey(tabId));
  suspendedTabs.delete(tabId);
  lastDynamicSignatures.delete(tabId);
  const update: SessionClearedMessage = { type: "SESSION_CLEARED", tabId, reason };
  void chrome.runtime.sendMessage(update).catch(() => undefined);
}

async function loadPendingJump(tabId: number): Promise<PendingJump | null> {
  const key = pendingJumpStorageKey(tabId);
  const stored = await chrome.storage.session.get(key);
  const pending = stored[key] as PendingJump | undefined;
  if (!pending) return null;
  if (Date.now() - pending.createdAt <= PENDING_JUMP_MAX_AGE_MS) return pending;
  await chrome.storage.session.remove(key);
  return null;
}

async function savePendingJump(
  tabId: number,
  pending: PendingJump,
): Promise<void> {
  await chrome.storage.session.set({ [pendingJumpStorageKey(tabId)]: pending });
}

async function clearPendingJump(tabId: number): Promise<void> {
  await chrome.storage.session.remove(pendingJumpStorageKey(tabId));
}

function suspendSession(tabId: number): void {
  // tabs.onUpdated emits loading before the destination identity is reliable.
  // Cancel any old-thread fallback immediately; the stored review session can
  // remain suspended for a possible same-thread reload.
  jumpRoutingTokens.delete(tabId);
  apiCaptureTokens.delete(tabId);
  bumpCaptureGeneration(tabId);
  lastDynamicSignatures.delete(tabId);
  suspendedTabs.add(tabId);
  void chrome.storage.session.set({
    [suspendedSessionStorageKey(tabId)]: {
      generation: captureGeneration(tabId),
      suspendedAt: new Date().toISOString(),
    },
  });
  const update: SessionSuspendedMessage = {
    type: "SESSION_SUSPENDED",
    tabId,
    reason: "url_unavailable",
  };
  void chrome.runtime.sendMessage(update).catch(() => undefined);
}

async function isSessionSuspended(tabId: number): Promise<boolean> {
  if (suspendedTabs.has(tabId)) return true;
  const key = suspendedSessionStorageKey(tabId);
  const stored = await chrome.storage.session.get(key);
  if (stored[key] === undefined) return false;
  suspendedTabs.add(tabId);
  return true;
}

async function clearSessionSuspension(
  tabId: number,
  expectedGeneration: number,
): Promise<void> {
  if (captureGeneration(tabId) !== expectedGeneration) {
    throw new ExtensionOperationError(
      "页面已重新加载，本次采集结果未恢复为活动会话。",
      "SESSION_STALE",
    );
  }

  const key = suspendedSessionStorageKey(tabId);
  await chrome.storage.session.remove(key);

  // A reload can begin while the storage removal above is in flight. Never
  // let the older capture erase the newer loading marker or publish its
  // session after that point.
  if (captureGeneration(tabId) !== expectedGeneration) {
    if (suspendedTabs.has(tabId)) {
      await chrome.storage.session.set({
        [key]: {
          generation: captureGeneration(tabId),
          suspendedAt: new Date().toISOString(),
        },
      });
    }
    throw new ExtensionOperationError(
      "页面已重新加载，本次采集结果未恢复为活动会话。",
      "SESSION_STALE",
    );
  }

  suspendedTabs.delete(tabId);
}

async function loadValidSession(
  tab: chrome.tabs.Tab,
): Promise<ReviewSession | null> {
  if (!tab.id) return null;
  const current = await loadSession(tab.id);
  if (!current) return null;
  if (await isSessionSuspended(tab.id)) return null;
  const url = await resolveTabUrl(tab);
  const status = classifySessionUrl(current, url);
  if (status === "unknown") return null;
  if (status === "different") {
    await clearSession(tab.id, "navigation");
    return null;
  }
  return current;
}

interface CaptureTabOptions {
  expectedDocumentInstanceId?: string;
  expectedGeneration?: number;
  startDynamicCapture?: boolean;
  additionalWarning?: string;
}

async function captureTab(
  tab: chrome.tabs.Tab,
  options: CaptureTabOptions = {},
): Promise<ReviewSession> {
  if (!tab.id) {
    throw new ExtensionOperationError("找不到当前标签页", "UNKNOWN");
  }
  const expectedGeneration =
    options.expectedGeneration ?? captureGeneration(tab.id);
  if (captureGeneration(tab.id) !== expectedGeneration) {
    throw new ExtensionOperationError(
      "审阅会话已失效，本次动态采集已取消。",
      "SESSION_STALE",
    );
  }
  const currentUrl = await resolveTabUrl(tab, { throwOnFailure: true });
  if (!currentUrl) {
    throw new ExtensionOperationError(
      tab.status === "loading"
        ? "当前帖子仍在加载，请等待页面完成后再读取。"
        : "无法确认当前页面地址，请刷新贴吧帖子后重试。",
      tab.status === "loading" ? "PAGE_NOT_READY" : "SCRIPT_INJECTION_FAILED",
    );
  }
  assertTiebaThreadUrl(currentUrl);
  const expectedThreadId = tiebaThreadIdFromUrl(currentUrl)!;
  const response = (await contentMessage<ThreadCapture>(tab.id, {
    type: "PARSE_TIEBA_PAGE",
  })) as ParseResponse;
  if (!response.ok) {
    throw new ExtensionOperationError(
      response.error,
      response.code ?? "PAGE_PARSE_FAILED",
    );
  }
  assertTiebaThreadUrl(response.data.url);
  const capturedThreadId = tiebaThreadIdFromUrl(response.data.url)!;
  if (
    capturedThreadId !== expectedThreadId ||
    response.data.threadId !== capturedThreadId
  ) {
    throw new ExtensionOperationError(
      "页面在读取过程中切换到了另一帖子，本次结果已丢弃，请重新读取。",
      "INVALID_TIEBA_PAGE",
    );
  }

  if (
    captureGeneration(tab.id) !== expectedGeneration
  ) {
    throw new ExtensionOperationError(
      "审阅会话已清除或页面已重新加载，本次动态结果未保存。",
      "SESSION_STALE",
    );
  }

  if (
    options.expectedDocumentInstanceId !== undefined &&
    response.data.documentInstanceId !== options.expectedDocumentInstanceId
  ) {
    throw new ExtensionOperationError(
      "页面已重新加载，本次动态采集结果已丢弃。",
      "SESSION_STALE",
    );
  }

  if (response.data.parserVariant === "spa") {
    if (!response.data.documentInstanceId) {
      throw new ExtensionOperationError(
        "新版帖子缺少页面实例标识，本次结果未保存。",
        "PAGE_PARSE_FAILED",
      );
    }
    if (options.startDynamicCapture !== false) {
      const observer = await contentMessage<boolean>(tab.id, {
        type: "START_DYNAMIC_CAPTURE",
        threadId: capturedThreadId,
        documentInstanceId: response.data.documentInstanceId,
        allowMissingContainer:
          response.data.coverage.declaredReplyCount === 0,
      });
      if (!observer.ok) {
        throw new ExtensionOperationError(
          observer.error,
          observer.code ?? "PAGE_LAYOUT_UNSUPPORTED",
        );
      }
    }
  }

  const captured =
    options.additionalWarning === undefined
      ? response.data
      : {
          ...response.data,
          warnings: [
            ...response.data.warnings,
            options.additionalWarning,
          ],
        };
  const current = await loadSession(tab.id);
  const merged = mergeCapture(current, captured, tab.id);
  await saveSession(merged, expectedGeneration);
  await clearSessionSuspension(tab.id, expectedGeneration);
  if (captureGeneration(tab.id) !== expectedGeneration) {
    throw new ExtensionOperationError(
      "页面已重新加载，本次采集结果未恢复为活动会话。",
      "SESSION_STALE",
    );
  }
  broadcastSessionUpdated(merged);
  return merged;
}

function extensionErrorInCauseChain(
  error: unknown,
): ExtensionOperationError | null {
  let current = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 8 && current && !seen.has(current); depth += 1) {
    seen.add(current);
    if (current instanceof ExtensionOperationError) return current;
    current =
      typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : null;
  }
  return null;
}

function normalizeWholeThreadError(error: unknown): ExtensionOperationError {
  const nested = extensionErrorInCauseChain(error);
  if (nested) {
    if (
      nested.code === "SESSION_STALE" ||
      nested.code === "CAPTURE_CANCELLED"
    ) {
      return normalizeExtensionError(error, "CAPTURE_CANCELLED");
    }
    return nested;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return normalizeExtensionError(error, "CAPTURE_CANCELLED");
  }
  if (error instanceof TiebaApiError) {
    const code: ExtensionErrorCode =
      error.code === "INVALID_RESPONSE" ||
      error.code === "THREAD_MISMATCH" ||
      error.code === "PAGE_MISMATCH" ||
      error.code === "INVALID_ARGUMENT"
        ? "TIEBA_READ_API_RESPONSE_INVALID"
        : "TIEBA_READ_API_FAILED";
    return normalizeExtensionError(error, code);
  }
  return normalizeExtensionError(error, "TIEBA_READ_API_FAILED");
}

function isApiSessionForThread(
  session: ReviewSession | null,
  threadId: string,
): boolean {
  return Boolean(
    session?.threadId === threadId &&
      Object.values(session.pages).some(
        (capture) => capture.parserVariant === "api",
      ),
  );
}

async function captureWholeThread(
  tab: chrome.tabs.Tab,
): Promise<ReviewSession> {
  if (!tab.id) {
    throw new ExtensionOperationError("找不到当前标签页", "UNKNOWN");
  }
  const tabId = tab.id;
  const currentUrl = await resolveTabUrl(tab, { throwOnFailure: true });
  if (!currentUrl) {
    throw new ExtensionOperationError(
      tab.status === "loading"
        ? "当前帖子仍在加载，请等待页面完成后再读取。"
        : "无法确认当前页面地址，请刷新贴吧帖子后重试。",
      tab.status === "loading" ? "PAGE_NOT_READY" : "SCRIPT_INJECTION_FAILED",
    );
  }
  assertTiebaThreadUrl(currentUrl);
  const threadId = tiebaThreadIdFromUrl(currentUrl)!;
  const expectedGeneration = captureGeneration(tabId);
  const token = Symbol(`tieba-api-${tabId}`);
  apiCaptureTokens.set(tabId, token);

  const checkpoint = async (): Promise<void> => {
    if (
      apiCaptureTokens.get(tabId) !== token ||
      captureGeneration(tabId) !== expectedGeneration
    ) {
      throw new ExtensionOperationError(
        "页面已切换或开始重新加载，本次整帖读取已取消。",
        "CAPTURE_CANCELLED",
      );
    }
  };

  try {
    await checkpoint();
    await ensureContentScript(tabId);
    const capture = await captureTiebaThread({
      threadId,
      threadUrl: currentUrl,
      checkpoint,
      request: async (request: TiebaReadRequest): Promise<string> => {
        const response = await contentMessage<TiebaTransportResponse>(
          tabId,
          { type: "FETCH_TIEBA_READ_API", request },
          { ensureInjected: false },
        );
        if (!response.ok) {
          throw new ExtensionOperationError(
            response.error,
            response.code ?? "TIEBA_READ_API_FAILED",
          );
        }
        if (
          response.data.status !== 200 ||
          response.data.url !== request.url ||
          typeof response.data.text !== "string"
        ) {
          throw new ExtensionOperationError(
            "贴吧只读接口返回了无法验证的响应。",
            "TIEBA_READ_API_RESPONSE_INVALID",
          );
        }
        return response.data.text;
      },
      parseNested: async (
        html,
        context,
      ): Promise<TiebaNestedPageProjection> => {
        const response = await contentMessage<TiebaNestedPageProjection>(
          tabId,
          { type: "PARSE_TIEBA_NESTED_HTML", html, context },
          { ensureInjected: false },
        );
        if (!response.ok) {
          throw new ExtensionOperationError(
            response.error,
            response.code ?? "TIEBA_READ_API_RESPONSE_INVALID",
          );
        }
        if (
          response.data.threadId !== threadId ||
          response.data.parentReplyId !== context.parentReplyId ||
          response.data.parentSiteReplyId !== context.parentSiteReplyId ||
          response.data.currentPage !== context.page
        ) {
          throw new ExtensionOperationError(
            "楼中楼接口结果与请求的帖子或父楼不一致。",
            "TIEBA_READ_API_RESPONSE_INVALID",
          );
        }
        return response.data;
      },
    } satisfies TiebaApiCaptureOptions);

    await checkpoint();
    if (
      capture.threadId !== threadId ||
      tiebaThreadIdFromUrl(capture.url) !== threadId
    ) {
      throw new ExtensionOperationError(
        "贴吧只读接口返回了另一个帖子的内容。",
        "TIEBA_READ_API_RESPONSE_INVALID",
      );
    }
    const identity = await contentMessage<string>(
      tabId,
      { type: "GET_PAGE_URL" },
      { ensureInjected: false },
    );
    if (
      !identity.ok ||
      tiebaThreadIdFromUrl(identity.data) !== threadId
    ) {
      throw new ExtensionOperationError(
        "页面在整帖读取期间发生了切换，本次结果已丢弃。",
        "CAPTURE_CANCELLED",
      );
    }
    await checkpoint();

    const current = await loadSession(tabId);
    const merged = mergeCapture(current, capture, tabId);
    await saveSession(merged, expectedGeneration);
    await clearSessionSuspension(tabId, expectedGeneration);
    await checkpoint();
    lastDynamicSignatures.delete(tabId);
    broadcastSessionUpdated(merged);
    return merged;
  } catch (error) {
    const normalized = normalizeWholeThreadError(error);
    if (
      normalized.code === "CAPTURE_CANCELLED" ||
      normalized.code === "SESSION_STALE"
    ) {
      throw normalized;
    }
    await checkpoint();
    const prior = await loadSession(tabId);
    if (isApiSessionForThread(prior, threadId)) {
      throw normalized;
    }
    return captureTab(tab, {
      expectedGeneration,
      additionalWarning:
        "整帖只读接口本次不可用，当前结果仅来自页面已挂载内容；请勿据此判定整帖安全。",
    });
  } finally {
    if (apiCaptureTokens.get(tabId) === token) {
      apiCaptureTokens.delete(tabId);
    }
  }
}

function parserVariantForReply(
  session: ReviewSession,
  replyId: string,
): ThreadCapture["parserVariant"] {
  return (
    Object.values(session.pages).find((capture) =>
      capture.replies.some((reply) => reply.id === replyId),
    )?.parserVariant ??
    (session.coverage.captureMode === "api"
      ? "api"
      : session.coverage.captureMode === "dynamic"
        ? "spa"
        : "legacy")
  );
}

function evidenceLocator(
  session: ReviewSession,
  replyId: string,
): EvidenceLocator | null {
  const reply = session.replies.find((candidate) => candidate.id === replyId);
  if (!reply) return null;
  const parent = reply.parentReplyId
    ? session.replies.find(
        (candidate) => candidate.id === reply.parentReplyId,
      ) ?? null
    : null;
  const parserVariant = parserVariantForReply(session, replyId);
  return {
    replyId: reply.id,
    siteReplyId: reply.siteReplyId,
    floor: reply.floor,
    // The read API knows the first-floor PID, but the new SPA's main thread
    // card currently omits it from the DOM. Its semantic root is nevertheless
    // always mounted, so retain the API selector and add the known root cards.
    anchor:
      parserVariant === "api" && !reply.isNested && reply.floor === 1
        ? `${reply.anchor}, .image-text, .score-thread, .recruit-thread`
        : reply.anchor,
    parentReplyId: reply.parentReplyId,
    parentSiteReplyId: parent?.siteReplyId ?? null,
    parentAnchor: parent?.anchor ?? null,
    isNested: reply.isNested,
    parserVariant,
  };
}

function isSameOfficialReplyUrl(
  currentUrl: string | undefined,
  target: URL,
): boolean {
  if (!currentUrl) return false;
  try {
    const current = new URL(currentUrl);
    const normalizedTarget = new URL(target.href);
    // Hash-only changes do not reload Tieba's SPA and therefore do not reset
    // its in-memory hot/ascending/descending list. Compare the navigational
    // part only and explicitly reload when it already points at this PID.
    current.hash = "";
    normalizedTarget.hash = "";
    return current.href === normalizedTarget.href;
  } catch {
    return false;
  }
}

async function navigateToOfficialReply(
  tab: chrome.tabs.Tab,
  session: ReviewSession,
  locator: EvidenceLocator,
  token: symbol,
): Promise<void> {
  const tabId = tab.id;
  if (!tabId) {
    throw new ExtensionOperationError(
      "当前标签页已失效，请重新打开帖子后再试。",
      "SESSION_STALE",
    );
  }
  const targetPid = locator.isNested
    ? locator.parentSiteReplyId
    : locator.siteReplyId;
  const threadId = session.threadId;
  if (!threadId || !targetPid) {
    throw new ExtensionOperationError(
      "这条证据当前未加载，请继续滚动或展开回复后重试。",
      "EVIDENCE_NOT_LOADED",
    );
  }
  const target = new URL(
    `/p/${encodeURIComponent(threadId)}`,
    "https://tieba.baidu.com",
  );
  target.searchParams.set("pid", targetPid);
  if (locator.isNested && locator.siteReplyId) {
    target.searchParams.set("cid", locator.siteReplyId);
    target.hash = locator.siteReplyId;
  } else {
    target.hash = targetPid;
  }
  await withJumpNavigationLock(tabId, async () => {
    let pendingSaved = false;
    try {
      assertLatestJump(tabId, token);
      await savePendingJump(tabId, {
        threadId,
        locator,
        createdAt: Date.now(),
      });
      pendingSaved = true;
      // A newer click can arrive while chrome.storage.session.set is pending.
      // Check again before touching the tab. The per-tab navigation lock keeps
      // the newer request from writing its pending locator until this stale
      // one has removed its own record.
      assertLatestJump(tabId, token);
      if (isSameOfficialReplyUrl(tab.url, target)) {
        // The three SPA sort modes share one URL. Updating a tab to its current
        // ?pid URL is a no-op, leaving an unloaded target missing in another
        // sort. A real reload lets Tieba's official PID route mount it again.
        assertLatestJump(tabId, token);
        await chrome.tabs.reload(tabId);
      } else {
        assertLatestJump(tabId, token);
        await chrome.tabs.update(tabId, { url: target.href });
      }
    } catch (error) {
      if (pendingSaved) await clearPendingJump(tabId);
      throw error;
    }
  });
}

function assertLatestJump(tabId: number, token: symbol): void {
  if (jumpRoutingTokens.get(tabId) !== token) {
    throw new ExtensionOperationError(
      "已有新的证据定位请求，本次旧请求已取消。",
      "SESSION_STALE",
    );
  }
}

async function withJumpNavigationLock<T>(
  tabId: number,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = jumpNavigationQueues.get(tabId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  jumpNavigationQueues.set(tabId, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (jumpNavigationQueues.get(tabId) === tail) {
      jumpNavigationQueues.delete(tabId);
    }
  }
}

async function revalidateJumpContext(
  tabId: number,
  expectedThreadId: string | null,
  token: symbol,
): Promise<{ tab: chrome.tabs.Tab; session: ReviewSession }> {
  assertLatestJump(tabId, token);
  const tab = await activeTab();
  assertLatestJump(tabId, token);
  if (tab.id !== tabId) {
    throw new ExtensionOperationError(
      "当前标签页已切换，本次证据定位已取消。",
      "SESSION_STALE",
    );
  }
  const session = await loadValidSession(tab);
  assertLatestJump(tabId, token);
  if (!expectedThreadId || !session || session.threadId !== expectedThreadId) {
    throw new ExtensionOperationError(
      "帖子已切换或审阅会话已失效，本次证据定位已取消。",
      "SESSION_STALE",
    );
  }
  return { tab, session };
}

async function resumePendingJump(
  tab: chrome.tabs.Tab,
  session: ReviewSession,
): Promise<void> {
  if (!tab.id) return;
  const pending = await loadPendingJump(tab.id);
  if (!pending || pending.threadId !== session.threadId) return;
  const response = await contentMessage<boolean>(tab.id, {
    type: "JUMP_TO_REPLY",
    locator: pending.locator,
    expectedThreadId: pending.threadId,
    waitForOfficialRoute: true,
  });
  if (response.ok) await clearPendingJump(tab.id);
}

function sessionDocumentInstanceId(session: ReviewSession): string | null {
  return session.pages.spa?.documentInstanceId ?? null;
}

function isDynamicContentChangedMessage(
  value: unknown,
): value is DynamicContentChangedMessage {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  const candidate = value as Partial<DynamicContentChangedMessage>;
  return (
    candidate.type === "TIEBA_DYNAMIC_CONTENT_CHANGED" &&
    typeof candidate.threadId === "string" &&
    typeof candidate.url === "string" &&
    typeof candidate.documentInstanceId === "string" &&
    typeof candidate.signature === "string" &&
    /^\d+:[0-9a-f]{16}$/u.test(candidate.signature)
  );
}

function isPageIdentityChangedMessage(
  value: unknown,
): value is PageIdentityChangedMessage {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  const candidate = value as Partial<PageIdentityChangedMessage>;
  return (
    candidate.type === "TIEBA_PAGE_IDENTITY_CHANGED" &&
    typeof candidate.previousThreadId === "string" &&
    typeof candidate.currentUrl === "string" &&
    candidate.currentUrl.length <= 4_096 &&
    typeof candidate.documentInstanceId === "string"
  );
}

function sameUrlIdentity(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    leftUrl.hash = "";
    rightUrl.hash = "";
    return leftUrl.href === rightUrl.href;
  } catch {
    return false;
  }
}

async function handlePageIdentityChanged(
  message: PageIdentityChangedMessage,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  const tab = sender.tab;
  if (!tab?.id || (sender.frameId !== undefined && sender.frameId !== 0)) return;
  const session = await loadSession(tab.id);
  if (
    !session ||
    session.threadId !== message.previousThreadId ||
    sessionDocumentInstanceId(session) !== message.documentInstanceId
  ) {
    return;
  }

  const claimedThreadId = tiebaThreadIdFromUrl(message.currentUrl);
  if (claimedThreadId === message.previousThreadId) return;
  const liveUrl = await resolveTabUrl(tab, { preferLiveLocation: true });
  if (!liveUrl) {
    suspendSession(tab.id);
    return;
  }
  const liveThreadId = tiebaThreadIdFromUrl(liveUrl);
  const confirmedDifferentThread =
    claimedThreadId !== null && liveThreadId === claimedThreadId;
  const confirmedNonThread =
    claimedThreadId === null &&
    liveThreadId === null &&
    sameUrlIdentity(liveUrl, message.currentUrl);
  if (!confirmedDifferentThread && !confirmedNonThread) return;
  await clearSession(tab.id, "navigation");
}

async function handleDynamicContentChanged(
  message: DynamicContentChangedMessage,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  const tab = sender.tab;
  if (!tab?.id || (sender.frameId !== undefined && sender.frameId !== 0)) return;
  if (
    tiebaThreadIdFromUrl(message.url) !== message.threadId ||
    (sender.url && tiebaThreadIdFromUrl(sender.url) !== message.threadId) ||
    (tab.url && tiebaThreadIdFromUrl(tab.url) !== message.threadId)
  ) {
    return;
  }
  const expectedGeneration = captureGeneration(tab.id);
  const session = await loadSession(tab.id);
  const previousSignature = lastDynamicSignatures.get(tab.id);
  if (
    !session ||
    session.threadId !== message.threadId ||
    sessionDocumentInstanceId(session) !== message.documentInstanceId ||
    (previousSignature?.documentInstanceId === message.documentInstanceId &&
      previousSignature.signature === message.signature)
  ) {
    return;
  }

  const liveUrl = await resolveTabUrl(tab);
  if (tiebaThreadIdFromUrl(liveUrl ?? undefined) !== message.threadId) return;
  await captureTab(tab, {
    expectedDocumentInstanceId: message.documentInstanceId,
    expectedGeneration,
    startDynamicCapture: false,
  });
  lastDynamicSignatures.set(tab.id, {
    documentInstanceId: message.documentInstanceId,
    signature: message.signature,
  });
}

function enqueueDynamicCapture(
  message: DynamicContentChangedMessage,
  sender: chrome.runtime.MessageSender,
): void {
  const tabId = sender.tab?.id;
  if (!tabId) return;
  const previous = dynamicCaptureQueues.get(tabId) ?? Promise.resolve();
  const next = previous
    .then(() => handleDynamicContentChanged(message, sender))
    .catch(() => undefined);
  dynamicCaptureQueues.set(tabId, next);
  void next.then(() => {
    if (dynamicCaptureQueues.get(tabId) === next) {
      dynamicCaptureQueues.delete(tabId);
    }
  });
}

async function routeRequest(
  message: ExtensionRequest,
): Promise<ExtensionResponse<unknown>> {
  if (message.type === "CAPTURE_WHOLE_THREAD") {
    return { ok: true, data: await captureWholeThread(await activeTab()) };
  }
  if (message.type === "CAPTURE_ACTIVE_PAGE") {
    return { ok: true, data: await captureTab(await activeTab()) };
  }
  if (message.type === "GET_ACTIVE_SESSION") {
    const tab = await activeTab();
    return { ok: true, data: await loadValidSession(tab) };
  }
  if (message.type === "GET_CLOUD_PERMISSION_STATUS") {
    return { ok: true, data: await cloudBroker?.getCleanupStatus() ?? null };
  }
  if (message.type === "CLEAR_ACTIVE_SESSION") {
    const tab = await activeTab();
    await clearSession(tab.id!, "manual");
    return { ok: true, data: null };
  }
  if (message.type === "JUMP_TO_REPLY") {
    const tab = await activeTab();
    const session = await loadValidSession(tab);
    if (!session) {
      throw new ExtensionOperationError(
        "当前帖子没有可用的审阅会话，请重新读取页面",
        "SESSION_STALE",
      );
    }
    const expectedThreadId = session.threadId;
    if (!expectedThreadId) {
      throw new ExtensionOperationError(
        "当前审阅会话缺少帖子标识，请重新读取页面。",
        "SESSION_STALE",
      );
    }
    const pending = await loadPendingJump(tab.id!);
    const isPendingRetry = Boolean(
      pending &&
      pending.threadId === session.threadId &&
      pending.locator.replyId === message.replyId,
    );
    const locator =
      evidenceLocator(session, message.replyId) ??
      (isPendingRetry ? pending?.locator ?? null : null);
    if (!locator) {
      throw new ExtensionOperationError(
        "这条证据不属于当前帖子会话",
        "SESSION_STALE",
      );
    }
    const tabId = tab.id!;
    const token = Symbol("jump-routing");
    jumpRoutingTokens.set(tabId, token);
    try {
      const response = await contentMessage<boolean>(tabId, {
        type: "JUMP_TO_REPLY",
        locator,
        expectedThreadId,
        waitForOfficialRoute: isPendingRetry,
      });
      assertLatestJump(tabId, token);
      if (response.ok && isPendingRetry) {
        await clearPendingJump(tabId);
      }
      if (
        !response.ok &&
        response.code === "EVIDENCE_NOT_LOADED" &&
        (locator.isNested
          ? locator.parserVariant === "api" &&
            locator.siteReplyId &&
            locator.parentSiteReplyId
          : locator.siteReplyId) &&
        !isPendingRetry
      ) {
        // The content script has already exhausted safe in-page scrolling,
        // sort switching and expansion. Revalidate the active tab and session
        // after that asynchronous work before using Tieba's official PID URL.
        const current = await revalidateJumpContext(
          tabId,
          expectedThreadId,
          token,
        );
        await navigateToOfficialReply(
          current.tab,
          current.session,
          locator,
          token,
        );
        return { ok: true, data: true };
      }
      return response;
    } finally {
      if (jumpRoutingTokens.get(tabId) === token) {
        jumpRoutingTokens.delete(tabId);
      }
    }
  }
  throw new ExtensionOperationError("未知扩展请求", "UNKNOWN");
}

chrome.runtime.onMessage.addListener(
  (
    message:
      | ExtensionRequest
      | SessionUpdatedMessage
      | SessionClearedMessage
      | SessionSuspendedMessage,
    sender,
    sendResponse: (response: ExtensionResponse<unknown>) => void,
  ) => {
    if (isDynamicContentChangedMessage(message)) {
      enqueueDynamicCapture(message, sender);
      sendResponse({ ok: true, data: null });
      return;
    }
    if (isPageIdentityChangedMessage(message)) {
      void handlePageIdentityChanged(message, sender).catch(() => undefined);
      sendResponse({ ok: true, data: null });
      return;
    }
    if (
      message.type === "SESSION_UPDATED" ||
      message.type === "SESSION_CLEARED" ||
      message.type === "SESSION_SUSPENDED"
    ) return;
    void routeRequest(message)
      .then(sendResponse)
      .catch((error: unknown) => {
        const normalized = normalizeExtensionError(error);
        sendResponse({
          ok: false,
          error: normalized.message,
          code: normalized.code,
        });
      });
    return true;
  },
);

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Chromium reports the previous tab URL for part of a navigation. Suspend
  // immediately instead of letting the side panel keep showing (or sending)
  // evidence from the previous page while the destination is unresolved.
  // The stored session is deliberately preserved so a completed same-thread
  // pagination can resume and merge into it.
  if (changeInfo.status === "loading") {
    suspendSession(tabId);
    return;
  }
  if (changeInfo.url) {
    void (async () => {
      const current = await loadSession(tabId);
      if (!current) return;
      const status = classifySessionUrl(current, changeInfo.url);
      if (status === "different") await clearSession(tabId, "navigation");
    })();
    if (changeInfo.status !== "complete") return;
  }
  if (changeInfo.status !== "complete") return;
  void (async () => {
    const current = await loadSession(tabId);
    if (!current) return;
    const url = await resolveTabUrl(tab);
    const status = classifySessionUrl(current, url);
    if (status === "unknown") {
      suspendSession(tabId);
      return;
    }
    if (status === "different") {
      await clearSession(tabId, "navigation");
      return;
    }
    if (current.pages.api?.parserVariant === "api") {
      // The API snapshot represents the whole explicit read. A normal reload
      // or evidence navigation only revalidates that snapshot; it must not be
      // replaced by the handful of SPA rows currently mounted in the DOM.
      const expectedGeneration = captureGeneration(tabId);
      try {
        await clearSessionSuspension(tabId, expectedGeneration);
        broadcastSessionUpdated(current);
        await resumePendingJump(tab, current);
      } catch {
        // A newer navigation won the race; leave the session suspended.
      }
      return;
    }
    try {
      const session = await captureTab(tab);
      await resumePendingJump(tab, session);
    } catch {
      // Navigation may leave Tieba or revoke activeTab. The user can explicitly
      // click the action again; no background fetch or retry is attempted.
    }
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  apiCaptureTokens.delete(tabId);
  jumpRoutingTokens.delete(tabId);
  jumpNavigationQueues.delete(tabId);
  void chrome.storage.session.remove(sessionStorageKey(tabId));
  void chrome.storage.session.remove(threadCloudCacheStorageKey(tabId));
  void chrome.storage.session.remove(pendingJumpStorageKey(tabId));
  void chrome.storage.session.remove(suspendedSessionStorageKey(tabId));
  dynamicCaptureQueues.delete(tabId);
  lastDynamicSignatures.delete(tabId);
  captureGenerations.delete(tabId);
  suspendedTabs.delete(tabId);
});
