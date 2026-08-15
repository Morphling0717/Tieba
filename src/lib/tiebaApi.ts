import type { CapturedReply } from "../types";

type UnknownRecord = Record<string, unknown>;
type RequestValue = string | number | boolean | null | undefined;

const TIEBA_ORIGIN = "https://tieba.baidu.com";
const PC_SIGN_SECRET = "36770b1f34c9bbf2e7d1a99d2b82fa9e";
const MAX_PAGE_NUMBER = 100_000;

export type TiebaReadEndpoint =
  | "/c/s/pc/sync"
  | "/c/f/pb/page_pc"
  | "/p/comment";

export interface TiebaApiRequest {
  endpoint: TiebaReadEndpoint;
  method: "GET" | "POST";
  url: string;
  headers: Readonly<Record<string, string>>;
  body?: string;
}

/** Name used by the whole-thread capture orchestrator. */
export type TiebaReadRequest = TiebaApiRequest;

export type TiebaApiErrorCode =
  | "INVALID_ARGUMENT"
  | "REMOTE_ERROR"
  | "INVALID_RESPONSE"
  | "THREAD_MISMATCH"
  | "PAGE_MISMATCH";

export class TiebaApiError extends Error {
  readonly code: TiebaApiErrorCode;
  readonly remoteCode: string | null;

  constructor(
    code: TiebaApiErrorCode,
    message: string,
    remoteCode: string | null = null,
  ) {
    super(message);
    this.name = "TiebaApiError";
    this.code = code;
    this.remoteCode = remoteCode;
  }
}

export interface TiebaSyncProjection {
  tbs: string;
}

export interface TiebaNestedParentProjection {
  parentReplyId: string;
  parentSiteReplyId: string;
  parentFloor: number | null;
  sourcePage: number;
  declaredCount: number;
  previewReplies: CapturedReply[];
}

export interface TiebaPagePcProjection {
  threadId: string;
  forumId: string;
  title: string;
  declaredReplyCount: number;
  currentPage: number;
  totalPages: number;
  hasMore: boolean;
  replies: CapturedReply[];
  nestedParents: TiebaNestedParentProjection[];
}

export interface TiebaPagePcParseContext {
  threadId: string;
  expectedPage?: number;
  sourceUrl?: string;
}

export interface TiebaNestedParseContext {
  threadId: string;
  /** Runtime reply id used by the analyzer and review session. */
  parentReplyId: string;
  /** Official Tieba pid used for the read-only nested-reply endpoint. */
  parentSiteReplyId: string;
  parentFloor: number | null;
  /** Main-reply page on which the parent was returned. */
  sourcePage: number;
  /** One-based page of /p/comment being parsed. */
  page: number;
  /** Known total for the parent; used to reject challenge/empty HTML as incomplete. */
  declaredCount?: number;
  sourceUrl?: string;
}

export interface TiebaNestedPageProjection {
  threadId: string;
  parentReplyId: string;
  parentSiteReplyId: string;
  currentPage: number;
  totalPages: number;
  totalNum: number;
  hasMore: boolean;
  replies: CapturedReply[];
  /** Reply-like nodes that could not be assigned a stable official spid. */
  unparsedReplyCount: number;
}

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

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const result = String(value).trim();
  return result || null;
}

function asInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value !== "string" || !/^-?\d+$/u.test(value.trim())) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : null;
}

function normalizeText(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value)
    .replace(/[\u200b-\u200d\ufeff]/gu, "")
    .replace(/[\t\r\n\u00a0 ]+/gu, " ")
    .trim();
}

function assertNumericId(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^\d{1,32}$/u.test(normalized)) {
    throw new TiebaApiError(
      "INVALID_ARGUMENT",
      `${label} 必须是 1 至 32 位数字。`,
    );
  }
  return normalized;
}

function assertPage(value: number, label = "页码"): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_PAGE_NUMBER
  ) {
    throw new TiebaApiError(
      "INVALID_ARGUMENT",
      `${label} 必须是 1 至 ${MAX_PAGE_NUMBER} 的整数。`,
    );
  }
  return value;
}

function assertTbs(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length < 8 ||
    normalized.length > 256 ||
    !/^[A-Za-z0-9_-]+$/u.test(normalized)
  ) {
    throw new TiebaApiError("INVALID_ARGUMENT", "贴吧会话令牌格式无效。");
  }
  return normalized;
}

function safePositiveInteger(
  value: unknown,
  fallback: number,
  label: string,
): number {
  const parsed = asInteger(value);
  if (parsed === null) return fallback;
  if (parsed < 1 || parsed > MAX_PAGE_NUMBER) {
    throw new TiebaApiError("INVALID_RESPONSE", `${label}超出有效范围。`);
  }
  return parsed;
}

function safeCount(value: unknown, fallback = 0): number {
  const parsed = asInteger(value);
  return parsed !== null && parsed >= 0 ? parsed : fallback;
}

function add32(left: number, right: number): number {
  return (left + right) | 0;
}

function rotateLeft(value: number, amount: number): number {
  return (value << amount) | (value >>> (32 - amount));
}

/**
 * Small synchronous MD5 implementation for Tieba's fixed PC request signature.
 * It deliberately accepts text only; no browser cookie or session data is read.
 */
export function md5Hex(text: string): string {
  const source = new TextEncoder().encode(text);
  const paddedLength = Math.ceil((source.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(source);
  bytes[source.length] = 0x80;

  const bitLength = BigInt(source.length) * 8n;
  for (let index = 0; index < 8; index += 1) {
    bytes[paddedLength - 8 + index] = Number(
      (bitLength >> BigInt(index * 8)) & 0xffn,
    );
  }

  let a0 = 0x67452301;
  let b0 = 0xefcdab89 | 0;
  let c0 = 0x98badcfe | 0;
  let d0 = 0x10325476;
  const shifts = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ] as const;

  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = new Int32Array(16);
    for (let index = 0; index < 16; index += 1) {
      const byteOffset = offset + index * 4;
      words[index] =
        bytes[byteOffset] |
        (bytes[byteOffset + 1] << 8) |
        (bytes[byteOffset + 2] << 16) |
        (bytes[byteOffset + 3] << 24);
    }

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let index = 0; index < 64; index += 1) {
      let f: number;
      let wordIndex: number;
      if (index < 16) {
        f = (b & c) | (~b & d);
        wordIndex = index;
      } else if (index < 32) {
        f = (d & b) | (~d & c);
        wordIndex = (5 * index + 1) % 16;
      } else if (index < 48) {
        f = b ^ c ^ d;
        wordIndex = (3 * index + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        wordIndex = (7 * index) % 16;
      }

      const constant = Math.floor(Math.abs(Math.sin(index + 1)) * 2 ** 32) | 0;
      const previousD = d;
      d = c;
      c = b;
      const mixed = add32(
        add32(add32(a, f), constant),
        words[wordIndex] ?? 0,
      );
      b = add32(b, rotateLeft(mixed, shifts[index] ?? 0));
      a = previousD;
    }

    a0 = add32(a0, a);
    b0 = add32(b0, b);
    c0 = add32(c0, c);
    d0 = add32(d0, d);
  }

  return [a0, b0, c0, d0]
    .map((word) =>
      [0, 8, 16, 24]
        .map((shift) => ((word >>> shift) & 0xff).toString(16).padStart(2, "0"))
        .join(""),
    )
    .join("");
}

export function signTiebaPcParams(
  params: Readonly<Record<string, RequestValue>>,
): string {
  const signText = Object.keys(params)
    .filter(
      (key) =>
        key !== "sign" &&
        key !== "sig" &&
        params[key] !== null &&
        params[key] !== undefined,
    )
    .sort()
    .map((key) => `${key}=${String(params[key])}`)
    .join("");
  return md5Hex(`${signText}${PC_SIGN_SECRET}`);
}

function encodedParams(
  params: Readonly<Record<string, RequestValue>>,
): string {
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) result.set(key, String(value));
  }
  return result.toString();
}

function signedParams(
  params: Readonly<Record<string, RequestValue>>,
): Record<string, RequestValue> {
  const unsigned = { ...params };
  return { ...unsigned, sign: signTiebaPcParams(unsigned) };
}

export function buildTiebaSyncRequest(): TiebaApiRequest {
  const query = signedParams({
    subapp_type: "pc",
    _client_type: "20",
  });
  return {
    endpoint: "/c/s/pc/sync",
    method: "GET",
    url: `${TIEBA_ORIGIN}/c/s/pc/sync?${encodedParams(query)}`,
    headers: {
      Accept: "application/json, text/plain, */*",
    },
  };
}

export function buildTiebaPagePcRequest(
  threadId: string,
  page: number,
  tbs: string,
): TiebaApiRequest {
  const tid = assertNumericId(threadId, "帖子 ID");
  const pn = assertPage(page);
  const safeTbs = assertTbs(tbs);
  const data = signedParams({
    pn,
    lz: 0,
    r: 0,
    mark_type: 0,
    back: 0,
    fr: "",
    kz: tid,
    session_request_times: 1,
    tbs: safeTbs,
    subapp_type: "pc",
    _client_type: "20",
  });
  return {
    endpoint: "/c/f/pb/page_pc",
    method: "POST",
    url: `${TIEBA_ORIGIN}/c/f/pb/page_pc`,
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body: encodedParams(data),
  };
}

export function buildTiebaNestedRequest(
  threadId: string,
  parentReplyId: string,
  page: number,
  forumId?: string,
): TiebaApiRequest {
  const tid = assertNumericId(threadId, "帖子 ID");
  const pid = assertNumericId(parentReplyId, "父回复 ID");
  const pn = assertPage(page);
  const fid =
    forumId === undefined ? undefined : assertNumericId(forumId, "贴吧 ID");
  const query = encodedParams({ tid, pid, fid, pn });
  return {
    endpoint: "/p/comment",
    method: "GET",
    url: `${TIEBA_ORIGIN}/p/comment?${query}`,
    headers: {
      Accept: "text/html, */*;q=0.8",
    },
  };
}

function assertSuccessfulResponse(raw: unknown): UnknownRecord {
  let value = raw;
  if (typeof raw === "string") {
    if (!raw.trim()) {
      throw new TiebaApiError("INVALID_RESPONSE", "贴吧接口返回了空响应。");
    }
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new TiebaApiError(
        "INVALID_RESPONSE",
        "贴吧接口没有返回有效 JSON。",
      );
    }
  }
  if (!isRecord(value)) {
    throw new TiebaApiError("INVALID_RESPONSE", "贴吧接口返回了无效数据。");
  }

  const rawCode = value.error_code ?? value.no;
  if (rawCode !== undefined && rawCode !== null) {
    const code = String(rawCode);
    if (code !== "0" && code !== "None") {
      throw new TiebaApiError(
        "REMOTE_ERROR",
        `贴吧读取接口返回错误码 ${code}。`,
        code,
      );
    }
  }
  return value;
}

export function parseTiebaSyncResponse(raw: unknown): TiebaSyncProjection {
  const value = assertSuccessfulResponse(raw);
  const tbs = asTrimmedString(
    atPath(value, "data", "anti", "tbs") ??
      atPath(value, "anti", "tbs"),
  );
  if (!tbs) {
    throw new TiebaApiError(
      "INVALID_RESPONSE",
      "贴吧同步接口未返回会话令牌。",
    );
  }
  return { tbs: assertTbs(tbs) };
}

function parseTimestamp(raw: unknown): {
  time: string | null;
  timestamp: number | null;
} {
  const value = asInteger(raw);
  if (value === null || value <= 0) {
    const text = asTrimmedString(raw);
    return { time: text, timestamp: null };
  }
  const timestamp = value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(timestamp);
  return {
    time: Number.isNaN(date.getTime()) ? String(raw) : date.toISOString(),
    timestamp,
  };
}

function parseApiContent(raw: unknown): {
  content: string;
  imageCount: number;
} {
  if (typeof raw === "string" || typeof raw === "number") {
    return { content: normalizeText(raw), imageCount: 0 };
  }
  if (!Array.isArray(raw)) return { content: "", imageCount: 0 };

  const parts: string[] = [];
  let imageCount = 0;
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const type = asInteger(entry.type);
    if (
      type === 3 ||
      entry.origin_src !== undefined ||
      entry.cdn_src !== undefined
    ) {
      imageCount += 1;
      continue;
    }
    if (type === 0 || type === 2 || type === 4 || type === null) {
      const text = normalizeText(entry.text ?? entry.c);
      if (text) parts.push(text);
    }
  }
  return { content: normalizeText(parts.join("")), imageCount };
}

function userName(
  userMap: ReadonlyMap<string, UnknownRecord>,
  authorId: unknown,
  inlineAuthor?: unknown,
): string | null {
  const id = asTrimmedString(authorId);
  const user = id ? userMap.get(id) : undefined;
  const inline = isRecord(inlineAuthor) ? inlineAuthor : {};
  return (
    asTrimmedString(user?.name_show) ??
    asTrimmedString(user?.show_name) ??
    asTrimmedString(user?.name) ??
    asTrimmedString(inline.name_show) ??
    asTrimmedString(inline.show_name) ??
    asTrimmedString(inline.name) ??
    null
  );
}

function apiAnchor(replyId: string, nested: boolean): string {
  return nested
    ? `[data-spid="${replyId}"], [data-field*='"spid":"${replyId}"'], [data-field*='"spid":${replyId}']`
    : `.pb-comment-item[data-id="${replyId}"], .l_post[data-pid="${replyId}"]`;
}

interface ApiReplyContext {
  threadId: string;
  sourcePage: number;
  sourceUrl: string;
  parentReplyId: string | null;
  parentFloor: number | null;
  userMap: ReadonlyMap<string, UnknownRecord>;
}

function apiReply(
  raw: unknown,
  context: ApiReplyContext,
): CapturedReply | null {
  if (!isRecord(raw)) return null;
  const id = asTrimmedString(raw.id ?? raw.spid);
  if (!id || !/^\d{1,32}$/u.test(id)) return null;
  const floor =
    context.parentFloor ??
    (() => {
      const parsed = asInteger(raw.floor ?? raw.post_no);
      return parsed !== null && parsed > 0 ? parsed : null;
    })();
  const { time, timestamp } = parseTimestamp(raw.time);
  const { content, imageCount } = parseApiContent(raw.content);
  const isNested = context.parentReplyId !== null;
  return {
    id,
    siteReplyId: id,
    floor,
    parentReplyId: context.parentReplyId,
    authorName: userName(context.userMap, raw.author_id, raw.author),
    time,
    timestamp,
    content,
    sourcePage: context.sourcePage,
    sourceUrl: context.sourceUrl,
    anchor: apiAnchor(id, isNested),
    imageCount,
    isNested,
    unexpandedNestedCount: 0,
  };
}

function responseUserMap(value: UnknownRecord): Map<string, UnknownRecord> {
  const result = new Map<string, UnknownRecord>();
  const rawUsers = value.user_list;
  if (!Array.isArray(rawUsers)) return result;
  for (const rawUser of rawUsers) {
    if (!isRecord(rawUser)) continue;
    const id = asTrimmedString(rawUser.id);
    if (id) result.set(id, rawUser);
  }
  return result;
}

function nestedPreviewList(raw: UnknownRecord): unknown[] {
  const wrapper = raw.sub_post_list;
  if (Array.isArray(wrapper)) return wrapper;
  if (!isRecord(wrapper)) return [];
  return Array.isArray(wrapper.sub_post_list) ? wrapper.sub_post_list : [];
}

export function parseTiebaPagePcResponse(
  raw: unknown,
  context: TiebaPagePcParseContext,
): TiebaPagePcProjection {
  const expectedThreadId = assertNumericId(context.threadId, "帖子 ID");
  if (context.expectedPage !== undefined) {
    assertPage(context.expectedPage, "预期页码");
  }
  const value = assertSuccessfulResponse(raw);
  const thread = isRecord(value.thread) ? value.thread : {};
  const responseThreadId = asTrimmedString(
    thread.id ?? thread.tid ?? atPath(value, "first_floor", "tid"),
  );
  if (!responseThreadId || !/^\d{1,32}$/u.test(responseThreadId)) {
    throw new TiebaApiError(
      "INVALID_RESPONSE",
      "贴吧帖子接口未返回有效帖子 ID。",
    );
  }
  if (responseThreadId !== expectedThreadId) {
    throw new TiebaApiError(
      "THREAD_MISMATCH",
      "贴吧接口返回了另一个帖子的内容。",
    );
  }

  const page = isRecord(value.page) ? value.page : {};
  const forum = isRecord(value.forum)
    ? value.forum
    : isRecord(value.display_forum)
      ? value.display_forum
      : {};
  const forumId = asTrimmedString(forum.id);
  if (!forumId || !/^\d{1,32}$/u.test(forumId)) {
    throw new TiebaApiError(
      "INVALID_RESPONSE",
      "贴吧帖子接口未返回有效贴吧 ID。",
    );
  }
  const currentPage = safePositiveInteger(
    page.current_page,
    context.expectedPage ?? 1,
    "当前页码",
  );
  const totalPages = safePositiveInteger(
    page.total_page,
    currentPage,
    "总页数",
  );
  if (totalPages < currentPage) {
    throw new TiebaApiError("INVALID_RESPONSE", "贴吧接口分页信息前后矛盾。");
  }
  if (
    context.expectedPage !== undefined &&
    currentPage !== context.expectedPage
  ) {
    throw new TiebaApiError(
      "PAGE_MISMATCH",
      `贴吧接口返回第 ${currentPage} 页，而不是请求的第 ${context.expectedPage} 页。`,
    );
  }

  const sourceUrl =
    context.sourceUrl ??
    `${TIEBA_ORIGIN}/p/${expectedThreadId}?pn=${currentPage}`;
  const userMap = responseUserMap(value);
  const replies: CapturedReply[] = [];
  const nestedParents: TiebaNestedParentProjection[] = [];
  const seenIds = new Set<string>();

  const rawMainReplies: unknown[] = [];
  if (currentPage === 1 && isRecord(value.first_floor)) {
    rawMainReplies.push(value.first_floor);
  }
  if (Array.isArray(value.post_list)) rawMainReplies.push(...value.post_list);

  for (const rawMain of rawMainReplies) {
    if (!isRecord(rawMain)) continue;
    const main = apiReply(rawMain, {
      threadId: expectedThreadId,
      sourcePage: currentPage,
      sourceUrl,
      parentReplyId: null,
      parentFloor: null,
      userMap,
    });
    if (!main || seenIds.has(main.id)) continue;
    seenIds.add(main.id);

    const previews: CapturedReply[] = [];
    for (const rawNested of nestedPreviewList(rawMain)) {
      const nested = apiReply(rawNested, {
        threadId: expectedThreadId,
        sourcePage: currentPage,
        sourceUrl,
        parentReplyId: main.id,
        parentFloor: main.floor,
        userMap,
      });
      if (!nested || seenIds.has(nested.id)) continue;
      seenIds.add(nested.id);
      previews.push(nested);
    }

    const declaredCount = Math.max(
      safeCount(rawMain.sub_post_number),
      previews.length,
    );
    main.unexpandedNestedCount = Math.max(
      0,
      declaredCount - previews.length,
    );
    replies.push(main, ...previews);
    if (declaredCount > 0) {
      nestedParents.push({
        parentReplyId: main.id,
        parentSiteReplyId: main.siteReplyId ?? main.id,
        parentFloor: main.floor,
        sourcePage: currentPage,
        declaredCount,
        previewReplies: previews,
      });
    }
  }

  if (replies.filter((reply) => !reply.isNested).length === 0) {
    throw new TiebaApiError(
      "INVALID_RESPONSE",
      "贴吧帖子接口没有返回可识别的楼层。",
    );
  }

  const rawHasMore = page.has_more;
  const hasMore =
    typeof rawHasMore === "boolean"
      ? rawHasMore
      : asInteger(rawHasMore) !== null
        ? asInteger(rawHasMore) !== 0
        : currentPage < totalPages;

  return {
    threadId: expectedThreadId,
    forumId,
    title: normalizeText(thread.title ?? atPath(value, "first_floor", "title")),
    declaredReplyCount: safeCount(thread.reply_num),
    currentPage,
    totalPages,
    hasMore,
    replies,
    nestedParents,
  };
}

function parseDataField(element: Element): UnknownRecord | null {
  const raw = element.getAttribute("data-field");
  if (!raw?.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function elementsFromNestedResponse(document: Document): {
  replies: Element[];
  pager: Element | null;
} {
  const replySelector =
    ".lzl_single_post, .lzl_single_post_old, .j_lzl_s_p";
  const pagerSelector =
    "li.lzl_li_pager[data-field], .lzl_li_pager[data-field]";
  const replies = Array.from(document.querySelectorAll(replySelector));
  let pager = document.querySelector(pagerSelector);
  if (replies.length > 0 || pager) return { replies, pager };

  // Some versions wrap the fragment in an HTML comment. DOMParser correctly
  // keeps it as a comment, so materialize only that inert fragment for parsing.
  const commentBodies: string[] = [];
  const visit = (node: Node): void => {
    if (node.nodeType === node.COMMENT_NODE) {
      const body = node.nodeValue ?? "";
      if (/lzl_(?:single_post|li_pager)|j_lzl_s_p/u.test(body)) {
        commentBodies.push(body);
      }
    }
    for (const child of node.childNodes) visit(child);
  };
  visit(document);
  if (commentBodies.length === 0) return { replies, pager };

  const template = document.createElement("template");
  template.innerHTML = commentBodies.join("");
  replies.push(...template.content.querySelectorAll(replySelector));
  pager = template.content.querySelector(pagerSelector);
  return { replies, pager };
}

function textFromNestedElement(element: Element): {
  content: string;
  imageCount: number;
} {
  const contentElement =
    element.querySelector(".lzl_content_main") ??
    element.querySelector(".j_lzl_content, .lzl_content");
  return {
    content: normalizeText(contentElement?.textContent),
    imageCount: contentElement?.querySelectorAll("img").length ?? 0,
  };
}

function nestedTime(
  element: Element,
  data: UnknownRecord,
): { time: string | null; timestamp: number | null } {
  const displayed = normalizeText(
    element.querySelector(".lzl_time, time, [class*='time']")?.textContent,
  );
  if (displayed) {
    const parsed = Date.parse(
      displayed.replace(/年|月/gu, "-").replace(/日/gu, ""),
    );
    return {
      time: displayed,
      timestamp: Number.isNaN(parsed) ? null : parsed,
    };
  }
  return parseTimestamp(data.time);
}

export function parseTiebaNestedDocument(
  document: Document,
  context: TiebaNestedParseContext,
): TiebaNestedPageProjection {
  const threadId = assertNumericId(context.threadId, "帖子 ID");
  const parentReplyId = assertNumericId(context.parentReplyId, "父回复 ID");
  const parentSiteReplyId = assertNumericId(
    context.parentSiteReplyId,
    "父回复站点 ID",
  );
  const currentPage = assertPage(context.page);
  const sourcePage = assertPage(context.sourcePage, "父回复来源页码");
  if (
    context.declaredCount !== undefined &&
    (!Number.isSafeInteger(context.declaredCount) || context.declaredCount < 0)
  ) {
    throw new TiebaApiError("INVALID_ARGUMENT", "楼中楼声明数量格式无效。");
  }
  if (
    typeof context.parentFloor !== "number" &&
    context.parentFloor !== null
  ) {
    throw new TiebaApiError("INVALID_ARGUMENT", "父回复楼层格式无效。");
  }
  const sourceUrl =
    context.sourceUrl ??
    `${TIEBA_ORIGIN}/p/comment?${encodedParams({
      tid: threadId,
      pid: parentSiteReplyId,
      pn: currentPage,
    })}`;

  const replies: CapturedReply[] = [];
  const seenIds = new Set<string>();
  let unparsedReplyCount = 0;
  const responseElements = elementsFromNestedResponse(document);
  const elements = responseElements.replies;
  for (const element of elements) {
    const data = parseDataField(element);
    const id = asTrimmedString(
      data?.spid ??
        data?.id ??
        element.getAttribute("data-spid") ??
        element.getAttribute("data-id"),
    );
    if (!id || !/^\d{1,32}$/u.test(id)) {
      unparsedReplyCount += 1;
      continue;
    }
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    const safeData = data ?? {};
    const { content, imageCount } = textFromNestedElement(element);
    const { time, timestamp } = nestedTime(element, safeData);
    replies.push({
      id,
      siteReplyId: id,
      floor: context.parentFloor,
      parentReplyId,
      authorName:
        asTrimmedString(safeData.showname) ??
        asTrimmedString(safeData.user_name) ??
        asTrimmedString(
          element
            .querySelector(".j_user_card, .lzl_p_p a")
            ?.getAttribute("username"),
        ) ??
        asTrimmedString(
          element.querySelector(".j_user_card, .lzl_p_p a")?.textContent,
        ) ??
        null,
      time,
      timestamp,
      content,
      sourcePage,
      sourceUrl,
      anchor: apiAnchor(id, true),
      imageCount,
      isNested: true,
      unexpandedNestedCount: 0,
    });
  }

  const pagerElement = responseElements.pager;
  const pager = pagerElement ? parseDataField(pagerElement) : null;
  const totalNum = pager
    ? safeCount(pager.total_num, replies.length)
    : replies.length;
  const totalPages = pager
    ? safePositiveInteger(pager.total_page, 1, "楼中楼总页数")
    : currentPage;
  if (totalPages < currentPage) {
    throw new TiebaApiError(
      "PAGE_MISMATCH",
      "楼中楼接口返回的总页数小于当前页码。",
    );
  }
  if (
    (context.declaredCount ?? 0) > 0 &&
    replies.length === 0 &&
    unparsedReplyCount === 0
  ) {
    throw new TiebaApiError(
      "INVALID_RESPONSE",
      "楼中楼接口没有返回声明存在的回复，页面可能是验证页或异常页。",
    );
  }

  return {
    threadId,
    parentReplyId,
    parentSiteReplyId,
    currentPage,
    totalPages,
    totalNum: Math.max(totalNum, replies.length),
    hasMore: currentPage < totalPages,
    replies,
    unparsedReplyCount,
  };
}
