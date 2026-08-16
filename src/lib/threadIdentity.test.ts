import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, type CapturedReply } from "../types";
import type { ReviewSession } from "./session";
import {
  createAnalysisKey,
  createSnapshotId,
  sha256Hex,
} from "./threadIdentity";

function reply(overrides: Partial<CapturedReply> = {}): CapturedReply {
  return {
    id: "runtime-1",
    siteReplyId: "site-1",
    floor: 1,
    parentReplyId: null,
    authorName: "用户甲",
    time: "2026-08-15 12:00",
    timestamp: 1_755_236_800,
    content: "第一行\r\n第二行",
    sourcePage: 1,
    sourceUrl: "https://tieba.baidu.com/p/123",
    anchor: "#post_content_site-1",
    imageCount: 0,
    isNested: false,
    unexpandedNestedCount: 0,
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<Pick<ReviewSession, "title" | "replies">> = {},
) {
  return {
    title: "  测试帖子  ",
    replies: [reply()],
    ...overrides,
  };
}

describe("thread snapshot identity", () => {
  it("implements the standard SHA-256 digest", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("normalizes harmless text representation differences", () => {
    const first = createSnapshotId(snapshot());
    const second = createSnapshotId(
      snapshot({
        title: "测试帖子",
        replies: [reply({ content: "第一行\n第二行" })],
      }),
    );

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("changes when reply content, authorship or structure changes", () => {
    const original = createSnapshotId(snapshot());
    expect(
      createSnapshotId(snapshot({ replies: [reply({ content: "改动" })] })),
    ).not.toBe(original);
    expect(
      createSnapshotId(snapshot({ replies: [reply({ authorName: "用户乙" })] })),
    ).not.toBe(original);
    expect(
      createSnapshotId(
        snapshot({ replies: [reply({ parentReplyId: "parent", isNested: true })] }),
      ),
    ).not.toBe(original);
  });

  it("does not accept session metadata as snapshot input", () => {
    const fullSession: ReviewSession = {
      schemaVersion: SCHEMA_VERSION,
      sessionSchemaVersion: 3,
      tabId: 8,
      threadId: "123",
      threadUrl: "https://tieba.baidu.com/p/123",
      title: "测试帖子",
      pages: {},
      replies: [reply()],
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
        dynamicContentMayRemain: false,
        reachedReplyListEnd: true,
        unstableReplyIdCount: 0,
        isComplete: true,
      },
      errors: [],
      warnings: [],
      updatedAt: "2026-08-15T04:00:00.000Z",
    };
    expect(createSnapshotId(fullSession)).toBe(
      createSnapshotId({ title: fullSession.title, replies: fullSession.replies }),
    );
  });
});

describe("analysis identity", () => {
  it("includes provider, endpoint, model, mode and all three versions", () => {
    const snapshotId = createSnapshotId(snapshot());
    const base = {
      snapshotId,
      provider: "alibaba" as const,
      endpoint: "https://provider.example/v1/",
      model: "model-1",
      mode: "fast" as const,
      analyzerVersion: "3.0.0",
      rulesVersion: "2026.07",
      transportVersion: "sidepanel-v3",
    };
    const original = createAnalysisKey(base);

    expect(original).toBe(
      createAnalysisKey({ ...base, endpoint: "https://provider.example/v1" }),
    );
    for (const changed of [
      { ...base, provider: "deepseek" as const },
      { ...base, endpoint: "https://other.example/v1" },
      { ...base, model: "model-2" },
      { ...base, mode: "deep" as const },
      { ...base, analyzerVersion: "3.0.1" },
      { ...base, rulesVersion: "2026.08" },
      { ...base, transportVersion: "background-v1" },
    ]) {
      expect(createAnalysisKey(changed)).not.toBe(original);
    }
  });
});
