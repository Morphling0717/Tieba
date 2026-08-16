import { parseTiebaDocument } from "./lib/extractor";
import {
  assignRuntimeNestedReplyIds,
  declaredReplyCountFromDocument,
  dynamicEvidenceSignature,
  evidenceScanFractions,
  findDynamicThreadContainer,
  findEvidenceElement,
  findSafeReadExpansionControls,
  findTiebaAscendingSortControl,
  findVirtualEvidencePlaceholder,
  findVirtualFloorPlaceholder,
  isSelectedSortControl,
  mountedVirtualIndexRange,
} from "./lib/evidence";
import {
  createMutationDebouncer,
  type MutationDebouncer,
} from "./lib/dynamicObserver";
import { waitForTiebaDocumentReady } from "./lib/readiness";
import { parseTiebaNestedDocument } from "./lib/tiebaApi";
import {
  executeTiebaReadRequest,
  TiebaTransportError,
  validateTiebaReadRequest,
} from "./lib/tiebaTransport";
import type {
  ContentRequest,
  DynamicContentChangedMessage,
  EvidenceLocator,
  ExtensionErrorCode,
  ExtensionResponse,
  PageIdentityChangedMessage,
} from "./messages";
import type { ThreadCapture } from "./types";

declare global {
  interface Window {
    __KR_TIEBA_REVIEWER_CONTENT__?: boolean;
  }
}

const PARSE_WAIT_MS = 5_000;
const PARSE_POLL_MS = 125;
const DYNAMIC_DEBOUNCE_MS = 750;
const IDENTITY_WATCH_INTERVAL_MS = 250;
const DYNAMIC_ROOT_WAIT_MS = 1_000;
// Allow short same-document SPA mounts after sorting, scrolling or expansion.
const IN_PAGE_MOUNT_WAIT_MS = 650;
const SORT_SETTLE_MS = 450;
const SCAN_SETTLE_MS = 225;
const MAX_NESTED_EXPANSIONS = 6;
const MAX_THREAD_EXPANSIONS = 3;
const JUMP_CANCEL_POLL_MS = 50;
const TIEBA_READ_TIMEOUT_MS = 12_000;
const DOCUMENT_INSTANCE_ATTRIBUTE = "data-kr-review-document-instance-id";
const MAX_NESTED_HTML_LENGTH = 2_000_000;

function randomOpaqueToken(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function randomHex64(): string {
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(8));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)
    .toString(16)
    .padStart(16, "0")
    .slice(-16);
}

function threadIdFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "tieba.baidu.com") {
      return null;
    }
    return url.pathname.match(/^\/p\/(\d+)(?:\/|$)/u)?.[1] ?? null;
  } catch {
    return null;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function installHighlightStyle(): void {
  // A development-mode extension reload does not reload the Tieba tab. Reuse
  // the marker but always replace its rules so stale 0.1.x highlighting cannot
  // survive in the current document.
  let style = document.getElementById(
    "kr-review-highlight-style",
  ) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = "kr-review-highlight-style";
    document.head.append(style);
  }
  style.textContent = `
    .kr-review-evidence-focus {
      outline: 3px solid #ef7f45 !important;
      outline-offset: 4px !important;
      box-shadow: 0 0 0 5px rgba(239, 127, 69, 0.22) !important;
      transition: outline-color 180ms ease, box-shadow 180ms ease;
    }
  `;
}

function focusEvidence(target: Element): void {
  const container =
    target.closest(
      ".l_post, .lzl_single_post, .pb-comment-item, .pb-lzl-item, .image-text, .score-thread, .recruit-thread",
    ) ?? target;
  container.scrollIntoView({ behavior: "smooth", block: "center" });
  container.classList.add("kr-review-evidence-focus");
  window.setTimeout(
    () => container.classList.remove("kr-review-evidence-focus"),
    2_400,
  );
}

function failure(
  error: string,
  code: ExtensionErrorCode,
): ExtensionResponse<never> {
  return { ok: false, error, code };
}

function requestedThreadId(
  request: Extract<ContentRequest, { type: "FETCH_TIEBA_READ_API" }>["request"],
): string | null {
  const url = validateTiebaReadRequest(request);
  if (request.endpoint === "/c/s/pc/sync") return null;
  if (request.endpoint === "/p/comment") {
    return url.searchParams.get("tid");
  }
  return new URLSearchParams(request.body).get("kz");
}

function transportFailure(error: unknown): ExtensionResponse<never> {
  if (error instanceof TiebaTransportError) {
    if (error.code === "RATE_LIMITED") {
      return failure(error.message, "TIEBA_READ_API_RATE_LIMITED");
    }
    if (
      error.code === "INVALID_REQUEST" ||
      error.code === "REDIRECT_BLOCKED" ||
      error.code === "RESPONSE_URL_MISMATCH" ||
      error.code === "RESPONSE_TOO_LARGE" ||
      error.code === "RESPONSE_READ_FAILED"
    ) {
      return failure(error.message, "TIEBA_READ_API_RESPONSE_INVALID");
    }
    return failure(error.message, "TIEBA_READ_API_FAILED");
  }
  if (error instanceof Error && error.name === "AbortError") {
    return failure(
      "贴吧只读接口 12 秒内没有响应，本次请求已停止；扩展不会自动重试。",
      "TIEBA_READ_API_FAILED",
    );
  }
  return failure("贴吧只读接口请求失败。", "TIEBA_READ_API_FAILED");
}

if (!window.__KR_TIEBA_REVIEWER_CONTENT__) {
  window.__KR_TIEBA_REVIEWER_CONTENT__ = true;
  installHighlightStyle();

  const documentInstanceId = randomOpaqueToken();
  const nestedReplyIdState = {
    byElement: new WeakMap<Element, string>(),
    byFingerprintOccurrence: new Map<string, string>(),
  };
  let dynamicObserver: MutationObserver | null = null;
  let dynamicRoot: Element | null = null;
  let dynamicThreadId: string | null = null;
  let dynamicDocumentInstanceId: string | null = null;
  let dynamicMutationDebouncer: MutationDebouncer | null = null;
  let identityWatchTimer: number | null = null;
  let dynamicRevision = 0;
  let jumpGeneration = 0;

  function annotateRuntimeEvidence(): void {
    document.documentElement.setAttribute(
      DOCUMENT_INSTANCE_ATTRIBUTE,
      documentInstanceId,
    );
    assignRuntimeNestedReplyIds(document, nestedReplyIdState, () =>
      `kr-lzl-${documentInstanceId}-${randomOpaqueToken()}`,
    );
  }

  async function parseCurrentPage(): Promise<ExtensionResponse<ThreadCapture>> {
    const inspection = await waitForTiebaDocumentReady(
      document,
      window.location.href,
      {
        timeoutMs: PARSE_WAIT_MS,
        pollMs: PARSE_POLL_MS,
        beforeInspect: annotateRuntimeEvidence,
      },
    );
    if (inspection.status !== "ready") {
      return inspection.status === "unsupported"
        ? failure(inspection.message, "PAGE_LAYOUT_UNSUPPORTED")
        : failure(inspection.message, "PAGE_NOT_READY");
    }

    try {
      const capture = parseTiebaDocument(document, window.location.href);
      if (capture.replies.length === 0 && capture.errors.length > 0) {
        return failure(capture.errors.join(" "), "PAGE_PARSE_FAILED");
      }
      return {
        ok: true,
        data:
          capture.parserVariant === "spa"
            ? { ...capture, documentInstanceId }
            : capture,
      };
    } catch (error) {
      return failure(
        error instanceof Error ? error.message : "页面结构解析失败",
        "PAGE_PARSE_FAILED",
      );
    }
  }

  async function fetchTiebaReadApi(
    request: Extract<ContentRequest, { type: "FETCH_TIEBA_READ_API" }>["request"],
  ): Promise<ExtensionResponse> {
    const initialThreadId = threadIdFromUrl(window.location.href);
    if (!initialThreadId) {
      return failure(
        "当前页面已经离开百度贴吧帖子，本次整帖读取已取消。",
        "SESSION_STALE",
      );
    }

    try {
      const requestThreadId = requestedThreadId(request);
      if (requestThreadId !== null && requestThreadId !== initialThreadId) {
        return failure(
          "只读请求与当前帖子不一致，本次整帖读取已取消。",
          "SESSION_STALE",
        );
      }

      const controller = new AbortController();
      const timeout = window.setTimeout(
        () => controller.abort(),
        TIEBA_READ_TIMEOUT_MS,
      );
      try {
        const result = await executeTiebaReadRequest(
          request,
          window.fetch.bind(window),
          controller.signal,
        );
        if (threadIdFromUrl(window.location.href) !== initialThreadId) {
          return failure(
            "页面在请求期间切换到了另一帖子，本次结果已丢弃。",
            "SESSION_STALE",
          );
        }
        return { ok: true, data: result };
      } finally {
        window.clearTimeout(timeout);
      }
    } catch (error) {
      return transportFailure(error);
    }
  }

  async function notifyDynamicContentChanged(): Promise<void> {
    if (checkPageIdentity()) return;
    if (!dynamicRoot || !dynamicThreadId || !dynamicDocumentInstanceId) return;
    if (threadIdFromUrl(window.location.href) !== dynamicThreadId) return;
    annotateRuntimeEvidence();
    dynamicRevision += 1;
    const message: DynamicContentChangedMessage = {
      type: "TIEBA_DYNAMIC_CONTENT_CHANGED",
      threadId: dynamicThreadId,
      url: window.location.href,
      documentInstanceId: dynamicDocumentInstanceId,
      // This is a random replay token, not a hash of page text. The content
      // signature used for deduplication remains inside this isolated script.
      signature: `${dynamicRevision}:${randomHex64()}`,
    };
    await chrome.runtime.sendMessage(message).catch(() => undefined);
  }

  function stopDynamicWatchers(): void {
    dynamicObserver?.disconnect();
    dynamicObserver = null;
    dynamicRoot = null;
    dynamicMutationDebouncer?.cancel();
    dynamicMutationDebouncer = null;
    if (identityWatchTimer !== null) {
      window.clearInterval(identityWatchTimer);
      identityWatchTimer = null;
    }
  }

  function checkPageIdentity(): boolean {
    if (!dynamicThreadId || !dynamicDocumentInstanceId) return false;
    if (threadIdFromUrl(window.location.href) === dynamicThreadId) return false;
    const message: PageIdentityChangedMessage = {
      type: "TIEBA_PAGE_IDENTITY_CHANGED",
      previousThreadId: dynamicThreadId,
      currentUrl: window.location.href,
      documentInstanceId: dynamicDocumentInstanceId,
    };
    stopDynamicWatchers();
    dynamicThreadId = null;
    dynamicDocumentInstanceId = null;
    void chrome.runtime.sendMessage(message).catch(() => undefined);
    return true;
  }

  function startIdentityWatcher(): void {
    if (identityWatchTimer !== null) window.clearInterval(identityWatchTimer);
    identityWatchTimer = window.setInterval(() => {
      checkPageIdentity();
    }, IDENTITY_WATCH_INTERVAL_MS);
  }

  async function startDynamicCapture(
    threadId: string,
    expectedDocumentInstanceId: string,
    allowMissingContainer: boolean,
  ): Promise<ExtensionResponse<boolean>> {
    if (
      threadIdFromUrl(window.location.href) !== threadId ||
      expectedDocumentInstanceId !== documentInstanceId
    ) {
      return failure(
        "页面已切换或重新加载，动态采集未启动。",
        "SESSION_STALE",
      );
    }

    annotateRuntimeEvidence();
    const rootDeadline = Date.now() + DYNAMIC_ROOT_WAIT_MS;
    let root = findDynamicThreadContainer(document);
    while (!root && Date.now() < rootDeadline) {
      await delay(PARSE_POLL_MS);
      root = findDynamicThreadContainer(document);
    }
    if (!root) {
      if (!allowMissingContainer) {
        return failure(
          "已识别新版帖子，但未找到可监听的回复列表容器。",
          "PAGE_LAYOUT_UNSUPPORTED",
        );
      }
    }

    dynamicThreadId = threadId;
    dynamicDocumentInstanceId = expectedDocumentInstanceId;
    startIdentityWatcher();
    if (!root) return { ok: true, data: true };

    if (
      dynamicObserver &&
      dynamicRoot === root &&
      dynamicThreadId === threadId &&
      dynamicDocumentInstanceId === expectedDocumentInstanceId
    ) {
      return { ok: true, data: true };
    }

    dynamicObserver?.disconnect();
    dynamicRoot = root;
    dynamicMutationDebouncer?.cancel();
    dynamicMutationDebouncer = createMutationDebouncer({
      delayMs: DYNAMIC_DEBOUNCE_MS,
      readSignature: () => {
        annotateRuntimeEvidence();
        return dynamicEvidenceSignature(root);
      },
      emit: () => void notifyDynamicContentChanged(),
    });
    dynamicObserver = new MutationObserver(() =>
      dynamicMutationDebouncer?.schedule(),
    );
    dynamicObserver.observe(root, { childList: true, subtree: true });
    return { ok: true, data: true };
  }

  function replyFloor(locator: EvidenceLocator): number | null {
    const value = (locator as EvidenceLocator & { floor?: unknown }).floor;
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
      ? value
      : null;
  }

  function jumpWasCancelled(generation: number): boolean {
    return generation !== jumpGeneration;
  }

  function cancelledJump(): ExtensionResponse<never> {
    return failure("已改为定位你刚点击的新证据。", "CAPTURE_CANCELLED");
  }

  function currentTarget(
    locator: EvidenceLocator,
    expectedThreadId: string,
    generation: number,
  ): Element | null {
    if (!jumpStillOnThread(expectedThreadId, generation)) return null;
    annotateRuntimeEvidence();
    return findEvidenceElement(
      document,
      locator.anchor,
      locator.replyId,
      locator.siteReplyId,
      locator.parserVariant === "legacy",
    );
  }

  function jumpStillOnThread(
    expectedThreadId: string,
    generation: number,
  ): boolean {
    return (
      !jumpWasCancelled(generation) &&
      threadIdFromUrl(window.location.href) === expectedThreadId
    );
  }

  function waitForJumpDelay(
    milliseconds: number,
    expectedThreadId: string,
    generation: number,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const poll = () => {
        if (!jumpStillOnThread(expectedThreadId, generation)) {
          resolve(false);
          return;
        }
        if (Date.now() - startedAt >= milliseconds) {
          resolve(true);
          return;
        }
        window.setTimeout(
          poll,
          Math.min(JUMP_CANCEL_POLL_MS, milliseconds - (Date.now() - startedAt)),
        );
      };
      poll();
    });
  }

  function waitForMountedEvidence(
    locator: EvidenceLocator,
    timeoutMs: number,
    expectedThreadId: string,
    generation: number,
  ): Promise<Element | null> {
    if (!jumpStillOnThread(expectedThreadId, generation)) {
      return Promise.resolve(null);
    }
    const initial = currentTarget(locator, expectedThreadId, generation);
    if (initial) return Promise.resolve(initial);

    const root = findDynamicThreadContainer(document) ?? document.body;
    return new Promise((resolve) => {
      let settled = false;
      let cancelPoll: number | null = null;
      let timeout: number | null = null;
      const finish = (target: Element | null) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        if (timeout !== null) window.clearTimeout(timeout);
        if (cancelPoll !== null) window.clearInterval(cancelPoll);
        resolve(target);
      };
      const inspect = () => {
        if (!jumpStillOnThread(expectedThreadId, generation)) {
          finish(null);
          return;
        }
        const target = currentTarget(locator, expectedThreadId, generation);
        if (target) finish(target);
      };
      const observer = new MutationObserver(inspect);
      observer.observe(root, {
        attributes: true,
        attributeFilter: [
          "data-id",
          "data-key",
          "data-pid",
          "data-spid",
          "data-kr-review-reply-id",
        ],
        childList: true,
        subtree: true,
      });
      // Close the initial-find/observe race before waiting for mutations.
      inspect();
      if (!settled) {
        cancelPoll = window.setInterval(inspect, JUMP_CANCEL_POLL_MS);
        timeout = window.setTimeout(() => finish(null), timeoutMs);
      }
    });
  }

  function controlIsRendered(control: HTMLElement): boolean {
    const style = window.getComputedStyle(control);
    return (
      control.isConnected &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.pointerEvents !== "none"
    );
  }

  function findScrollSurface(): Element {
    const dynamicRoot = findDynamicThreadContainer(document);
    const candidates: Element[] = [];
    let current: Element | null = dynamicRoot;
    while (current) {
      candidates.push(current);
      current = current.parentElement;
    }
    const scrollingElement = document.scrollingElement ?? document.documentElement;
    let bestScrollable: Element | null = null;
    let bestRange = -1;
    for (const candidate of candidates) {
      if (candidate === scrollingElement || candidate === document.documentElement) {
        continue;
      }
      const range = Math.max(0, candidate.scrollHeight - candidate.clientHeight);
      if (range <= 0) continue;
      const overflowY = window.getComputedStyle(candidate).overflowY;
      if (!/^(?:auto|scroll|overlay)$/u.test(overflowY)) continue;
      if (range > bestRange) {
        bestScrollable = candidate;
        bestRange = range;
      }
    }
    return bestScrollable ?? scrollingElement;
  }

  function scrollSurfaceToFraction(surface: Element, fraction: number): void {
    const maximum = Math.max(0, surface.scrollHeight - surface.clientHeight);
    const top = Math.round(maximum * fraction);
    if (surface === document.scrollingElement || surface === document.documentElement) {
      window.scrollTo({ top, behavior: "auto" });
      return;
    }
    if (typeof surface.scrollTo === "function") {
      surface.scrollTo({ top, behavior: "auto" });
    } else {
      surface.scrollTop = top;
    }
  }

  async function tryMountedPlaceholder(
    locator: EvidenceLocator,
    expectedThreadId: string,
    generation: number,
  ): Promise<Element | null> {
    if (!jumpStillOnThread(expectedThreadId, generation)) return null;
    const official = findVirtualEvidencePlaceholder(
      document,
      locator.siteReplyId,
    );
    const floorHint = findVirtualFloorPlaceholder(document, replyFloor(locator));
    const placeholder = official ?? floorHint;
    if (!placeholder) return null;
    if (!jumpStillOnThread(expectedThreadId, generation)) return null;
    placeholder.scrollIntoView({ behavior: "auto", block: "center" });
    return waitForMountedEvidence(
      locator,
      IN_PAGE_MOUNT_WAIT_MS,
      expectedThreadId,
      generation,
    );
  }

  async function locateMainEvidenceInPage(
    locator: EvidenceLocator,
    expectedThreadId: string,
    generation: number,
  ): Promise<Element | null> {
    if (!jumpStillOnThread(expectedThreadId, generation)) return null;
    let target = currentTarget(locator, expectedThreadId, generation);
    if (target) return target;

    target = await tryMountedPlaceholder(locator, expectedThreadId, generation);
    if (target || !jumpStillOnThread(expectedThreadId, generation)) return target;

    if (locator.parserVariant !== "legacy") {
      const ascending = findTiebaAscendingSortControl(document);
      if (
        ascending &&
        !isSelectedSortControl(ascending) &&
        controlIsRendered(ascending) &&
        jumpStillOnThread(expectedThreadId, generation)
      ) {
        ascending.click();
        if (!(await waitForJumpDelay(SORT_SETTLE_MS, expectedThreadId, generation))) {
          return null;
        }
        target = currentTarget(locator, expectedThreadId, generation);
        if (target) return target;
        target = await tryMountedPlaceholder(locator, expectedThreadId, generation);
        if (target || !jumpStillOnThread(expectedThreadId, generation)) return target;
      }
    }

    const clickedThreadControls = new WeakSet<HTMLElement>();
    const triedOfficialPlaceholders = new WeakSet<Element>();
    let expansionClicks = 0;
    const inspectAfterScroll = async (): Promise<Element | null> => {
      let mounted = currentTarget(locator, expectedThreadId, generation);
      if (mounted) return mounted;
      const officialPlaceholder = findVirtualEvidencePlaceholder(
        document,
        locator.siteReplyId,
      );
      if (
        officialPlaceholder &&
        !triedOfficialPlaceholders.has(officialPlaceholder) &&
        jumpStillOnThread(expectedThreadId, generation)
      ) {
        triedOfficialPlaceholders.add(officialPlaceholder);
        officialPlaceholder.scrollIntoView({ behavior: "auto", block: "center" });
        mounted = await waitForMountedEvidence(
          locator,
          IN_PAGE_MOUNT_WAIT_MS,
          expectedThreadId,
          generation,
        );
      }
      return mounted;
    };

    const floor = replyFloor(locator);
    const declaredReplyCount = declaredReplyCountFromDocument(document);
    const targetIndex = floor !== null && floor >= 2 ? floor - 2 : null;
    if (targetIndex !== null && declaredReplyCount && declaredReplyCount > 1) {
      let lowerFraction = 0;
      let upperFraction = 1;
      let fraction = Math.max(
        0,
        Math.min(1, targetIndex / Math.max(1, declaredReplyCount - 1)),
      );
      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (!jumpStillOnThread(expectedThreadId, generation)) return null;
        scrollSurfaceToFraction(findScrollSurface(), fraction);
        if (
          !(await waitForJumpDelay(
            SCAN_SETTLE_MS,
            expectedThreadId,
            generation,
          ))
        ) {
          return null;
        }
        target = await inspectAfterScroll();
        if (target) return target;

        const range = mountedVirtualIndexRange(document);
        if (!range || (targetIndex >= range.min && targetIndex <= range.max)) {
          break;
        }
        if (targetIndex > range.max) {
          lowerFraction = Math.max(lowerFraction, fraction);
        } else {
          upperFraction = Math.min(upperFraction, fraction);
        }
        const next = (lowerFraction + upperFraction) / 2;
        if (Math.abs(next - fraction) < 0.002) break;
        fraction = next;
      }
    }

    const currentRange = mountedVirtualIndexRange(document);
    const uniformSteps =
      declaredReplyCount && currentRange
        ? Math.max(
            12,
            Math.ceil(
              declaredReplyCount / Math.max(4, currentRange.count * 0.75),
            ),
          )
        : 16;
    const fractions = evidenceScanFractions(
      floor,
      declaredReplyCount,
      uniformSteps,
    );
    for (const fraction of fractions) {
      if (!jumpStillOnThread(expectedThreadId, generation)) return null;
      scrollSurfaceToFraction(findScrollSurface(), fraction);
      if (!(await waitForJumpDelay(SCAN_SETTLE_MS, expectedThreadId, generation))) {
        return null;
      }
      target = await inspectAfterScroll();
      if (target) return target;

      if (expansionClicks < MAX_THREAD_EXPANSIONS) {
        const expansionRoot =
          document.querySelector(
            ".pc-pb-reply-list .thread-container, .pc-pb-reply-list, .thread-container, .pb-comment-list",
          ) ?? findDynamicThreadContainer(document);
        const more = expansionRoot
          ? findSafeReadExpansionControls(expansionRoot, "thread").find(
          (control) =>
            !clickedThreadControls.has(control) && controlIsRendered(control),
            )
          : undefined;
        if (more && jumpStillOnThread(expectedThreadId, generation)) {
          clickedThreadControls.add(more);
          expansionClicks += 1;
          more.click();
          if (
            !(await waitForJumpDelay(
              SORT_SETTLE_MS,
              expectedThreadId,
              generation,
            ))
          ) {
            return null;
          }
          target = currentTarget(locator, expectedThreadId, generation);
          if (target) return target;
        }
      }
    }

    return null;
  }

  async function expandNestedEvidence(
    parent: Element,
    parentLocator: EvidenceLocator,
    locator: EvidenceLocator,
    expectedThreadId: string,
    generation: number,
  ): Promise<Element | null> {
    const clickedControls = new WeakSet<HTMLElement>();
    let liveParent = parent;
    for (let attempt = 0; attempt < MAX_NESTED_EXPANSIONS; attempt += 1) {
      const existing = currentTarget(locator, expectedThreadId, generation);
      if (existing) return existing;
      if (!jumpStillOnThread(expectedThreadId, generation)) return null;

      liveParent =
        currentTarget(parentLocator, expectedThreadId, generation) ?? liveParent;
      if (!liveParent.isConnected) return null;
      const controls = findSafeReadExpansionControls(liveParent, "nested").filter(
        (control) =>
          controlIsRendered(control) && !clickedControls.has(control),
      );
      const control = controls[0];
      if (!control) return null;
      clickedControls.add(control);
      control.click();
      const target = await waitForMountedEvidence(
        locator,
        IN_PAGE_MOUNT_WAIT_MS,
        expectedThreadId,
        generation,
      );
      if (target) return target;
    }
    return null;
  }

  async function jumpToEvidence(
    locator: EvidenceLocator,
    generation: number,
    expectedThreadId: string,
  ): Promise<ExtensionResponse<boolean>> {
    if (
      !/^\d+$/u.test(expectedThreadId) ||
      !jumpStillOnThread(expectedThreadId, generation)
    ) {
      return failure("当前页面已离开这个贴吧帖子。", "SESSION_STALE");
    }

    let target = currentTarget(locator, expectedThreadId, generation);
    if (target) {
      if (!jumpStillOnThread(expectedThreadId, generation)) {
        return jumpWasCancelled(generation)
          ? cancelledJump()
          : failure("页面已切换，本次定位已停止。", "SESSION_STALE");
      }
      focusEvidence(target);
      return { ok: true, data: true };
    }

    if (locator.isNested) {
      const parentReplyId =
        locator.parentReplyId ?? locator.parentSiteReplyId ?? "";
      const parentLocator: EvidenceLocator = {
        ...locator,
        replyId: parentReplyId,
        siteReplyId: locator.parentSiteReplyId,
        anchor: locator.parentAnchor ?? "",
        parentReplyId: null,
        parentSiteReplyId: null,
        parentAnchor: null,
        isNested: false,
      };
      const parent = parentReplyId
        ? await locateMainEvidenceInPage(
            parentLocator,
            expectedThreadId,
            generation,
          )
        : null;
      if (jumpWasCancelled(generation)) return cancelledJump();
      if (!jumpStillOnThread(expectedThreadId, generation)) {
        return failure("页面已切换，本次定位已停止。", "SESSION_STALE");
      }
      if (!parent) {
        return failure(
          "这条楼中楼的父楼尚未加载。为避免刷新页面，已停留在当前帖子；请继续滚动后再试。",
          "EVIDENCE_NOT_LOADED",
        );
      }

      if (!jumpStillOnThread(expectedThreadId, generation)) {
        return failure("页面已切换，本次定位已停止。", "SESSION_STALE");
      }
      focusEvidence(parent);
      target = await expandNestedEvidence(
        parent,
        parentLocator,
        locator,
        expectedThreadId,
        generation,
      );
      if (jumpWasCancelled(generation)) return cancelledJump();
      if (!jumpStillOnThread(expectedThreadId, generation)) {
        return failure("页面已切换，本次定位已停止。", "SESSION_STALE");
      }
      if (target) {
        focusEvidence(target);
        return { ok: true, data: true };
      }
      return failure(
        "已定位父楼并尝试展开楼中楼，但目标仍未加载。为避免刷新页面，已停留在当前位置。",
        "EVIDENCE_NOT_LOADED",
      );
    }

    target = await locateMainEvidenceInPage(
      locator,
      expectedThreadId,
      generation,
    );
    if (jumpWasCancelled(generation)) return cancelledJump();
    if (!jumpStillOnThread(expectedThreadId, generation)) {
      return failure("页面已切换，本次定位已停止。", "SESSION_STALE");
    }
    if (target) {
      focusEvidence(target);
      return { ok: true, data: true };
    }

    return failure(
      "这条回复尚未加载到当前页面。为避免刷新页面，已停留在当前帖子；请继续滚动后再试。",
      "EVIDENCE_NOT_LOADED",
    );
  }

  chrome.runtime.onMessage.addListener(
    (
      message: ContentRequest,
      _sender,
      sendResponse: (response: ExtensionResponse) => void,
    ) => {
      if (message.type === "GET_PAGE_URL") {
        sendResponse({ ok: true, data: window.location.href });
        return;
      }
      if (message.type === "PARSE_TIEBA_PAGE") {
        void parseCurrentPage().then(sendResponse);
        return true;
      }
      if (message.type === "FETCH_TIEBA_READ_API") {
        void fetchTiebaReadApi(message.request).then(sendResponse);
        return true;
      }
      if (message.type === "START_DYNAMIC_CAPTURE") {
        void startDynamicCapture(
          message.threadId,
          message.documentInstanceId,
          message.allowMissingContainer,
        ).then(sendResponse);
        return true;
      }
      if (message.type === "PARSE_TIEBA_NESTED_HTML") {
        if (threadIdFromUrl(window.location.href) !== message.context.threadId) {
          sendResponse(
            failure(
              "页面已切换到另一帖子，楼中楼结果已丢弃。",
              "SESSION_STALE",
            ),
          );
          return;
        }
        if (
          typeof message.html !== "string" ||
          message.html.length === 0 ||
          message.html.length > MAX_NESTED_HTML_LENGTH
        ) {
          sendResponse(
            failure(
              "贴吧楼中楼接口返回了空内容或异常大的响应。",
              "TIEBA_READ_API_RESPONSE_INVALID",
            ),
          );
          return;
        }
        try {
          const parsed = new DOMParser().parseFromString(
            message.html,
            "text/html",
          );
          sendResponse({
            ok: true,
            data: parseTiebaNestedDocument(parsed, message.context),
          });
        } catch {
          sendResponse(
            failure(
              "贴吧楼中楼接口结构已变化，无法可靠解析。",
              "TIEBA_READ_API_RESPONSE_INVALID",
            ),
          );
        }
        return;
      }
      if (message.type === "JUMP_TO_REPLY") {
        const generation = ++jumpGeneration;
        void jumpToEvidence(
          message.locator,
          generation,
          message.expectedThreadId,
        ).then(sendResponse);
        return true;
      }
    },
  );
}
