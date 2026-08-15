import { describe, expect, it } from "vitest";

import pagePcFixture from "../test/fixtures/tieba-pagepc-sanitized.json";
import nestedFixture from "../test/fixtures/tieba-pcomment-sanitized.html?raw";
import {
  TiebaApiError,
  buildTiebaNestedRequest,
  buildTiebaPagePcRequest,
  buildTiebaSyncRequest,
  md5Hex,
  parseTiebaNestedDocument,
  parseTiebaPagePcResponse,
  parseTiebaSyncResponse,
  signTiebaPcParams,
} from "./tiebaApi";

function documentFrom(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("Tieba API read request construction", () => {
  it("generates standard MD5 and the fixed PC signature", () => {
    expect(md5Hex("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5Hex("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(
      signTiebaPcParams({
        subapp_type: "pc",
        _client_type: "20",
      }),
    ).toBe("e9b101df871c39eedcf9a232c2d26ec8");
    expect(
      signTiebaPcParams({
        sign: "ignored",
        sig: "also-ignored",
        empty: null,
        a: 1,
        b: "二",
      }),
    ).toBe(signTiebaPcParams({ b: "二", a: 1 }));
  });

  it("only constructs the three allow-listed read requests", () => {
    const sync = buildTiebaSyncRequest();
    expect(sync).toMatchObject({
      endpoint: "/c/s/pc/sync",
      method: "GET",
    });
    expect(new URL(sync.url).origin).toBe("https://tieba.baidu.com");
    expect(new URL(sync.url).pathname).toBe("/c/s/pc/sync");
    expect(new URL(sync.url).searchParams.get("sign")).toMatch(/^[a-f\d]{32}$/u);

    const page = buildTiebaPagePcRequest(
      "99000000001",
      2,
      "0123456789abcdef0123456789abcdef",
    );
    expect(page).toMatchObject({
      endpoint: "/c/f/pb/page_pc",
      method: "POST",
      url: "https://tieba.baidu.com/c/f/pb/page_pc",
    });
    const body = new URLSearchParams(page.body);
    expect(body.get("kz")).toBe("99000000001");
    expect(body.get("pn")).toBe("2");
    expect(body.get("r")).toBe("0");
    expect(body.get("sign")).toMatch(/^[a-f\d]{32}$/u);

    const nested = buildTiebaNestedRequest(
      "99000000001",
      "990100000002",
      3,
      "123",
    );
    expect(nested).toMatchObject({
      endpoint: "/p/comment",
      method: "GET",
    });
    expect(nested.url).toBe(
      "https://tieba.baidu.com/p/comment?tid=99000000001&pid=990100000002&fid=123&pn=3",
    );
  });

  it("rejects injection-shaped ids, invalid pages and invalid tbs", () => {
    expect(() =>
      buildTiebaNestedRequest("108/x", "990100000002", 1),
    ).toThrowError(TiebaApiError);
    expect(() =>
      buildTiebaNestedRequest("99000000001", "1537&pn=9", 1),
    ).toThrowError(TiebaApiError);
    expect(() =>
      buildTiebaNestedRequest("99000000001", "990100000002", 0),
    ).toThrowError(TiebaApiError);
    expect(() =>
      buildTiebaPagePcRequest("99000000001", 1, "bad tbs"),
    ).toThrowError(TiebaApiError);
  });
});

describe("Tieba API response projections", () => {
  it("projects tbs without retaining anti or user data", () => {
    const result = parseTiebaSyncResponse(JSON.stringify({
      error_code: 0,
      anti: {
        tbs: "0123456789abcdef0123456789abcdef",
        user: { private: "must-not-escape" },
      },
    }));
    expect(result).toEqual({
      tbs: "0123456789abcdef0123456789abcdef",
    });
    expect(JSON.stringify(result)).not.toContain("must-not-escape");
  });

  it("projects the first floor, main reply and nested preview", () => {
    const result = parseTiebaPagePcResponse(pagePcFixture, {
      threadId: "99000000001",
      expectedPage: 1,
    });

    expect(result).toMatchObject({
      threadId: "99000000001",
      forumId: "123",
      title: "脱敏测试帖",
      declaredReplyCount: 4,
      currentPage: 1,
      totalPages: 2,
      hasMore: true,
    });
    expect(result.replies).toHaveLength(3);
    expect(result.replies[0]).toMatchObject({
      id: "990100000001",
      siteReplyId: "990100000001",
      floor: 1,
      parentReplyId: null,
      authorName: "楼主甲",
      content: "主楼正文",
      imageCount: 1,
      isNested: false,
    });
    expect(result.replies[1]).toMatchObject({
      id: "990100000002",
      floor: 2,
      authorName: "用户乙",
      content: "普通回复@用户丙[表情]",
      unexpandedNestedCount: 2,
    });
    expect(result.replies[2]).toMatchObject({
      id: "990100100001",
      parentReplyId: "990100000002",
      floor: 2,
      authorName: "用户丙",
      content: "楼中楼预览",
      isNested: true,
    });
    expect(result.nestedParents).toEqual([
      expect.objectContaining({
        parentReplyId: "990100000002",
        parentSiteReplyId: "990100000002",
        parentFloor: 2,
        sourcePage: 1,
        declaredCount: 3,
      }),
    ]);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("redacted-a");
    expect(serialized).not.toContain("10001");
    expect(serialized).not.toContain("portrait");
    expect(serialized).not.toContain("tbs");
  });

  it("does not repeat first_floor on later pages", () => {
    const response = structuredClone(pagePcFixture);
    response.page.current_page = "2";
    response.page.total_page = "2";
    response.page.has_more = "0";
    response.post_list[0]!.id = "990100000004";
    response.post_list[0]!.floor = "4";
    response.post_list[0]!.sub_post_number = "0";
    response.post_list[0]!.sub_post_list.sub_post_list = [];

    const result = parseTiebaPagePcResponse(response, {
      threadId: "99000000001",
      expectedPage: 2,
    });
    expect(result.replies.map((reply) => reply.id)).toEqual(["990100000004"]);
    expect(result.hasMore).toBe(false);
  });

  it("rejects remote errors, thread mixups and page mixups without echoing raw data", () => {
    expect(() =>
      parseTiebaPagePcResponse(
        { error_code: "4", error_msg: "sensitive raw details" },
        { threadId: "99000000001" },
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "REMOTE_ERROR",
        remoteCode: "4",
        message: expect.not.stringContaining("sensitive raw details"),
      }),
    );

    const wrongThread = structuredClone(pagePcFixture);
    wrongThread.thread.id = "999999";
    expect(() =>
      parseTiebaPagePcResponse(wrongThread, {
        threadId: "99000000001",
      }),
    ).toThrowError(expect.objectContaining({ code: "THREAD_MISMATCH" }));

    expect(() =>
      parseTiebaPagePcResponse(pagePcFixture, {
        threadId: "99000000001",
        expectedPage: 2,
      }),
    ).toThrowError(expect.objectContaining({ code: "PAGE_MISMATCH" }));
  });
});

describe("Tieba nested HTML projection", () => {
  it("returns stable spids and pager totals", () => {
    const result = parseTiebaNestedDocument(documentFrom(nestedFixture), {
      threadId: "99000000001",
      parentReplyId: "990100000002",
      parentSiteReplyId: "990100000002",
      parentFloor: 2,
      sourcePage: 1,
      page: 1,
    });

    expect(result).toMatchObject({
      threadId: "99000000001",
      parentReplyId: "990100000002",
      currentPage: 1,
      totalPages: 2,
      totalNum: 12,
      hasMore: true,
      unparsedReplyCount: 0,
    });
    expect(result.replies).toHaveLength(2);
    expect(result.replies[0]).toMatchObject({
      id: "990100100001",
      siteReplyId: "990100100001",
      parentReplyId: "990100000002",
      floor: 2,
      authorName: "用户丙",
      time: "2026-07-22 09:02",
      content: "第一条楼中楼",
      imageCount: 0,
      isNested: true,
    });
    expect(result.replies[1]).toMatchObject({
      id: "990100100002",
      authorName: "用户丁",
      imageCount: 1,
    });
    expect(JSON.stringify(result)).not.toContain("portrait");
    expect(JSON.stringify(result)).not.toContain("redacted-c");
  });

  it("counts reply-like nodes without stable spids instead of inventing ids", () => {
    const document = documentFrom(`
      <ul>
        <li class="lzl_single_post"><span class="lzl_content_main">缺少 id</span></li>
      </ul>
    `);
    const result = parseTiebaNestedDocument(document, {
      threadId: "99000000001",
      parentReplyId: "990100000002",
      parentSiteReplyId: "990100000002",
      parentFloor: 2,
      sourcePage: 1,
      page: 1,
    });
    expect(result.replies).toEqual([]);
    expect(result.unparsedReplyCount).toBe(1);
  });

  it("parses comment-wrapped legacy fragments and rejects empty challenge pages", () => {
    const wrapped = documentFrom(`
      <!--
        <li class="lzl_single_post_old" data-field='{"spid":"990100100003","showname":"用户戊"}'>
          <span class="lzl_content_main">被注释包裹的回复</span>
        </li>
        <li class="lzl_li_pager" data-field='{"total_num":"1","total_page":"1"}'></li>
      -->
    `);
    const context = {
      threadId: "99000000001",
      parentReplyId: "990100000002",
      parentSiteReplyId: "990100000002",
      parentFloor: 2,
      sourcePage: 1,
      page: 1,
      declaredCount: 1,
    } as const;
    expect(parseTiebaNestedDocument(wrapped, context).replies[0]).toMatchObject({
      id: "990100100003",
      authorName: "用户戊",
      content: "被注释包裹的回复",
    });

    expect(() =>
      parseTiebaNestedDocument(
        documentFrom("<html><body>安全验证</body></html>"),
        context,
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_RESPONSE" }));
  });
});
