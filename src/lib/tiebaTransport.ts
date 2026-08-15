import type { TiebaReadRequest } from "./tiebaApi";

export const TIEBA_RESPONSE_BODY_LIMIT_BYTES = 4 * 1024 * 1024;

const TIEBA_ORIGIN = "https://tieba.baidu.com";
const ALLOWED_HEADERS = new Set(["accept", "content-type"]);
const ENDPOINT_METHODS = {
  "/c/s/pc/sync": "GET",
  "/c/f/pb/page_pc": "POST",
  "/p/comment": "GET",
} as const satisfies Record<TiebaReadRequest["endpoint"], "GET" | "POST">;

const SYNC_QUERY_KEYS = new Set(["subapp_type", "_client_type", "sign"]);
const COMMENT_QUERY_KEYS = new Set(["tid", "pid", "pn", "fid"]);
const PAGE_PC_BODY_KEYS = new Set([
  "pn",
  "lz",
  "r",
  "mark_type",
  "back",
  "fr",
  "kz",
  "session_request_times",
  "tbs",
  "subapp_type",
  "_client_type",
  "sign",
]);

export type TiebaTransportErrorCode =
  | "INVALID_REQUEST"
  | "NETWORK_ERROR"
  | "REDIRECT_BLOCKED"
  | "RATE_LIMITED"
  | "HTTP_STATUS"
  | "RESPONSE_URL_MISMATCH"
  | "RESPONSE_TOO_LARGE"
  | "RESPONSE_READ_FAILED";

export class TiebaTransportError extends Error {
  constructor(
    public readonly code: TiebaTransportErrorCode,
    message: string,
    public readonly status: number | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TiebaTransportError";
  }
}

export interface TiebaTransportResponse {
  text: string;
  status: number;
  url: string;
}

export type TiebaFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function invalidRequest(message: string): never {
  throw new TiebaTransportError("INVALID_REQUEST", message);
}

function exactHeader(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | null {
  const matches = Object.entries(headers).filter(
    ([key]) => key.toLowerCase() === name,
  );
  if (matches.length > 1) {
    invalidRequest(`请求包含重复的 ${name} 头。`);
  }
  return matches[0]?.[1]?.trim() || null;
}

function assertAllowedHeaders(
  headers: Readonly<Record<string, string>>,
): void {
  for (const key of Object.keys(headers)) {
    if (!ALLOWED_HEADERS.has(key.toLowerCase())) {
      invalidRequest(`只读请求不允许使用请求头 ${key}。`);
    }
  }
}

function assertExactKeys(
  params: URLSearchParams,
  allowed: ReadonlySet<string>,
  required: readonly string[],
  label: string,
): void {
  for (const key of params.keys()) {
    if (!allowed.has(key)) invalidRequest(`${label}包含未允许的参数 ${key}。`);
    if (params.getAll(key).length !== 1) {
      invalidRequest(`${label}参数 ${key} 不能重复。`);
    }
  }
  for (const key of required) {
    if (!params.get(key)?.trim()) invalidRequest(`${label}缺少参数 ${key}。`);
  }
}

function assertNumericParam(
  params: URLSearchParams,
  key: string,
  label: string,
): void {
  if (!/^\d{1,32}$/u.test(params.get(key) ?? "")) {
    invalidRequest(`${label}参数 ${key} 必须是数字。`);
  }
}

function assertSignature(params: URLSearchParams, label: string): void {
  if (!/^[a-f\d]{32}$/u.test(params.get("sign") ?? "")) {
    invalidRequest(`${label}签名格式无效。`);
  }
}

function assertSyncQuery(url: URL): void {
  assertExactKeys(
    url.searchParams,
    SYNC_QUERY_KEYS,
    ["subapp_type", "_client_type", "sign"],
    "同步接口查询",
  );
  if (url.searchParams.get("subapp_type") !== "pc") {
    invalidRequest("同步接口仅允许 PC 子应用。");
  }
  if (url.searchParams.get("_client_type") !== "20") {
    invalidRequest("同步接口客户端类型无效。");
  }
  assertSignature(url.searchParams, "同步接口");
}

function assertCommentQuery(url: URL): void {
  assertExactKeys(
    url.searchParams,
    COMMENT_QUERY_KEYS,
    ["tid", "pid", "pn"],
    "楼中楼接口查询",
  );
  assertNumericParam(url.searchParams, "tid", "楼中楼接口");
  assertNumericParam(url.searchParams, "pid", "楼中楼接口");
  assertNumericParam(url.searchParams, "pn", "楼中楼接口");
  if (url.searchParams.has("fid")) {
    assertNumericParam(url.searchParams, "fid", "楼中楼接口");
  }
  if (Number(url.searchParams.get("pn")) < 1) {
    invalidRequest("楼中楼接口页码必须大于零。");
  }
}

function assertPagePcBody(request: TiebaReadRequest, url: URL): void {
  if (url.search) invalidRequest("帖子分页接口不允许 URL 查询参数。");
  const contentType = exactHeader(request.headers, "content-type");
  const normalizedContentType = contentType
    ?.toLowerCase()
    .replace(/[\t ]+/gu, "");
  if (
    normalizedContentType !== "application/x-www-form-urlencoded" &&
    normalizedContentType !==
      "application/x-www-form-urlencoded;charset=utf-8"
  ) {
    invalidRequest("帖子分页接口必须使用表单 Content-Type。");
  }
  if (typeof request.body !== "string" || request.body.length === 0) {
    invalidRequest("帖子分页接口必须提供非空表单正文。");
  }

  const params = new URLSearchParams(request.body);
  assertExactKeys(
    params,
    PAGE_PC_BODY_KEYS,
    ["pn", "kz", "tbs", "subapp_type", "_client_type", "sign"],
    "帖子分页接口表单",
  );
  assertNumericParam(params, "pn", "帖子分页接口");
  assertNumericParam(params, "kz", "帖子分页接口");
  if (Number(params.get("pn")) < 1) {
    invalidRequest("帖子分页接口页码必须大于零。");
  }
  if (!/^[A-Za-z0-9_-]{8,256}$/u.test(params.get("tbs") ?? "")) {
    invalidRequest("帖子分页接口 tbs 格式无效。");
  }
  if (params.get("subapp_type") !== "pc") {
    invalidRequest("帖子分页接口仅允许 PC 子应用。");
  }
  if (params.get("_client_type") !== "20") {
    invalidRequest("帖子分页接口客户端类型无效。");
  }
  assertSignature(params, "帖子分页接口");
}

/**
 * Rejects every request except the three known read-only Tieba operations.
 * This is a runtime boundary: callers cannot use it as an arbitrary URL proxy.
 */
export function validateTiebaReadRequest(request: TiebaReadRequest): URL {
  if (!request || typeof request !== "object") {
    invalidRequest("贴吧只读请求格式无效。");
  }
  if (
    typeof request.endpoint !== "string" ||
    !Object.prototype.hasOwnProperty.call(ENDPOINT_METHODS, request.endpoint)
  ) {
    invalidRequest("该贴吧接口不在只读白名单中。");
  }
  if (
    typeof request.url !== "string" ||
    !request.headers ||
    typeof request.headers !== "object" ||
    Array.isArray(request.headers)
  ) {
    invalidRequest("贴吧只读请求缺少地址或请求头。");
  }

  let url: URL;
  try {
    url = new URL(request.url);
  } catch (error) {
    throw new TiebaTransportError(
      "INVALID_REQUEST",
      "贴吧只读请求地址无效。",
      null,
      { cause: error },
    );
  }
  if (
    url.origin !== TIEBA_ORIGIN ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port
  ) {
    invalidRequest("贴吧只读请求只能访问 https://tieba.baidu.com。");
  }
  if (url.hash) invalidRequest("贴吧只读请求不允许 URL 片段。");
  if (url.pathname !== request.endpoint) {
    invalidRequest("请求地址与声明的贴吧只读接口不一致。");
  }

  const expectedMethod = ENDPOINT_METHODS[request.endpoint];
  if (request.method !== expectedMethod) {
    invalidRequest(`${request.endpoint} 只允许 ${expectedMethod} 方法。`);
  }
  assertAllowedHeaders(request.headers);

  if (request.method === "GET") {
    if (request.body !== undefined) {
      invalidRequest("贴吧只读 GET 请求不允许携带正文。");
    }
    if (exactHeader(request.headers, "content-type") !== null) {
      invalidRequest("贴吧只读 GET 请求不允许 Content-Type 头。");
    }
    if (request.endpoint === "/c/s/pc/sync") assertSyncQuery(url);
    else assertCommentQuery(url);
  } else {
    assertPagePcBody(request, url);
  }
  return url;
}

async function readLimitedText(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/u.test(contentLength)) {
    const declaredLength = Number(contentLength);
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > TIEBA_RESPONSE_BODY_LIMIT_BYTES
    ) {
      throw new TiebaTransportError(
        "RESPONSE_TOO_LARGE",
        "贴吧只读接口响应超过 4MB 上限。",
        response.status,
      );
    }
  }

  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytesRead += value.byteLength;
      if (bytesRead > TIEBA_RESPONSE_BODY_LIMIT_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new TiebaTransportError(
          "RESPONSE_TOO_LARGE",
          "贴吧只读接口响应超过 4MB 上限。",
          response.status,
        );
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } catch (error) {
    if (error instanceof TiebaTransportError) throw error;
    throw new TiebaTransportError(
      "RESPONSE_READ_FAILED",
      "读取贴吧只读接口响应失败。",
      response.status,
      { cause: error },
    );
  } finally {
    reader.releaseLock();
  }
}

/**
 * Executes one validated Tieba read request. It never follows redirects,
 * retries, or permits any endpoint capable of mutating Tieba state.
 */
export async function executeTiebaReadRequest(
  request: TiebaReadRequest,
  fetchImpl: TiebaFetch,
  signal?: AbortSignal,
): Promise<TiebaTransportResponse> {
  const expectedUrl = validateTiebaReadRequest(request);
  let response: Response;
  try {
    response = await fetchImpl(expectedUrl.href, {
      method: request.method,
      headers: request.headers,
      ...(request.method === "POST" ? { body: request.body } : {}),
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      signal,
    });
  } catch (error) {
    if (
      signal?.aborted ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      throw error;
    }
    const redirected =
      error instanceof Error && /redirect/iu.test(error.message);
    throw new TiebaTransportError(
      redirected ? "REDIRECT_BLOCKED" : "NETWORK_ERROR",
      redirected
        ? "贴吧只读接口尝试重定向，已阻止本次读取。"
        : "贴吧只读接口网络请求失败。",
      null,
      { cause: error },
    );
  }

  if (response.redirected || response.type === "opaqueredirect") {
    throw new TiebaTransportError(
      "REDIRECT_BLOCKED",
      "贴吧只读接口尝试重定向，已阻止本次读取。",
      response.status,
    );
  }

  let responseUrl: URL;
  try {
    responseUrl = new URL(response.url);
  } catch (error) {
    throw new TiebaTransportError(
      "RESPONSE_URL_MISMATCH",
      "贴吧只读接口未返回可验证的响应地址。",
      response.status,
      { cause: error },
    );
  }
  if (responseUrl.href !== expectedUrl.href) {
    throw new TiebaTransportError(
      "RESPONSE_URL_MISMATCH",
      "贴吧只读接口响应地址与请求地址不一致。",
      response.status,
    );
  }
  if (response.status === 429) {
    throw new TiebaTransportError(
      "RATE_LIMITED",
      "贴吧暂时限制了只读请求。",
      response.status,
    );
  }
  if (!response.ok) {
    throw new TiebaTransportError(
      "HTTP_STATUS",
      `贴吧只读接口返回 HTTP ${response.status}。`,
      response.status,
    );
  }

  return {
    text: await readLimitedText(response),
    status: response.status,
    url: responseUrl.href,
  };
}
