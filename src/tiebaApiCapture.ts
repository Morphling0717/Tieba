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

const REQUEST_CONCURRENCY = 3;

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
  unparsedReplyCount: number;
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
  now?: () => Date;
  /**
   * Test-only lower bounds. Values can reduce, but never raise, the production
   * hard limits above.
   */
  limits?: Partial<TiebaApiCaptureLimits>;
}

interface MainPageProjection {
  title: string;
  forumId: string | null;
  currentPage: number;
  totalPages: number;
  declaredReplyCount: number | null;
  replies: CapturedReply[];
  nestedParents: NestedParentProjection[];
}

interface NestedParentProjection {
  parentReplyId: string;
  parentSiteReplyId: string;
  parentFloor: number | null;
  sourcePage: number;
  declaredCount: number;
}

interface NestedParentState extends NestedParentProjection {
  pagesFetched: number;
  pagesExpected: number | null;
  reachedEnd: boolean;
  failed: boolean;
  truncated: boolean;
  unparsedReplyCount: number;
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

  const replies = Array.isArray(source.replies)
    ? (source.replies as CapturedReply[])
    : [];
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

    nestedParents.push({
      parentReplyId,
      parentSiteReplyId,
      parentFloor:
        nonNegativeInteger(parent.parentFloor ?? parent.floor) ?? null,
      sourcePage:
        positiveInteger(parent.sourcePage ?? source.currentPage) ?? currentPage,
      declaredCount,
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
    declaredReplyCount: nonNegativeInteger(
      source.declaredReplyCount ??
        source.replyCount ??
        source.replyNum ??
        source.reply_num,
    ),
    replies,
    nestedParents,
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
  try {
    const syncBody = await requestOnce(buildTiebaSyncRequest());
    tbs = parseTiebaSyncResponse(syncBody).tbs;
  } catch (error) {
    if (isCancellation(error)) throw error;
    firstPageError("读取贴吧同步令牌", error);
  }

  let firstPage: MainPageProjection;
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
  const mainPageTotal = firstPage.totalPages;
  const lastMainPage = Math.min(mainPageTotal, limits.mainPages);

  if (mainPageTotal > limits.mainPages) {
    mainTruncated = true;
    errors.push(
      `主回复共 ${mainPageTotal} 页，超过安全上限 ${limits.mainPages} 页；结果已截断。`,
    );
  }

  const remainingMainPages = Array.from(
    { length: Math.max(0, lastMainPage - 1) },
    (_, index) => index + 2,
  );
  await mapConcurrent(
    remainingMainPages,
    REQUEST_CONCURRENCY,
    async (page) => {
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
      }
    },
  );

  const allReplies = new Map<string, CapturedReply>();
  const parents = new Map<string, NestedParentProjection>();
  const orderedMainPages = [...mainPages.values()].sort(
    (left, right) => left.currentPage - right.currentPage,
  );
  let declaredReplyCount = firstPage.declaredReplyCount;
  let title = firstPage.title;
  let forumId = firstPage.forumId;

  for (const page of orderedMainPages) {
    if (!title && page.title) title = page.title;
    if (!forumId && page.forumId) forumId = page.forumId;
    if (page.declaredReplyCount !== null) {
      declaredReplyCount = Math.max(
        declaredReplyCount ?? 0,
        page.declaredReplyCount,
      );
    }
    for (const reply of page.replies) {
      allReplies.set(replyKey(reply), reply);
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
      });
    }
  }

  const allParentEntries = [...parents.values()];
  const selectedParents = allParentEntries.slice(0, limits.nestedParents);
  if (allParentEntries.length > limits.nestedParents) {
    errors.push(
      `含楼中楼的父楼共 ${allParentEntries.length} 个，超过安全上限 ${limits.nestedParents} 个；结果已截断。`,
    );
  }

  const parentStates = await mapConcurrent(
    selectedParents,
    REQUEST_CONCURRENCY,
    async (parent): Promise<NestedParentState> => {
      const state: NestedParentState = {
        ...parent,
        pagesFetched: 0,
        pagesExpected: null,
        reachedEnd: false,
        failed: false,
        truncated: false,
        unparsedReplyCount: 0,
      };

      for (let page = 1; page <= limits.nestedPagesPerParent; page += 1) {
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
            `读取父楼 ${parent.parentReplyId} 的楼中楼第 ${page} 页失败：${errorMessage(error)}`,
          );
          break;
        }

        state.pagesFetched += 1;
        state.declaredCount = Math.max(
          state.declaredCount,
          nonNegativeInteger(parsed.totalNum) ?? 0,
        );
        state.unparsedReplyCount +=
          nonNegativeInteger(parsed.unparsedReplyCount) ?? 0;
        state.pagesExpected = Math.max(
          state.pagesExpected ?? 0,
          parsed.totalPages,
        );
        for (const reply of parsed.replies) {
          // Full p/comment results intentionally overwrite page_pc previews
          // with the same official spid.
          allReplies.set(replyKey(reply), reply);
        }

        const knownEnd =
          !parsed.hasMore && parsed.currentPage >= parsed.totalPages;
        if (knownEnd) {
          state.reachedEnd = true;
          break;
        }
      }

      if (!state.reachedEnd && !state.failed && !state.truncated) {
        state.truncated = true;
        errors.push(
          `父楼 ${parent.parentReplyId} 的楼中楼超过安全上限 ${limits.nestedPagesPerParent} 页；结果已截断。`,
        );
      } else if (
        state.pagesExpected !== null &&
        state.pagesExpected > limits.nestedPagesPerParent
      ) {
        state.truncated = true;
        errors.push(
          `父楼 ${parent.parentReplyId} 的楼中楼共 ${state.pagesExpected} 页，超过安全上限 ${limits.nestedPagesPerParent} 页；结果已截断。`,
        );
      }
      return state;
    },
  );

  const stateByParent = new Map(
    parentStates.map((state) => [state.parentReplyId, state]),
  );
  const nestedFetchedByParent = new Map<string, number>();
  for (const reply of allReplies.values()) {
    if (!reply.isNested || !reply.parentReplyId) continue;
    nestedFetchedByParent.set(
      reply.parentReplyId,
      (nestedFetchedByParent.get(reply.parentReplyId) ?? 0) + 1,
    );
  }
  for (const parent of allParentEntries) {
    const declared =
      stateByParent.get(parent.parentReplyId)?.declaredCount ??
      parent.declaredCount;
    const shortfall = Math.max(
      0,
      declared - (nestedFetchedByParent.get(parent.parentReplyId) ?? 0),
    );
    const main = allReplies.get(`main:${parent.parentSiteReplyId}`);
    if (main) main.unexpandedNestedCount = shortfall;
  }

  const replies = sortReplies([...allReplies.values()], parents);
  const mainReplies = replies.filter((reply) => !reply.isNested);
  const nestedReplies = replies.filter((reply) => reply.isNested);
  const nestedRepliesDeclared = allParentEntries.reduce((sum, parent) => {
    const state = stateByParent.get(parent.parentReplyId);
    return sum + (state?.declaredCount ?? parent.declaredCount);
  }, 0);
  const unparsedNestedReplyCount = parentStates.reduce(
    (sum, state) => sum + state.unparsedReplyCount,
    0,
  );
  const nestedShortfall = Math.max(
    unparsedNestedReplyCount,
    nestedRepliesDeclared - nestedReplies.length,
    0,
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
    nestedShortfall === 0;
  const unavailableReplyCount =
    declaredReplyCount === null
      ? nestedShortfall
      : Math.max(
          nestedShortfall,
          declaredReplyCount + 1 - replies.length,
          0,
        );

  if (nestedShortfall > 0) {
    warnings.push(
      `贴吧声明有 ${nestedRepliesDeclared} 条楼中楼回复，实际读取 ${nestedReplies.length} 条，仍缺 ${nestedShortfall} 条。`,
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
      unexpandedLzlCount: nestedShortfall,
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
          (state) => state.pagesFetched > 0,
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
