// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://tieba.baidu.com/p/123"}

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ContentRequest, EvidenceLocator, ExtensionResponse } from "./messages";

type ContentListener = (
  message: ContentRequest,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: ExtensionResponse) => void,
) => boolean | void;

const mainLocator = (overrides: Partial<EvidenceLocator> = {}): EvidenceLocator => ({
  replyId: "101",
  siteReplyId: "101",
  floor: 8,
  anchor: '.pb-comment-item[data-id="101"]',
  parentReplyId: null,
  parentSiteReplyId: null,
  parentAnchor: null,
  isNested: false,
  parserVariant: "spa",
  ...overrides,
});

async function loadContent(): Promise<ContentListener> {
  let listener: ContentListener | null = null;
  vi.stubGlobal("chrome", {
    runtime: {
      onMessage: {
        addListener: vi.fn((next: ContentListener) => {
          listener = next;
        }),
      },
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
  });
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
  delete window.__KR_TIEBA_REVIEWER_CONTENT__;
  vi.resetModules();
  await import("./content");
  if (!listener) throw new Error("content listener was not installed");
  return listener;
}

function dispatchJump(
  listener: ContentListener,
  locator: EvidenceLocator,
  expectedThreadId = "123",
): Promise<ExtensionResponse> {
  return new Promise((resolve) => {
    listener(
      {
        type: "JUMP_TO_REPLY",
        locator,
        expectedThreadId,
      },
      {} as chrome.runtime.MessageSender,
      resolve,
    );
  });
}

describe("in-page evidence navigation", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/p/123");
  });

  it("uses Tieba's div-based ascending tab without changing the page URL", async () => {
    window.history.replaceState({}, "", "/p/123?pid=101");
    const initialUrl = window.location.href;
    document.body.innerHTML = `
      <section class="pc-pb-comments">
        <div class="pc-pb-reply-top">全部回复（268）
          <div class="sub-tab-list">
            <div class="sub-tab-item sub-tab-item-active">热门</div>
            <div id="ascending" class="sub-tab-item">正序</div>
            <div class="sub-tab-item">倒序</div>
          </div>
        </div>
        <div class="pc-pb-reply-list"><div class="thread-container"></div></div>
      </section>
    `;
    const ascending = document.querySelector<HTMLButtonElement>("#ascending")!;
    const click = vi.fn(() => {
      document.querySelector(".thread-container")!.innerHTML =
        '<div class="pb-comment-item" data-id="101">目标</div>';
    });
    ascending.addEventListener("click", click);
    const listener = await loadContent();

    await expect(dispatchJump(listener, mainLocator())).resolves.toEqual({
      ok: true,
      data: true,
    });
    expect(click).toHaveBeenCalledTimes(1);
    expect(window.location.href).toBe(initialUrl);
  });

  it("locates the parent, expands a nested read control, and verifies the child id", async () => {
    document.body.innerHTML = `
      <section class="pc-pb-comments">
        <div class="pc-pb-reply-list"><div class="thread-container">
          <div class="pb-comment-item" data-id="101">
            <div class="lzl-wrapper"><button id="more" class="show-more-lzl">展开 3 条回复</button></div>
          </div>
        </div></div>
      </section>
    `;
    const more = document.querySelector<HTMLButtonElement>("#more")!;
    const click = vi.fn(() => {
      more.insertAdjacentHTML(
        "beforebegin",
        '<div class="pb-lzl-item" data-spid="201">楼中楼目标</div>',
      );
    });
    more.addEventListener("click", click);
    const listener = await loadContent();
    const locator = mainLocator({
      replyId: "201",
      siteReplyId: "201",
      anchor: '[data-spid="201"]',
      parentReplyId: "101",
      parentSiteReplyId: "101",
      parentAnchor: '.pb-comment-item[data-id="101"]',
      isNested: true,
    });

    await expect(dispatchJump(listener, locator)).resolves.toEqual({
      ok: true,
      data: true,
    });
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("never double-clicks one unchanged expansion control", async () => {
    document.body.innerHTML = `
      <section class="pc-pb-comments"><div class="pc-pb-reply-list">
        <div class="pb-comment-item" data-id="101">
          <button id="more" class="show-more-lzl">查看更多回复</button>
        </div>
      </div></section>
    `;
    const more = document.querySelector<HTMLButtonElement>("#more")!;
    const click = vi.fn();
    more.addEventListener("click", click);
    const listener = await loadContent();
    const initialUrl = window.location.href;
    const response = await dispatchJump(
      listener,
      mainLocator({
        replyId: "201",
        siteReplyId: null,
        anchor: '[data-kr-review-reply-id="opaque-201"]',
        parentReplyId: "101",
        parentSiteReplyId: "101",
        parentAnchor: '.pb-comment-item[data-id="101"]',
        isNested: true,
      }),
    );

    expect(response).toMatchObject({ ok: false, code: "EVIDENCE_NOT_LOADED" });
    expect(click).toHaveBeenCalledTimes(1);
    expect(window.location.href).toBe(initialUrl);
  });

  it("does not click a moderation control whose visible words resemble expansion", async () => {
    document.body.innerHTML = `
      <section class="pc-pb-comments"><div class="pc-pb-reply-list">
        <div class="pb-comment-item" data-id="101">
          <button id="unsafe" class="manage-more" aria-label="管理回复">查看更多回复</button>
        </div>
      </div></section>
    `;
    const unsafe = document.querySelector<HTMLButtonElement>("#unsafe")!;
    const click = vi.fn();
    unsafe.addEventListener("click", click);
    const listener = await loadContent();
    const response = await dispatchJump(
      listener,
      mainLocator({
        replyId: "201",
        siteReplyId: null,
        anchor: '[data-kr-review-reply-id="opaque-201"]',
        parentReplyId: "101",
        parentSiteReplyId: "101",
        parentAnchor: '.pb-comment-item[data-id="101"]',
        isNested: true,
      }),
    );

    expect(response).toMatchObject({ ok: false, code: "EVIDENCE_NOT_LOADED" });
    expect(click).not.toHaveBeenCalled();
  });

  it("cancels an older scan when a newer evidence click arrives", async () => {
    document.body.innerHTML = `
      <section class="pc-pb-comments">
        <div class="pc-pb-reply-top"><button role="tab" aria-selected="true">正序</button></div>
        <div class="pc-pb-reply-list"><div class="thread-container">
          <div class="pb-comment-item" data-id="202">新目标</div>
        </div></div>
      </section>
    `;
    const listener = await loadContent();
    const oldJump = dispatchJump(listener, mainLocator({ replyId: "missing", siteReplyId: "missing" }));
    await new Promise((resolve) => window.setTimeout(resolve, 10));
    const newJump = dispatchJump(
      listener,
      mainLocator({
        replyId: "202",
        siteReplyId: "202",
        anchor: '.pb-comment-item[data-id="202"]',
      }),
    );

    await expect(newJump).resolves.toEqual({ ok: true, data: true });
    await expect(oldJump).resolves.toMatchObject({
      ok: false,
      code: "CAPTURE_CANCELLED",
    });
  });

  it("rejects a queued jump delivered after the tab has already changed threads", async () => {
    window.history.replaceState({}, "", "/p/999");
    document.body.innerHTML = `
      <section class="pc-pb-comments">
        <div class="pc-pb-reply-top"><button id="ascending" role="tab">正序</button></div>
        <div class="pc-pb-reply-list"><div class="thread-container">
          <button id="more" class="show-more">加载更多回复</button>
          <div class="pb-comment-item" data-id="101">B 帖中恰好同 PID 的内容</div>
        </div></div>
      </section>
    `;
    const sortClick = vi.fn();
    const expandClick = vi.fn();
    document.querySelector("#ascending")!.addEventListener("click", sortClick);
    document.querySelector("#more")!.addEventListener("click", expandClick);
    const listener = await loadContent();

    await expect(
      dispatchJump(listener, mainLocator(), "123"),
    ).resolves.toMatchObject({ ok: false, code: "SESSION_STALE" });
    expect(sortClick).not.toHaveBeenCalled();
    expect(expandClick).not.toHaveBeenCalled();
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    expect(window.scrollTo).not.toHaveBeenCalled();
  });
});
