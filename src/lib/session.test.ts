import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../types";
import type { ThreadCapture } from "../types";
import {
  SESSION_SCHEMA_VERSION,
  classifySessionUrl,
  isSameThreadUrl,
  mergeCapture,
  sessionStorageKey,
  tiebaThreadIdFromUrl,
} from "./session";

function capture(
  pageNumber: number,
  replyId: string,
  parserVariant: ThreadCapture["parserVariant"] = "legacy",
  documentInstanceId: string | null = null,
): ThreadCapture {
  return {
    schemaVersion: SCHEMA_VERSION,
    parserVariant,
    documentInstanceId,
    threadId: "123",
    url: `https://tieba.baidu.com/p/123?pn=${pageNumber}`,
    title: "测试帖",
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
        content: `内容${pageNumber}`,
        sourcePage: pageNumber,
        sourceUrl: `https://tieba.baidu.com/p/123?pn=${pageNumber}`,
        anchor: `#post-${replyId}`,
        imageCount: pageNumber,
        isNested: false,
        unexpandedNestedCount: 0,
      },
    ],
    coverage: {
      captureMode: parserVariant === "spa" ? "dynamic" : "paginated",
      visibleReplyCount: 1,
      mainReplyCount: 1,
      nestedReplyCount: 0,
      imageCount: pageNumber,
      unexpandedLzlCount: 0,
      analyzedPageNumbers: [pageNumber],
      hasUnanalyzedImages: true,
      declaredReplyCount: parserVariant === "spa" ? 212 : null,
      dynamicContentMayRemain: parserVariant === "spa",
      reachedReplyListEnd: false,
      unstableReplyIdCount: 0,
      isComplete: false,
    },
    errors: [],
    warnings: [],
    capturedAt: new Date(2026, 6, pageNumber).toISOString(),
  };
}

function apiCapture(replyId = "api-main"): ThreadCapture {
  const result = capture(1, replyId, "api");
  result.coverage = {
    ...result.coverage,
    captureMode: "api",
    imageCount: 0,
    hasUnanalyzedImages: false,
    declaredReplyCount: 0,
    dynamicContentMayRemain: false,
    reachedReplyListEnd: true,
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
  };
  result.replies[0].imageCount = 0;
  return result;
}

describe("mergeCapture", () => {
  it("accumulates pages and replaces a recaptured page", () => {
    const first = mergeCapture(null, capture(1, "a"), 7);
    const second = mergeCapture(first, capture(2, "b"), 7);
    const recaptured = mergeCapture(second, capture(1, "c"), 7);

    expect(second.coverage.analyzedPageNumbers).toEqual([1, 2]);
    expect(second.replies.map((reply) => reply.id)).toEqual(["a", "b"]);
    expect(recaptured.replies.map((reply) => reply.id)).toEqual(["c", "b"]);
    expect(recaptured.coverage.imageCount).toBe(3);
    expect(recaptured.sessionSchemaVersion).toBe(SESSION_SCHEMA_VERSION);
  });

  it("uses the v3 transient storage key without changing record schema", () => {
    expect(sessionStorageKey(7)).toBe("kr_tieba_review_session_v3_7");
    expect(mergeCapture(null, capture(1, "a"), 7).schemaVersion).toBe(
      SCHEMA_VERSION,
    );
  });

  it("starts over after navigating to a different thread", () => {
    const first = mergeCapture(null, capture(1, "a"), 7);
    const other = capture(1, "x");
    other.threadId = "999";
    other.url = "https://tieba.baidu.com/p/999";

    const result = mergeCapture(first, other, 7);
    expect(result.threadId).toBe("999");
    expect(result.replies.map((reply) => reply.id)).toEqual(["x"]);
  });

  it("unions overlapping SPA windows and keeps replies that leave the DOM", () => {
    const firstCapture = capture(1, "a", "spa", "document-1");
    firstCapture.replies.push({
      ...firstCapture.replies[0],
      id: "b",
      siteReplyId: "b",
      content: "B old",
      imageCount: 2,
      unexpandedNestedCount: 3,
    });
    const secondCapture = capture(1, "b", "spa", "document-1");
    secondCapture.replies[0] = {
      ...secondCapture.replies[0],
      content: "B new",
      imageCount: 4,
      unexpandedNestedCount: 1,
    };
    secondCapture.replies.push({
      ...secondCapture.replies[0],
      id: "c",
      siteReplyId: "c",
      content: "C",
      imageCount: 2,
      unexpandedNestedCount: 2,
    });

    const first = mergeCapture(null, firstCapture, 7);
    const result = mergeCapture(first, secondCapture, 7);

    expect(result.replies.map((reply) => reply.id)).toEqual(["a", "b", "c"]);
    expect(result.replies.find((reply) => reply.id === "b")?.content).toBe(
      "B new",
    );
    expect(result.coverage.visibleReplyCount).toBe(3);
    expect(result.coverage.imageCount).toBe(7);
    expect(result.coverage.unexpandedLzlCount).toBe(3);
    expect(result.coverage.declaredReplyCount).toBe(212);
    expect(result.coverage.captureMode).toBe("dynamic");
    expect(result.coverage.isComplete).toBe(false);
  });

  it("uses the official site id as the SPA replacement key", () => {
    const firstCapture = capture(1, "runtime-old", "spa", "document-1");
    firstCapture.replies[0].siteReplyId = "official-42";
    const secondCapture = capture(1, "runtime-new", "spa", "document-1");
    secondCapture.replies[0] = {
      ...secondCapture.replies[0],
      siteReplyId: "official-42",
      content: "站点同一回复的更新内容",
    };

    const first = mergeCapture(null, firstCapture, 7);
    const result = mergeCapture(first, secondCapture, 7);

    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]).toMatchObject({
      id: "runtime-new",
      siteReplyId: "official-42",
      content: "站点同一回复的更新内容",
    });
  });

  it("recomputes unique SPA coverage and deduplicates diagnostics", () => {
    const firstCapture = capture(1, "a", "spa", "document-1");
    firstCapture.replies[0].siteReplyId = null;
    firstCapture.replies[0].isNested = true;
    firstCapture.errors = ["一次错误"];
    firstCapture.warnings = ["同一提示"];
    const secondCapture = capture(1, "a", "spa", "document-1");
    secondCapture.replies[0].siteReplyId = null;
    secondCapture.replies[0].isNested = true;
    secondCapture.replies[0].imageCount = 5;
    secondCapture.errors = ["一次错误"];
    secondCapture.warnings = ["同一提示", "新增提示"];
    secondCapture.coverage.declaredReplyCount = null;
    secondCapture.coverage.reachedReplyListEnd = true;

    const first = mergeCapture(null, firstCapture, 7);
    const result = mergeCapture(first, secondCapture, 7);

    expect(result.replies).toHaveLength(1);
    expect(result.coverage.imageCount).toBe(5);
    expect(result.coverage.unstableReplyIdCount).toBe(1);
    expect(result.coverage.declaredReplyCount).toBe(212);
    expect(result.coverage.reachedReplyListEnd).toBe(true);
    expect(result.coverage.dynamicContentMayRemain).toBe(false);
    expect(result.errors).toEqual(["一次错误"]);
    expect(result.warnings).toEqual([
      "同一提示",
      "新增提示",
      "检测到 5 张图片；当前版本不识别图片文字。",
      "1 条回复没有网站稳定 ID，动态去重与跳转可能不完整。",
    ]);
  });

  it("replaces stale SPA coverage warnings with one current aggregate", () => {
    const firstCapture = capture(1, "a", "spa", "document-1");
    firstCapture.replies[0].isNested = true;
    firstCapture.replies[0].siteReplyId = null;
    firstCapture.replies[0].imageCount = 1;
    firstCapture.warnings = [
      "14 条回复没有网站稳定 ID，动态去重与跳转可能不完整。",
      "检测到 1 张图片；当前版本不识别图片文字。",
    ];
    const secondCapture = capture(1, "b", "spa", "document-1");
    secondCapture.replies[0].isNested = true;
    secondCapture.replies[0].siteReplyId = null;
    secondCapture.replies[0].imageCount = 0;
    secondCapture.replies[0].unexpandedNestedCount = 3;
    secondCapture.warnings = [
      "15 条回复没有网站稳定 ID，动态去重与跳转可能不完整。",
      "估计仍有 3 条楼中楼回复未展开。",
      "新版页面使用动态列表；本次只分析已挂载内容，继续滚动或展开后可补充采集。",
    ];

    const first = mergeCapture(null, firstCapture, 7);
    const result = mergeCapture(first, secondCapture, 7);

    expect(result.warnings).toEqual([
      "新版页面使用动态列表；本次只分析已挂载内容，继续滚动或展开后可补充采集。",
      "检测到 1 张图片；当前版本不识别图片文字。",
      "2 条回复没有网站稳定 ID，动态去重与跳转可能不完整。",
    ]);
    expect(result.warnings.join(" ")).not.toMatch(/14 条|15 条/u);
  });

  it("does not count the deterministic SPA first-floor fallback as unstable", () => {
    const spaCapture = capture(1, "123-first-floor", "spa", "document-1");
    spaCapture.replies[0] = {
      ...spaCapture.replies[0],
      siteReplyId: null,
      isNested: false,
    };
    spaCapture.replies.push({
      ...spaCapture.replies[0],
      id: "kr-lzl-runtime",
      parentReplyId: "123-first-floor",
      isNested: true,
    });

    const result = mergeCapture(null, spaCapture, 7);

    expect(result.coverage.unstableReplyIdCount).toBe(1);
  });

  it("uses the latest SPA end marker instead of retaining a stale one", () => {
    const atEnd = capture(1, "a", "spa", "document-1");
    atEnd.coverage.reachedReplyListEnd = true;
    atEnd.coverage.dynamicContentMayRemain = false;
    const afterListChanges = capture(1, "b", "spa", "document-1");

    const first = mergeCapture(null, atEnd, 7);
    const result = mergeCapture(first, afterListChanges, 7);

    expect(result.coverage.reachedReplyListEnd).toBe(false);
    expect(result.coverage.dynamicContentMayRemain).toBe(true);
  });

  it("resets SPA accumulation when the document instance changes", () => {
    const first = mergeCapture(null, capture(1, "a", "spa", "document-1"), 7);
    const reloaded = mergeCapture(
      first,
      capture(1, "b", "spa", "document-2"),
      7,
    );

    expect(reloaded.replies.map((reply) => reply.id)).toEqual(["b"]);
    expect(reloaded.pages.spa.documentInstanceId).toBe("document-2");
  });

  it("resets SPA accumulation when no document identity is available", () => {
    const first = mergeCapture(null, capture(1, "a", "spa", null), 7);
    const next = mergeCapture(first, capture(1, "b", "spa", null), 7);

    expect(next.replies.map((reply) => reply.id)).toEqual(["b"]);
  });

  it("resets accumulated pages when the parser mode changes", () => {
    const legacy = mergeCapture(null, capture(1, "a"), 7);
    const spa = mergeCapture(legacy, capture(1, "b", "spa", "document-1"), 7);
    const backToLegacy = mergeCapture(spa, capture(2, "c"), 7);

    expect(spa.replies.map((reply) => reply.id)).toEqual(["b"]);
    expect(backToLegacy.replies.map((reply) => reply.id)).toEqual(["c"]);
  });

  it("atomically replaces DOM windows with one reconciled API snapshot", () => {
    const first = mergeCapture(null, capture(1, "legacy-a"), 7);
    const paged = mergeCapture(first, capture(2, "legacy-b"), 7);
    const api = apiCapture();

    const result = mergeCapture(paged, api, 7);

    expect(Object.keys(result.pages)).toEqual(["api"]);
    expect(result.replies.map((reply) => reply.id)).toEqual(["api-main"]);
    expect(result.coverage).toMatchObject({
      captureMode: "api",
      apiCoverage: {
        mainPagesFetched: 1,
        mainPagesTotal: 1,
        readableTextComplete: true,
      },
    });
  });

  it("never lets a same-thread DOM mutation downgrade an API snapshot", () => {
    const api = mergeCapture(null, apiCapture(), 7);
    const mountedWindow = capture(1, "spa-only-row", "spa", "document-2");

    const result = mergeCapture(api, mountedWindow, 7);

    expect(result).toBe(api);
    expect(result.coverage.captureMode).toBe("api");
    expect(result.replies.map((reply) => reply.id)).toEqual(["api-main"]);
  });

  it("keeps a main reply and nested reply when Tieba gives them the same numeric id", () => {
    const api = apiCapture("42");
    api.replies.push({
      ...api.replies[0],
      id: "42",
      siteReplyId: "42",
      parentReplyId: "42",
      isNested: true,
      content: "同号楼中楼",
    });
    api.coverage.visibleReplyCount = 2;
    api.coverage.nestedReplyCount = 1;
    api.coverage.apiCoverage!.nestedRepliesFetched = 1;
    api.coverage.apiCoverage!.nestedRepliesDeclared = 1;

    const result = mergeCapture(null, api, 7);

    expect(result.replies).toHaveLength(2);
    expect(result.replies.map((reply) => reply.isNested)).toEqual([
      false,
      true,
    ]);
  });

  it("merges a 500-reply dynamic window in under 3 seconds", () => {
    const firstCapture = capture(1, "reply-0", "spa", "document-1");
    const secondCapture = capture(1, "reply-200", "spa", "document-1");
    const template = firstCapture.replies[0]!;
    firstCapture.replies = Array.from({ length: 300 }, (_, index) => ({
      ...template,
      id: `reply-${index}`,
      siteReplyId: `site-${index}`,
      floor: index + 2,
      content: `脱敏测试回复 ${index}`,
    }));
    secondCapture.replies = Array.from({ length: 300 }, (_, offset) => {
      const index = offset + 200;
      return {
        ...template,
        id: `reply-${index}`,
        siteReplyId: `site-${index}`,
        floor: index + 2,
        content: `更新后的脱敏测试回复 ${index}`,
      };
    });

    const startedAt = performance.now();
    const first = mergeCapture(null, firstCapture, 7);
    const result = mergeCapture(first, secondCapture, 7);
    const elapsed = performance.now() - startedAt;

    expect(result.replies).toHaveLength(500);
    expect(result.replies.find((reply) => reply.id === "reply-200")?.content)
      .toBe("更新后的脱敏测试回复 200");
    expect(elapsed).toBeLessThan(3_000);
  });
});

describe("isSameThreadUrl", () => {
  it("allows pagination inside the reviewed thread only", () => {
    const session = mergeCapture(null, capture(1, "a"), 7);

    expect(isSameThreadUrl(session, "https://tieba.baidu.com/p/123?pn=8")).toBe(
      true,
    );
    expect(isSameThreadUrl(session, "https://tieba.baidu.com/p/999?pn=2")).toBe(
      false,
    );
    expect(isSameThreadUrl(session, "https://example.com/p/123?pn=2")).toBe(
      false,
    );
    expect(isSameThreadUrl(session, undefined)).toBe(false);
  });

  it("recognizes only real Tieba thread URLs", () => {
    expect(tiebaThreadIdFromUrl("https://tieba.baidu.com/p/123?pn=2")).toBe(
      "123",
    );
    expect(tiebaThreadIdFromUrl("https://example.com/p/123")).toBeNull();
    expect(tiebaThreadIdFromUrl("https://m.tieba.baidu.com/p/123")).toBeNull();
    expect(tiebaThreadIdFromUrl("http://tieba.baidu.com/p/123")).toBeNull();
    expect(tiebaThreadIdFromUrl(undefined)).toBeNull();
  });

  it("distinguishes an unavailable URL from a confirmed navigation", () => {
    const session = mergeCapture(null, capture(1, "a"), 7);

    expect(classifySessionUrl(session, null)).toBe("unknown");
    expect(
      classifySessionUrl(session, "https://tieba.baidu.com/p/123?pn=9"),
    ).toBe("same");
    expect(classifySessionUrl(session, "https://tieba.baidu.com/p/999")).toBe(
      "different",
    );
    expect(
      classifySessionUrl(session, "https://tieba.baidu.com.evil/p/123"),
    ).toBe("different");
  });
});
