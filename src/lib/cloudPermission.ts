import type { CloudProvider } from "../types";

export const CLOUD_PROVIDER_DEFAULTS: Record<
  CloudProvider,
  { endpoint: string; model: string }
> = {
  alibaba: {
    endpoint:
      "https://ws-7ee35od4h2zs6dft.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    model: "qwen3.7-max",
  },
  deepseek: {
    endpoint: "https://api.deepseek.com/chat/completions",
    model: "deepseek-v4-pro",
  },
};

export const DEFAULT_CLOUD_PROVIDER: CloudProvider = "alibaba";

export const PERSISTENT_CLOUD_PERMISSION_ORIGINS = [
  "https://ws-7ee35od4h2zs6dft.cn-beijing.maas.aliyuncs.com/*",
  "https://api.deepseek.com/*",
] as const;

/**
 * Migrates pre-provider settings without trusting a free-form model name.
 * DeepSeek is selected only for its exact official API hostname; every older
 * endpoint keeps the existing Alibaba behavior.
 */
export function normalizeCloudProvider(
  value: unknown,
  endpoint = "",
): CloudProvider {
  if (value === "alibaba" || value === "deepseek") return value;
  try {
    if (new URL(endpoint).hostname.toLocaleLowerCase("en-US") === "api.deepseek.com") {
      return "deepseek";
    }
  } catch {
    // Empty/legacy-invalid endpoints retain the existing Alibaba default.
  }
  return DEFAULT_CLOUD_PROVIDER;
}

export function isPersistentCloudPermissionOrigin(origin: string): boolean {
  return PERSISTENT_CLOUD_PERMISSION_ORIGINS.some(
    (allowed) => allowed === origin,
  );
}

/**
 * Returns the narrow optional host-permission pattern for one configured
 * provider. Chrome ignores ports and paths in host permission match patterns.
 */
export function endpointPermissionPattern(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.username || url.password) {
    throw new Error("云端 endpoint 不能在 URL 中携带用户名或密码");
  }
  if (url.protocol === "http:") {
    if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      throw new Error("非本机云端 endpoint 必须使用 HTTPS");
    }
  } else if (url.protocol !== "https:") {
    throw new Error("云端 endpoint 仅支持 HTTPS 或本机 HTTP");
  }
  if (url.hostname === "tieba.baidu.com") {
    throw new Error("云端 endpoint 不能使用贴吧页面域名");
  }
  return `${url.protocol}//${url.hostname}/*`;
}

const SENSITIVE_QUERY_KEYS = new Set([
  "apikey",
  "key",
  "xapikey",
  "subscriptionkey",
  "accesstoken",
  "token",
  "secret",
  "clientsecret",
  "password",
  "passwd",
  "signature",
  "sig",
  "auth",
  "authorization",
  "credential",
  "credentials",
]);

/**
 * Validates the endpoint string before it enters durable local storage.
 * Provider credentials belong in the session-only API-key field, never in a
 * URL user-info segment, fragment, or credential-shaped query parameter.
 */
export function persistableCloudEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (!trimmed) return "";
  endpointPermissionPattern(trimmed);
  const url = new URL(trimmed);
  if (url.hash) {
    throw new Error("云端 endpoint 不能包含 URL 片段");
  }
  for (const key of url.searchParams.keys()) {
    const normalized = key.toLocaleLowerCase("en-US").replace(/[^a-z0-9]/gu, "");
    if (
      SENSITIVE_QUERY_KEYS.has(normalized) ||
      normalized.endsWith("apikey") ||
      normalized.endsWith("subscriptionkey") ||
      normalized.endsWith("token") ||
      normalized.endsWith("secret")
    ) {
      throw new Error("云端 endpoint 不能在查询参数中携带密钥或令牌");
    }
  }
  return url.toString();
}
