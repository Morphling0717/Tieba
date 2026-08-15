import { describe, expect, it } from "vitest";
import type { CapturedReply } from "../types";
import {
  anonymizeReplies,
  containsAnyOriginalAuthorName,
  createAuthorAliasMap,
  redactSensitiveText,
} from "./privacy";

function reply(
  id: string,
  authorName: string,
  content: string,
  overrides: Partial<CapturedReply> = {},
): CapturedReply {
  return {
    id,
    floor: Number(id.replace(/\D/g, "")) || null,
    parentReplyId: null,
    authorName,
    authorAlias: null,
    time: "2026-07-22 12:00",
    content,
    sourcePage: 1,
    sourceUrl: "https://tieba.baidu.com/p/123",
    domAnchor: `#post-${id}`,
    domSelector: `[data-id=\"${id}\"]`,
    kind: "floor",
    imageCount: 0,
    state: "visible",
    warnings: [],
    ...overrides,
  } as CapturedReply;
}

describe("privacy", () => {
  it("redacts common contact and identity values", () => {
    const text = [
      "\u624b\u673a 13812345678",
      "\u90ae\u7bb1 rider@example.com",
      "\u8eab\u4efd\u8bc1 11010519491231002X",
      "QQ: 123456789",
      "\u5fae\u4fe1 wx: rider_2026",
    ].join("\uff1b");

    const result = redactSensitiveText(text);

    expect(result).toContain("[\u624b\u673a\u53f7]");
    expect(result).toContain("[\u90ae\u7bb1]");
    expect(result).toContain("[\u8eab\u4efd\u8bc1]");
    expect(result).toContain("[QQ\u53f7]");
    expect(result).toContain("[\u5fae\u4fe1\u53f7]");
    expect(result).not.toMatch(/13812345678|rider@example\.com|11010519491231002X|123456789|rider_2026/);
  });

  it("assigns stable aliases and removes names from author and body fields", () => {
    const replies = [
      reply("r1", "\u7532\u9762\u9a91\u58ebA", "@\u7532\u9762\u9a91\u58ebB \u4f60\u770b\u8fd9\u4e2a"),
      reply("r2", "\u7532\u9762\u9a91\u58ebB", "\u56de\u590d \u7532\u9762\u9a91\u58ebA\uff1a\u6536\u5230"),
      reply("r3", "\u7532\u9762\u9a91\u58ebA", "\u518d\u8bf4\u4e00\u6b21"),
    ];

    const aliases = createAuthorAliasMap(replies);
    const anonymized = anonymizeReplies(replies);

    expect(aliases.get("\u7532\u9762\u9a91\u58ebA")).toBe("U1");
    expect(aliases.get("\u7532\u9762\u9a91\u58ebB")).toBe("U2");
    expect(anonymized.map((item) => item.authorAlias)).toEqual(["U1", "U2", "U1"]);
    expect(anonymized[0]?.content).toContain("@U2");
    expect(containsAnyOriginalAuthorName(anonymized, replies.map((item) => item.authorName))).toBe(false);
    expect(anonymized[0]).not.toHaveProperty("authorName");
    expect(anonymized[0]).not.toHaveProperty("imageCount");
    expect(anonymized[0]).not.toHaveProperty("sourceUrl");
  });

  it("also strips usernames that occur outside the selected context", () => {
    const selected = [reply("r1", "A\u9a91\u58eb", "\u8bf7\u8054\u7cfb\u697c\u4e3bB\u9a91\u58eb")];
    const anonymized = anonymizeReplies(selected, {
      knownAuthorNames: ["\u697c\u4e3bB\u9a91\u58eb"],
    });

    expect(anonymized[0]?.content).toBe("\u8bf7\u8054\u7cfb[\u7528\u6237\u540d]");
  });

  it("redacts an @ mention even when that user is outside all captured pages", () => {
    const anonymized = anonymizeReplies([
      reply("r1", "\u5df2\u91c7\u96c6\u7528\u6237", "@\u672a\u53c2\u4e0e\u672c\u9875\u7684\u7528\u6237 \u53bb\u770b\u4ed6\u4e3b\u9875"),
    ]);

    expect(anonymized[0]?.content).toBe("@[\u7528\u6237\u540d] \u53bb\u770b\u4ed6\u4e3b\u9875");
  });

  it("redacts an email before treating its @ sign as a username mention", () => {
    const anonymized = anonymizeReplies([
      reply("r1", "已采集用户", "请发到 danger@example.com，不要公开"),
    ]);

    expect(anonymized[0]?.content).toBe("请发到 [邮箱]，不要公开");
  });

  it("does not confuse a literal @U1 with a generated author alias", () => {
    const anonymized = anonymizeReplies([
      reply("r1", "甲面骑士", "@甲面骑士 是本人；@U1 是未识别账号"),
    ]);

    expect(anonymized[0]?.content).toBe("@U1 是本人；@[用户名] 是未识别账号");
  });

  it("redacts unknown reply targets even when every author failed to parse", () => {
    const source = reply(
      "r1",
      "",
      "@未识别甲 请看；回复 未识别乙：不要再发了",
      { authorName: null },
    );
    const anonymized = anonymizeReplies([source]);

    expect(anonymized[0]?.authorAlias).toBe("U0");
    expect(anonymized[0]?.content).toBe(
      "@[用户名] 请看；回复 [用户名]：不要再发了",
    );
  });
});
