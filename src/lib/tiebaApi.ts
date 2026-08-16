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
  declaredReplyCount: number | null;
  currentPage: number;
  totalPages: number;
  hasMore: boolean;
  replies: CapturedReply[];
  nestedParents: TiebaNestedParentProjection[];
  /** All main-reply and nested-preview nodes exposed by page_pc. */
  rawReplyNodeCount: number;
  /** Supported node occurrences carrying a valid stable official id. */
  stableReplyOccurrenceCount: number;
  /** Repeated stable ids on this page; repeated nodes are returned once. */
  duplicateStableIdCount: number;
  /** Reply-like nodes that could not be attached to a stable official id. */
  unparsedReplyCount: number;
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
  /** Allows exactly the empty total_num=null/total_page=0 overrun sentinel. */
  allowOutOfRangeEmptyProbe?: boolean;
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
  /** All nodes matching a currently supported nested-reply shape. */
  rawReplyNodeCount: number;
  /** Supported reply-node occurrences carrying a valid stable official spid. */
  stableReplyOccurrenceCount: number;
  /** Repeated stable spids on this page; repeated nodes are not returned twice. */
  duplicateStableIdCount: number;
  /** Reply-like nodes that could not be assigned a stable official spid. */
  unparsedReplyCount: number;
  /** data-field list nodes whose shape is neither a reply nor the pager. */
  unknownStructureCount: number;
  /** Whether totalNum/totalPages came from a validated /p/comment pager. */
  hasTrustedPager: boolean;
  /** True only for the explicitly allowed, structurally exact overrun sentinel. */
  isOutOfRangeEmptyProbe: boolean;
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
  const mainById = new Map<string, CapturedReply>();
  const nestedParentById = new Map<string, TiebaNestedParentProjection>();
  let rawReplyNodeCount = 0;
  let stableReplyOccurrenceCount = 0;
  let duplicateStableIdCount = 0;
  let unparsedReplyCount = 0;

  const rawMainReplies: unknown[] = [];
  if (currentPage === 1 && isRecord(value.first_floor)) {
    rawMainReplies.push(value.first_floor);
  }
  if (Array.isArray(value.post_list)) rawMainReplies.push(...value.post_list);

  for (const rawMain of rawMainReplies) {
    rawReplyNodeCount += 1;
    if (!isRecord(rawMain)) {
      unparsedReplyCount += 1;
      continue;
    }
    const rawPreviews = nestedPreviewList(rawMain);
    rawReplyNodeCount += rawPreviews.length;
    const main = apiReply(rawMain, {
      threadId: expectedThreadId,
      sourcePage: currentPage,
      sourceUrl,
      parentReplyId: null,
      parentFloor: null,
      userMap,
    });
    if (!main) {
      // Without a stable parent id none of its preview nodes can be attached
      // safely, even if an individual preview happens to expose an id.
      unparsedReplyCount += 1 + rawPreviews.length;
      continue;
    }
    stableReplyOccurrenceCount += 1;
    let canonicalMain = mainById.get(main.id);
    if (seenIds.has(main.id)) {
      duplicateStableIdCount += 1;
    } else {
      seenIds.add(main.id);
      replies.push(main);
      mainById.set(main.id, main);
      canonicalMain = main;
    }

    // A main id colliding with an earlier preview is not a safe parent. Count
    // every child as unparsed instead of silently attaching it elsewhere.
    if (!canonicalMain) {
      unparsedReplyCount += rawPreviews.length;
      continue;
    }

    const previews: CapturedReply[] = [];
    for (const rawNested of rawPreviews) {
      const nested = apiReply(rawNested, {
        threadId: expectedThreadId,
        sourcePage: currentPage,
        sourceUrl,
        parentReplyId: canonicalMain.id,
        parentFloor: canonicalMain.floor,
        userMap,
      });
      if (!nested) {
        unparsedReplyCount += 1;
        continue;
      }
      stableReplyOccurrenceCount += 1;
      if (seenIds.has(nested.id)) {
        duplicateStableIdCount += 1;
        continue;
      }
      seenIds.add(nested.id);
      previews.push(nested);
      replies.push(nested);
    }

    const declaredCount = Math.max(
      safeCount(rawMain.sub_post_number),
      previews.length,
    );
    const previousParent = nestedParentById.get(canonicalMain.id);
    const mergedPreviews = previousParent
      ? [
          ...previousParent.previewReplies,
          ...previews.filter(
            (preview) =>
              !previousParent.previewReplies.some(
                (existing) => existing.id === preview.id,
              ),
          ),
        ]
      : previews;
    const mergedDeclaredCount = Math.max(
      previousParent?.declaredCount ?? 0,
      declaredCount,
      mergedPreviews.length,
    );
    canonicalMain.unexpandedNestedCount = Math.max(
      0,
      mergedDeclaredCount - mergedPreviews.length,
    );
    if (mergedDeclaredCount > 0) {
      const projection: TiebaNestedParentProjection = {
        parentReplyId: canonicalMain.id,
        parentSiteReplyId: canonicalMain.siteReplyId ?? canonicalMain.id,
        parentFloor: canonicalMain.floor,
        sourcePage: currentPage,
        declaredCount: mergedDeclaredCount,
        previewReplies: mergedPreviews,
      };
      if (!previousParent) nestedParents.push(projection);
      else nestedParents[nestedParents.indexOf(previousParent)] = projection;
      nestedParentById.set(canonicalMain.id, projection);
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
    declaredReplyCount: (() => {
      const parsed = asInteger(thread.reply_num);
      return parsed !== null && parsed >= 0 ? parsed : null;
    })(),
    currentPage,
    totalPages,
    hasMore,
    replies,
    nestedParents,
    rawReplyNodeCount,
    stableReplyOccurrenceCount,
    duplicateStableIdCount,
    unparsedReplyCount,
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

const NESTED_REPLY_SELECTOR =
  "li.lzl_single_post, li.lzl_single_post_old, li.j_lzl_s_p";
const NESTED_PAGER_SELECTOR =
  "li.lzl_li_pager[data-field], .lzl_li_pager[data-field]";
const NESTED_ENDPOINT_NODE_SELECTOR =
  `${NESTED_REPLY_SELECTOR}, ${NESTED_PAGER_SELECTOR}, li[data-field], li[data-spid], li[data-id]`;

type NestedRoot = Node & ParentNode;

function directChildElements(root: Node): Element[] {
  return Array.from(root.childNodes).filter(
    (node): node is Element => node.nodeType === node.ELEMENT_NODE,
  );
}

function hasDirectNonWhitespaceText(root: Node): boolean {
  return Array.from(root.childNodes).some(
    (node) =>
      node.nodeType === node.TEXT_NODE && Boolean((node.nodeValue ?? "").trim()),
  );
}

function hasTextOutsideRoot(scope: Node, root: Node): boolean {
  const visit = (node: Node): boolean => {
    if (node.nodeType === node.TEXT_NODE && (node.nodeValue ?? "").trim()) {
      const parent = node.parentNode;
      if (!parent || (parent !== root && !root.contains(parent))) return true;
    }
    for (const child of node.childNodes) {
      if (visit(child)) return true;
    }
    return false;
  };
  return visit(scope);
}

function classifyNestedRoot(
  scope: NestedRoot,
  extraUnknownStructureCount = 0,
): {
  replies: Element[];
  pager: Element | null;
  unknownStructureCount: number;
  pagerOnlyStructure: boolean;
} {
  const allReplies = Array.from(
    scope.querySelectorAll(NESTED_REPLY_SELECTOR),
  );
  const allPagers = Array.from(
    scope.querySelectorAll(NESTED_PAGER_SELECTOR),
  );
  const allEndpointNodes = Array.from(
    scope.querySelectorAll(NESTED_ENDPOINT_NODE_SELECTOR),
  );
  const pager = allPagers[0] ?? null;
  if (allPagers.length !== 1 || !pager?.parentNode) {
    return {
      replies: [],
      pager,
      unknownStructureCount: Math.max(
        1,
        extraUnknownStructureCount +
          allReplies.length +
          allEndpointNodes.filter(
            (element) =>
              !element.matches(NESTED_REPLY_SELECTOR) &&
              !element.matches(NESTED_PAGER_SELECTOR),
          ).length +
          Math.abs(allPagers.length - 1),
      ),
      pagerOnlyStructure: false,
    };
  }

  const rootCandidate = pager.parentNode;
  if (!("querySelectorAll" in rootCandidate)) {
    return {
      replies: [],
      pager,
      unknownStructureCount: Math.max(1, extraUnknownStructureCount),
      pagerOnlyStructure: false,
    };
  }
  const root = rootCandidate as NestedRoot;
  const rootChildren = directChildElements(root);
  const replies = rootChildren.filter((element) =>
    element.matches(NESTED_REPLY_SELECTOR),
  );
  const directPagers = rootChildren.filter((element) =>
    element.matches(NESTED_PAGER_SELECTOR),
  );
  const unknownRootChildren = rootChildren.filter(
    (element) =>
      !element.matches(NESTED_REPLY_SELECTOR) &&
      !element.matches(NESTED_PAGER_SELECTOR),
  ).length;
  const offRootReplies = allReplies.filter(
    (element) => !replies.includes(element),
  ).length;
  const unknownEndpointNodes = allEndpointNodes.filter(
    (element) =>
      !element.matches(NESTED_REPLY_SELECTOR) &&
      !element.matches(NESTED_PAGER_SELECTOR) &&
      !rootChildren.includes(element),
  ).length;
  const shellElements = Array.from(scope.querySelectorAll("*"));
  const elementsOutsideRootShell = shellElements.filter(
    (element) =>
      element !== root &&
      !root.contains(element) &&
      !element.contains(root),
  ).length;
  const directTextViolation = hasDirectNonWhitespaceText(root) ? 1 : 0;
  const shellTextViolation = hasTextOutsideRoot(scope, root) ? 1 : 0;
  const unknownStructureCount =
    extraUnknownStructureCount +
    unknownRootChildren +
    offRootReplies +
    unknownEndpointNodes +
    elementsOutsideRootShell +
    directTextViolation +
    shellTextViolation +
    (directPagers.length === 1 ? 0 : 1);

  return {
    replies,
    pager,
    unknownStructureCount,
    pagerOnlyStructure:
      unknownStructureCount === 0 &&
      replies.length === 0 &&
      rootChildren.length === 1 &&
      directPagers.length === 1,
  };
}

function elementsFromNestedResponse(document: Document): {
  replies: Element[];
  pager: Element | null;
  unknownStructureCount: number;
  pagerOnlyStructure: boolean;
  isCommentWrapped: boolean;
} {
  if (document.body.querySelector(NESTED_ENDPOINT_NODE_SELECTOR)) {
    return {
      ...classifyNestedRoot(
        document.body,
        document.head.children.length > 0 ||
          Boolean((document.head.textContent ?? "").trim())
          ? 1
          : 0,
      ),
      isCommentWrapped: false,
    };
  }

  // Some versions wrap the fragment in an HTML comment. DOMParser correctly
  // keeps it as a comment. Accept only one direct, otherwise-empty body
  // fragment so a challenge/login shell cannot smuggle a fake pager sentinel
  // inside an unrelated comment.
  const allComments: Comment[] = [];
  const candidateComments: Comment[] = [];
  const visit = (node: Node): void => {
    if (node.nodeType === node.COMMENT_NODE) {
      const comment = node as Comment;
      allComments.push(comment);
      const body = node.nodeValue ?? "";
      if (
        /lzl_(?:single_post|li_pager)|j_lzl_s_p|<li\b[^>]*\bdata-(?:field|spid|id)\b/iu.test(
          body,
        )
      ) {
        candidateComments.push(comment);
      }
    }
    for (const child of node.childNodes) visit(child);
  };
  visit(document);
  if (candidateComments.length > 1) {
    throw new TiebaApiError(
      "INVALID_RESPONSE",
      "楼中楼接口返回了多个互不相连的注释片段。",
    );
  }
  if (candidateComments.length === 0) {
    return {
      replies: [],
      pager: null,
      unknownStructureCount: 0,
      pagerOnlyStructure: false,
      isCommentWrapped: false,
    };
  }

  const candidate = candidateComments[0]!;
  const suspiciousHead =
    document.head.children.length > 0 ||
    Boolean((document.head.textContent ?? "").trim());
  const suspiciousBodyShell = Array.from(document.body.childNodes).some(
    (node) =>
      node !== candidate &&
      !(
        node.nodeType === node.TEXT_NODE &&
        !(node.nodeValue ?? "").trim()
      ),
  );
  const candidateHasCanonicalParent =
    candidate.parentNode === document.body || candidate.parentNode === document;
  const suspiciousDocumentShell = Array.from(document.childNodes).some(
    (node) =>
      node !== candidate &&
      node !== document.documentElement &&
      node.nodeType !== node.DOCUMENT_TYPE_NODE &&
      !(
        node.nodeType === node.TEXT_NODE &&
        !(node.nodeValue ?? "").trim()
      ),
  );
  const htmlHasCanonicalScaffold = Array.from(
    document.documentElement.children,
  ).every((element) => element === document.head || element === document.body) &&
    document.documentElement.children.length === 2;
  const suspiciousScaffoldAttributes =
    document.documentElement.attributes.length > 0 ||
    document.head.attributes.length > 0 ||
    document.body.attributes.length > 0;
  if (
    suspiciousHead ||
    !candidateHasCanonicalParent ||
    allComments.length !== 1 ||
    suspiciousBodyShell ||
    suspiciousDocumentShell ||
    !htmlHasCanonicalScaffold ||
    suspiciousScaffoldAttributes
  ) {
    throw new TiebaApiError(
      "INVALID_RESPONSE",
      "楼中楼接口的注释片段带有无法验证的页面外壳。",
    );
  }

  const template = document.createElement("template");
  template.innerHTML = candidate.nodeValue ?? "";
  const classified = classifyNestedRoot(template.content);
  if (!classified.pager || classified.unknownStructureCount > 0) {
    throw new TiebaApiError(
      "INVALID_RESPONSE",
      "楼中楼接口的注释片段结构无法完整验证。",
    );
  }
  return { ...classified, isCommentWrapped: true };
}

function nestedContentElement(element: Element): Element | null {
  return (
    element.querySelector(".lzl_content_main") ??
    element.querySelector(".j_lzl_content, .lzl_content")
  );
}

function stableNestedReplyId(
  element: Element,
  data: UnknownRecord | null,
): string | null {
  // A present but malformed data-field is structural uncertainty even when a
  // second attribute happens to contain a usable-looking id. Likewise, when
  // Tieba exposes the same id through multiple attributes, every source must
  // agree so a markup transition cannot silently attach text to the wrong
  // official reply.
  if (element.hasAttribute("data-field") && data === null) return null;
  const rawSources = [
    data?.spid,
    data?.id,
    element.hasAttribute("data-spid")
      ? element.getAttribute("data-spid")
      : undefined,
    element.hasAttribute("data-id")
      ? element.getAttribute("data-id")
      : undefined,
  ].filter((value) => value !== undefined && value !== null);
  if (rawSources.length === 0) return null;
  const ids = rawSources.map((value) => asTrimmedString(value));
  if (ids.some((id) => !id || !/^\d{1,32}$/u.test(id))) return null;
  const unique = new Set(ids as string[]);
  return unique.size === 1 ? (ids[0] ?? null) : null;
}

function textFromNestedElement(element: Element): {
  content: string;
  imageCount: number;
} {
  const contentElement = nestedContentElement(element);
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
  let stableReplyOccurrenceCount = 0;
  let duplicateStableIdCount = 0;
  let unparsedReplyCount = 0;
  const responseElements = elementsFromNestedResponse(document);
  const elements = responseElements.replies;
  for (const element of elements) {
    const data = parseDataField(element);
    const id = stableNestedReplyId(element, data);
    if (
      !id ||
      !/^\d{1,32}$/u.test(id) ||
      nestedContentElement(element) === null
    ) {
      unparsedReplyCount += 1;
      continue;
    }
    stableReplyOccurrenceCount += 1;
    if (seenIds.has(id)) {
      duplicateStableIdCount += 1;
      continue;
    }
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
  if (pagerElement && !pager) {
    throw new TiebaApiError(
      "INVALID_RESPONSE",
      "楼中楼接口返回了无法解析的分页信息。",
    );
  }
  const pagerKeys = pager ? Object.keys(pager).sort() : [];
  const isExactOutOfRangeEmptyProbe =
    context.allowOutOfRangeEmptyProbe === true &&
    !responseElements.isCommentWrapped &&
    elements.length === 0 &&
    unparsedReplyCount === 0 &&
    responseElements.unknownStructureCount === 0 &&
    responseElements.pagerOnlyStructure &&
    pager !== null &&
    pagerKeys.length === 2 &&
    pagerKeys[0] === "total_num" &&
    pagerKeys[1] === "total_page" &&
    pager.total_num === null &&
    asInteger(pager.total_page) === 0;
  if (isExactOutOfRangeEmptyProbe) {
    return {
      threadId,
      parentReplyId,
      parentSiteReplyId,
      currentPage,
      totalPages: 0,
      totalNum: 0,
      hasMore: false,
      replies: [],
      rawReplyNodeCount: 0,
      stableReplyOccurrenceCount: 0,
      duplicateStableIdCount: 0,
      unparsedReplyCount: 0,
      unknownStructureCount: 0,
      hasTrustedPager: false,
      isOutOfRangeEmptyProbe: true,
    };
  }
  let hasTrustedPager = false;
  let totalNum = replies.length;
  let totalPages = currentPage;
  if (pager) {
    const parsedTotalNum = asInteger(pager.total_num);
    const parsedTotalPages = asInteger(pager.total_page);
    if (
      parsedTotalNum === null ||
      parsedTotalNum < 0 ||
      parsedTotalPages === null ||
      parsedTotalPages < 1 ||
      parsedTotalPages > MAX_PAGE_NUMBER
    ) {
      throw new TiebaApiError(
        "INVALID_RESPONSE",
        "楼中楼接口返回了无效的分页信息。",
      );
    }
    hasTrustedPager = true;
    totalNum = parsedTotalNum;
    totalPages = parsedTotalPages;
  }
  if (totalPages < currentPage) {
    throw new TiebaApiError(
      "PAGE_MISMATCH",
      "楼中楼接口返回的总页数小于当前页码。",
    );
  }
  if (
    (context.declaredCount ?? 0) > 0 &&
    replies.length === 0 &&
    unparsedReplyCount === 0 &&
    responseElements.unknownStructureCount === 0 &&
    !hasTrustedPager
  ) {
    throw new TiebaApiError(
      "INVALID_RESPONSE",
      "楼中楼接口没有返回声明存在的回复，页面可能是验证页或异常页。",
    );
  }
  if (hasTrustedPager && totalNum < replies.length) {
    throw new TiebaApiError(
      "INVALID_RESPONSE",
      "楼中楼接口分页数量小于当前页可识别的稳定回复数。",
    );
  }

  return {
    threadId,
    parentReplyId,
    parentSiteReplyId,
    currentPage,
    totalPages,
    totalNum,
    hasMore: currentPage < totalPages,
    replies,
    rawReplyNodeCount: elements.length,
    stableReplyOccurrenceCount,
    duplicateStableIdCount,
    unparsedReplyCount,
    unknownStructureCount: responseElements.unknownStructureCount,
    hasTrustedPager,
    isOutOfRangeEmptyProbe: false,
  };
}
