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
  hasMore?: boolean;
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
      has_more: (input.hasMore ?? input.page < input.totalPages) ? 1 : 0,
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
  maxNestedConcurrent: () => number;
  contexts: TiebaNestedParseContext[];
} {
  const calls: string[] = [];
  const contexts: TiebaNestedParseContext[] = [];
  let active = 0;
  let maxActive = 0;
  let nestedActive = 0;
  let maxNestedActive = 0;

  return {
    calls,
    contexts,
    maxConcurrent: () => maxActive,
    maxNestedConcurrent: () => maxNestedActive,
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
        const isNestedRequest = key.startsWith("nested:");
        if (isNestedRequest) {
          nestedActive += 1;
          maxNestedActive = Math.max(maxNestedActive, nestedActive);
        }
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
          if (isNestedRequest) nestedActive -= 1;
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
    duplicateStableIdCount?: number;
    unknownStructureCount?: number;
    rawReplyNodeCount?: number;
    stableReplyOccurrenceCount?: number;
    hasTrustedPager?: boolean;
    isOutOfRangeEmptyProbe?: boolean;
  },
): TiebaNestedPageProjection {
  const unparsedReplyCount = input.unparsedReplyCount ?? 0;
  const duplicateStableIdCount = input.duplicateStableIdCount ?? 0;
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
    rawReplyNodeCount:
      input.rawReplyNodeCount ??
      input.ids.length + duplicateStableIdCount + unparsedReplyCount,
    stableReplyOccurrenceCount:
      input.stableReplyOccurrenceCount ??
      input.ids.length + duplicateStableIdCount,
    duplicateStableIdCount,
    unparsedReplyCount,
    unknownStructureCount: input.unknownStructureCount ?? 0,
    hasTrustedPager: input.hasTrustedPager ?? true,
    isOutOfRangeEmptyProbe: input.isOutOfRangeEmptyProbe ?? false,
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

  it("blocks readable completeness for invalid and repeated ids within one page_pc page", async () => {
    const test = harness({
      pages: {
        1: pageBody({
          page: 1,
          totalPages: 1,
          declaredReplyCount: 1,
          firstFloor: { id: "100", floor: 1 },
          posts: [
            { id: "101", floor: 2 },
            { id: "101", floor: 2 },
            { id: "invalid-id", floor: 3 },
          ],
        }),
      },
    });

    const result = await captureTiebaThread(test.options);

    expect(result.coverage.mainReplyCount).toBe(2);
    expect(result.coverage.apiCoverage?.readableTextComplete).toBe(false);
    expect(result.coverage.isComplete).toBe(false);
    expect(result.warnings.join("\n")).toContain("主回复或楼中楼预览节点缺少稳定 ID");
    expect(result.warnings.join("\n")).toContain("单页出现 1 次稳定 ID 重复");
  });

  it("blocks readable completeness when a stable page_pc id repeats across pages", async () => {
    const test = harness({
      pages: {
        1: pageBody({
          page: 1,
          totalPages: 2,
          declaredReplyCount: 2,
          firstFloor: { id: "100", floor: 1 },
          posts: [{ id: "101", floor: 2 }],
        }),
        2: pageBody({
          page: 2,
          totalPages: 2,
          declaredReplyCount: 2,
          posts: [
            { id: "101", floor: 2 },
            { id: "102", floor: 3 },
          ],
        }),
      },
    });

    const result = await captureTiebaThread(test.options);

    expect(result.coverage.mainReplyCount).toBe(3);
    expect(result.coverage.apiCoverage?.readableTextComplete).toBe(false);
    expect(result.coverage.isComplete).toBe(false);
    expect(result.warnings.join("\n")).toContain("跨页出现 1 次稳定 ID 重复");
  });

  it("fails closed when page_pc omits reply_num", async () => {
    const missingReplyNum = JSON.parse(
      pageBody({
        page: 1,
        totalPages: 1,
        declaredReplyCount: 1,
        firstFloor: { id: "100", floor: 1 },
        posts: [{ id: "101", floor: 2 }],
      }),
    ) as { thread: Record<string, unknown> };
    delete missingReplyNum.thread.reply_num;
    const test = harness({
      pages: { 1: JSON.stringify(missingReplyNum) },
    });

    const result = await captureTiebaThread(test.options);

    expect(result.coverage.declaredReplyCount).toBeNull();
    expect(result.coverage.apiCoverage?.readableTextComplete).toBe(false);
    expect(result.coverage.isComplete).toBe(false);
    expect(result.warnings.join("\n")).toContain("缺少 reply_num");
  });

  it("reconciles a 148-reply moving frontier and only expands incomplete nested previews", async () => {
    const nested: Record<string, NestedFactory> = {};
    let nextNestedId = 200_000;
    const posts = Array.from({ length: 58 }, (_, index): MainPostInput => ({
      id: String(1_002 + index),
      floor: index + 2,
    }));

    for (let index = 0; index < 16; index += 1) {
      const post = posts[index]!;
      const declared = index < 10 ? 5 : index < 14 ? 7 : 6;
      post.nestedDeclared = declared;
      const ids = Array.from({ length: declared }, () =>
        String(nextNestedId++),
      );
      if (index < 10) {
        post.previews = ids.map((id) => ({ id, text: `完整预览 ${id}` }));
      } else {
        nested[`nested:${post.id}:1`] = (context) =>
          nestedPage(context, {
            ids,
            page: 1,
            totalPages: 1,
            totalNum: declared,
          });
      }
    }

    const test = harness({
      pages: {
        1: pageBody({
          page: 1,
          // Simulates a stale first response: has_more is the lower bound that
          // proves page 2 exists even though total_page still says 1.
          totalPages: 1,
          hasMore: true,
          declaredReplyCount: 148,
          firstFloor: { id: "1001", floor: 1 },
          posts: posts.slice(0, 14),
        }),
        2: pageBody({
          page: 2,
          totalPages: 4,
          declaredReplyCount: 148,
          posts: posts.slice(14, 29),
        }),
        3: pageBody({
          page: 3,
          totalPages: 4,
          declaredReplyCount: 148,
          posts: posts.slice(29, 44),
        }),
        4: pageBody({
          page: 4,
          totalPages: 4,
          declaredReplyCount: 148,
          posts: posts.slice(44),
        }),
      },
      nested,
      delayMs: 1,
    });

    const result = await captureTiebaThread(test.options);

    expect(result.coverage.mainReplyCount).toBe(59);
    expect(result.coverage.nestedReplyCount).toBe(90);
    expect(result.coverage.apiCoverage).toEqual({
      mainPagesFetched: 4,
      mainPagesTotal: 4,
      mainRepliesFetched: 59,
      nestedParentsFetched: 16,
      nestedParentsTotal: 16,
      nestedRepliesFetched: 90,
      nestedRepliesDeclared: 90,
      failedRequestCount: 0,
      unavailableReplyCount: 0,
      readableTextComplete: true,
    });
    expect(result.coverage.isComplete).toBe(true);
    expect(test.calls.filter((key) => key.startsWith("nested:"))).toHaveLength(
      6,
    );
    expect(test.maxNestedConcurrent()).toBe(1);
    expect(test.calls).toEqual(
      expect.arrayContaining(["main:1", "main:2", "main:3", "main:4"]),
    );
  });

  it("classifies the verified 33-parent 94/99 case as a non-blocking endpoint count gap", async () => {
    let nextNestedId = 300_000;
    const posts = Array.from({ length: 33 }, (_, index): MainPostInput => ({
      id: String(101 + index),
      floor: index + 2,
    }));

    // The 32 ordinary parents are exact in page_pc: 25 * 3 + 7 * 2 = 89.
    for (let index = 0; index < 32; index += 1) {
      const post = posts[index]!;
      const declared = index < 25 ? 3 : 2;
      post.nestedDeclared = declared;
      post.previews = Array.from({ length: declared }, () => {
        const id = String(nextNestedId++);
        return { id, text: `完整预览 ${id}` };
      });
    }

    // The real-world equivalent: pager says 10/1, while the terminal page has
    // five unique stable SPIDs and no duplicate, unknown or unparsed node.
    const exceptional = posts[32]!;
    exceptional.nestedDeclared = 10;
    const exceptionalIds = Array.from({ length: 5 }, () =>
      String(nextNestedId++),
    );
    const test = harness({
      pages: {
        1: pageBody({
          page: 1,
          totalPages: 1,
          // 33 main replies + 99 nested replies, excluding the first floor.
          declaredReplyCount: 132,
          firstFloor: { id: "100", floor: 1 },
          posts,
        }),
      },
      nested: {
        [`nested:${exceptional.id}:1`]: (context) =>
          nestedPage(context, {
            ids: exceptionalIds,
            page: 1,
            totalPages: 1,
            totalNum: 10,
          }),
        [`nested:${exceptional.id}:2`]: (context) =>
          nestedPage(context, {
            ids: [],
            page: 2,
            totalPages: 0,
            totalNum: 0,
            hasTrustedPager: false,
            isOutOfRangeEmptyProbe: true,
          }),
      },
    });
    const progress: Array<{
      phase: string;
      completed: number;
      total: number;
    }> = [];
    test.options.onProgress = (event) => progress.push(event);

    const result = await captureTiebaThread(test.options);

    expect(result.coverage.mainReplyCount).toBe(34);
    expect(result.coverage.nestedReplyCount).toBe(94);
    expect(result.coverage.unexpandedLzlCount).toBe(0);
    expect(result.coverage.apiCoverage).toEqual({
      mainPagesFetched: 1,
      mainPagesTotal: 1,
      mainRepliesFetched: 34,
      nestedParentsFetched: 33,
      nestedParentsTotal: 33,
      nestedRepliesFetched: 94,
      nestedRepliesDeclared: 99,
      failedRequestCount: 0,
      unavailableReplyCount: 5,
      readableTextComplete: true,
    });
    expect(result.coverage.isComplete).toBe(false);
    expect(result.warnings.join("\n")).toContain("5 条端点计数差额");
    expect(test.calls.filter((key) => key.startsWith("nested:"))).toEqual([
      `nested:${exceptional.id}:1`,
      `nested:${exceptional.id}:2`,
    ]);
    expect(test.contexts.at(-1)?.allowOutOfRangeEmptyProbe).toBe(true);
    expect(progress).toEqual(
      expect.arrayContaining([
        { phase: "nested", completed: 32, total: 34 },
        { phase: "nested", completed: 33, total: 34 },
        { phase: "nested", completed: 34, total: 34 },
      ]),
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

  it("reports a terminal declared-count gap without blocking readable API text", async () => {
    const test = harness({
      pages: {
        1: pageBody({
          page: 1,
          totalPages: 1,
          declaredReplyCount: 2,
          firstFloor: { id: "100", floor: 1 },
          posts: [
            {
              id: "101",
              floor: 2,
              nestedDeclared: 2,
              previews: [{ id: "1999", text: "已过时的预览" }],
            },
          ],
        }),
      },
      nested: {
        "nested:101:1": (context) =>
          nestedPage(context, {
            ids: ["1001"],
            page: 1,
            totalPages: 1,
            totalNum: 1,
          }),
      },
    });

    const result = await captureTiebaThread(test.options);

    expect(result.coverage.unexpandedLzlCount).toBe(0);
    expect(result.coverage.apiCoverage).toMatchObject({
      nestedRepliesFetched: 1,
      nestedRepliesDeclared: 1,
      unavailableReplyCount: 1,
      readableTextComplete: true,
    });
    expect(
      result.replies.find((reply) => reply.id === "101")
        ?.unexpandedNestedCount,
    ).toBe(0);
    expect(result.replies.some((reply) => reply.id === "1999")).toBe(false);
    expect(result.warnings.join("\n")).toContain("逐楼对账仍有 1 条差额");
    expect(result.coverage.isComplete).toBe(false);
  });

  it("does not let new replies on one parent hide a stale declaration gap on another", async () => {
    const test = harness({
      pages: {
        1: pageBody({
          page: 1,
          totalPages: 1,
          declaredReplyCount: 4,
          firstFloor: { id: "100", floor: 1 },
          posts: [
            { id: "101", floor: 2, nestedDeclared: 1 },
            { id: "102", floor: 3, nestedDeclared: 1 },
          ],
        }),
      },
      nested: {
        "nested:101:1": (context) =>
          nestedPage(context, {
            ids: ["1001", "1002"],
            page: 1,
            totalPages: 1,
            totalNum: 2,
          }),
        "nested:102:1": (context) =>
          nestedPage(context, {
            ids: [],
            page: 1,
            totalPages: 1,
            totalNum: 0,
          }),
      },
    });

    const result = await captureTiebaThread(test.options);

    expect(result.coverage.apiCoverage).toMatchObject({
      nestedRepliesFetched: 2,
      nestedRepliesDeclared: 2,
      unavailableReplyCount: 1,
      readableTextComplete: true,
    });
    expect(result.warnings.join("\n")).toContain("逐楼对账仍有 1 条差额");
    expect(result.coverage.isComplete).toBe(false);
  });

  it("blocks a terminal pager gap when the overrun probe is not the exact empty sentinel", async () => {
    const test = harness({
      pages: {
        1: pageBody({
          page: 1,
          totalPages: 1,
          declaredReplyCount: 2,
          firstFloor: { id: "100", floor: 1 },
          posts: [{ id: "101", floor: 2, nestedDeclared: 2 }],
        }),
      },
      nested: {
        "nested:101:1": (context) =>
          nestedPage(context, {
            ids: ["1001"],
            page: 1,
            totalPages: 1,
            totalNum: 2,
          }),
        "nested:101:2": (context) =>
          nestedPage(context, {
            ids: ["1002"],
            page: 2,
            totalPages: 2,
            totalNum: 2,
          }),
      },
    });

    const result = await captureTiebaThread(test.options);

    expect(result.coverage.unexpandedLzlCount).toBe(1);
    expect(result.coverage.apiCoverage).toMatchObject({
      nestedRepliesFetched: 1,
      nestedRepliesDeclared: 2,
      unavailableReplyCount: 1,
      readableTextComplete: false,
    });
    expect(result.warnings.join("\n")).toContain("未通过空页哨兵验证");
    expect(result.errors.join("\n")).toContain("终页后探测返回了非空");
    expect(test.calls).toContain("nested:101:2");
    expect(result.coverage.isComplete).toBe(false);
  });

  it("keeps a terminal count gap blocking when its overrun probe request fails", async () => {
    const test = harness({
      pages: {
        1: pageBody({
          page: 1,
          totalPages: 1,
          declaredReplyCount: 2,
          firstFloor: { id: "100", floor: 1 },
          posts: [{ id: "101", floor: 2, nestedDeclared: 2 }],
        }),
      },
      nested: {
        "nested:101:1": (context) =>
          nestedPage(context, {
            ids: ["1001"],
            page: 1,
            totalPages: 1,
            totalNum: 2,
          }),
      },
      fail: new Set(["nested:101:2"]),
    });

    const result = await captureTiebaThread(test.options);

    expect(result.coverage.apiCoverage).toMatchObject({
      failedRequestCount: 1,
      readableTextComplete: false,
    });
    expect(result.errors.join("\n")).toContain("终页后探测失败");
    expect(test.calls).toContain("nested:101:2");
  });

  it("blocks readable completeness on a stable id repeated across nested pages", async () => {
    const test = harness({
      pages: {
        1: pageBody({
          page: 1,
          totalPages: 1,
          declaredReplyCount: 4,
          firstFloor: { id: "100", floor: 1 },
          posts: [{ id: "101", floor: 2, nestedDeclared: 3 }],
        }),
      },
      nested: {
        "nested:101:1": (context) =>
          nestedPage(context, {
            ids: ["1001", "1002"],
            page: 1,
            totalPages: 2,
            totalNum: 3,
          }),
        "nested:101:2": (context) =>
          nestedPage(context, {
            ids: ["1002", "1003"],
            page: 2,
            totalPages: 2,
            totalNum: 3,
          }),
      },
    });

    const result = await captureTiebaThread(test.options);

    expect(result.coverage.nestedReplyCount).toBe(3);
    expect(result.coverage.apiCoverage).toMatchObject({
      failedRequestCount: 0,
      readableTextComplete: false,
    });
    expect(result.warnings.join("\n")).toContain("稳定 ID 重复");
  });

  it("blocks readable completeness when trusted pager totals drift between pages", async () => {
    const test = harness({
      pages: {
        1: pageBody({
          page: 1,
          totalPages: 1,
          declaredReplyCount: 4,
          firstFloor: { id: "100", floor: 1 },
          posts: [{ id: "101", floor: 2, nestedDeclared: 3 }],
        }),
      },
      nested: {
        "nested:101:1": (context) =>
          nestedPage(context, {
            ids: ["1001", "1002"],
            page: 1,
            totalPages: 2,
            totalNum: 4,
          }),
        "nested:101:2": (context) =>
          nestedPage(context, {
            ids: ["1003"],
            page: 2,
            totalPages: 2,
            totalNum: 3,
          }),
      },
    });

    const result = await captureTiebaThread(test.options);

    expect(result.coverage.apiCoverage?.readableTextComplete).toBe(false);
    expect(result.warnings.join("\n")).toContain("分页总数发生漂移");
    expect(test.calls).not.toContain("nested:101:3");
  });

  it("blocks readable completeness when a nested page contains an unknown structure", async () => {
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
            ids: ["1001"],
            page: 1,
            totalPages: 1,
            totalNum: 1,
            unknownStructureCount: 1,
          }),
      },
    });

    const result = await captureTiebaThread(test.options);

    expect(result.coverage.apiCoverage?.readableTextComplete).toBe(false);
    expect(result.warnings.join("\n")).toContain("未识别的数据节点");
  });

  it("blocks readable completeness when a terminal nested node has no stable id", async () => {
    const test = harness({
      pages: {
        1: pageBody({
          page: 1,
          totalPages: 1,
          declaredReplyCount: 1,
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
            unparsedReplyCount: 1,
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
    expect(result.warnings.join("\n")).toContain("缺少稳定 ID");
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

  it("reports real body-free progress for sync, main, nested and coverage work", async () => {
    const test = harness({
      pages: {
        1: pageBody({
          page: 1,
          totalPages: 2,
          declaredReplyCount: 2,
          firstFloor: { id: "100", floor: 1 },
          posts: [{ id: "101", floor: 2, nestedDeclared: 1 }],
        }),
        2: pageBody({
          page: 2,
          totalPages: 2,
          declaredReplyCount: 2,
          posts: [{ id: "102", floor: 3 }],
        }),
      },
      nested: {
        "nested:101:1": (context) =>
          nestedPage(context, {
            ids: ["1001"],
            page: 1,
            totalPages: 1,
            totalNum: 1,
          }),
      },
    });
    const progress: Array<{
      phase: string;
      completed: number;
      total: number;
    }> = [];
    test.options.onProgress = (event) => progress.push(event);

    await captureTiebaThread(test.options);

    expect(progress).toEqual([
      { phase: "sync", completed: 0, total: 1 },
      { phase: "sync", completed: 1, total: 1 },
      { phase: "main", completed: 0, total: 1 },
      { phase: "main", completed: 1, total: 2 },
      { phase: "main", completed: 2, total: 2 },
      { phase: "nested", completed: 0, total: 1 },
      { phase: "nested", completed: 1, total: 1 },
      { phase: "coverage", completed: 0, total: 1 },
      { phase: "coverage", completed: 1, total: 1 },
    ]);
    expect(JSON.stringify(progress)).not.toContain("正文");
    expect(JSON.stringify(progress)).not.toContain("用户");
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
