import { describe, expect, it } from "vitest";

import spaFixture from "../test/fixtures/tieba-thread-spa.html?raw";
import fixture from "../test/fixtures/tieba-thread.html?raw";
import { inspectTiebaDocument, parseTiebaDocument } from "./extractor";

function documentFrom(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("parseTiebaDocument", () => {
  it("解析楼层、楼中楼、覆盖缺口与可跳转证据", () => {
    const document = documentFrom(fixture);
    const result = parseTiebaDocument(
      document,
      "https://tieba.baidu.com/p/998877?pn=2",
    );

    expect(result.threadId).toBe("998877");
    expect(result.pageNumber).toBe(2);
    expect(result.title).toBe("假面骑士长帖测试");
    expect(result.errors).toEqual([]);
    expect(result.replies).toHaveLength(4);

    expect(result.replies[0]).toMatchObject({
      id: "1001",
      floor: 1,
      parentReplyId: null,
      authorName: "楼主A",
      time: "2026-07-22 09:30",
      content: "主楼正文：今天来讨论剧情。",
      sourcePage: 2,
      imageCount: 1,
      isNested: false,
    });
    expect(result.replies[1]).toMatchObject({
      id: "2001",
      floor: 1,
      parentReplyId: "1001",
      authorName: "回复者B",
      content: "回复 楼主A：我不同意",
      isNested: true,
    });
    expect(result.replies[2]).toMatchObject({
      id: "2002",
      floor: 1,
      parentReplyId: "2001",
      authorName: "回复者C",
      time: "2026-07-22 09:40",
    });

    for (const reply of result.replies) {
      expect(document.querySelector(reply.anchor)).not.toBeNull();
    }

    expect(result.coverage).toEqual({
      captureMode: "paginated",
      visibleReplyCount: 4,
      mainReplyCount: 2,
      nestedReplyCount: 2,
      imageCount: 1,
      unexpandedLzlCount: 1,
      analyzedPageNumbers: [2],
      hasUnanalyzedImages: true,
      declaredReplyCount: null,
      dynamicContentMayRemain: false,
      reachedReplyListEnd: false,
      unstableReplyIdCount: 0,
      isComplete: false,
    });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("1 条楼中楼回复未展开"),
        expect.stringContaining("1 张图片"),
        expect.stringContaining("至少有 3 页"),
      ]),
    );
  });

  it("兼容 data-field 损坏、字段缺失以及删除提示", () => {
    const document = documentFrom(`
      <!doctype html>
      <html data-total-page="1"><head><title>缺字段_百度贴吧</title></head><body>
        <div class="l_post" data-field="{not-json">
          <span class="p_author_name">匿名用户</span>
          <span class="tail-info">7楼</span>
          <div class="post_deleted">该楼层已被删除</div>
          <ul>
            <li class="lzl_single_post" data-field='{"spid":"nested-only","content":"仅存在于 data-field 的回复"}'></li>
          </ul>
        </div>
      </body></html>
    `);
    const result = parseTiebaDocument(document, "/p/12345");

    expect(result.errors).toEqual([]);
    expect(result.replies).toHaveLength(2);
    expect(result.replies[0]).toMatchObject({
      floor: 7,
      authorName: "匿名用户",
      content: "该楼层已被删除",
    });
    expect(result.replies[1]).toMatchObject({
      id: "nested-only",
      parentReplyId: result.replies[0]?.id,
      floor: 7,
      authorName: null,
      content: "仅存在于 data-field 的回复",
    });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("data-field 无法解析"),
        expect.stringContaining("删除、折叠或屏蔽提示"),
      ]),
    );
  });

  it("对非帖子页返回明确错误，不生成空泛结果", () => {
    const document = documentFrom(
      "<!doctype html><html><head><title>贴吧首页</title></head><body><div>欢迎</div></body></html>",
    );
    const result = parseTiebaDocument(document, "https://tieba.baidu.com/f?kw=test");

    expect(result.threadId).toBeNull();
    expect(result.replies).toEqual([]);
    expect(result.coverage.visibleReplyCount).toBe(0);
    expect(result.coverage.isComplete).toBe(false);
    expect(result.errors).toContain(
      "当前页面不是可识别的贴吧帖子页：未找到楼层内容。",
    );
  });

  it("缺少 data-field 时即使单页也不会声称完整", () => {
    const document = documentFrom(`
      <!doctype html>
      <html data-total-page="1"><head><title>单页帖</title></head><body>
        <div class="l_post" data-pid="p1">
          <span class="p_author_name">可见用户</span>
          <div class="d_post_content">可见正文</div>
        </div>
      </body></html>
    `);
    const result = parseTiebaDocument(document, "https://tieba.baidu.com/p/123");

    expect(result.errors).toEqual([]);
    expect(result.coverage.isComplete).toBe(false);
    expect(result.warnings).toContain(
      "1 条回复缺少 data-field，部分作者、时间或楼层信息可能缺失。",
    );
  });

  it("无数字的展开回复按钮也会标记未知楼中楼缺口", () => {
    const document = documentFrom(`
      <!doctype html>
      <html data-total-page="1"><head><title>单页帖</title></head><body>
        <div class="l_post" data-field='{"content":{"post_id":"p1","post_no":1}}'>
          <span class="p_author_name">用户甲</span>
          <div class="d_post_content">正文</div>
          <button class="lzl_more">展开回复</button>
        </div>
      </body></html>
    `);
    const result = parseTiebaDocument(document, "https://tieba.baidu.com/p/123");

    expect(result.coverage.unexpandedLzlCount).toBe(1);
    expect(result.coverage.isComplete).toBe(false);
    expect(result.warnings).toContain("估计仍有 1 条楼中楼回复未展开。");
  });

  it("DOM 选择器失效时仍统计 data-field HTML 中的图片", () => {
    const document = documentFrom(`
      <!doctype html>
      <html data-total-page="1"><head><title>回退内容</title></head><body>
        <div class="l_post" data-field='{"author":{"user_name":"用户甲"},"content":{"post_id":"p1","post_no":1,"comment_num":1,"content":"文字<img src=main.png>"}}'>
          <div class="changed-content-class">新版正文节点</div>
          <ul>
            <li class="lzl_single_post" data-field='{"spid":"n1","user_name":"用户乙","content":"楼中楼<img src=nested.png>"}'></li>
          </ul>
        </div>
      </body></html>
    `);
    const result = parseTiebaDocument(document, "https://tieba.baidu.com/p/123");

    expect(result.replies.map((reply) => reply.content)).toEqual([
      "文字",
      "楼中楼",
    ]);
    expect(result.coverage.imageCount).toBe(2);
    expect(result.coverage.hasUnanalyzedImages).toBe(true);
    expect(result.coverage.isComplete).toBe(false);
    expect(result.warnings).toContain("检测到 2 张图片；当前版本不识别图片文字。");
  });

  it("解析新版 SPA 主楼、虚拟列表、楼中楼和覆盖缺口", () => {
    const document = documentFrom(spaFixture);
    const result = parseTiebaDocument(
      document,
      "https://tieba.baidu.com/p/99000000001?fr=frs",
    );

    expect(result).toMatchObject({
      parserVariant: "spa",
      documentInstanceId: "doc-spa-1",
      threadId: "99000000001",
      pageNumber: 1,
      title: "新版长帖脱敏夹具",
    });
    expect(result.replies).toHaveLength(5);
    expect(result.replies[0]).toMatchObject({
      id: "99000000001-first-floor",
      siteReplyId: null,
      floor: 1,
      authorName: "楼主甲",
      time: "2026-07-22 08:15",
      content: "主楼只讨论剧情。",
      imageCount: 1,
      isNested: false,
    });
    expect(result.replies[1]).toMatchObject({
      id: "9002",
      siteReplyId: "9002",
      floor: 2,
      authorName: "用户乙",
      time: "2026-07-22 09:20",
      content: "我不同意这个看法。",
      imageCount: 1,
      unexpandedNestedCount: 3,
      anchor: '.pb-comment-item[data-id="9002"]',
    });
    expect(result.replies[2]).toMatchObject({
      id: "kr-lzl-doc-spa-1-a",
      siteReplyId: null,
      parentReplyId: "9002",
      floor: 2,
      authorName: "用户丙",
      content: "请就事论事。",
      isNested: true,
      anchor: '[data-kr-review-reply-id="kr-lzl-doc-spa-1-a"]',
    });
    expect(result.replies[3]?.id).toMatch(/^kr-lzl-temp-/u);
    expect(result.replies[3]).toMatchObject({
      siteReplyId: null,
      parentReplyId: "9002",
      floor: 2,
      authorName: "用户丁",
      isNested: true,
    });
    expect(result.replies[4]).toMatchObject({
      id: "9003",
      floor: 3,
      time: null,
      content: "该楼层已被删除",
    });

    expect(result.coverage).toEqual({
      captureMode: "dynamic",
      visibleReplyCount: 5,
      mainReplyCount: 3,
      nestedReplyCount: 2,
      imageCount: 2,
      unexpandedLzlCount: 3,
      analyzedPageNumbers: [1],
      hasUnanalyzedImages: true,
      declaredReplyCount: 212,
      dynamicContentMayRemain: false,
      reachedReplyListEnd: true,
      unstableReplyIdCount: 2,
      isComplete: false,
    });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("3 条楼中楼回复未展开"),
        expect.stringContaining("2 张图片"),
        expect.stringContaining("2 条回复没有网站稳定 ID"),
        expect.stringContaining("已到达当前回复列表末尾"),
      ]),
    );
    expect(result.coverage.isComplete).toBe(false);

    expect(document.querySelector(result.replies[1]?.anchor ?? "")).not.toBeNull();
    expect(document.querySelector(result.replies[2]?.anchor ?? "")).not.toBeNull();
  });

  it("区分 CSR 仍在加载与已渲染但结构不支持", () => {
    const loading = documentFrom(
      "<!doctype html><html><body><div id='app'></div></body></html>",
    );
    expect(
      inspectTiebaDocument(loading, "https://tieba.baidu.com/p/123"),
    ).toMatchObject({ status: "not_ready" });

    const unsupported = documentFrom(`
      <!doctype html><html><body><div id="app">
        <h1 class="pc-pb-title">已渲染标题</h1>
        <div class="pc-pb-reply-top">全部回复（10）</div>
        <div class="changed-comment-layout">新结构</div>
      </div></body></html>
    `);
    expect(
      inspectTiebaDocument(unsupported, "https://tieba.baidu.com/p/123"),
    ).toMatchObject({ status: "unsupported" });

    const result = parseTiebaDocument(
      unsupported,
      "https://tieba.baidu.com/p/123",
    );
    expect(result.replies).toEqual([]);
    expect(result.errors[0]).toContain("尚不支持的页面结构");
    expect(result.coverage.isComplete).toBe(false);
  });

  it("特殊主楼与空回复列表仍是 SPA 已就绪，但不声称整帖完整", () => {
    for (const variant of ["score-thread", "recruit-thread"]) {
      const document = documentFrom(`
        <!doctype html><html data-kr-review-document-instance-id="special-${variant}">
          <head><title>特殊主楼_百度贴吧</title></head>
          <body><div id="app">
            <article class="${variant}">
              <div class="user-info"><a class="head-name">用户甲</a></div>
              <div class="pb-content-wrap">特殊主楼文字</div>
            </article>
            <div class="pc-pb-reply-top">全部回复（0）</div>
            <div class="pc-pb-reply-list"><div class="empty">别让楼主寂寞太久哦</div></div>
          </div></body>
        </html>
      `);
      const result = parseTiebaDocument(
        document,
        "https://tieba.baidu.com/p/321",
      );

      expect(result.parserVariant).toBe("spa");
      expect(result.replies).toHaveLength(1);
      expect(result.replies[0]?.content).toBe("特殊主楼文字");
      expect(result.coverage.declaredReplyCount).toBe(0);
      expect(result.coverage.reachedReplyListEnd).toBe(true);
      expect(result.coverage.isComplete).toBe(false);
    }
  });

  it("保留新版主楼的可见相对时间，不伪造绝对时间戳", () => {
    const relative = documentFrom(`
      <!doctype html><html data-kr-review-document-instance-id="relative-doc">
        <head><title>相对时间_百度贴吧</title></head>
        <body><div id="app">
          <article class="image-text">
            <div class="user-info">
              <a class="head-name">用户甲</a>
              <span class="post-num">16小时前</span>
            </div>
            <div class="pb-content-wrap">主楼</div>
          </article>
        </div></body>
      </html>
    `);
    const relativeResult = parseTiebaDocument(
      relative,
      "https://tieba.baidu.com/p/456",
    );
    expect(relativeResult.replies[0]).toMatchObject({
      time: "16小时前",
      timestamp: null,
    });

    const absoluteFallback = documentFrom(`
      <!doctype html><html data-kr-review-document-instance-id="absolute-doc">
        <head><title>绝对时间_百度贴吧</title></head>
        <body><div id="app">
          <article class="image-text">
            <div class="user-info"><span class="post-num">16小时前</span></div>
            <div class="pb-content-wrap">主楼</div>
            <div class="rel-thread-time">发布于 2026-07-22 08:15</div>
          </article>
        </div></body>
      </html>
    `);
    const absoluteResult = parseTiebaDocument(
      absoluteFallback,
      "https://tieba.baidu.com/p/457",
    );
    expect(absoluteResult.replies[0]?.time).toBe("2026-07-22 08:15");
    expect(absoluteResult.replies[0]?.timestamp).not.toBeNull();
  });

  it("父回复字段缺失时不会误取楼中楼的作者、时间或正文", () => {
    const document = documentFrom(`
      <!doctype html><html data-kr-review-document-instance-id="ownership-doc">
        <head><title>层级归属_百度贴吧</title></head>
        <body><div id="app">
          <article class="image-text"><div class="pb-content-wrap">主楼</div></article>
          <div class="pc-pb-reply-top">全部回复（1）</div>
          <div class="pb-comment-item" data-id="parent-1">
            <div class="comment-content">
              <div class="lzl-wrapper">
                <div class="pb-lzl-item" data-kr-review-reply-id="child-1">
                  <div class="user-info"><a class="head-name">子回复用户</a></div>
                  <div class="comment-content">
                    <div class="pb-rich-text">子回复正文</div>
                    <div class="pc-pb-comments-desc">
                      <div class="comment-desc-left">2026-07-22 11:00</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div></body>
      </html>
    `);
    const result = parseTiebaDocument(
      document,
      "https://tieba.baidu.com/p/458",
    );

    expect(result.replies[1]).toMatchObject({
      id: "parent-1",
      authorName: null,
      time: null,
      floor: null,
      content: "",
    });
    expect(result.replies[2]).toMatchObject({
      id: "child-1",
      parentReplyId: "parent-1",
      authorName: "子回复用户",
      time: "2026-07-22 11:00",
      content: "子回复正文",
    });
    expect(result.errors).toContain("1 条可见回复未能读取正文。");
  });

  it("500 条 SPA 文本回复的本地解析低于 3 秒", () => {
    const comments = Array.from({ length: 500 }, (_, index) => `
      <div class="virtual-list-item" data-key="${10_000 + index}">
        <div class="pb-comment-item" data-id="${10_000 + index}">
          <div class="user-info"><a class="head-name">用户${index}</a></div>
          <div class="comment-content">
            <div class="pb-rich-text">脱敏性能样本 ${index}</div>
            <div class="comment-desc-left">第${index + 2}楼 2026-07-22 10:00</div>
          </div>
        </div>
      </div>
    `).join("");
    const document = documentFrom(`
      <!doctype html><html data-kr-review-document-instance-id="perf-doc">
        <head><title>性能样本_百度贴吧</title></head>
        <body><div id="app">
          <article class="image-text"><div class="pb-content-wrap">主楼</div></article>
          <div class="pc-pb-reply-top">全部回复（500）</div>
          <div class="pc-pb-reply-list"><div class="thread-container">
            ${comments}
            <div class="loading">—— 已加载全部评论 ——</div>
          </div></div>
        </div></body>
      </html>
    `);

    const started = performance.now();
    const result = parseTiebaDocument(
      document,
      "https://tieba.baidu.com/p/999000",
    );
    const elapsed = performance.now() - started;

    expect(result.replies).toHaveLength(501);
    expect(elapsed).toBeLessThan(3_000);
  });
});
