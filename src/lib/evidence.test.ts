import { describe, expect, it } from "vitest";

import {
  assignRuntimeNestedReplyIds,
  declaredReplyCountFromDocument,
  dynamicEvidenceSignature,
  evidenceScanFractions,
  findDynamicThreadContainer,
  findEvidenceElement,
  findSafeReadExpansionControls,
  findTiebaAscendingSortControl,
  findVirtualEvidencePlaceholder,
  findVirtualFloorPlaceholder,
  isSelectedSortControl,
  mountedVirtualIndexRange,
} from "./evidence";

function documentFrom(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("findEvidenceElement", () => {
  it("falls back to stable nested reply ids when an old structural anchor breaks", () => {
    const document = documentFrom(`
      <ul><li class="lzl_single_post" data-spid="nested-42">证据</li></ul>
    `);

    expect(
      findEvidenceElement(document, "body > ul > li:nth-of-type(9)", "nested-42"),
    ).toBe(document.querySelector("[data-spid='nested-42']"));
  });

  it("survives an invalid selector and supports data-id fallbacks", () => {
    const document = documentFrom(`<div data-id="reply:7">证据</div>`);
    expect(findEvidenceElement(document, "[", "reply:7")).toBe(
      document.querySelector("[data-id='reply:7']"),
    );
  });

  it("prefers a stable reply id when an old structural anchor now hits another reply", () => {
    const document = documentFrom(`
      <ul>
        <li class="lzl_single_post" data-spid="new-reply">新插入</li>
        <li class="lzl_single_post" data-spid="wanted">原证据</li>
      </ul>
    `);

    expect(findEvidenceElement(document, "li:nth-of-type(1)", "wanted")).toBe(
      document.querySelector("[data-spid='wanted']"),
    );
  });

  it("resolves runtime-only SPA nested reply ids", () => {
    const document = documentFrom(`
      <div class="pb-lzl-item" data-kr-review-reply-id="kr-lzl-doc-opaque">证据</div>
    `);
    expect(findEvidenceElement(document, "", "kr-lzl-doc-opaque")).toBe(
      document.querySelector("[data-kr-review-reply-id='kr-lzl-doc-opaque']"),
    );
  });

  it("uses a separate official site id when the runtime reply id differs", () => {
    const document = documentFrom(`<div class="pb-comment-item" data-id="987">证据</div>`);
    expect(findEvidenceElement(document, "", "runtime-987", "987")).toBe(
      document.querySelector("[data-id='987']"),
    );
  });

  it("does not let a generic SPA data-id shadow the captured reply element", () => {
    const document = documentFrom(`
      <div data-id="987">非回复元素</div>
      <div class="pb-comment-item" data-id="987">回复证据</div>
    `);
    expect(findEvidenceElement(document, "", "987", "987")).toBe(
      document.querySelector(".pb-comment-item"),
    );
  });

  it("can disable the broad legacy data-id fallback for an unloaded SPA reply", () => {
    const document = documentFrom(`<div data-id="987">非回复元素</div>`);
    expect(
      findEvidenceElement(
        document,
        `.pb-comment-item[data-id="987"]`,
        "987",
        "987",
        false,
      ),
    ).toBeNull();
  });
});

describe("SPA evidence helpers", () => {
  it("finds only a virtual-list placeholder with the requested official id", () => {
    const document = documentFrom(`
      <div class="virtual-list-item" data-key="100"></div>
      <div class="virtual-list-item" data-key="200"></div>
    `);
    expect(findVirtualEvidencePlaceholder(document, "200")).toBe(
      document.querySelector("[data-key='200']"),
    );
    expect(findVirtualEvidencePlaceholder(document, "300")).toBeNull();
  });

  it("prefers the stable thread container for mutation observation", () => {
    const document = documentFrom(`
      <main class="thread-container"><div class="pb-comment-item" data-id="1"></div></main>
    `);
    expect(findDynamicThreadContainer(document)).toBe(
      document.querySelector(".thread-container"),
    );
  });

  it("finds an empty rendered SPA reply-list container", () => {
    const document = documentFrom(`
      <section class="pc-pb-comments">
        <div class="pc-pb-reply-top">全部回复 (0)</div>
        <div class="pc-pb-reply-list"></div>
      </section>
    `);
    expect(findDynamicThreadContainer(document)).toBe(
      document.querySelector(".pc-pb-comments"),
    );
  });

  it("returns the same opaque signature until mounted evidence changes", () => {
    const document = documentFrom(`
      <main class="thread-container">
        <div class="pb-comment-item" data-id="1">原文</div>
      </main>
    `);
    const root = document.querySelector(".thread-container")!;
    const initial = dynamicEvidenceSignature(root);
    expect(dynamicEvidenceSignature(root)).toBe(initial);

    document.querySelector(".pb-comment-item")!.textContent = "更新后的原文";
    expect(dynamicEvidenceSignature(root)).not.toBe(initial);
    expect(dynamicEvidenceSignature(root)).toMatch(/^1:[0-9a-f]{16}$/u);
    expect(dynamicEvidenceSignature(root)).not.toContain("更新后的原文");
  });

  it("assigns distinct stable opaque ids to identical nested sibling replies", () => {
    const document = documentFrom(`
      <div class="pb-comment-item" data-id="101">
        <div class="lzl-wrapper">
          <div class="pb-lzl-item"><span class="head-name">重复用户</span><span class="pb-rich-text">重复内容</span></div>
          <div class="pb-lzl-item"><span class="head-name">重复用户</span><span class="pb-rich-text">重复内容</span></div>
        </div>
      </div>
    `);
    const state = {
      byElement: new WeakMap<Element, string>(),
      byFingerprintOccurrence: new Map<string, string>(),
    };
    let sequence = 0;
    assignRuntimeNestedReplyIds(document, state, () => `opaque-${++sequence}`);
    const firstPass = Array.from(document.querySelectorAll(".pb-lzl-item")).map(
      (element) => element.getAttribute("data-kr-review-reply-id"),
    );

    expect(firstPass).toEqual(["opaque-1", "opaque-2"]);
    assignRuntimeNestedReplyIds(document, state, () => `opaque-${++sequence}`);
    expect(
      Array.from(document.querySelectorAll(".pb-lzl-item")).map((element) =>
        element.getAttribute("data-kr-review-reply-id"),
      ),
    ).toEqual(firstPass);
    expect(sequence).toBe(2);
  });

  it("uses a floor only as a virtual-row scroll hint", () => {
    const document = documentFrom(`
      <div class="virtual-list-item" data-index="6"><div data-id="wrong"></div></div>
      <div class="virtual-list-item" data-index="7"><div data-id="wanted"></div></div>
    `);
    expect(findVirtualFloorPlaceholder(document, 8)).toBe(
      document.querySelector("[data-index='6']"),
    );
    expect(findVirtualFloorPlaceholder(document, 1)).toBeNull();
    expect(findVirtualFloorPlaceholder(document, Number.NaN)).toBeNull();
    expect(mountedVirtualIndexRange(document)).toEqual({
      min: 6,
      max: 7,
      count: 2,
    });
  });

  it("finds only a semantic ascending control inside the reply header", () => {
    const document = documentFrom(`
      <article><button id="body-button">正序</button></article>
      <div class="pc-pb-comments">
        <div class="pc-pb-reply-top">
          <div role="tablist">
            <button role="tab">热门</button>
            <button id="ascending" role="tab" aria-selected="true"><span>正序</span></button>
            <button role="tab">倒序</button>
          </div>
        </div>
      </div>
    `);
    const control = findTiebaAscendingSortControl(document);
    expect(control).toBe(document.querySelector("#ascending"));
    expect(isSelectedSortControl(control!)).toBe(true);
  });

  it("recognizes the current Tieba div-based ascending tab", () => {
    const document = documentFrom(`
      <div class="pc-pb-comments">
        <div class="pc-pb-reply-top">
          <div class="sub-tab-list">
            <div class="sub-tab-item sub-tab-item-active">热门</div>
            <div id="ascending" class="sub-tab-item"><span>正序</span></div>
            <div class="sub-tab-item">倒序</div>
          </div>
        </div>
      </div>
    `);

    const control = findTiebaAscendingSortControl(document);
    expect(control).toBe(document.querySelector("#ascending"));
    expect(isSelectedSortControl(control!)).toBe(false);
  });

  it("does not treat reply body text or a navigating link as a sort control", () => {
    const bodyOnly = documentFrom(
      `<section class="pc-pb-comments"><div class="pb-comment-item"><div role="tablist"><button role="tab">正序</button></div></div></section>`,
    );
    expect(findTiebaAscendingSortControl(bodyOnly)).toBeNull();

    const navigating = documentFrom(`
      <div class="pc-pb-comments"><div class="pc-pb-reply-top">
        <a role="tab" href="/p/other">正序</a>
        <a role="tab" href="javascript:void(0)">正序</a>
      </div></div>
    `);
    expect(findTiebaAscendingSortControl(navigating)).toBeNull();

    const unrelatedHeader = documentFrom(`
      <div class="pc-pb-reply-top"><button role="tab">正序</button></div>
    `);
    expect(findTiebaAscendingSortControl(unrelatedHeader)).toBeNull();
  });

  it("allows only explicit read-only nested expansion controls", () => {
    const document = documentFrom(`
      <div id="parent" class="pb-comment-item">
        <div class="lzl-wrapper">
          <div id="more" class="show-more-lzl">展开 3 条回复</div>
          <button id="all">查看全部回复</button>
          <button id="reply">回复</button>
          <button id="delete">删除回复</button>
          <a id="navigate" href="/p/123?pn=2">查看更多回复</a>
        </div>
      </div>
    `);
    expect(
      findSafeReadExpansionControls(
        document.querySelector("#parent")!,
        "nested",
      ).map((element) => element.id),
    ).toEqual(["more"]);
  });

  it("keeps thread expansion outside replies and rejects moderation actions", () => {
    const document = documentFrom(`
      <main id="thread">
        <button id="thread-more" class="load-more">加载更多评论</button>
        <button id="ban">封禁</button>
        <form><button id="form-more" class="show-more">查看更多回复</button></form>
        <div contenteditable="true"><button id="editor-more" class="show-more">展开更多</button></div>
        <aside><button id="ad-more" class="show-more">查看更多回复</button></aside>
        <div class="recommend-card"><button id="recommend-more" class="show-more">查看更多回复</button></div>
        <button id="disabled-more" class="show-more" disabled>加载更多评论</button>
        <div class="pb-comment-item"><button id="nested-more">查看更多回复</button></div>
      </main>
    `);
    expect(
      findSafeReadExpansionControls(
        document.querySelector("#thread")!,
        "thread",
      ).map((element) => element.id),
    ).toEqual(["thread-more"]);
  });

  it("reads the declared reply count and prioritizes the estimated floor", () => {
    const document = documentFrom(
      `<div class="pc-pb-reply-top">全部回复（268） 正序</div>`,
    );
    expect(declaredReplyCountFromDocument(document)).toBe(268);
    const fractions = evidenceScanFractions(202, 268, 4);
    expect(fractions[0]).toBeCloseTo(200 / 267);
    expect(fractions).toContain(0);
    expect(fractions).toContain(1);
    expect(new Set(fractions).size).toBe(fractions.length);
  });
});
