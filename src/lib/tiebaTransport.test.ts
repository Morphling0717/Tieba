import { describe, expect, it, vi } from "vitest";

import {
  TIEBA_RESPONSE_BODY_LIMIT_BYTES,
  TiebaTransportError,
  executeTiebaReadRequest,
  validateTiebaReadRequest,
  type TiebaFetch,
} from "./tiebaTransport";
import {
  buildTiebaNestedRequest,
  buildTiebaPagePcRequest,
  buildTiebaSyncRequest,
  type TiebaReadRequest,
} from "./tiebaApi";

function responseAt(
  url: string,
  body = "{}",
  init: ResponseInit & { redirected?: boolean } = {},
): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", {
    configurable: true,
    value: url,
  });
  Object.defineProperty(response, "redirected", {
    configurable: true,
    value: init.redirected ?? false,
  });
  return response;
}

function validPageRequest(): TiebaReadRequest {
  return buildTiebaPagePcRequest(
    "99000000001",
    1,
    "0123456789abcdef0123456789abcdef",
  );
}

describe("validateTiebaReadRequest", () => {
  it("accepts only the three exact read endpoint and method pairs", () => {
    expect(validateTiebaReadRequest(buildTiebaSyncRequest()).pathname).toBe(
      "/c/s/pc/sync",
    );
    expect(validateTiebaReadRequest(validPageRequest()).pathname).toBe(
      "/c/f/pb/page_pc",
    );
    expect(
      validateTiebaReadRequest(
        buildTiebaNestedRequest("99000000001", "990100000002", 1),
      ).pathname,
    ).toBe("/p/comment");
  });

  it.each([
    "http://tieba.baidu.com/p/comment?tid=1&pid=2&pn=1",
    "https://tieba.baidu.com.evil.example/p/comment?tid=1&pid=2&pn=1",
    "https://user@tieba.baidu.com/p/comment?tid=1&pid=2&pn=1",
    "https://tieba.baidu.com:444/p/comment?tid=1&pid=2&pn=1",
  ])("rejects a non-exact Tieba origin: %s", (url) => {
    const request = {
      ...buildTiebaNestedRequest("1", "2", 1),
      url,
    };
    expect(() => validateTiebaReadRequest(request)).toThrowError(
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("rejects path, endpoint and method confusion, including write paths", () => {
    const nested = buildTiebaNestedRequest("1", "2", 1);
    expect(() =>
      validateTiebaReadRequest({
        ...nested,
        url: "https://tieba.baidu.com/f/commit/post/add",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(() =>
      validateTiebaReadRequest({
        ...nested,
        endpoint: "/c/s/pc/sync",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(() =>
      validateTiebaReadRequest({
        ...nested,
        method: "POST",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(() =>
      validateTiebaReadRequest({
        ...nested,
        endpoint: "__proto__",
        url: "https://tieba.baidu.com/__proto__",
      } as unknown as TiebaReadRequest),
    ).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(() =>
      validateTiebaReadRequest({
        ...nested,
        headers: null,
      } as unknown as TiebaReadRequest),
    ).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });

  it("rejects GET bodies, unexpected parameters and override headers", () => {
    const nested = buildTiebaNestedRequest("1", "2", 1);
    expect(() =>
      validateTiebaReadRequest({ ...nested, body: "" }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(() =>
      validateTiebaReadRequest({
        ...nested,
        url: `${nested.url}&delete=1`,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(() =>
      validateTiebaReadRequest({
        ...nested,
        headers: { ...nested.headers, "X-HTTP-Method-Override": "POST" },
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });

  it("allows one optional numeric fid for the nested read endpoint only", () => {
    const nested = buildTiebaNestedRequest("1", "2", 1);
    expect(() =>
      validateTiebaReadRequest({
        ...nested,
        url: `${nested.url}&fid=4293157`,
      }),
    ).not.toThrow();
    expect(() =>
      validateTiebaReadRequest({
        ...nested,
        url: `${nested.url}&fid=not-a-number`,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(() =>
      validateTiebaReadRequest({
        ...nested,
        url: `${nested.url}&fid=1&fid=2`,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });

  it("requires a non-empty form body and form content type for page_pc", () => {
    const page = validPageRequest();
    expect(() =>
      validateTiebaReadRequest({ ...page, body: undefined }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(() =>
      validateTiebaReadRequest({
        ...page,
        headers: { ...page.headers, "Content-Type": "application/json" },
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(() =>
      validateTiebaReadRequest({
        ...page,
        body: `${page.body}&action=delete`,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });
});

describe("executeTiebaReadRequest", () => {
  it("uses credentialed no-cache fetch and never follows redirects", async () => {
    const request = buildTiebaNestedRequest("99000000001", "990100000002", 1);
    const fetchImpl = vi.fn<TiebaFetch>().mockResolvedValue(
      responseAt(request.url, "<li>只读内容</li>"),
    );

    await expect(
      executeTiebaReadRequest(request, fetchImpl),
    ).resolves.toEqual({
      text: "<li>只读内容</li>",
      status: 200,
      url: request.url,
    });
    expect(fetchImpl).toHaveBeenCalledWith(request.url, {
      method: "GET",
      headers: request.headers,
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      signal: undefined,
    });
  });

  it("sends only the validated form body for page_pc", async () => {
    const request = validPageRequest();
    const fetchImpl = vi.fn<TiebaFetch>().mockResolvedValue(
      responseAt(request.url),
    );

    await executeTiebaReadRequest(request, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      request.url,
      expect.objectContaining({
        method: "POST",
        body: request.body,
        redirect: "error",
      }),
    );
  });

  it.each([
    [429, "RATE_LIMITED"],
    [403, "HTTP_STATUS"],
    [500, "HTTP_STATUS"],
  ] as const)("maps HTTP %i to %s", async (status, code) => {
    const request = buildTiebaSyncRequest();
    const fetchImpl = vi.fn<TiebaFetch>().mockResolvedValue(
      responseAt(request.url, "", { status }),
    );

    await expect(
      executeTiebaReadRequest(request, fetchImpl),
    ).rejects.toMatchObject({ code, status });
  });

  it("rejects redirected and mismatched response URLs", async () => {
    const request = buildTiebaSyncRequest();
    const redirectedFetch = vi.fn<TiebaFetch>().mockResolvedValue(
      responseAt(request.url, "", { redirected: true }),
    );
    await expect(
      executeTiebaReadRequest(request, redirectedFetch),
    ).rejects.toMatchObject({ code: "REDIRECT_BLOCKED" });

    const mismatchedFetch = vi.fn<TiebaFetch>().mockResolvedValue(
      responseAt("https://tieba.baidu.com/c/s/pc/sync?different=1"),
    );
    await expect(
      executeTiebaReadRequest(request, mismatchedFetch),
    ).rejects.toMatchObject({ code: "RESPONSE_URL_MISMATCH" });
  });

  it("maps a redirect rejection from fetch to a stable error", async () => {
    const request = buildTiebaSyncRequest();
    const fetchImpl = vi
      .fn<TiebaFetch>()
      .mockRejectedValue(new TypeError("Failed to fetch: redirect disallowed"));

    await expect(
      executeTiebaReadRequest(request, fetchImpl),
    ).rejects.toMatchObject({ code: "REDIRECT_BLOCKED" });
  });

  it("rejects content-length and streamed bodies over 4MB", async () => {
    const request = buildTiebaSyncRequest();
    const declaredOversize = vi.fn<TiebaFetch>().mockResolvedValue(
      responseAt(request.url, "", {
        headers: {
          "Content-Length": String(TIEBA_RESPONSE_BODY_LIMIT_BYTES + 1),
        },
      }),
    );
    await expect(
      executeTiebaReadRequest(request, declaredOversize),
    ).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });

    const streamedOversize = vi.fn<TiebaFetch>().mockResolvedValue(
      responseAt(request.url, "x".repeat(TIEBA_RESPONSE_BODY_LIMIT_BYTES + 1)),
    );
    await expect(
      executeTiebaReadRequest(request, streamedOversize),
    ).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  });

  it("preserves AbortError so navigation cancellation wins", async () => {
    const request = buildTiebaSyncRequest();
    const controller = new AbortController();
    const aborted = new DOMException("aborted", "AbortError");
    const fetchImpl = vi.fn<TiebaFetch>().mockImplementation(async () => {
      controller.abort();
      throw aborted;
    });

    await expect(
      executeTiebaReadRequest(request, fetchImpl, controller.signal),
    ).rejects.toBe(aborted);
  });

  it("exposes a stable network error without response content", async () => {
    const request = buildTiebaSyncRequest();
    const fetchImpl = vi
      .fn<TiebaFetch>()
      .mockRejectedValue(new Error("sensitive low-level details"));

    try {
      await executeTiebaReadRequest(request, fetchImpl);
      throw new Error("expected transport failure");
    } catch (error) {
      expect(error).toBeInstanceOf(TiebaTransportError);
      expect(error).toMatchObject({ code: "NETWORK_ERROR", status: null });
      expect((error as Error).message).not.toContain("sensitive");
    }
  });
});
