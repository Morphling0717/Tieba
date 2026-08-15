import { describe, expect, it } from "vitest";
import type { CapturedReply, Finding } from "../types";
import { buildCloudPreflight } from "./cloudPreflight";

const replies: CapturedReply[] = [
  {
    id: "r1",
    siteReplyId: "r1",
    floor: 1,
    parentReplyId: null,
    authorName: "用户甲",
    time: null,
    timestamp: null,
    content: "@用户乙 联系 13812345678",
    sourcePage: 1,
    sourceUrl: "https://tieba.baidu.com/p/1",
    anchor: "#r1",
    imageCount: 2,
    isNested: false,
    unexpandedNestedCount: 0,
  },
  {
    id: "r2",
    siteReplyId: "r2",
    floor: 2,
    parentReplyId: null,
    authorName: "用户乙",
    time: null,
    timestamp: null,
    content: "回复 用户甲：收到",
    sourcePage: 1,
    sourceUrl: "https://tieba.baidu.com/p/1",
    anchor: "#r2",
    imageCount: 0,
    isNested: false,
    unexpandedNestedCount: 0,
  },
];

const finding: Finding = {
  id: "f1",
  type: "harassment",
  severity: "high",
  score: 80,
  summary: "测试",
  replyIds: ["r1"],
  participantNames: ["用户甲", "用户乙"],
  evidence: [],
  reasonCandidates: [],
  uncertainties: [],
};

describe("buildCloudPreflight", () => {
  it("显示精确域名与实际脱敏上下文范围", () => {
    const preview = buildCloudPreflight(
      finding,
      replies,
      "https://api.example.com/v1/chat/completions",
    );

    expect(preview).toEqual({
      hostname: "api.example.com",
      replyCount: 2,
      selectedReplyCount: 1,
      omittedImageCount: 2,
      usernamesRedacted: true,
      sensitiveFieldsRedacted: true,
      imagesExcluded: true,
    });
  });

  it("不会把 U1 或单字用户名与匿名别名、ID 字段误判为泄漏", () => {
    const edgeReplies: CapturedReply[] = [
      { ...replies[0]!, authorName: "U1", content: "普通文字" },
      { ...replies[1]!, authorName: "甲", content: "另一条普通文字" },
    ];

    expect(() =>
      buildCloudPreflight(
        finding,
        edgeReplies,
        "https://api.example.com/v1",
      ),
    ).not.toThrow();
  });
});
