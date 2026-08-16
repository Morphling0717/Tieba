import {
  TiebaApiError,
  buildTiebaNestedRequest,
  buildTiebaPagePcRequest,
  buildTiebaSyncRequest,
  parseTiebaPagePcResponse,
  parseTiebaSyncResponse,
} from "./lib/tiebaApi";
import { SCHEMA_VERSION } from "./types";
import type { CapturedReply, ThreadCapture } from "./types";
import type { TiebaReadRequest } from "./lib/tiebaApi";
import type { CaptureProgressPhase } from "./messages";

const REQUEST_CONCURRENCY = 3;
const NESTED_PARENT_CONCURRENCY = 1;

/**
 * These bounds are deliberately much larger than an ordinary Tieba thread.
 * They are nevertheless finite so a corrupt response cannot turn one explicit
 * click into an unbounded crawler.
 */
export interface TiebaApiCaptureLimits {
  mainPages: number;
  nestedParents: number;
  nestedPagesPerParent: number;
  totalRequests: number;
}

export const TIEBA_API_CAPTURE_LIMITS: Readonly<TiebaApiCaptureLimits> =
  Object.freeze({
    mainPages: 500,
    nestedParents: 5_000,
    nestedPagesPerParent: 500,
    totalRequests: 20_000,
  });

export interface TiebaNestedParseContext {
  threadId: string;
  parentReplyId: string;
  parentSiteReplyId: string;
  parentFloor: number | null;
  sourcePage: number;
  sourceUrl: string;
  page: number;
  declaredCount: number;
  forumId: string | null;
  allowOutOfRangeEmptyProbe?: boolean;
}

export interface TiebaNestedPageProjection {
  threadId: string;
  parentReplyId: string;
  parentSiteReplyId: string;
  replies: CapturedReply[];
  currentPage: number;
  totalPages: number;
  totalNum: number;
  hasMore: boolean;
  rawReplyNodeCount: number;
  stableReplyOccurrenceCount: number;
  duplicateStableIdCount: number;
  unparsedReplyCount: number;
  unknownStructureCount: number;
  hasTrustedPager: boolean;
  isOutOfRangeEmptyProbe: boolean;
}

export interface TiebaApiCaptureOptions {
  threadId: string;
  threadUrl: string;
  request: (request: TiebaReadRequest) => Promise<string>;
  parseNested: (
    html: string,
    context: TiebaNestedParseContext,
  ) => Promise<TiebaNestedPageProjection>;
  /**
   * Revalidates tab id, URL and generation. It is deliberately called both
   * before and after every network request.
   */
  checkpoint: () => Promise<void>;
  /** Body-free progress. Callback failures never interrupt the capture. */
  onProgress?: (progress: TiebaApiCaptureProgress) => void;
  now?: () => Date;
  /**
   * Test-only lower bounds. Values can reduce, but never raise, the production
   * hard limits above.
   */
  limits?: Partial<TiebaApiCaptureLimits>;
}

export interface TiebaApiCaptureProgress {
  phase: Exclude<CaptureProgressPhase, "validation">;
  completed: number;
  total: number;
}

interface MainPageProjection {
  title: string;
  forumId: string | null;
  currentPage: number;
  totalPages: number;
  hasMore: boolean;
  declaredReplyCount: number | null;
  replies: CapturedReply[];
  nestedParents: NestedParentProjection[];
  rawReplyNodeCount: number;
  stableReplyOccurrenceCount: number;
  duplicateStableIdCount: number;
  unparsedReplyCount: number;
}

interface NestedParentProjection {
  parentReplyId: string;
  parentSiteReplyId: string;
  parentFloor: number | null;
  sourcePage: number;
  declaredCount: number;
  previewReplyIds: string[];
}

interface NestedParentState extends NestedParentProjection {
  pagesFetched: number;
  pagesExpected: number | null;
  availableCount: number | null;
  fullReplyKeys: Set<string>;
  reachedEnd: boolean;
  failed: boolean;
  truncated: boolean;
  satisfiedByPreview: boolean;
  rawReplyNodeCount: number;
  stableReplyOccurrenceCount: number;
  duplicateStableIdCount: number;
  unparsedReplyCount: number;
  unknownStructureCount: number;
  pagerDriftCount: number;
  diagnosticMismatchCount: number;
  pagerWasTrusted: boolean | null;
  pagerTotalNum: number | null;
  pagerTotalPages: number | null;
  endpointProbeAttempted: boolean;
  endpointGapVerified: boolean;
  endpointProbeFailureCount: number;
}

function nestedParentLabel(parent: NestedParentProjection): string {
  return parent.parentFloor === null
    ? `父回复 ${parent.parentReplyId}`
    : `第 ${parent.parentFloor} 楼`;
}

class CheckpointCancelledError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super(errorMessage(cause));
    this.name = "AbortError";
    this.cause = cause;
  }
}

class CaptureLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureLimitError";
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return String(error || "未知错误");
}

function positiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/u.test(value.trim())) {
    const result = Number(value);
    return result > 0 ? result : null;
  }
  return null;
}

function nonNegativeInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/u.test(value.trim())) {
    return Number(value);
  }
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeMainProjection(value: unknown): MainPageProjection {
  const source = record(value);
  if (!source) {
    throw new Error("page_pc 返回内容不是可识别的对象。");
  }

  const currentPage = positiveInteger(
    source.currentPage ?? source.page ?? source.current_page,
  );
  const totalPages = positiveInteger(
    source.totalPages ?? source.totalPage ?? source.total_page,
  );
  if (currentPage === null || totalPages === null) {
    throw new Error("page_pc 未提供有效的分页信息。");
  }

  const rawHasMore = source.hasMore ?? source.has_more;
  const hasMore =
    typeof rawHasMore === "boolean"
      ? rawHasMore
      : nonNegativeInteger(rawHasMore) !== null
        ? nonNegativeInteger(rawHasMore) !== 0
        : currentPage < totalPages;

  const replies = Array.isArray(source.replies)
    ? (source.replies as CapturedReply[])
    : [];
  const rawReplyNodeCount = nonNegativeInteger(source.rawReplyNodeCount);
  const stableReplyOccurrenceCount = nonNegativeInteger(
    source.stableReplyOccurrenceCount,
  );
  const duplicateStableIdCount = nonNegativeInteger(
    source.duplicateStableIdCount,
  );
  const unparsedReplyCount = nonNegativeInteger(source.unparsedReplyCount);
  if (
    rawReplyNodeCount === null ||
    stableReplyOccurrenceCount === null ||
    duplicateStableIdCount === null ||
    unparsedReplyCount === null
  ) {
    throw new Error("page_pc 未提供完整的回复节点诊断数据。");
  }
  const rawParents = Array.isArray(source.nestedParents)
    ? source.nestedParents
    : [];
  const nestedParents: NestedParentProjection[] = [];

  for (const candidate of rawParents) {
    const parent = record(candidate);
    if (!parent) continue;
    const parentReplyIdValue =
      parent.parentReplyId ?? parent.replyId ?? parent.pid;
    const parentReplyId =
      typeof parentReplyIdValue === "string" ||
      typeof parentReplyIdValue === "number"
        ? String(parentReplyIdValue).trim()
        : "";
    const declaredCount = nonNegativeInteger(
      parent.declaredCount ??
        parent.subPostNumber ??
        parent.sub_post_number,
    );
    if (!parentReplyId || declaredCount === null) continue;
    const parentSiteReplyIdValue =
      parent.parentSiteReplyId ?? parent.siteReplyId ?? parentReplyId;
    const parentSiteReplyId =
      typeof parentSiteReplyIdValue === "string" ||
      typeof parentSiteReplyIdValue === "number"
        ? String(parentSiteReplyIdValue).trim()
        : "";
    if (!parentSiteReplyId) continue;

    const previewReplyIds = new Set<string>();
    const rawPreviewReplyIds = Array.isArray(parent.previewReplyIds)
      ? parent.previewReplyIds
      : [];
    for (const rawId of rawPreviewReplyIds) {
      const id =
        typeof rawId === "string" || typeof rawId === "number"
          ? String(rawId).trim()
          : "";
      if (/^\d{1,32}$/u.test(id)) previewReplyIds.add(id);
    }
    const rawPreviewReplies = Array.isArray(parent.previewReplies)
      ? parent.previewReplies
      : [];
    for (const rawPreview of rawPreviewReplies) {
      const preview = record(rawPreview);
      if (!preview) continue;
      const rawId = preview.siteReplyId ?? preview.id;
      const id =
        typeof rawId === "string" || typeof rawId === "number"
          ? String(rawId).trim()
          : "";
      if (/^\d{1,32}$/u.test(id)) previewReplyIds.add(id);
    }

    nestedParents.push({
      parentReplyId,
      parentSiteReplyId,
      parentFloor:
        nonNegativeInteger(parent.parentFloor ?? parent.floor) ?? null,
      sourcePage:
        positiveInteger(parent.sourcePage ?? source.currentPage) ?? currentPage,
      declaredCount,
      previewReplyIds: [...previewReplyIds],
    });
  }

  const titleValue = source.title;
  const forumIdValue = source.forumId ?? source.forum_id ?? source.fid;
  return {
    title: typeof titleValue === "string" ? titleValue.trim() : "",
    forumId:
      typeof forumIdValue === "string" || typeof forumIdValue === "number"
        ? String(forumIdValue).trim() || null
        : null,
    currentPage,
    totalPages,
    hasMore,
    declaredReplyCount: nonNegativeInteger(
      source.declaredReplyCount ??
        source.replyCount ??
        source.replyNum ??
        source.reply_num,
    ),
    replies,
    nestedParents,
    rawReplyNodeCount,
    stableReplyOccurrenceCount,
    duplicateStableIdCount,
    unparsedReplyCount,
  };
}

function normalizedLimit(
  proposed: number | undefined,
  hardLimit: number,
): number {
  if (
    proposed === undefined ||
    !Number.isFinite(proposed) ||
    proposed <= 0
  ) {
    return hardLimit;
  }
  return Math.min(Math.trunc(proposed), hardLimit);
}

function isCancellation(error: unknown): boolean {
  return (
    error instanceof CheckpointCancelledError ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function firstPageError(stage: string, error: unknown): never {
  if (error instanceof TiebaApiError) throw error;
  const wrapped = new TiebaApiError(
    "REMOTE_ERROR",
    `${stage}失败：${errorMessage(error)}`,
  );
  Object.defineProperty(wrapped, "cause", { value: error });
  throw wrapped;
}

function replyKey(reply: CapturedReply): string {
  const kind = reply.isNested ? "nested" : "main";
  return `${kind}:${reply.siteReplyId ?? reply.id}`;
}

function stablePagePcReplyId(reply: CapturedReply): string | null {
  if (
    !/^\d{1,32}$/u.test(reply.id) ||
    reply.siteReplyId === null ||
    !/^\d{1,32}$/u.test(reply.siteReplyId) ||
    reply.siteReplyId !== reply.id
  ) {
    return null;
  }
  return reply.siteReplyId;
}

function sortReplies(
  replies: CapturedReply[],
  parents: Map<string, NestedParentProjection>,
): CapturedReply[] {
  return replies.sort((left, right) => {
    const leftParent = left.parentReplyId
      ? parents.get(left.parentReplyId)
      : undefined;
    const rightParent = right.parentReplyId
      ? parents.get(right.parentReplyId)
      : undefined;
    const leftFloor = left.floor ?? leftParent?.parentFloor ?? Number.MAX_VALUE;
    const rightFloor =
      right.floor ?? rightParent?.parentFloor ?? Number.MAX_VALUE;
    if (leftFloor !== rightFloor) return leftFloor - rightFloor;
    if (left.isNested !== right.isNested) return left.isNested ? 1 : -1;
    if (
      left.timestamp !== null &&
      right.timestamp !== null &&
      left.timestamp !== right.timestamp
    ) {
      return left.timestamp - right.timestamp;
    }
    return left.id.localeCompare(right.id);
  });
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

/**
 * Performs one explicit whole-thread read. It has no timers, observers,
 * retries, automatic scrolling, or write endpoints.
 */
export async function captureTiebaThread(
  options: TiebaApiCaptureOptions,
): Promise<ThreadCapture> {
  const threadId = options.threadId.trim();
  if (!/^\d+$/u.test(threadId)) {
    throw new TiebaApiError(
      "INVALID_ARGUMENT",
      "帖子 ID 无效，无法读取整帖。",
    );
  }

  let parsedThreadUrl: URL;
  try {
    parsedThreadUrl = new URL(options.threadUrl);
  } catch (error) {
    const wrapped = new TiebaApiError("INVALID_ARGUMENT", "帖子地址无效。");
    Object.defineProperty(wrapped, "cause", { value: error });
    throw wrapped;
  }
  if (
    parsedThreadUrl.protocol !== "https:" ||
    parsedThreadUrl.hostname !== "tieba.baidu.com" ||
    !parsedThreadUrl.pathname.match(new RegExp(`^/p/${threadId}(?:/|$)`, "u"))
  ) {
    throw new TiebaApiError(
      "INVALID_ARGUMENT",
      "帖子地址与当前贴吧帖子不一致。",
    );
  }

  const limits = {
    mainPages: normalizedLimit(
      options.limits?.mainPages,
      TIEBA_API_CAPTURE_LIMITS.mainPages,
    ),
    nestedParents: normalizedLimit(
      options.limits?.nestedParents,
      TIEBA_API_CAPTURE_LIMITS.nestedParents,
    ),
    nestedPagesPerParent: normalizedLimit(
      options.limits?.nestedPagesPerParent,
      TIEBA_API_CAPTURE_LIMITS.nestedPagesPerParent,
    ),
    totalRequests: normalizedLimit(
      options.limits?.totalRequests,
      TIEBA_API_CAPTURE_LIMITS.totalRequests,
    ),
  };

  const reportProgress = (
    phase: TiebaApiCaptureProgress["phase"],
    completed: number,
    total: number,
  ): void => {
    try {
      options.onProgress?.({ phase, completed, total });
    } catch {
      // Progress is advisory. It must never change capture correctness.
    }
  };

  let requestCount = 0;
  const checkpoint = async (): Promise<void> => {
    try {
      await options.checkpoint();
    } catch (error) {
      throw new CheckpointCancelledError(error);
    }
  };
  const requestOnce = async (request: TiebaReadRequest): Promise<string> => {
    if (requestCount >= limits.totalRequests) {
      throw new CaptureLimitError(
        `只读请求数超过安全上限 ${limits.totalRequests}，已停止读取。`,
      );
    }
    requestCount += 1;
    await checkpoint();
    let body: string;
    try {
      body = await options.request(request);
    } catch (error) {
      // A navigation that happened while the request failed must win over the
      // network error so stale data is never returned for another thread.
      await checkpoint();
      throw error;
    }
    await checkpoint();
    return body;
  };

  let tbs: string;
  reportProgress("sync", 0, 1);
  try {
    const syncBody = await requestOnce(buildTiebaSyncRequest());
    tbs = parseTiebaSyncResponse(syncBody).tbs;
    reportProgress("sync", 1, 1);
  } catch (error) {
    if (isCancellation(error)) throw error;
    firstPageError("读取贴吧同步令牌", error);
  }

  let firstPage: MainPageProjection;
  reportProgress("main", 0, 1);
  try {
    const firstBody = await requestOnce(
      buildTiebaPagePcRequest(threadId, 1, tbs),
    );
    firstPage = normalizeMainProjection(
      parseTiebaPagePcResponse(firstBody, {
        threadId,
        expectedPage: 1,
        sourceUrl: options.threadUrl,
      }),
    );
  } catch (error) {
    if (isCancellation(error)) throw error;
    firstPageError("读取主回复第 1 页", error);
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  let failedRequestCount = 0;
  let mainTruncated = false;
  const mainPages = new Map<number, MainPageProjection>([[1, firstPage]]);
  const attemptedMainPages = new Set<number>([1]);
  let mainPageTotal = Math.max(
    firstPage.totalPages,
    firstPage.hasMore ? firstPage.currentPage + 1 : firstPage.currentPage,
  );
  let lastMainPage = Math.min(mainPageTotal, limits.mainPages);
  let completedMainPages = 1;
  reportProgress("main", completedMainPages, lastMainPage);

  const noteMainLimit = (): void => {
    if (mainPageTotal <= limits.mainPages || mainTruncated) return;
    mainTruncated = true;
    errors.push(
      `主回复分页至少需要读取 ${mainPageTotal} 页，超过安全上限 ${limits.mainPages} 页；结果已截断。`,
    );
  };
  noteMainLimit();

  // Tieba's pagination metadata can move while a long thread is being read.
  // Do not trust only page 1: every fetched page may raise total_page, and
  // has_more=true is an explicit lower bound that requires one more page.
  // The frontier remains bounded by mainPages and each page is attempted once.
  while (true) {
    const remainingMainPages = Array.from(
      { length: lastMainPage },
      (_, index) => index + 1,
    ).filter((page) => !attemptedMainPages.has(page));
    if (remainingMainPages.length === 0) break;
    for (const page of remainingMainPages) attemptedMainPages.add(page);

    await mapConcurrent(
      remainingMainPages,
      REQUEST_CONCURRENCY,
      async (page) => {
        let processed = false;
        try {
          const body = await requestOnce(
            buildTiebaPagePcRequest(threadId, page, tbs),
          );
          const parsed = normalizeMainProjection(
            parseTiebaPagePcResponse(body, {
              threadId,
              expectedPage: page,
              sourceUrl: options.threadUrl,
            }),
          );
          mainPages.set(page, parsed);
          mainPageTotal = Math.max(
            mainPageTotal,
            parsed.totalPages,
            parsed.hasMore ? parsed.currentPage + 1 : parsed.currentPage,
          );
          lastMainPage = Math.min(mainPageTotal, limits.mainPages);
          noteMainLimit();
          processed = true;
        } catch (error) {
          if (isCancellation(error)) throw error;
          if (error instanceof CaptureLimitError) {
            mainTruncated = true;
          } else {
            failedRequestCount += 1;
          }
          errors.push(
            `读取主回复第 ${page}/${mainPageTotal} 页失败：${errorMessage(error)}`,
          );
          processed = true;
        } finally {
          if (processed) {
            completedMainPages += 1;
            reportProgress("main", completedMainPages, lastMainPage);
          }
        }
      },
    );
  }

  const allReplies = new Map<string, CapturedReply>();
  const parents = new Map<string, NestedParentProjection>();
  const orderedMainPages = [...mainPages.values()].sort(
    (left, right) => left.currentPage - right.currentPage,
  );
  let declaredReplyCount = firstPage.declaredReplyCount;
  let title = firstPage.title;
  let forumId = firstPage.forumId;
  const seenPagePcStableIds = new Set<string>();
  let mainRawReplyNodeCount = 0;
  let mainStableReplyOccurrenceCount = 0;
  let mainDuplicateStableIdCount = 0;
  let mainCrossPageDuplicateStableIdCount = 0;
  let mainUnparsedReplyCount = 0;
  let mainDiagnosticMismatchCount = 0;
  let mainMissingReplyCountPages = 0;

  for (const page of orderedMainPages) {
    mainRawReplyNodeCount += page.rawReplyNodeCount;
    mainStableReplyOccurrenceCount += page.stableReplyOccurrenceCount;
    mainDuplicateStableIdCount += page.duplicateStableIdCount;
    mainUnparsedReplyCount += page.unparsedReplyCount;
    if (page.declaredReplyCount === null) {
      mainMissingReplyCountPages += 1;
    }
    if (!title && page.title) title = page.title;
    if (!forumId && page.forumId) forumId = page.forumId;
    if (page.declaredReplyCount !== null) {
      declaredReplyCount = Math.max(
        declaredReplyCount ?? 0,
        page.declaredReplyCount,
      );
    }
    const pageStableIds = new Set<string>();
    let returnedInvalidIdCount = 0;
    let returnedSamePageDuplicateCount = 0;
    for (const reply of page.replies) {
      const stableId = stablePagePcReplyId(reply);
      if (!stableId) {
        returnedInvalidIdCount += 1;
        continue;
      }
      if (pageStableIds.has(stableId)) {
        returnedSamePageDuplicateCount += 1;
        continue;
      }
      pageStableIds.add(stableId);
      if (seenPagePcStableIds.has(stableId)) {
        mainCrossPageDuplicateStableIdCount += 1;
        continue;
      }
      seenPagePcStableIds.add(stableId);
      allReplies.set(replyKey(reply), reply);
    }
    mainDuplicateStableIdCount += returnedSamePageDuplicateCount;
    mainUnparsedReplyCount += returnedInvalidIdCount;
    if (
      page.rawReplyNodeCount !==
        page.stableReplyOccurrenceCount + page.unparsedReplyCount ||
      page.stableReplyOccurrenceCount !==
        pageStableIds.size + page.duplicateStableIdCount ||
      returnedInvalidIdCount > 0 ||
      returnedSamePageDuplicateCount > 0
    ) {
      mainDiagnosticMismatchCount += 1;
    }
    for (const parent of page.nestedParents) {
      if (parent.declaredCount <= 0) continue;
      const previous = parents.get(parent.parentReplyId);
      parents.set(parent.parentReplyId, {
        ...(previous ?? parent),
        ...parent,
        parentFloor: parent.parentFloor ?? previous?.parentFloor ?? null,
        parentSiteReplyId:
          parent.parentSiteReplyId || previous?.parentSiteReplyId || "",
        declaredCount: Math.max(
          previous?.declaredCount ?? 0,
          parent.declaredCount,
        ),
        previewReplyIds: [
          ...new Set([
            ...(previous?.previewReplyIds ?? []),
            ...parent.previewReplyIds,
          ]),
        ],
      });
    }
  }

  const allParentEntries = [...parents.values()];
  const selectedParents = allParentEntries.slice(0, limits.nestedParents);
  let completedNestedWork = 0;
  let nestedWorkTotal = selectedParents.length;
  reportProgress("nested", 0, nestedWorkTotal);
  if (allParentEntries.length > limits.nestedParents) {
    errors.push(
      `含楼中楼的父楼共 ${allParentEntries.length} 个，超过安全上限 ${limits.nestedParents} 个；结果已截断。`,
    );
  }

  const parentStates = await mapConcurrent(
    selectedParents,
    NESTED_PARENT_CONCURRENCY,
    async (parent): Promise<NestedParentState> => {
      const state: NestedParentState = {
        ...parent,
        pagesFetched: 0,
        pagesExpected: null,
        availableCount: null,
        fullReplyKeys: new Set<string>(),
        reachedEnd: false,
        failed: false,
        truncated: false,
        satisfiedByPreview: false,
        rawReplyNodeCount: 0,
        stableReplyOccurrenceCount: 0,
        duplicateStableIdCount: 0,
        unparsedReplyCount: 0,
        unknownStructureCount: 0,
        pagerDriftCount: 0,
        diagnosticMismatchCount: 0,
        pagerWasTrusted: null,
        pagerTotalNum: null,
        pagerTotalPages: null,
        endpointProbeAttempted: false,
        endpointGapVerified: false,
        endpointProbeFailureCount: 0,
      };

      if (parent.previewReplyIds.length >= parent.declaredCount) {
        state.availableCount = parent.declaredCount;
        for (const id of parent.previewReplyIds) {
          state.fullReplyKeys.add(`nested:${id}`);
        }
        state.reachedEnd = true;
        state.pagesExpected = 0;
        state.satisfiedByPreview = true;
      }

      for (
        let page = 1;
        !state.satisfiedByPreview && page <= limits.nestedPagesPerParent;
        page += 1
      ) {
        let parsed: TiebaNestedPageProjection;
        try {
          const body = await requestOnce(
            buildTiebaNestedRequest(
              threadId,
              parent.parentSiteReplyId,
              page,
              forumId ?? undefined,
            ),
          );
          parsed = await options.parseNested(body, {
            threadId,
            parentReplyId: parent.parentReplyId,
            parentSiteReplyId: parent.parentSiteReplyId,
            parentFloor: parent.parentFloor,
            sourcePage: parent.sourcePage,
            sourceUrl: options.threadUrl,
            page,
            declaredCount: parent.declaredCount,
            forumId,
          });
        } catch (error) {
          if (isCancellation(error)) throw error;
          if (error instanceof CaptureLimitError) {
            state.truncated = true;
          } else {
            state.failed = true;
            failedRequestCount += 1;
          }
          errors.push(
            `读取${nestedParentLabel(parent)}的楼中楼第 ${page} 页失败：${errorMessage(error)}`,
          );
          break;
        }

        state.pagesFetched += 1;
        const totalNum = nonNegativeInteger(parsed.totalNum);
        const totalPages = positiveInteger(parsed.totalPages);
        const currentPage = positiveInteger(parsed.currentPage);
        const rawReplyNodeCount = nonNegativeInteger(
          parsed.rawReplyNodeCount,
        );
        const stableReplyOccurrenceCount = nonNegativeInteger(
          parsed.stableReplyOccurrenceCount,
        );
        const duplicateStableIdCount = nonNegativeInteger(
          parsed.duplicateStableIdCount,
        );
        const unparsedReplyCount = nonNegativeInteger(
          parsed.unparsedReplyCount,
        );
        const unknownStructureCount = nonNegativeInteger(
          parsed.unknownStructureCount,
        );
        const hasTrustedPager =
          typeof parsed.hasTrustedPager === "boolean"
            ? parsed.hasTrustedPager
            : null;

        const pageReplies = new Map<string, CapturedReply>();
        let returnedDuplicateCount = 0;
        for (const reply of parsed.replies) {
          const key = replyKey(reply);
          if (pageReplies.has(key)) {
            returnedDuplicateCount += 1;
          } else {
            pageReplies.set(key, reply);
          }
        }

        if (
          totalNum === null ||
          totalPages === null ||
          currentPage !== page ||
          currentPage > totalPages ||
          rawReplyNodeCount === null ||
          stableReplyOccurrenceCount === null ||
          duplicateStableIdCount === null ||
          unparsedReplyCount === null ||
          unknownStructureCount === null ||
          hasTrustedPager === null ||
          rawReplyNodeCount !==
            stableReplyOccurrenceCount + unparsedReplyCount ||
          stableReplyOccurrenceCount !==
            pageReplies.size + duplicateStableIdCount
        ) {
          state.diagnosticMismatchCount += 1;
        }

        state.availableCount = Math.max(
          state.availableCount ?? 0,
          totalNum ?? 0,
        );
        state.rawReplyNodeCount += rawReplyNodeCount ?? 0;
        state.stableReplyOccurrenceCount +=
          stableReplyOccurrenceCount ?? pageReplies.size;
        state.duplicateStableIdCount +=
          (duplicateStableIdCount ?? 0) + returnedDuplicateCount;
        state.unparsedReplyCount += unparsedReplyCount ?? 0;
        state.unknownStructureCount += unknownStructureCount ?? 0;

        let pagerDrifted = false;
        if (
          state.pagerWasTrusted !== null &&
          hasTrustedPager !== null &&
          state.pagerWasTrusted !== hasTrustedPager
        ) {
          pagerDrifted = true;
        }
        if (hasTrustedPager === true && totalNum !== null && totalPages !== null) {
          if (
            state.pagerTotalNum !== null &&
            (state.pagerTotalNum !== totalNum ||
              state.pagerTotalPages !== totalPages)
          ) {
            pagerDrifted = true;
          }
          if (state.pagerTotalNum === null) {
            state.pagerTotalNum = totalNum;
            state.pagerTotalPages = totalPages;
          }
        }
        if (state.pagerWasTrusted === null && hasTrustedPager !== null) {
          state.pagerWasTrusted = hasTrustedPager;
        }
        if (pagerDrifted) state.pagerDriftCount += 1;

        state.pagesExpected = Math.max(
          state.pagesExpected ?? 0,
          parsed.totalPages,
        );
        for (const [key, reply] of pageReplies) {
          // Full p/comment results intentionally overwrite page_pc previews
          // with the same official spid.
          if (state.fullReplyKeys.has(key)) {
            state.duplicateStableIdCount += 1;
          } else {
            state.fullReplyKeys.add(key);
          }
          allReplies.set(key, reply);
        }

        const knownEnd =
          !parsed.hasMore && parsed.currentPage >= parsed.totalPages;
        if (knownEnd) {
          state.reachedEnd = true;
          const terminalCountGap = Math.max(
            (state.availableCount ?? 0) - state.fullReplyKeys.size,
            0,
          );
          const canVerifyEndpointGap =
            terminalCountGap > 0 &&
            hasTrustedPager === true &&
            state.unparsedReplyCount === 0 &&
            state.duplicateStableIdCount === 0 &&
            state.unknownStructureCount === 0 &&
            state.pagerDriftCount === 0 &&
            state.diagnosticMismatchCount === 0 &&
            state.stableReplyOccurrenceCount === state.fullReplyKeys.size;
          if (canVerifyEndpointGap) {
            const probePage = parsed.totalPages + 1;
            state.endpointProbeAttempted = true;
            nestedWorkTotal += 1;
            reportProgress(
              "nested",
              completedNestedWork,
              nestedWorkTotal,
            );
            try {
              const probeBody = await requestOnce(
                buildTiebaNestedRequest(
                  threadId,
                  parent.parentSiteReplyId,
                  probePage,
                  forumId ?? undefined,
                ),
              );
              const probe = await options.parseNested(probeBody, {
                threadId,
                parentReplyId: parent.parentReplyId,
                parentSiteReplyId: parent.parentSiteReplyId,
                parentFloor: parent.parentFloor,
                sourcePage: parent.sourcePage,
                sourceUrl: options.threadUrl,
                page: probePage,
                declaredCount: parent.declaredCount,
                forumId,
                allowOutOfRangeEmptyProbe: true,
              });
              state.pagesFetched += 1;
              if (
                probe.isOutOfRangeEmptyProbe === true &&
                probe.currentPage === probePage &&
                probe.totalPages === 0 &&
                probe.totalNum === 0 &&
                probe.replies.length === 0 &&
                probe.rawReplyNodeCount === 0 &&
                probe.stableReplyOccurrenceCount === 0 &&
                probe.duplicateStableIdCount === 0 &&
                probe.unparsedReplyCount === 0 &&
                probe.unknownStructureCount === 0 &&
                probe.hasMore === false
              ) {
                state.endpointGapVerified = true;
              } else {
                state.endpointProbeFailureCount += 1;
                errors.push(
                  `${nestedParentLabel(parent)}的楼中楼终页后探测返回了非空或未知结构，无法把数量差额判定为仅端点不可见。`,
                );
              }
            } catch (error) {
              if (isCancellation(error)) throw error;
              state.endpointProbeFailureCount += 1;
              if (error instanceof CaptureLimitError) {
                state.truncated = true;
              } else {
                state.failed = true;
                failedRequestCount += 1;
              }
              errors.push(
                `${nestedParentLabel(parent)}的楼中楼终页后探测失败：${errorMessage(error)}`,
              );
            } finally {
              completedNestedWork += 1;
              reportProgress(
                "nested",
                completedNestedWork,
                nestedWorkTotal,
              );
            }
          }
          break;
        }
      }

      if (
        !state.satisfiedByPreview &&
        state.stableReplyOccurrenceCount - state.duplicateStableIdCount !==
          state.fullReplyKeys.size
      ) {
        state.diagnosticMismatchCount += 1;
      }

      if (!state.reachedEnd && !state.failed && !state.truncated) {
        state.truncated = true;
        errors.push(
          `${nestedParentLabel(parent)}的楼中楼超过安全上限 ${limits.nestedPagesPerParent} 页；结果已截断。`,
        );
      } else if (
        state.pagesExpected !== null &&
        state.pagesExpected > limits.nestedPagesPerParent
      ) {
        state.truncated = true;
        errors.push(
          `${nestedParentLabel(parent)}的楼中楼共 ${state.pagesExpected} 页，超过安全上限 ${limits.nestedPagesPerParent} 页；结果已截断。`,
        );
      }
      completedNestedWork += 1;
      reportProgress(
        "nested",
        completedNestedWork,
        nestedWorkTotal,
      );
      return state;
    },
  );

  reportProgress("coverage", 0, 1);

  const stateByParent = new Map(
    parentStates.map((state) => [state.parentReplyId, state]),
  );
  for (const state of parentStates) {
    if (
      state.satisfiedByPreview ||
      !state.reachedEnd ||
      state.failed ||
      state.truncated
    ) {
      continue;
    }
    // Once p/comment reached a trusted terminal page, it is the current source
    // of truth for this parent. Drop stale page_pc previews that disappeared
    // from the full result; their old declaration is retained only as an
    // unavailable-count signal below.
    for (const previewId of state.previewReplyIds) {
      const key = `nested:${previewId}`;
      if (!state.fullReplyKeys.has(key)) allReplies.delete(key);
    }
  }
  const nestedFetchedByParent = new Map<string, number>();
  for (const reply of allReplies.values()) {
    if (!reply.isNested || !reply.parentReplyId) continue;
    nestedFetchedByParent.set(
      reply.parentReplyId,
      (nestedFetchedByParent.get(reply.parentReplyId) ?? 0) + 1,
    );
  }
  const stateDiagnosticCount = (state: NestedParentState): number => {
    const unverifiedEndpointGap =
      state.reachedEnd &&
      (state.availableCount ?? 0) > state.fullReplyKeys.size &&
      !state.endpointGapVerified
        ? (state.availableCount ?? 0) - state.fullReplyKeys.size
        : 0;
    return Math.max(
      state.unparsedReplyCount + state.unknownStructureCount,
      state.duplicateStableIdCount +
        state.pagerDriftCount +
        state.diagnosticMismatchCount,
      unverifiedEndpointGap,
    );
  };
  const isStableTerminalState = (state: NestedParentState): boolean =>
    state.reachedEnd &&
    !state.failed &&
    !state.truncated &&
    stateDiagnosticCount(state) === 0;
  let unresolvedNestedReplyCount = 0;
  for (const parent of allParentEntries) {
    const state = stateByParent.get(parent.parentReplyId);
    const declared = Math.max(
      state?.declaredCount ?? parent.declaredCount,
      state?.availableCount ?? 0,
    );
    const shortfall = Math.max(
      0,
      declared - (nestedFetchedByParent.get(parent.parentReplyId) ?? 0),
    );
    // A stable terminal /p/comment response has no further page to read. Its
    // numeric shortfall is an endpoint-visibility gap, not an unexpanded node.
    // Missing IDs, duplicates, unknown structures or pager drift remain
    // fail-closed because they can hide a real parser/pagination loss.
    const unresolved =
      state && isStableTerminalState(state)
        ? 0
        : Math.max(shortfall, state ? stateDiagnosticCount(state) : 0);
    unresolvedNestedReplyCount += unresolved;
    const main = allReplies.get(`main:${parent.parentSiteReplyId}`);
    if (main) main.unexpandedNestedCount = unresolved;
  }

  const replies = sortReplies([...allReplies.values()], parents);
  const mainReplies = replies.filter((reply) => !reply.isNested);
  const nestedReplies = replies.filter((reply) => reply.isNested);
  const pagePcNestedRepliesDeclared = allParentEntries.reduce(
    (sum, parent) => sum + parent.declaredCount,
    0,
  );
  const nestedRepliesDeclared = allParentEntries.reduce((sum, parent) => {
    const state = stateByParent.get(parent.parentReplyId);
    return sum + (state?.availableCount ?? parent.declaredCount);
  }, 0);
  const unparsedNestedReplyCount = parentStates.reduce(
    (sum, state) => sum + state.unparsedReplyCount,
    0,
  );
  const duplicateStableIdCount = parentStates.reduce(
    (sum, state) => sum + state.duplicateStableIdCount,
    0,
  );
  const unknownStructureCount = parentStates.reduce(
    (sum, state) => sum + state.unknownStructureCount,
    0,
  );
  const pagerDriftCount = parentStates.reduce(
    (sum, state) => sum + state.pagerDriftCount,
    0,
  );
  const diagnosticMismatchCount = parentStates.reduce(
    (sum, state) => sum + state.diagnosticMismatchCount,
    0,
  );
  const unverifiedEndpointGapCount = parentStates.reduce(
    (sum, state) =>
      sum +
      (state.reachedEnd &&
      (state.availableCount ?? 0) > state.fullReplyKeys.size &&
      !state.endpointGapVerified
        ? 1
        : 0),
    0,
  );
  const unverifiedEndpointShortfall = parentStates.reduce(
    (sum, state) =>
      sum +
      (state.reachedEnd && !state.endpointGapVerified
        ? Math.max(
            (state.availableCount ?? 0) - state.fullReplyKeys.size,
            0,
          )
        : 0),
    0,
  );
  const structuralDiagnosticCount =
    Math.max(
      unparsedNestedReplyCount + unknownStructureCount,
      duplicateStableIdCount + pagerDriftCount + diagnosticMismatchCount,
      unverifiedEndpointShortfall,
    );
  const mainStructuralDiagnosticCount = Math.max(
    mainUnparsedReplyCount,
    mainDuplicateStableIdCount + mainCrossPageDuplicateStableIdCount,
    mainDiagnosticMismatchCount,
    mainMissingReplyCountPages,
    Math.abs(
      mainRawReplyNodeCount -
        mainStableReplyOccurrenceCount -
        mainUnparsedReplyCount,
    ),
  );
  let endpointCountShortfall = 0;
  let stalePagePcShortfall = 0;
  for (const parent of allParentEntries) {
    const state = stateByParent.get(parent.parentReplyId);
    if (!state || !isStableTerminalState(state)) continue;
    const fetched = nestedFetchedByParent.get(parent.parentReplyId) ?? 0;
    const available = state.availableCount ?? fetched;
    if (!state.satisfiedByPreview && state.endpointGapVerified) {
      endpointCountShortfall += Math.max(available - fetched, 0);
    }
    stalePagePcShortfall += Math.max(
      parent.declaredCount - Math.max(available, fetched),
      0,
    );
  }
  // Count declaration gaps per parent. A newly active parent with more replies
  // must never hide a stale/deleted gap on another parent through global sums.
  const declaredNestedShortfall = allParentEntries.reduce(
    (sum, parent) => {
      const state = stateByParent.get(parent.parentReplyId);
      const declared = Math.max(
        parent.declaredCount,
        state?.availableCount ?? 0,
      );
      const fetched = nestedFetchedByParent.get(parent.parentReplyId) ?? 0;
      return sum + Math.max(declared - fetched, 0);
    },
    0,
  );
  const nestedShortfall = Math.max(
    unresolvedNestedReplyCount,
    declaredNestedShortfall,
  );
  const imageCount = replies.reduce(
    (sum, reply) => sum + reply.imageCount,
    0,
  );
  const mainPagesComplete =
    !mainTruncated && mainPages.size === mainPageTotal;
  const nestedRequestsComplete =
    selectedParents.length === allParentEntries.length &&
    parentStates.every(
      (state) => state.reachedEnd && !state.failed && !state.truncated,
    );
  const readableTextComplete =
    mainPagesComplete &&
    nestedRequestsComplete &&
    failedRequestCount === 0 &&
    mainStructuralDiagnosticCount === 0 &&
    unresolvedNestedReplyCount === 0;
  const unavailableReplyCount =
    declaredReplyCount === null
      ? nestedShortfall
      : Math.max(
          nestedShortfall,
          declaredReplyCount + 1 - replies.length,
          0,
        );

  if (mainMissingReplyCountPages > 0) {
    warnings.push(
      `贴吧主回复接口有 ${mainMissingReplyCountPages} 页缺少 reply_num，无法核对整帖声明回复数。`,
    );
  }
  if (mainUnparsedReplyCount > 0) {
    warnings.push(
      `贴吧主回复接口有 ${mainUnparsedReplyCount} 个主回复或楼中楼预览节点缺少稳定 ID，无法安全纳入分析。`,
    );
  }
  if (mainDuplicateStableIdCount > 0) {
    warnings.push(
      `贴吧主回复接口单页出现 ${mainDuplicateStableIdCount} 次稳定 ID 重复，无法确认页面结构是否完整。`,
    );
  }
  if (mainCrossPageDuplicateStableIdCount > 0) {
    warnings.push(
      `贴吧主回复接口跨页出现 ${mainCrossPageDuplicateStableIdCount} 次稳定 ID 重复，无法确认分页边界是否完整。`,
    );
  }
  if (mainDiagnosticMismatchCount > 0) {
    warnings.push(
      `贴吧主回复接口有 ${mainDiagnosticMismatchCount} 页的节点诊断数据不一致，已按不完整读取处理。`,
    );
  }
  if (endpointCountShortfall > 0) {
    warnings.push(
      `楼中楼接口已到稳定终页；当前分页标注 ${nestedRepliesDeclared} 条，实际取得 ${nestedReplies.length} 条，其中有 ${endpointCountShortfall} 条端点计数差额。对应页面没有重复、未知结构或分页漂移，差额可能来自已删除、审核中或当前账号不可见的回复。`,
    );
  }
  if (stalePagePcShortfall > 0) {
    warnings.push(
      `贴吧主回复接口曾标注 ${pagePcNestedRepliesDeclared} 条楼中楼回复；逐楼对账仍有 ${stalePagePcShortfall} 条差额（仅存在于旧声明），当前楼中楼终页没有返回对应节点。`,
    );
  }
  if (unresolvedNestedReplyCount > structuralDiagnosticCount) {
    warnings.push(
      `仍有 ${unresolvedNestedReplyCount - structuralDiagnosticCount} 条楼中楼回复因读取失败、分页未到终点或安全上限而无法确认，读取范围尚未完成。`,
    );
  }
  if (unparsedNestedReplyCount > 0) {
    warnings.push(
      `楼中楼接口有 ${unparsedNestedReplyCount} 个回复节点缺少稳定 ID，无法安全纳入分析。`,
    );
  }
  if (duplicateStableIdCount > 0) {
    warnings.push(
      `楼中楼分页出现 ${duplicateStableIdCount} 次稳定 ID 重复，无法确认分页边界是否完整。`,
    );
  }
  if (unknownStructureCount > 0) {
    warnings.push(
      `楼中楼接口出现 ${unknownStructureCount} 个未识别的数据节点，可能存在尚未适配的回复结构。`,
    );
  }
  if (pagerDriftCount > 0) {
    warnings.push(
      `楼中楼读取期间有 ${pagerDriftCount} 页的分页总数发生漂移，无法可靠完成逐页对账。`,
    );
  }
  if (diagnosticMismatchCount > 0) {
    warnings.push(
      `楼中楼接口有 ${diagnosticMismatchCount} 页的节点诊断数据不一致，已按不完整读取处理。`,
    );
  }
  if (unverifiedEndpointGapCount > 0) {
    warnings.push(
      `有 ${unverifiedEndpointGapCount} 个父楼的终页数量差额未通过空页哨兵验证，不能排除验证码、分页漂移或实际漏项。`,
    );
  }
  if (unavailableReplyCount > nestedShortfall) {
    warnings.push(
      `按贴吧声明回复数估算，仍有 ${unavailableReplyCount} 条回复无法从只读接口取得。`,
    );
  }
  if (imageCount > 0) {
    warnings.push(`检测到 ${imageCount} 张图片；当前版本不识别图片文字。`);
  }

  const analyzedPageNumbers = [...mainPages.keys()].sort(
    (left, right) => left - right,
  );
  const capturedAt = (options.now ?? (() => new Date()))().toISOString();

  reportProgress("coverage", 1, 1);

  return {
    schemaVersion: SCHEMA_VERSION,
    parserVariant: "api",
    documentInstanceId: null,
    threadId,
    url: options.threadUrl,
    title: title || `贴吧帖子 ${threadId}`,
    pageNumber: 1,
    replies,
    coverage: {
      captureMode: "api",
      visibleReplyCount: replies.length,
      mainReplyCount: mainReplies.length,
      nestedReplyCount: nestedReplies.length,
      imageCount,
      unexpandedLzlCount: unresolvedNestedReplyCount,
      analyzedPageNumbers,
      hasUnanalyzedImages: imageCount > 0,
      declaredReplyCount,
      dynamicContentMayRemain: !readableTextComplete,
      reachedReplyListEnd: mainPagesComplete,
      unstableReplyIdCount: replies.filter(
        (reply) => reply.siteReplyId === null,
      ).length,
      apiCoverage: {
        mainPagesFetched: mainPages.size,
        mainPagesTotal: mainPageTotal,
        mainRepliesFetched: mainReplies.length,
        nestedParentsFetched: parentStates.filter(
          (state) => state.pagesFetched > 0 || state.satisfiedByPreview,
        ).length,
        nestedParentsTotal: allParentEntries.length,
        nestedRepliesFetched: nestedReplies.length,
        nestedRepliesDeclared,
        failedRequestCount,
        unavailableReplyCount,
        readableTextComplete,
      },
      isComplete:
        readableTextComplete &&
        unavailableReplyCount === 0 &&
        imageCount === 0,
    },
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    capturedAt,
  };
}
