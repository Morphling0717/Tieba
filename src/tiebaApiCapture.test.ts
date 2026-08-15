import { describe, expect, it } from "vitest";
import { TiebaApiError } from "./lib/tiebaApi";
import type { CapturedReply } from "./types";
import {
  captureTiebaThread,
  type TiebaApiCaptureOptions,
  type TiebaNestedPageProjection,
  type TiebaNestedParseContext,
} from "./tiebaApiCapture";

const THREAD_ID = "99000000001";
const THREAD_URL = `https://tieba.baidu.com/p/${THREAD_ID}`;

interface MainPostInput {
  id: string;
  floor: number;
  text?: string;
  nestedDeclared?: number;
  previews?: Array<{ id: string; text: string }>;
  image?: boolean;
}

function mainPost(input: MainPostInput): Record<string, unknown> {
  return {
    id: input.id,
    floor: input.floor,
    author_id: `u-${input.id}`,
    time: 1_750_000_000 + input.floor,
    content: input.image
      ? [
          { type: 0, text: input.text ?? `正文 ${input.id}` },
          { type: 3, origin_src: "https://example.invalid/image.jpg" },
        ]
      : [{ type: 0, text: input.text ?? `正文 ${input.id}` }],
    sub_post_number: input.nestedDeclared ?? 0,
    sub_post_list: {
      sub_post_list: (input.previews ?? []).map((preview, index) => ({
        id: preview.id,
        author_id: `preview-${index}`,
        time: 1_750_000_100 + index,
        content: [{ type: 0, text: preview.text }],
      })),
    },
  };
}

function pageBody(input: {
  page: number;
  totalPages: number;
  declaredReplyCount: number;
  firstFloor?: MainPostInput;
  posts?: MainPostInput[];
}): string {
  const users = [
    ...(input.firstFloor ? [input.firstFloor] : []),
    ...(input.posts ?? []),
  ].flatMap((post) => [
    { id: `u-${post.id}`, name_show: `用户 ${post.id}` },
    ...(post.previews ?? []).map((_, index) => ({
      id: `preview-${index}`,
      name_show: `楼中楼用户 ${index}`,
    })),
  ]);
  return JSON.stringify({
    error_code: "0",
    thread: {
      id: THREAD_ID,
      title: "整帖 API 测试",
      reply_num: input.declaredReplyCount,
    },
    forum: { id: "2048035" },
    page: {
      current_page: input.page,
      total_page: input.totalPages,
      has_more: input.page < input.totalPages ? 1 : 0,
    },
    first_floor: input.firstFloor
      ? { ...mainPost(input.firstFloor), tid: THREAD_ID }
      : undefined,
    post_list: (input.posts ?? []).map(mainPost),
    user_list: users,
  });
}

function nestedReply(
  id: string,
  context: TiebaNestedParseContext,
  content = `楼中楼 ${id}`,
): CapturedReply {
  return {
    id,
    siteReplyId: id,
    floor: context.parentFloor,
    parentReplyId: context.parentReplyId,
    authorName: `用户 ${id}`,
    time: "2026-07-28 12:00",
    timestamp: 1_753_700_000_000 + Number(id.slice(-3)),
    content,
    sourcePage: context.sourcePage,
    sourceUrl: context.sourceUrl,
    anchor: `[data-spid="${id}"]`,
    imageCount: 0,
    isNested: true,
    unexpandedNestedCount: 0,
  };
}

type NestedFactory = (
  context: TiebaNestedParseContext,
) => TiebaNestedPageProjection | Promise<TiebaNestedPageProjection>;

function requestKey(
  request: Parameters<TiebaApiCaptureOptions["request"]>[0],
): string {
  if (request.endpoint === "/c/s/pc/sync") return "sync";
  if (request.endpoint === "/c/f/pb/page_pc") {
    return `main:${new URLSearchParams(request.body).get("pn")}`;
  }
  const url = new URL(request.url);
  return `nested:${url.searchParams.get("pid")}:${url.searchParams.get("pn")}`;
}

function harness(input: {
  pages: Record<number, string>;
  nested?: Record<string, NestedFactory>;
  fail?: Set<string>;
  delayMs?: number;
  checkpoint?: () => Promise<void>;
}): {
  options: TiebaApiCaptureOptions;
  calls: string[];
  maxConcurrent: () => number;
  contexts: TiebaNestedParseContext[];
} {
  const calls: string[] = [];
  const contexts: TiebaNestedParseContext[] = [];
  let active = 0;
  let maxActive = 0;

  return {
    calls,
    contexts,
    maxConcurrent: () => maxActive,
    options: {
      threadId: THREAD_ID,
      threadUrl: THREAD_URL,
      checkpoint: input.checkpoint ?? (async () => undefined),
      now: () => new Date("2026-07-28T12:00:00.000Z"),
      request: async (request) => {
        const key = requestKey(request);
        calls.push(key);
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          if (input.delayMs) {
            await new Promise((resolve) => setTimeout(resolve, input.delayMs));
          }
          if (input.fail?.has(key)) throw new Error(`模拟失败 ${key}`);
          if (key === "sync") {
            return JSON.stringify({
              error_code: "0",
              data: { anti: { tbs: "abcdefgh12345678" } },
            });
          }
          if (key.startsWith("main:")) {
            const page = Number(key.slice("main:".length));
            const body = input.pages[page];
            if (!body) throw new Error(`缺少主回复 fixture ${page}`);
            return body;
          }
          return key;
        } finally {
          active -= 1;
        }
      },
      parseNested: async (body, context) => {
        contexts.push(context);
        const factory = input.nested?.[body];
        if (!factory) throw new Error(`缺少楼中楼 fixture ${body}`);
        return factory(context);
      },
    },
  };
}

function nestedPage(
  context: TiebaNestedParseContext,
  input: {
    ids: string[];
    page: number;
    totalPages: number;
    totalNum: number;
    contents?: Record<string, string>;
    unparsedReplyCount?: number;
  },
): TiebaNestedPageProjection {
  return {
    threadId: context.threadId,
    parentReplyId: context.parentReplyId,
    parentSiteReplyId: context.parentSiteReplyId,
    currentPage: input.page,
    totalPages: input.totalPages,
    totalNum: input.totalNum,
    hasMore: input.page < input.totalPages,
    replies: input.ids.map((id) =>
      nestedReply(id, context, input.contents?.[id]),
    ),
    unparsedReplyCount: input.unparsedReplyCount ?? 0,
  };
}

describe("captureTiebaThread", () => {
  it("reads all main and nested pages with concurrency 3 and deduplicates previews by spid", async () => {
    let checkpoints = 0;
    const pages: Record<number, string> = {
      1: pageBody({
        page: 1,
        totalPages: 5,
        declaredReplyCount: 11,
        firstFloor: { id: "100", floor: 1 },
        posts: [
          {
            id: "101",
            floor: 2,
            nestedDeclared: 2,
            previews: [{ id: "1001", text: "旧预览" }],
          },
        ],
      }),
      2: pageBody({
        page: 2,
        totalPages: 5,
        declaredReplyCount: 11,
        posts: [
          { id: "102", floor: 3, nestedDeclared: 1 },
          { id: "103", floor: 4 },
        ],
      }),
      3: pageBody({
        page: 3,
        totalPages: 5,
        declaredReplyCount: 11,
        posts: [{ id: "104", floor: 5, nestedDeclared: 1 }],
      }),
      4: pageBody({
        page: 4,
        totalPages: 5,
        declaredReplyCount: 11,
        posts: [{ id: "105", floor: 6, nestedDeclared: 1 }],
      }),
      5: pageBody({
        page: 5,
        totalPages: 5,
        declaredReplyCount: 11,
        posts: [{ id: "106", floor: 7 }],
      }),
    };
    const test = harness({
      pages,
      delayMs: 2,
      checkpoint: async () => {
        checkpoints += 1;
      },
      nested: {
        "nested:101:1": (context) =>
          nestedPage(context, {
            ids: ["1001"],
            page: 1,
            totalPages: 2,
            totalNum: 2,
            contents: { "1001": "全量结果覆盖预览" },
          }),
        "nested:101:2": (context) =>
          nestedPage(context, {
            ids: ["1002"],
            page: 2,
            totalPages: 2,
            totalNum: 2,
          }),
        "nested:102:1": (context) =>
          nestedPage(context, {
            ids: ["1003"],
            page: 1,
            totalPages: 1,
            totalNum: 1,
          }),
        "nested:104:1": (context) =>
          nestedPage(context, {
            ids: ["1004"],
            page: 1,
            totalPages: 1,
            totalNum: 1,
          }),
        "nested:105:1": (context) =>
          nestedPage(context, {
            ids: ["1005"],
            page: 1,
            totalPages: 1,
            totalNum: 1,
          }),
      },
    });

    const result = await captureTiebaThread(test.options);

    expect(result.parserVariant).toBe("api");
    expect(result.coverage.captureMode).toBe("api");
    expect(result.coverage.mainReplyCount).toBe(7);
    expect(result.coverage.nestedReplyCount).toBe(5);
    expect(result.replies).toHaveLength(12);
    expect(
      result.replies.find((reply) => reply.siteReplyId === "1001")?.content,
    ).toBe("全量结果覆盖预览");
    expect(
      result.replies
        .filter((reply) => !reply.isNested)
        .map((reply) => reply.unexpandedNestedCount),
    ).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(result.coverage.apiCoverage).toEqual({
      mainPagesFetched: 5,
      mainPagesTotal: 5,
      mainRepliesFetched: 7,
      nestedParentsFetched: 4,
      nestedParentsTotal: 4,
      nestedRepliesFetched: 5,
      nestedRepliesDeclared: 5,
      failedRequestCount: 0,
      unavailableReplyCount: 0,
      readableTextComplete: true,
    });
    expect(result.coverage.isComplete).toBe(true);
    expect(test.maxConcurrent()).toBe(3);
    expect(test.calls.filter((key) => key === "nested:101:1")).toHaveLength(1);
    expect(checkpoints).toBe(test.calls.length * 2);
    expect(test.contexts.every((context) => context.forumId === "2048035")).toBe(
      true,
    );
  });

  it("keeps partial results after a later main-page failure without retrying", async () => {
    const test = harness({
      pages: {
        1: pageBody({
          page: 1,
          totalPages: 3,
          declaredReplyCount: 2,
          firstFloor: { id: "100", floor: 1 },
        }),
        3: pageBody({
          page: 3,
          totalPages: 3,
          declaredReplyCount: 2,
          posts: [{ id: "103", floor: 3 }],
        }),
      },
      fail: new Set(["main:2"]),
    });

    const result = await captureTiebaThread(test.options);

    expect(result.replies.map((reply) => reply.id)).toEqual(["100", "103"]);
    expect(result.coverage.apiCoverage).toMatchObject({
      mainPagesFetched: 2,
      mainPagesTotal: 3,
      failedRequestCount: 1,
      readableTextComplete: false,
    });
    expect(result.coverage.isComplete).toBe(false);
    expect(result.errors.join("\n")).toContain("第 2/3 页失败");
    expect(test.calls.filter((key) => key === "main:2")).toHaveLength(1);
  });

  it("throws TiebaApiError when synchronization or the first page fails", async () => {
    const syncFailure = harness({
      pages: {},
      fail: new Set(["sync"]),
    });
    await expect(captureTiebaThread(syncFailure.options)).rejects.toBeInstanceOf(
      TiebaApiError,
    );

    const firstPageFailure = harness({
      pages: {},
      fail: new Set(["main:1"]),
    });
    await expect(
      captureTiebaThread(firstPageFailure.options),
    ).rejects.toMatchObject({
      name: "TiebaApiError",
      code: "REMOTE_ERROR",
    });
    expect(firstPageFailure.calls.filter((key) => key === "main:1")).toHaveLength(
      1,
    );
  });

  it("cancels immediately when a post-request checkpoint rejects", async () => {
    let checkpoints = 0;
    const test = harness({
      pages: {
        1: pageBody({
          page: 1,
          totalPages: 1,
          declaredReplyCount: 0,
          firstFloor: { id: "100", floor: 1 },
        }),
      },
      checkpoint: async () => {
        checkpoints += 1;
        if (checkpoints === 4) throw new Error("SESSION_STALE");
      },
    });

    await expect(captureTiebaThread(test.options)).rejects.toMatchObject({
      name: "AbortError",
      message: "SESSION_STALE",
    });
    expect(test.calls).toEqual(["sync", "main:1"]);
  });

  it("reports hard-limit truncation as an error instead of claiming completeness", async () => {
    const test = harness({
      pages: {
        1: pageBody({
          page: 1,
          totalPages: 3,
          declaredReplyCount: 2,
          firstFloor: { id: "100", floor: 1 },
        }),
        2: pageBody({
          page: 2,
          totalPages: 3,
          declaredReplyCount: 2,
          posts: [{ id: "102", floor: 2 }],
        }),
      },
    });
    test.options.limits = { mainPages: 2 };

    const result = await captureTiebaThread(test.options);

    expect(test.calls).not.toContain("main:3");
    expect(result.errors.join("\n")).toContain("超过安全上限 2 页");
    expect(result.coverage.apiCoverage).toMatchObject({
      mainPagesFetched: 2,
      mainPagesTotal: 3,
      failedRequestCount: 0,
      readableTextComplete: false,
    });
    expect(result.coverage.isComplete).toBe(false);
  });

  it("keeps a declared nested-reply gap visible when p/comment returns no replies", async () => {
    const test = harness({
      pages: {
        1: pageBody({
          page: 1,
          totalPages: 1,
          declaredReplyCount: 2,
          firstFloor: { id: "100", floor: 1 },
          posts: [{ id: "101", floor: 2, nestedDeclared: 1 }],
        }),
      },
      nested: {
        "nested:101:1": (context) =>
          nestedPage(context, {
            ids: [],
            page: 1,
            totalPages: 1,
            totalNum: 1,
          }),
      },
    });

    const result = await captureTiebaThread(test.options);

    expect(result.coverage.unexpandedLzlCount).toBe(1);
    expect(result.coverage.apiCoverage).toMatchObject({
      nestedRepliesFetched: 0,
      nestedRepliesDeclared: 1,
      unavailableReplyCount: 1,
      readableTextComplete: false,
    });
    expect(
      result.replies.find((reply) => reply.id === "101")
        ?.unexpandedNestedCount,
    ).toBe(1);
    expect(result.warnings.join("\n")).toContain("仍缺 1 条");
    expect(result.coverage.isComplete).toBe(false);
  });

  it("separates complete readable text from unanalyzed image content", async () => {
    const test = harness({
      pages: {
        1: pageBody({
          page: 1,
          totalPages: 1,
          declaredReplyCount: 0,
          firstFloor: { id: "100", floor: 1, image: true },
        }),
      },
    });

    const result = await captureTiebaThread(test.options);

    expect(result.coverage.apiCoverage?.readableTextComplete).toBe(true);
    expect(result.coverage.hasUnanalyzedImages).toBe(true);
    expect(result.coverage.isComplete).toBe(false);
  });

  it("parses and reconciles 500 text replies well below the 3 second target", async () => {
    const posts = Array.from({ length: 499 }, (_, index) => ({
      id: String(10_001 + index),
      floor: index + 2,
      text: `第 ${index + 2} 楼的普通讨论内容`,
    }));
    const test = harness({
      pages: {
        1: pageBody({
          page: 1,
          totalPages: 1,
          declaredReplyCount: 499,
          firstFloor: { id: "10000", floor: 1 },
          posts,
        }),
      },
    });

    const startedAt = performance.now();
    const result = await captureTiebaThread(test.options);
    const elapsed = performance.now() - startedAt;

    expect(result.replies).toHaveLength(500);
    expect(result.coverage.isComplete).toBe(true);
    expect(elapsed).toBeLessThan(3_000);
  });
});
