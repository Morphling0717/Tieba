import { SCHEMA_VERSION } from "../types";
import type {
  CapturedReply,
  ParserVariant,
  ThreadCapture,
} from "../types";

type UnknownRecord = Record<string, unknown>;

const MAIN_POST_SELECTOR = ".l_post";
const NESTED_POST_SELECTOR = ".lzl_single_post";
const SPA_FIRST_FLOOR_SELECTOR = ".image-text, .score-thread, .recruit-thread";
const SPA_COMMENT_SELECTOR = ".pb-comment-item[data-id]";
const SPA_REPLY_TOP_SELECTOR = ".pc-pb-reply-top";
const SPA_RUNTIME_REPLY_ID_ATTRIBUTE = "data-kr-review-reply-id";
const DOCUMENT_INSTANCE_ID_ATTRIBUTE =
  "data-kr-review-document-instance-id";
const CONTENT_SELECTOR =
  ".d_post_content, .j_d_post_content, [id^='post_content_']";
const NESTED_CONTENT_SELECTOR =
  ".lzl_content_main, .j_lzl_content, .lzl_content";
const DELETED_OR_FOLDED_PATTERN =
  /(?:该|此)?(?:楼层|回复|内容|帖子).{0,8}(?:已被?|被)?(?:删除|折叠|屏蔽|隐藏)|(?:删除|折叠|屏蔽)提示/u;
const DATE_TIME_PATTERN =
  /(?:20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?|\d{1,2}[-/.月]\d{1,2}(?:日)?\s+\d{1,2}:\d{2}|今天\s*\d{1,2}:\d{2}|昨天\s*\d{1,2}:\d{2})/u;
const RELATIVE_TIME_PATTERN =
  /(?:刚刚|(?:\d+(?:\.\d+)?)\s*(?:秒|分钟|小时|天|周|个月|月|年)前|昨天|前天)/u;

export type TiebaDocumentInspection =
  | { status: "ready"; parserVariant: ParserVariant }
  | { status: "not_ready"; message: string }
  | { status: "unsupported"; message: string };

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function atPath(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" || typeof value === "number") {
      const result = String(value).trim();
      if (result) return result;
    }
  }
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.trunc(value);
    }
    if (typeof value === "string") {
      const match = value.trim().match(/^\d+$/u);
      if (match) return Number(match[0]);
    }
  }
  return null;
}

function normalizedText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/[\u200b-\u200d\ufeff]/gu, "")
    .replace(/[\t\r\n\u00a0 ]+/gu, " ")
    .trim();
}

function parseDataField(element: Element): {
  data: UnknownRecord;
  malformed: boolean;
  present: boolean;
} {
  const raw = element.getAttribute("data-field");
  if (!raw?.trim()) return { data: {}, malformed: false, present: false };

  try {
    const parsed: unknown = JSON.parse(raw);
    return {
      data: isRecord(parsed) ? parsed : {},
      malformed: !isRecord(parsed),
      present: true,
    };
  } catch {
    return { data: {}, malformed: true, present: true };
  }
}

function contentFromHtml(
  document: Document,
  value: unknown,
): { content: string; imageCount: number } {
  if (typeof value !== "string" || !value.trim()) {
    return { content: "", imageCount: 0 };
  }
  const template = document.createElement("template");
  template.innerHTML = value;
  return {
    content: normalizedText(template.content.textContent),
    imageCount: template.content.querySelectorAll("img").length,
  };
}

function selectorFor(element: Element): string {
  const id = element.getAttribute("id");
  if (id) return `[id="${id.replace(/["\\]/gu, "\\$&")}"]`;

  const segments: string[] = [];
  let current: Element | null = element;
  while (current && current !== current.ownerDocument.documentElement) {
    if (current === current.ownerDocument.body) {
      segments.unshift("body");
      break;
    }

    const currentId = current.getAttribute("id");
    if (currentId) {
      segments.unshift(
        `[id="${currentId.replace(/["\\]/gu, "\\$&")}"]`,
      );
      break;
    }

    const tag = current.tagName.toLowerCase();
    const parent: Element | null = current.parentElement;
    if (!parent) {
      segments.unshift(tag);
      break;
    }
    const siblings = Array.from(parent.children).filter(
      (candidate) => candidate.tagName === current?.tagName,
    );
    const position = siblings.indexOf(current) + 1;
    segments.unshift(
      siblings.length > 1 ? `${tag}:nth-of-type(${position})` : tag,
    );
    current = parent;
  }

  return segments.join(" > ") || MAIN_POST_SELECTOR;
}

function numberFromUrl(url: URL, name: string): number | null {
  const raw = url.searchParams.get(name);
  if (!raw || !/^\d+$/u.test(raw)) return null;
  const value = Number(raw);
  return value > 0 ? value : null;
}

function pageNumberFromUrl(url: URL): number {
  return numberFromUrl(url, "pn") ?? 1;
}

function threadIdFromUrl(url: URL): string | null {
  return url.pathname.match(/\/p\/(\d+)(?:\/|$)/u)?.[1] ?? null;
}

function extractTitle(document: Document): string {
  const titleElement = document.querySelector(
    ".core_title_txt, [data-testid='thread-title'], .pc-pb-title, h1",
  );
  const explicitTitle = firstString(
    titleElement?.getAttribute("title"),
    titleElement?.textContent,
  );
  if (explicitTitle) return normalizedText(explicitTitle);

  return normalizedText(document.title)
    .replace(/[_-]?百度贴吧\s*$/u, "")
    .trim();
}

function floorFromElement(element: Element, data: UnknownRecord): number | null {
  const fromData = firstNumber(
    atPath(data, "content", "post_no"),
    atPath(data, "content", "floor"),
    data.post_no,
    element.getAttribute("data-floor"),
  );
  if (fromData !== null) return fromData;

  for (const candidate of element.querySelectorAll(
    ".tail-info, .post-tail-wrap span, [class*='floor']",
  )) {
    const floor = normalizedText(candidate.textContent).match(/(\d+)\s*楼/u)?.[1];
    if (floor) return Number(floor);
  }
  return null;
}

function authorFromMain(element: Element, data: UnknownRecord): string | null {
  return firstString(
    atPath(data, "author", "user_name"),
    atPath(data, "author", "user_nickname"),
    atPath(data, "author", "name"),
    element.querySelector(".p_author_name")?.getAttribute("username"),
    element.querySelector(".p_author_name")?.getAttribute("data-name"),
    element.querySelector(".p_author_name")?.textContent,
    element.querySelector(".d_name .j_user_card, .d_name")?.textContent,
  );
}

function authorFromNested(element: Element, data: UnknownRecord): string | null {
  const userCard = element.querySelector(".j_user_card, .lzl_p_p a");
  const cardData = userCard ? parseDataField(userCard).data : {};
  return firstString(
    data.user_name,
    data.user_nickname,
    atPath(data, "author", "user_name"),
    cardData.un,
    cardData.user_name,
    userCard?.getAttribute("username"),
    userCard?.getAttribute("data-name"),
    userCard?.textContent,
  );
}

function timeFromElement(
  element: Element,
  dataValues: unknown[],
): string | null {
  const fromData = firstString(...dataValues);
  if (fromData && !/^\d{9,13}$/u.test(fromData)) return fromData;

  const preferred = element.querySelector(
    ".lzl_time, .tail-info, time, [class*='time']",
  );
  const candidates = preferred
    ? [preferred, ...element.querySelectorAll(".tail-info, time")]
    : [...element.querySelectorAll(".tail-info, time")];
  for (const candidate of candidates) {
    const text = normalizedText(candidate.textContent);
    const match = text.match(DATE_TIME_PATTERN)?.[0];
    if (match) return match;
  }

  if (fromData) {
    const numeric = Number(fromData);
    const milliseconds = fromData.length <= 10 ? numeric * 1000 : numeric;
    const date = new Date(milliseconds);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return null;
}

function timestampFromTime(time: string | null, rawValues: unknown[]): number | null {
  for (const value of rawValues) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value < 10_000_000_000 ? value * 1000 : value;
    }
    if (typeof value === "string" && /^\d{9,13}$/u.test(value.trim())) {
      const numeric = Number(value);
      return value.trim().length <= 10 ? numeric * 1000 : numeric;
    }
  }
  if (!time) return null;
  const parsed = Date.parse(time.replace(/年|月/gu, "-").replace(/日/gu, ""));
  return Number.isNaN(parsed) ? null : parsed;
}

function stateNotice(element: Element): string {
  const likelyNotice = element.querySelector(
    ".deleted, .post_deleted, .lzl_post_deleted, .folded, .post_fold, .j_post_fold, [class*='delete'], [class*='fold']",
  );
  const preferred = normalizedText(likelyNotice?.textContent);
  if (preferred && DELETED_OR_FOLDED_PATTERN.test(preferred)) return preferred;

  const allText = normalizedText(element.textContent);
  return allText.match(DELETED_OR_FOLDED_PATTERN)?.[0] ?? "";
}

function mainPostId(
  element: Element,
  data: UnknownRecord,
  threadId: string | null,
  pageNumber: number,
  floor: number | null,
  index: number,
): string {
  return (
    legacyMainSiteReplyId(element, data) ??
    `${threadId ?? "thread"}-page-${pageNumber}-floor-${floor ?? index + 1}`
  );
}

function legacyMainSiteReplyId(
  element: Element,
  data: UnknownRecord,
): string | null {
  const contentId = element
    .querySelector(CONTENT_SELECTOR)
    ?.getAttribute("id")
    ?.match(/(\d+)/u)?.[1];
  return firstString(
    atPath(data, "content", "post_id"),
    data.post_id,
    element.getAttribute("data-pid"),
    element.getAttribute("data-post-id"),
    contentId,
  );
}

function nestedPostId(
  element: Element,
  data: UnknownRecord,
  parentId: string,
  index: number,
): string {
  return (
    legacyNestedSiteReplyId(element, data) ??
    `${parentId}-nested-${index + 1}`
  );
}

function legacyNestedSiteReplyId(
  element: Element,
  data: UnknownRecord,
): string | null {
  return firstString(
    data.spid,
    data.comment_id,
    data.id,
    atPath(data, "content", "post_id"),
    element.getAttribute("data-spid"),
    element.getAttribute("data-id"),
  );
}

function nestedParentId(
  element: Element,
  data: UnknownRecord,
  mainPostId: string,
  currentPostId: string,
): string {
  const candidate = firstString(
    data.reply_to_id,
    data.reply_id,
    data.parent_id,
    atPath(data, "content", "reply_to_id"),
    atPath(data, "content", "reply_id"),
    atPath(data, "content", "parent_id"),
    element.getAttribute("data-reply-to"),
    element.getAttribute("data-parent-id"),
  );
  return candidate && candidate !== currentPostId ? candidate : mainPostId;
}

function extractMainContent(
  document: Document,
  element: Element,
  data: UnknownRecord,
): { content: string; imageCount: number; target: Element } {
  const contentElement = element.querySelector(CONTENT_SELECTOR);
  const visible = normalizedText(contentElement?.textContent);
  const fallback = contentFromHtml(
    document,
    atPath(data, "content", "content") ?? data.content,
  );
  return {
    content: visible || fallback.content || stateNotice(element),
    imageCount: Math.max(
      contentElement?.querySelectorAll("img").length ?? 0,
      fallback.imageCount,
    ),
    target: contentElement ?? element,
  };
}

function extractNestedContent(
  document: Document,
  element: Element,
  data: UnknownRecord,
): { content: string; imageCount: number; target: Element } {
  const contentElement = element.querySelector(NESTED_CONTENT_SELECTOR);
  const visible = normalizedText(contentElement?.textContent);
  const fallback = contentFromHtml(
    document,
    data.content ?? atPath(data, "content", "content"),
  );
  return {
    content: visible || fallback.content || stateNotice(element),
    imageCount: Math.max(
      contentElement?.querySelectorAll("img").length ?? 0,
      fallback.imageCount,
    ),
    target: contentElement ?? element,
  };
}

function parseUnexpandedCount(
  mainPost: Element,
  data: UnknownRecord,
  visibleNestedCount: number,
): number {
  const declaredTotal = firstNumber(
    atPath(data, "content", "comment_num"),
    atPath(data, "content", "comment_count"),
    data.comment_num,
  );
  let estimate = declaredTotal === null
    ? 0
    : Math.max(0, declaredTotal - visibleNestedCount);

  const controls = mainPost.querySelectorAll(
    ".lzl_more, .j_lzl_more, .j_lzl_m_w, .lzl_link_unfold, [class*='lzl_more']",
  );
  for (const control of controls) {
    const text = normalizedText(control.textContent);
    const remaining = text.match(/(?:还有|剩余)\s*(\d+)\s*条/u)?.[1];
    if (remaining) {
      estimate = Math.max(estimate, Number(remaining));
      continue;
    }
    const total = text.match(/(?:共|全部|查看全部)\s*(\d+)\s*条/u)?.[1];
    if (total) {
      estimate = Math.max(estimate, Number(total) - visibleNestedCount);
      continue;
    }
    // Some Tieba variants expose only “展开回复/查看更多”. The exact count is
    // unknown, but treating that control as zero would falsely claim coverage.
    if (text && !/收起/u.test(text) && /展开|更多|查看/u.test(text)) {
      estimate = Math.max(estimate, 1);
    }
  }
  return estimate;
}

function maxKnownPage(document: Document, url: URL, threadId: string | null): number {
  let maximum = pageNumberFromUrl(url);
  const explicit = firstNumber(
    document.documentElement.getAttribute("data-total-page"),
    document.body?.getAttribute("data-total-page"),
    document.querySelector("[data-total-page]")?.getAttribute("data-total-page"),
  );
  if (explicit !== null) maximum = Math.max(maximum, explicit);

  for (const anchor of document.querySelectorAll<HTMLAnchorElement>(
    ".l_pager a, .pager a, .pb_list_pager a, a[href*='pn=']",
  )) {
    try {
      const target = new URL(anchor.href, url);
      const targetThreadId = threadIdFromUrl(target);
      if (threadId && targetThreadId !== threadId) continue;
      maximum = Math.max(maximum, pageNumberFromUrl(target));
    } catch {
      // An invalid unrelated link does not reduce the known page count.
    }
  }
  return maximum;
}

function singlePageIsProven(document: Document, maxPage: number): boolean {
  if (maxPage !== 1) return false;
  const explicit = firstNumber(
    document.documentElement.getAttribute("data-total-page"),
    document.body?.getAttribute("data-total-page"),
    document.querySelector("[data-total-page]")?.getAttribute("data-total-page"),
  );
  if (explicit === 1) return true;

  const paginationText = normalizedText(
    document.querySelector(".l_pager, .pager, .pb_list_pager")?.textContent,
  );
  return /共\s*1\s*页/u.test(paginationText);
}

function quotedAttributeSelector(name: string, value: string): string {
  const escaped = value.replace(/["\\]/gu, "\\$&");
  return `[${name}="${escaped}"]`;
}

function randomOpaqueId(prefix: string): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return `${prefix}-${randomUuid}`;
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    const values = globalThis.crypto.getRandomValues(new Uint32Array(4));
    return `${prefix}-${[...values]
      .map((value) => value.toString(36))
      .join("")}`;
  }
  return `${prefix}-${Math.random().toString(36).slice(2)}`;
}

function compactCount(value: string | null | undefined): number | null {
  const match = normalizedText(value)
    .replace(/,/gu, "")
    .match(/(\d+(?:\.\d+)?)\s*(\u4e07)?/u);
  if (!match) return null;
  const numeric = Number(match[1]);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.floor(numeric * (match[2] ? 10_000 : 1)));
}

function textTimeFromText(text: string): string | null {
  return text.match(DATE_TIME_PATTERN)?.[0]
    ?? text.match(RELATIVE_TIME_PATTERN)?.[0]
    ?? null;
}

function spaFirstFloorTime(element: Element): string | null {
  const candidates = [
    ...element.querySelectorAll(":scope > .user-info .post-num"),
    ...element.querySelectorAll(":scope > .user-info"),
    ...element.querySelectorAll(":scope > .rel-thread-time"),
  ];

  for (const candidate of candidates) {
    const absolute = normalizedText(candidate.textContent)
      .match(DATE_TIME_PATTERN)?.[0];
    if (absolute) return absolute;
  }
  for (const candidate of candidates) {
    const relative = normalizedText(candidate.textContent)
      .match(RELATIVE_TIME_PATTERN)?.[0];
    if (relative) return relative;
  }
  return null;
}

function directChildWithClass(
  element: Element,
  className: string,
): Element | null {
  for (
    let child = element.firstElementChild;
    child;
    child = child.nextElementSibling
  ) {
    if (child.classList.contains(className)) return child;
  }
  return null;
}

function firstDescendantWithClass(
  element: Element,
  className: string,
): Element | null {
  const pending: Element[] = [];
  if (element.firstElementChild) pending.push(element.firstElementChild);

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    if (current.classList.contains(className)) return current;
    if (current.nextElementSibling) pending.push(current.nextElementSibling);
    if (current.firstElementChild) pending.push(current.firstElementChild);
  }
  return null;
}

function spaCommentContent(element: Element): Element | null {
  return directChildWithClass(element, "comment-content");
}

function spaContentTarget(
  element: Element,
  firstFloor = false,
  knownCommentContent?: Element | null,
): Element | null {
  const container = firstFloor
    ? element
    : knownCommentContent === undefined
      ? spaCommentContent(element)
      : knownCommentContent;
  if (!container) return null;
  return directChildWithClass(
    container,
    firstFloor ? "pb-content-wrap" : "pb-rich-text",
  );
}

function spaDescriptionTarget(
  element: Element,
  commentContent = spaCommentContent(element),
): Element | null {
  if (!commentContent) return null;
  for (
    let child = commentContent.firstElementChild;
    child;
    child = child.nextElementSibling
  ) {
    if (child.classList.contains("comment-desc-left")) return child;
    if (child.classList.contains("pc-pb-comments-desc")) {
      const description = firstDescendantWithClass(
        child,
        "comment-desc-left",
      );
      if (description) return description;
    }
  }
  return null;
}

function spaAuthorName(element: Element): string | null {
  const userInfo = directChildWithClass(element, "user-info");
  return firstString(
    userInfo
      ? firstDescendantWithClass(userInfo, "head-name")?.textContent
      : null,
  );
}

interface SpaDocumentIndexes {
  comments: Element[];
  nestedByComment: Map<Element, Element[]>;
  unexpandedByComment: Map<Element, number>;
  imageCountByBoundary: Map<Element, number>;
}

function nearestSpaComment(element: Element): Element | null {
  let current: Element | null = element.parentElement;
  while (current) {
    if (
      current.classList.contains("pb-comment-item") &&
      current.hasAttribute("data-id")
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function isSpaReplyBoundary(element: Element): boolean {
  return (
    element.classList.contains("pb-comment-item") ||
    element.classList.contains("pb-lzl-item") ||
    element.classList.contains("image-text") ||
    element.classList.contains("score-thread") ||
    element.classList.contains("recruit-thread")
  );
}

/**
 * Builds the descendant indexes once for the whole SPA document. Calling
 * `getElementsBy*` separately for every mounted reply is disproportionately
 * expensive in large DOMs (and especially in jsdom), while all of these
 * relationships are stable for the duration of one synchronous capture.
 */
function indexSpaDocument(document: Document): SpaDocumentIndexes {
  const comments: Element[] = [];
  for (const element of document.getElementsByClassName("pb-comment-item")) {
    if (!element.hasAttribute("data-id")) continue;
    comments.push(element);
  }

  const nestedByComment = new Map<Element, Element[]>();
  for (const nested of document.getElementsByClassName("pb-lzl-item")) {
    if (!nested.parentElement?.classList.contains("lzl-wrapper")) continue;
    const owner = nearestSpaComment(nested);
    if (!owner) continue;
    const existing = nestedByComment.get(owner);
    if (existing) existing.push(nested);
    else nestedByComment.set(owner, [nested]);
  }

  const unexpandedByComment = new Map<Element, number>();
  for (const control of document.getElementsByClassName("show-more-lzl")) {
    const owner = nearestSpaComment(control);
    if (!owner) continue;
    const text = normalizedText(control.textContent);
    const explicit = text.match(
      /(?:\u5c55\u5f00|\u8fd8\u6709|\u5269\u4f59|\u66f4\u591a)\s*([\d.,]+\s*\u4e07?)\s*\u6761?\s*\u56de\u590d/u,
    )?.[1];
    const parsed = compactCount(explicit);
    const count = parsed ?? (text && !/\u6536\u8d77/u.test(text) ? 1 : 0);
    if (count > 0) {
      unexpandedByComment.set(
        owner,
        (unexpandedByComment.get(owner) ?? 0) + count,
      );
    }
  }

  const imageCountByBoundary = new Map<Element, number>();
  for (const image of document.getElementsByTagName("img")) {
    let owner: Element | null = image.parentElement;
    let isContentImage = false;
    while (owner) {
      if (
        owner.classList.contains("image-card-wrapper") ||
        owner.classList.contains("pb-content-wrap")
      ) {
        isContentImage = true;
      }
      if (isSpaReplyBoundary(owner)) {
        if (isContentImage) {
          imageCountByBoundary.set(
            owner,
            (imageCountByBoundary.get(owner) ?? 0) + 1,
          );
        }
        break;
      }
      owner = owner.parentElement;
    }
  }

  return {
    comments,
    nestedByComment,
    unexpandedByComment,
    imageCountByBoundary,
  };
}

function spaStateNotice(
  element: Element,
  contentText: string,
  firstFloor = false,
  knownCommentContent?: Element | null,
): string {
  const container = firstFloor
    ? element
    : knownCommentContent === undefined
      ? spaCommentContent(element)
      : knownCommentContent;
  let directNotice: Element | null = null;
  if (container) {
    for (const child of container.children) {
      const classValue = child.getAttribute("class") ?? "";
      if (classValue.includes("delete") || classValue.includes("fold")) {
        directNotice = child;
        break;
      }
    }
  }
  const ownText = `${contentText} ${normalizedText(directNotice?.textContent)}`;
  return ownText.match(DELETED_OR_FOLDED_PATTERN)?.[0] ?? "";
}

function spaDeclaredReplyCount(document: Document): number | null {
  const text = normalizedText(
    document.querySelector(SPA_REPLY_TOP_SELECTOR)?.textContent,
  );
  const replyScoped = text.match(
    /(?:\u5168\u90e8)?\u56de\u590d\s*[\uff08(]?\s*([\d.,]+\s*\u4e07?)/u,
  )?.[1];
  return compactCount(replyScoped);
}

function spaReachedReplyListEnd(document: Document): boolean {
  const endCandidates = document.querySelectorAll(
    ".pc-pb-reply-list .loading, .pc-pb-reply-list [class*='no-more'], .thread-container [class*='no-more']",
  );
  if (
    [...endCandidates].some((element) =>
      /\u5df2\u52a0\u8f7d\u5168\u90e8\u8bc4\u8bba|\u5df2\u7ecf\u5230\u5e95|\u6ca1\u6709\u66f4\u591a/u.test(normalizedText(element.textContent)),
    )
  ) {
    return true;
  }

  const emptyText = normalizedText(
    document.querySelector(".pc-pb-reply-list .empty")?.textContent,
  );
  return /\u522b\u8ba9\u697c\u4e3b\u5bc2\u5bde|\u697c\u4e3b\u592a\u61d2/u.test(emptyText);
}

function guessedParserVariant(document: Document): ParserVariant {
  return document.querySelector(
    `#app, ${SPA_FIRST_FLOOR_SELECTOR}, ${SPA_REPLY_TOP_SELECTOR}, .pc-pb-reply-list`,
  )
    ? "spa"
    : "legacy";
}

/**
 * Distinguishes a still-hydrating CSR page from a rendered but unknown layout.
 * Callers may poll `not_ready`; `unsupported` should fail immediately.
 */
export function inspectTiebaDocument(
  document: Document,
  url: string,
): TiebaDocumentInspection {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url, "https://tieba.baidu.com");
  } catch {
    return {
      status: "unsupported",
      message: "\u9875\u9762\u5730\u5740\u65e0\u6548\uff0c\u65e0\u6cd5\u8bc6\u522b\u8d34\u5427\u5e16\u5b50\u3002",
    };
  }

  if (document.querySelector(MAIN_POST_SELECTOR)) {
    return { status: "ready", parserVariant: "legacy" };
  }
  if (
    document.querySelector(SPA_FIRST_FLOOR_SELECTOR) ||
    document.querySelector(SPA_COMMENT_SELECTOR)
  ) {
    return { status: "ready", parserVariant: "spa" };
  }

  if (!threadIdFromUrl(parsedUrl)) {
    return {
      status: "unsupported",
      message: "\u5f53\u524d\u9875\u9762\u4e0d\u662f\u53ef\u8bc6\u522b\u7684\u8d34\u5427\u5e16\u5b50\u9875\uff1a\u672a\u627e\u5230\u697c\u5c42\u5185\u5bb9\u3002",
    };
  }

  const app = document.querySelector("#app");
  const hasLoadingUi = Boolean(
    document.querySelector(
      ".loading-wrapper, .text-loading, .t-loading, [class*='skeleton']",
    ),
  );
  const hasRenderedThreadSemantics = Boolean(
    document.querySelector(
      `${SPA_REPLY_TOP_SELECTOR}, .pc-pb-reply-list, .pc-pb-comments, .pc-pb-title`,
    ),
  ) || /\u5168\u90e8\u56de\u590d|\u53ea\u770b\u697c\u4e3b/u.test(normalizedText(document.body?.textContent));

  if (
    hasLoadingUi ||
    (app !== null && !normalizedText(app.textContent) && !hasRenderedThreadSemantics)
  ) {
    return {
      status: "not_ready",
      message: "\u8d34\u5427\u5e16\u5b50\u4ecd\u5728\u52a0\u8f7d\uff0c\u5c1a\u672a\u51fa\u73b0\u53ef\u8bc6\u522b\u7684\u697c\u5c42\u5185\u5bb9\u3002",
    };
  }

  return {
    status: "unsupported",
    message: "\u5f53\u524d\u8d34\u5427\u5e16\u5b50\u91c7\u7528\u4e86\u5c1a\u4e0d\u652f\u6301\u7684\u9875\u9762\u7ed3\u6784\uff0c\u672a\u627e\u5230\u697c\u5c42\u5185\u5bb9\u3002",
  };
}

/**
 * Reads only the supplied document and URL. It never expands replies, performs
 * network requests, or mutates the page, so callers can decide when to capture.
 */
function parseLegacyDocument(document: Document, url: string): ThreadCapture {
  let parsedUrl: URL;
  const errors: string[] = [];
  const warnings: string[] = [];
  try {
    parsedUrl = new URL(url, "https://tieba.baidu.com");
  } catch {
    parsedUrl = new URL("https://tieba.baidu.com/");
    errors.push("页面地址无效，无法识别帖子 ID 与页码。");
  }

  const pageNumber = pageNumberFromUrl(parsedUrl);
  const threadId = threadIdFromUrl(parsedUrl);
  const mainPosts = Array.from(document.querySelectorAll(MAIN_POST_SELECTOR));
  const replies: CapturedReply[] = [];
  let unexpandedLzlCount = 0;
  let malformedDataFieldCount = 0;
  let missingDataFieldCount = 0;
  let missingContentCount = 0;
  let stateNoticeCount = 0;

  if (!threadId) warnings.push("页面地址中未找到 /p/{帖子ID}，帖子 ID 未知。");
  if (mainPosts.length === 0) {
    errors.push("当前页面不是可识别的贴吧帖子页：未找到楼层内容。");
  }

  for (const [mainIndex, mainPost] of mainPosts.entries()) {
    const parsed = parseDataField(mainPost);
    if (!parsed.present) missingDataFieldCount += 1;
    if (parsed.malformed) malformedDataFieldCount += 1;

    const floor = floorFromElement(mainPost, parsed.data);
    const id = mainPostId(
      mainPost,
      parsed.data,
      threadId,
      pageNumber,
      floor,
      mainIndex,
    );
    const extracted = extractMainContent(document, mainPost, parsed.data);
    if (!extracted.content) missingContentCount += 1;
    if (stateNotice(mainPost)) stateNoticeCount += 1;
    const rawTimes = [
      atPath(parsed.data, "content", "date"),
      atPath(parsed.data, "content", "time"),
      atPath(parsed.data, "content", "timestamp"),
      parsed.data.time,
    ];
    const time = timeFromElement(mainPost, rawTimes);

    const mainReply: CapturedReply = {
      id,
      siteReplyId: legacyMainSiteReplyId(mainPost, parsed.data),
      floor,
      parentReplyId: null,
      authorName: authorFromMain(mainPost, parsed.data),
      time,
      timestamp: timestampFromTime(time, rawTimes),
      content: extracted.content,
      sourcePage: pageNumber,
      sourceUrl: parsedUrl.href,
      anchor: selectorFor(extracted.target),
      imageCount: extracted.imageCount,
      isNested: false,
      unexpandedNestedCount: 0,
    };
    replies.push(mainReply);

    const nestedPosts = Array.from(
      mainPost.querySelectorAll(NESTED_POST_SELECTOR),
    );
    const unexpandedForMain = parseUnexpandedCount(
      mainPost,
      parsed.data,
      nestedPosts.length,
    );
    mainReply.unexpandedNestedCount = unexpandedForMain;
    unexpandedLzlCount += unexpandedForMain;

    for (const [nestedIndex, nestedPost] of nestedPosts.entries()) {
      const nestedParsed = parseDataField(nestedPost);
      if (!nestedParsed.present) missingDataFieldCount += 1;
      if (nestedParsed.malformed) malformedDataFieldCount += 1;
      const nestedExtracted = extractNestedContent(
        document,
        nestedPost,
        nestedParsed.data,
      );
      if (!nestedExtracted.content) missingContentCount += 1;
      if (stateNotice(nestedPost)) stateNoticeCount += 1;
      const rawNestedTimes = [
        nestedParsed.data.time,
        nestedParsed.data.date,
        nestedParsed.data.timestamp,
        atPath(nestedParsed.data, "content", "date"),
      ];
      const nestedTime = timeFromElement(nestedPost, rawNestedTimes);

      const nestedId = nestedPostId(
        nestedPost,
        nestedParsed.data,
        id,
        nestedIndex,
      );
      replies.push({
        id: nestedId,
        siteReplyId: legacyNestedSiteReplyId(
          nestedPost,
          nestedParsed.data,
        ),
        floor,
        parentReplyId: nestedParentId(
          nestedPost,
          nestedParsed.data,
          id,
          nestedId,
        ),
        authorName: authorFromNested(nestedPost, nestedParsed.data),
        time: nestedTime,
        timestamp: timestampFromTime(nestedTime, rawNestedTimes),
        content: nestedExtracted.content,
        sourcePage: pageNumber,
        sourceUrl: parsedUrl.href,
        anchor: selectorFor(nestedExtracted.target),
        imageCount: nestedExtracted.imageCount,
        isNested: true,
        unexpandedNestedCount: 0,
      });
    }
  }

  if (malformedDataFieldCount > 0) {
    warnings.push(
      `${malformedDataFieldCount} 条回复的 data-field 无法解析，已改用页面可见信息。`,
    );
  }
  if (missingDataFieldCount > 0) {
    warnings.push(
      `${missingDataFieldCount} 条回复缺少 data-field，部分作者、时间或楼层信息可能缺失。`,
    );
  }
  if (missingContentCount > 0) {
    errors.push(`${missingContentCount} 条可见回复未能读取正文。`);
  }
  if (stateNoticeCount > 0) {
    warnings.push(
      `${stateNoticeCount} 条回复显示删除、折叠或屏蔽提示，正文可能不完整。`,
    );
  }
  if (unexpandedLzlCount > 0) {
    warnings.push(`估计仍有 ${unexpandedLzlCount} 条楼中楼回复未展开。`);
  }

  const imageCount = replies.reduce(
    (total, reply) => total + reply.imageCount,
    0,
  );
  if (imageCount > 0) {
    warnings.push(`检测到 ${imageCount} 张图片；当前版本不识别图片文字。`);
  }

  const maxPage = maxKnownPage(document, parsedUrl, threadId);
  if (maxPage > 1) {
    warnings.push(`该帖至少有 ${maxPage} 页，本次只分析了第 ${pageNumber} 页。`);
  }

  const mainReplyCount = replies.filter((reply) => !reply.isNested).length;
  const nestedReplyCount = replies.length - mainReplyCount;
  const isComplete =
    errors.length === 0 &&
    malformedDataFieldCount === 0 &&
    missingDataFieldCount === 0 &&
    unexpandedLzlCount === 0 &&
    imageCount === 0 &&
    stateNoticeCount === 0 &&
    singlePageIsProven(document, maxPage);

  return {
    schemaVersion: SCHEMA_VERSION,
    parserVariant: "legacy",
    documentInstanceId: null,
    threadId,
    url: parsedUrl.href,
    title: extractTitle(document),
    pageNumber,
    replies,
    coverage: {
      captureMode: "paginated",
      visibleReplyCount: replies.length,
      mainReplyCount,
      nestedReplyCount,
      imageCount,
      unexpandedLzlCount,
      analyzedPageNumbers: [pageNumber],
      hasUnanalyzedImages: imageCount > 0,
      declaredReplyCount: null,
      dynamicContentMayRemain: false,
      reachedReplyListEnd: false,
      unstableReplyIdCount: replies.filter(
        (reply) => reply.siteReplyId === null,
      ).length,
      isComplete,
    },
    errors,
    warnings,
    capturedAt: new Date().toISOString(),
  };
}

function parseSpaDocument(document: Document, url: string): ThreadCapture {
  let parsedUrl: URL;
  const errors: string[] = [];
  const warnings: string[] = [];
  try {
    parsedUrl = new URL(url, "https://tieba.baidu.com");
  } catch {
    parsedUrl = new URL("https://tieba.baidu.com/");
    errors.push("\u9875\u9762\u5730\u5740\u65e0\u6548\uff0c\u65e0\u6cd5\u8bc6\u522b\u5e16\u5b50 ID \u4e0e\u9875\u7801\u3002");
  }

  const pageNumber = pageNumberFromUrl(parsedUrl);
  const threadId = threadIdFromUrl(parsedUrl);
  const documentInstanceId = firstString(
    document.documentElement.getAttribute(DOCUMENT_INSTANCE_ID_ATTRIBUTE),
  );
  const replies: CapturedReply[] = [];
  let missingContentCount = 0;
  let stateNoticeCount = 0;
  let unexpandedLzlCount = 0;
  let imageCount = 0;
  let nestedReplyCount = 0;
  const indexes = indexSpaDocument(document);

  const firstFloor = document.querySelector(SPA_FIRST_FLOOR_SELECTOR);
  if (firstFloor) {
    const contentTarget = spaContentTarget(firstFloor, true);
    const contentText = normalizedText(contentTarget?.textContent);
    const stateNotice = spaStateNotice(firstFloor, contentText, true);
    const content = contentText || stateNotice;
    const firstFloorImageCount =
      indexes.imageCountByBoundary.get(firstFloor) ?? 0;
    const firstFloorSiteId = firstString(
      firstFloor.getAttribute("data-id"),
      firstFloor.getAttribute("data-pid"),
      firstFloor.getAttribute("data-post-id"),
    );
    const time = spaFirstFloorTime(firstFloor);
    const stableClass = ["image-text", "score-thread", "recruit-thread"]
      .find((className) => firstFloor.classList.contains(className));

    if (!content && firstFloorImageCount === 0) {
      warnings.push("\u4e3b\u697c\u6ca1\u6709\u53ef\u8bfb\u53d6\u7684\u6587\u5b57\u6216\u56fe\u7247\u5185\u5bb9\u3002");
    }
    if (stateNotice) stateNoticeCount += 1;
    imageCount += firstFloorImageCount;

    replies.push({
      id: firstFloorSiteId ?? `${threadId ?? "thread"}-first-floor`,
      siteReplyId: firstFloorSiteId,
      floor: 1,
      parentReplyId: null,
      authorName: spaAuthorName(firstFloor),
      time,
      timestamp: timestampFromTime(time, []),
      content,
      sourcePage: pageNumber,
      sourceUrl: parsedUrl.href,
      anchor: stableClass ? `.${stableClass}` : selectorFor(firstFloor),
      imageCount: firstFloorImageCount,
      isNested: false,
      unexpandedNestedCount: 0,
    });
  } else {
    warnings.push("\u5f53\u524d\u52a8\u6001\u89c6\u56fe\u672a\u6302\u8f7d\u4e3b\u697c\uff0c\u672c\u6b21\u53ea\u80fd\u8bfb\u53d6\u5df2\u663e\u793a\u56de\u590d\u3002");
  }

  const commentElements = indexes.comments;
  for (const commentElement of commentElements) {
    const siteReplyId = firstString(commentElement.getAttribute("data-id"));
    const id = siteReplyId ?? randomOpaqueId("kr-comment-temp");
    const commentContent = spaCommentContent(commentElement);
    const contentTarget = spaContentTarget(
      commentElement,
      false,
      commentContent,
    );
    const contentText = normalizedText(contentTarget?.textContent);
    const stateNotice = spaStateNotice(
      commentElement,
      contentText,
      false,
      commentContent,
    );
    const content = contentText || stateNotice;
    const description = spaDescriptionTarget(commentElement, commentContent);
    const descriptionText = normalizedText(description?.textContent);
    const floorMatch = descriptionText.match(
      /(?:\u7b2c\s*)?(\d+)\s*\u697c/u,
    );
    const floor = floorMatch ? Number(floorMatch[1]) : null;
    const time = textTimeFromText(descriptionText);
    const nestedElements = indexes.nestedByComment.get(commentElement) ?? [];
    const unexpandedForMain =
      indexes.unexpandedByComment.get(commentElement) ?? 0;
    const mainImageCount =
      indexes.imageCountByBoundary.get(commentElement) ?? 0;

    if (!content && mainImageCount === 0) missingContentCount += 1;
    if (stateNotice) stateNoticeCount += 1;
    unexpandedLzlCount += unexpandedForMain;
    imageCount += mainImageCount;

    replies.push({
      id,
      siteReplyId,
      floor,
      parentReplyId: null,
      authorName: spaAuthorName(commentElement),
      time,
      timestamp: timestampFromTime(time, []),
      content,
      sourcePage: pageNumber,
      sourceUrl: parsedUrl.href,
      anchor: siteReplyId
        ? `.pb-comment-item${quotedAttributeSelector("data-id", siteReplyId)}`
        : selectorFor(commentElement),
      imageCount: mainImageCount,
      isNested: false,
      unexpandedNestedCount: unexpandedForMain,
    });

    for (const nestedElement of nestedElements) {
      const injectedId = firstString(
        nestedElement.getAttribute(SPA_RUNTIME_REPLY_ID_ATTRIBUTE),
      );
      const nestedId = injectedId ?? randomOpaqueId("kr-lzl-temp");
      const nestedCommentContent = spaCommentContent(nestedElement);
      const nestedTarget = spaContentTarget(
        nestedElement,
        false,
        nestedCommentContent,
      );
      const nestedContentText = normalizedText(nestedTarget?.textContent);
      const nestedStateNotice = spaStateNotice(
        nestedElement,
        nestedContentText,
        false,
        nestedCommentContent,
      );
      const nestedContent = nestedContentText || nestedStateNotice;
      const nestedDescriptionText = normalizedText(
        spaDescriptionTarget(
          nestedElement,
          nestedCommentContent,
        )?.textContent,
      );
      const nestedTime = textTimeFromText(nestedDescriptionText);
      const nestedImageCount =
        indexes.imageCountByBoundary.get(nestedElement) ?? 0;

      if (!nestedContent && nestedImageCount === 0) {
        missingContentCount += 1;
      }
      if (nestedStateNotice) stateNoticeCount += 1;
      imageCount += nestedImageCount;
      nestedReplyCount += 1;

      replies.push({
        id: nestedId,
        siteReplyId: null,
        floor,
        parentReplyId: id,
        authorName: spaAuthorName(nestedElement),
        time: nestedTime,
        timestamp: timestampFromTime(nestedTime, []),
        content: nestedContent,
        sourcePage: pageNumber,
        sourceUrl: parsedUrl.href,
        anchor: injectedId
          ? quotedAttributeSelector(SPA_RUNTIME_REPLY_ID_ATTRIBUTE, injectedId)
          : selectorFor(nestedElement),
        imageCount: nestedImageCount,
        isNested: true,
        unexpandedNestedCount: 0,
      });
    }
  }

  if (missingContentCount > 0) {
    errors.push(`${missingContentCount} \u6761\u53ef\u89c1\u56de\u590d\u672a\u80fd\u8bfb\u53d6\u6b63\u6587\u3002`);
  }
  if (stateNoticeCount > 0) {
    warnings.push(
      `${stateNoticeCount} \u6761\u56de\u590d\u663e\u793a\u5220\u9664\u3001\u6298\u53e0\u6216\u5c4f\u853d\u63d0\u793a\uff0c\u6b63\u6587\u53ef\u80fd\u4e0d\u5b8c\u6574\u3002`,
    );
  }
  if (unexpandedLzlCount > 0) {
    warnings.push(`\u4f30\u8ba1\u4ecd\u6709 ${unexpandedLzlCount} \u6761\u697c\u4e2d\u697c\u56de\u590d\u672a\u5c55\u5f00\u3002`);
  }

  if (imageCount > 0) {
    warnings.push(`\u68c0\u6d4b\u5230 ${imageCount} \u5f20\u56fe\u7247\uff1b\u5f53\u524d\u7248\u672c\u4e0d\u8bc6\u522b\u56fe\u7247\u6587\u5b57\u3002`);
  }

  const mainReplyCount = replies.length - nestedReplyCount;
  const unstableReplyIdCount = nestedReplyCount;
  if (unstableReplyIdCount > 0) {
    warnings.push(
      `${unstableReplyIdCount} \u6761\u56de\u590d\u6ca1\u6709\u7f51\u7ad9\u7a33\u5b9a ID\uff0c\u52a8\u6001\u53bb\u91cd\u4e0e\u8df3\u8f6c\u53ef\u80fd\u4e0d\u5b8c\u6574\u3002`,
    );
  }
  if (!documentInstanceId) {
    warnings.push("\u52a8\u6001\u9875\u9762\u672a\u63d0\u4f9b\u6587\u6863\u5b9e\u4f8b\u6807\u8bc6\uff0c\u91cd\u8f7d\u540e\u4e0d\u5e94\u7ee7\u7eed\u7d2f\u79ef\u3002");
  }

  const declaredReplyCount = spaDeclaredReplyCount(document);
  const reachedReplyListEnd = spaReachedReplyListEnd(document);
  warnings.push(
    reachedReplyListEnd
      ? "\u5df2\u5230\u8fbe\u5f53\u524d\u56de\u590d\u5217\u8868\u672b\u5c3e\uff1b\u65b0\u7248\u9875\u9762\u4ecd\u4e0d\u58f0\u79f0\u6574\u5e16\u5b8c\u6574\u3002"
      : "\u65b0\u7248\u9875\u9762\u4f7f\u7528\u52a8\u6001\u5217\u8868\uff1b\u672c\u6b21\u53ea\u5206\u6790\u5df2\u6302\u8f7d\u5185\u5bb9\uff0c\u7ee7\u7eed\u6eda\u52a8\u6216\u5c55\u5f00\u540e\u53ef\u8865\u5145\u91c7\u96c6\u3002",
  );

  return {
    schemaVersion: SCHEMA_VERSION,
    parserVariant: "spa",
    documentInstanceId,
    threadId,
    url: parsedUrl.href,
    title: extractTitle(document),
    pageNumber,
    replies,
    coverage: {
      captureMode: "dynamic",
      visibleReplyCount: replies.length,
      mainReplyCount,
      nestedReplyCount,
      imageCount,
      unexpandedLzlCount,
      analyzedPageNumbers: [pageNumber],
      hasUnanalyzedImages: imageCount > 0,
      declaredReplyCount,
      dynamicContentMayRemain: !reachedReplyListEnd,
      reachedReplyListEnd,
      unstableReplyIdCount,
      // Even an explicit end marker does not prove that folded or moderated
      // content is present, so the SPA adapter never claims full coverage.
      isComplete: false,
    },
    errors,
    warnings,
    capturedAt: new Date().toISOString(),
  };
}

function emptyCapture(
  document: Document,
  url: string,
  inspection: Exclude<TiebaDocumentInspection, { status: "ready" }>,
): ThreadCapture {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url, "https://tieba.baidu.com");
  } catch {
    parsedUrl = new URL("https://tieba.baidu.com/");
  }
  const parserVariant = guessedParserVariant(document);
  const pageNumber = pageNumberFromUrl(parsedUrl);
  return {
    schemaVersion: SCHEMA_VERSION,
    parserVariant,
    documentInstanceId: parserVariant === "spa"
      ? firstString(
          document.documentElement.getAttribute(DOCUMENT_INSTANCE_ID_ATTRIBUTE),
        )
      : null,
    threadId: threadIdFromUrl(parsedUrl),
    url: parsedUrl.href,
    title: extractTitle(document),
    pageNumber,
    replies: [],
    coverage: {
      captureMode: parserVariant === "spa" ? "dynamic" : "paginated",
      visibleReplyCount: 0,
      mainReplyCount: 0,
      nestedReplyCount: 0,
      imageCount: 0,
      unexpandedLzlCount: 0,
      analyzedPageNumbers: [pageNumber],
      hasUnanalyzedImages: false,
      declaredReplyCount: parserVariant === "spa"
        ? spaDeclaredReplyCount(document)
        : null,
      dynamicContentMayRemain: parserVariant === "spa",
      reachedReplyListEnd: false,
      unstableReplyIdCount: 0,
      isComplete: false,
    },
    errors: [inspection.message],
    warnings: [],
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Reads only the supplied DOM. It never expands replies, calls Tieba APIs,
 * accesses cookies, or mutates page/application state.
 */
export function parseTiebaDocument(document: Document, url: string): ThreadCapture {
  const inspection = inspectTiebaDocument(document, url);
  if (inspection.status !== "ready") {
    return emptyCapture(document, url, inspection);
  }
  return inspection.parserVariant === "spa"
    ? parseSpaDocument(document, url)
    : parseLegacyDocument(document, url);
}
