import { describe, expect, it } from "vitest";
import type { CapturedReply } from "../types";
import { analyzeReplies } from "./analyzer";

function reply(
  id: string,
  authorName: string,
  content: string,
  overrides: Partial<CapturedReply> = {},
): CapturedReply {
  return {
    id,
    siteReplyId: id,
    floor: Number(id.replace(/\D/g, "")) || null,
    parentReplyId: null,
    authorName,
    time: "2026-07-22 12:00",
    timestamp: Date.parse("2026-07-22T12:00:00+08:00"),
    content,
    sourcePage: 1,
    sourceUrl: "https://tieba.baidu.com/p/123",
    anchor: `#post-${id}`,
    imageCount: 0,
    isNested: false,
    unexpandedNestedCount: 0,
    ...overrides,
  };
}

describe("analyzeReplies", () => {
  it("returns explainable evidence and a canonical reason for a targeted insult", () => {
    const replies = [
      reply("r1", "A\u9a91\u58eb", "\u6211觉得这个设定不错"),
      reply("r2", "B\u9a91\u58eb", "@A\u9a91\u58eb 你就是个傻逼，闭嘴吧", {
        parentReplyId: "r1",
        isNested: true,
      }),
    ];

    const finding = analyzeReplies(replies).find(
      (item) => item.type === "personal_attack",
    );

    expect(finding).toBeDefined();
    expect(finding?.replyIds).toContain("r2");
    expect(finding?.evidence[0]).toMatchObject({ replyId: "r2" });
    expect(finding?.evidence[0]?.signals).toEqual(
      expect.arrayContaining(["高风险辱骂词", "存在明确回复或 @ 对象"]),
    );
    expect(finding?.reasonCandidates[0]?.reasonId).toMatch(/^R03\./u);
    expect(finding?.summary).toContain("请回到原楼");
  });

  it("groups repeated text by the same author as a spam finding", () => {
    const replies = [
      reply("r1", "刷屏者", "顶一下"),
      reply("r2", "刷屏者", "顶一下"),
      reply("r3", "刷屏者", "顶一下"),
    ];

    const finding = analyzeReplies(replies).find((item) => item.type === "spam");

    expect(finding?.replyIds).toEqual(["r1", "r2", "r3"]);
    expect(finding?.score).toBeGreaterThanOrEqual(48);
    expect(finding?.evidence[0]?.signals[0]).toContain("重复发布");
    expect(finding?.reasonCandidates[0]?.reasonId).toBe("R06.05");
  });

  it("uses mutual replies and a short burst as supporting escalation signals", () => {
    const base = Date.parse("2026-07-22T12:00:00+08:00");
    const replies = [
      reply("r1", "A", "我喜欢这部作品", { timestamp: base }),
      reply("r2", "B", "不会真有人这么想吧", {
        parentReplyId: "r1",
        time: "2026-07-22 12:01",
        timestamp: base + 60_000,
      }),
      reply("r3", "A", "你急了？", {
        parentReplyId: "r2",
        time: "2026-07-22 12:02",
        timestamp: base + 120_000,
      }),
      reply("r4", "B", "就这？来对线", {
        parentReplyId: "r3",
        time: "2026-07-22 12:03",
        timestamp: base + 180_000,
      }),
      reply("r5", "A", "破防了就别回", {
        parentReplyId: "r4",
        time: "2026-07-22 12:04",
        timestamp: base + 240_000,
      }),
    ];

    const finding = analyzeReplies(replies).find(
      (item) => item.type === "provocation",
    );
    const signals = finding?.evidence.flatMap((item) => item.signals) ?? [];

    expect(finding?.participantNames).toEqual(expect.arrayContaining(["A", "B"]));
    expect(signals.some((signal) => signal.includes("双方连续互回"))).toBe(true);
    expect(signals.some((signal) => signal.includes("10分钟内密集互回"))).toBe(true);
  });

  it("does not label an ordinary back-and-forth discussion by dynamics alone", () => {
    const replies = [
      reply("r1", "A", "我倾向第一种解释"),
      reply("r2", "B", "我不同意，理由是设定集有反例", { parentReplyId: "r1" }),
      reply("r3", "A", "这个反例我理解，但前提不同", { parentReplyId: "r2" }),
      reply("r4", "B", "好的，那我们分别列一下前提", { parentReplyId: "r3" }),
      reply("r5", "A", "可以，我先列第一条", { parentReplyId: "r4" }),
    ];

    expect(analyzeReplies(replies)).toEqual([]);
  });

  it("recognizes a visible 回复 用户名： prefix when parent metadata is absent", () => {
    const replies = [
      reply("r1", "楼主甲", "我认为这个设定可以这样解释"),
      reply("r2", "用户乙", "回复 楼主甲：你就是个傻逼，别装懂", {
        parentReplyId: null,
        isNested: true,
      }),
    ];

    const finding = analyzeReplies(replies).find(
      (item) => item.type === "personal_attack",
    );
    expect(finding?.participantNames).toEqual(
      expect.arrayContaining(["楼主甲", "用户乙"]),
    );
  });
});
