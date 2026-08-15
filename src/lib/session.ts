import { SCHEMA_VERSION } from "../types";
import type { CapturedReply, Coverage, ThreadCapture } from "../types";

export const SESSION_SCHEMA_VERSION = 3 as const;

export interface ReviewSession {
  schemaVersion: typeof SCHEMA_VERSION;
  /** Version of the transient chrome.storage.session representation. */
  sessionSchemaVersion: typeof SESSION_SCHEMA_VERSION;
  tabId: number;
  threadId: string | null;
  threadUrl: string;
  title: string;
  pages: Record<string, ThreadCapture>;
  replies: CapturedReply[];
  coverage: Coverage;
  errors: string[];
  warnings: string[];
  updatedAt: string;
}

export const sessionStorageKey = (tabId: number): string =>
  `kr_tieba_review_session_v${SESSION_SCHEMA_VERSION}_${tabId}`;

export function tiebaThreadIdFromUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (url.hostname !== "tieba.baidu.com") return null;
    return url.pathname.match(/^\/p\/(\d+)(?:\/|$)/u)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Auto-capture is allowed only while the same tab is paging inside the exact
 * thread that the moderator explicitly started reviewing.
 */
export function isSameThreadUrl(
  session: Pick<ReviewSession, "threadId" | "threadUrl">,
  candidateUrl: string | undefined,
): boolean {
  if (!candidateUrl) return false;
  const candidateThreadId = tiebaThreadIdFromUrl(candidateUrl);
  if (!candidateThreadId) return false;
  if (session.threadId) return candidateThreadId === session.threadId;
  return candidateThreadId === tiebaThreadIdFromUrl(session.threadUrl);
}

export function classifySessionUrl(
  session: Pick<ReviewSession, "threadId" | "threadUrl">,
  candidateUrl: string | null | undefined,
): "same" | "different" | "unknown" {
  if (candidateUrl == null) return "unknown";
  return isSameThreadUrl(session, candidateUrl) ? "same" : "different";
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function replySort(left: CapturedReply, right: CapturedReply): number {
  if (
    left.floor !== null &&
    right.floor !== null &&
    left.floor !== right.floor
  ) {
    return left.floor - right.floor;
  }
  if (left.timestamp !== null && right.timestamp !== null) {
    return left.timestamp - right.timestamp;
  }
  if (left.isNested !== right.isNested) return left.isNested ? 1 : -1;
  return left.id.localeCompare(right.id);
}

function replyMergeKey(reply: CapturedReply): string {
  return reply.siteReplyId
    ? `site:${reply.isNested ? "nested" : "main"}:${reply.siteReplyId}`
    : `session:${reply.id}`;
}

function latestNonNullDeclaredCount(
  captures: readonly ThreadCapture[],
): number | null {
  let result: number | null = null;
  for (const capture of captures) {
    if (capture.coverage.declaredReplyCount !== null) {
      result = capture.coverage.declaredReplyCount;
    }
  }
  return result;
}

function coverageFromReplies(
  replies: readonly CapturedReply[],
  captures: readonly ThreadCapture[],
  parserVariant: ThreadCapture["parserVariant"],
): Coverage {
  const pageNumbers = unique(
    captures.flatMap((capture) => capture.coverage.analyzedPageNumbers),
  ).sort((left, right) => left - right);
  const mainReplies = replies.filter((reply) => !reply.isNested);
  const nestedReplyCount = replies.length - mainReplies.length;
  const imageCount = replies.reduce((sum, reply) => sum + reply.imageCount, 0);
  const unexpandedLzlCount = mainReplies.reduce(
    (sum, reply) => sum + reply.unexpandedNestedCount,
    0,
  );
  const latestApiCapture =
    parserVariant === "api"
      ? [...captures].reverse().find((capture) => capture.parserVariant === "api")
      : undefined;
  if (latestApiCapture) {
    return {
      ...latestApiCapture.coverage,
      visibleReplyCount: replies.length,
      mainReplyCount: mainReplies.length,
      nestedReplyCount,
      imageCount,
      unexpandedLzlCount,
      analyzedPageNumbers: pageNumbers,
      hasUnanalyzedImages: imageCount > 0,
      unstableReplyIdCount: replies.filter(
        (reply) => reply.siteReplyId === null,
      ).length,
    };
  }
  const isDynamic = parserVariant === "spa";
  const reachedReplyListEnd = isDynamic
    ? (captures.at(-1)?.coverage.reachedReplyListEnd ?? false)
    : captures.some((capture) => capture.coverage.reachedReplyListEnd);

  return {
    captureMode: isDynamic ? "dynamic" : "paginated",
    visibleReplyCount: replies.length,
    mainReplyCount: mainReplies.length,
    nestedReplyCount,
    imageCount,
    unexpandedLzlCount,
    analyzedPageNumbers: pageNumbers,
    hasUnanalyzedImages: imageCount > 0,
    declaredReplyCount: latestNonNullDeclaredCount(captures),
    dynamicContentMayRemain: isDynamic
      ? !reachedReplyListEnd
      : captures.some((capture) => capture.coverage.dynamicContentMayRemain),
    reachedReplyListEnd,
    unstableReplyIdCount: replies.filter(
      (reply) => reply.isNested && reply.siteReplyId === null,
    ).length,
    isComplete:
      !isDynamic &&
      captures.length > 0 &&
      captures.every((capture) => capture.coverage.isComplete),
  };
}

const SPA_AGGREGATE_WARNING = /^(?:估计仍有 \d+ 条楼中楼回复未展开。|检测到 \d+ 张图片；当前版本不识别图片文字。|\d+ 条回复没有网站稳定 ID，动态去重与跳转可能不完整。)$/u;

function spaWarningsFromCoverage(
  incomingWarnings: readonly string[],
  coverage: Coverage,
): string[] {
  const warnings = unique(
    incomingWarnings.filter((warning) => !SPA_AGGREGATE_WARNING.test(warning)),
  );
  if (coverage.unexpandedLzlCount > 0) {
    warnings.push(`估计仍有 ${coverage.unexpandedLzlCount} 条楼中楼回复未展开。`);
  }
  if (coverage.imageCount > 0) {
    warnings.push(`检测到 ${coverage.imageCount} 张图片；当前版本不识别图片文字。`);
  }
  if (coverage.unstableReplyIdCount > 0) {
    warnings.push(
      `${coverage.unstableReplyIdCount} 条回复没有网站稳定 ID，动态去重与跳转可能不完整。`,
    );
  }
  return warnings;
}

function aggregatePages(pages: Record<string, ThreadCapture>): {
  replies: CapturedReply[];
  coverage: Coverage;
  errors: string[];
  warnings: string[];
} {
  const captures = Object.values(pages).sort(
    (left, right) => left.pageNumber - right.pageNumber,
  );
  const repliesById = new Map<string, CapturedReply>();
  for (const capture of captures) {
    for (const reply of capture.replies) {
      repliesById.set(replyMergeKey(reply), reply);
    }
  }
  const replies = [...repliesById.values()].sort(replySort);
  const parserVariant = captures.some(
    (capture) => capture.parserVariant === "api",
  )
    ? "api"
    : captures.some(
    (capture) => capture.parserVariant === "spa",
  )
    ? "spa"
    : "legacy";

  return {
    replies,
    coverage: coverageFromReplies(replies, captures, parserVariant),
    errors: unique(captures.flatMap((capture) => capture.errors)),
    warnings: unique(captures.flatMap((capture) => capture.warnings)),
  };
}

function sameThread(current: ReviewSession, capture: ThreadCapture): boolean {
  if (current.threadId && capture.threadId) {
    return current.threadId === capture.threadId;
  }
  return (
    tiebaThreadIdFromUrl(current.threadUrl) !== null &&
    tiebaThreadIdFromUrl(current.threadUrl) ===
      tiebaThreadIdFromUrl(capture.url)
  );
}

function mergeSpaCapture(
  previous: ThreadCapture,
  incoming: ThreadCapture,
): ThreadCapture {
  const repliesById = new Map<string, CapturedReply>();
  for (const reply of previous.replies) {
    repliesById.set(replyMergeKey(reply), reply);
  }
  for (const reply of incoming.replies) {
    repliesById.set(replyMergeKey(reply), reply);
  }
  const replies = [...repliesById.values()].sort(replySort);
  const captures = [previous, incoming];
  const coverage = coverageFromReplies(replies, captures, "spa");

  return {
    ...incoming,
    replies,
    coverage,
    errors: unique(captures.flatMap((capture) => capture.errors)),
    // Dynamic snapshot counts are replaced by the aggregate derived from the
    // current union. Keeping old numeric warnings made the side panel show a
    // contradictory history such as 14/15/16 unstable replies at once.
    warnings: spaWarningsFromCoverage(incoming.warnings, coverage),
  };
}

export function mergeCapture(
  current: ReviewSession | null,
  capture: ThreadCapture,
  tabId: number,
): ReviewSession {
  const isSameThread = current !== null && sameThread(current, capture);
  const currentCaptures = current ? Object.values(current.pages) : [];
  const currentIsApi = currentCaptures.some(
    (existing) => existing.parserVariant === "api",
  );
  const currentIsSpa = currentCaptures.some(
    (existing) => existing.parserVariant === "spa",
  );
  let pages: Record<string, ThreadCapture>;

  if (capture.parserVariant === "api") {
    // A whole-thread API run is already internally reconciled. Re-running it
    // atomically replaces the prior snapshot instead of mixing old and new
    // replies from different moments.
    pages = { api: capture };
  } else if (isSameThread && currentIsApi) {
    // A later SPA mutation or same-thread navigation must never downgrade a
    // completed/partial API snapshot to the handful of rows currently mounted
    // by Tieba's virtual list.
    return current;
  } else if (capture.parserVariant === "spa") {
    const previous =
      isSameThread && currentIsSpa ? current?.pages.spa : undefined;
    const sameDocument =
      previous?.documentInstanceId !== null &&
      previous?.documentInstanceId !== undefined &&
      previous.documentInstanceId === capture.documentInstanceId;
    pages = {
      spa:
        previous && sameDocument ? mergeSpaCapture(previous, capture) : capture,
    };
  } else {
    pages = isSameThread && !currentIsSpa ? { ...current.pages } : {};
    pages[String(capture.pageNumber)] = capture;
  }
  const aggregate = aggregatePages(pages);

  return {
    schemaVersion: SCHEMA_VERSION,
    sessionSchemaVersion: SESSION_SCHEMA_VERSION,
    tabId,
    threadId: capture.threadId,
    threadUrl: capture.url,
    title:
      capture.title ||
      (isSameThread ? current?.title : undefined) ||
      "未命名帖子",
    pages,
    ...aggregate,
    updatedAt: capture.capturedAt,
  };
}
