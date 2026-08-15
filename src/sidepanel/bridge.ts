import type {
  ExtensionErrorCode,
  ExtensionResponse,
  SidePanelRequest,
} from "../messages";
import {
  CLOUD_ANALYSIS_PORT_NAME,
  type CloudBrokerRequest,
  type CloudBrokerResponse,
} from "../cloudBroker";
import {
  analyzeWholeThreadWithCloud,
  type CloudAnalysisConfig,
  type CloudAnalysisMode,
  type CloudAnalysisResult,
  type WholeThreadCloudAnalysisResult,
} from "../lib/cloud";
import {
  endpointPermissionPattern,
  isPersistentCloudPermissionOrigin,
} from "../lib/cloudPermission";
import type { CapturedReply, Finding } from "../types";

export class ExtensionRequestError extends Error {
  constructor(
    message: string,
    public readonly code: ExtensionErrorCode,
  ) {
    super(message);
    this.name = "ExtensionRequestError";
  }
}

export const PERSISTENT_CLOUD_PERMISSION_REQUIRED_MESSAGE =
  "Chrome 尚未授予当前 AI 服务商的固定域名权限。";

/**
 * A fixed provider can still be withheld by Chrome's per-extension site
 * access controls. Keep this distinct from transport/model failures: no
 * reviewed text has left the browser when this error is raised.
 */
export class PersistentCloudPermissionRequiredError extends Error {
  constructor(public readonly origin: string) {
    super(PERSISTENT_CLOUD_PERMISSION_REQUIRED_MESSAGE);
    this.name = "PersistentCloudPermissionRequiredError";
  }
}

export function isPersistentCloudPermissionRequired(
  value: unknown,
): boolean {
  const message =
    value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : "";
  return (
    value instanceof PersistentCloudPermissionRequiredError ||
    message === PERSISTENT_CLOUD_PERMISSION_REQUIRED_MESSAGE ||
    // Recognize the 0.2.0 cached failure so an already affected Chrome user
    // gets the recovery button without first paying for another request.
    message.includes("固定 AI 端点权限尚未生效")
  );
}

/**
 * Starts Chrome's persistent grant prompt immediately. This deliberately is
 * not async: callers must invoke it directly from the moderator's click
 * handler, before any await would consume the required user gesture.
 */
export function requestPersistentCloudPermission(
  endpoint: string,
): Promise<boolean> {
  const origin = endpointPermissionPattern(endpoint);
  if (!isPersistentCloudPermissionOrigin(origin)) {
    throw new Error(
      "自动整帖分析仅支持已固定授权的 AI 服务商端点，请检查云端设置。",
    );
  }
  return chrome.permissions.request({ origins: [origin] });
}

export async function sendExtensionMessage<T>(
  request: SidePanelRequest,
): Promise<T> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    throw new ExtensionRequestError(
      "请从已安装扩展的侧栏中使用此功能",
      "UNKNOWN",
    );
  }
  const response = (await chrome.runtime.sendMessage(
    request,
  )) as ExtensionResponse<T>;
  if (!response?.ok) {
    throw new ExtensionRequestError(
      response?.error ?? "扩展没有返回结果",
      response?.code ?? "UNKNOWN",
    );
  }
  return response.data;
}

export async function getActiveTabId(): Promise<number | null> {
  if (typeof chrome === "undefined" || !chrome.tabs?.query) return null;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

export { endpointPermissionPattern } from "../lib/cloudPermission";

export interface ManagedCloudAnalysisOptions {
  endpoint: string;
  model: string;
  apiKey: string;
  mode?: CloudAnalysisMode;
  signal?: AbortSignal;
  /** Runs after permission is granted but before any request leaves the browser. */
  beforeStart?: () => Promise<void>;
}

export interface ManagedWholeThreadCloudAnalysisOptions
  extends ManagedCloudAnalysisOptions {
  /** Test seam; production callers use the real side-panel implementation. */
  analyze?: typeof analyzeWholeThreadWithCloud;
}

function requestId(): string {
  return typeof crypto?.randomUUID === "function"
    ? crypto.randomUUID()
    : `cloud-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Requests the origin from the confirmation click, then hands the request to
 * the background broker. The broker revokes the permission before resolving
 * and also revokes it if this side-panel port disappears.
 */
export async function runManagedCloudAnalysis(
  finding: Finding,
  replies: CapturedReply[],
  options: ManagedCloudAnalysisOptions,
): Promise<CloudAnalysisResult> {
  const origin = endpointPermissionPattern(options.endpoint);
  const persistentPermission = isPersistentCloudPermissionOrigin(origin);
  const id = requestId();
  const port = chrome.runtime.connect({ name: CLOUD_ANALYSIS_PORT_NAME });
  let settled = false;
  let resolveResponse!: (value: CloudAnalysisResult) => void;
  let rejectResponse!: (reason: Error) => void;
  const response = new Promise<CloudAnalysisResult>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  let permissionGranted = false;
  let startPosted = false;
  // The permission prompt can outlive the foreground page. Mark the deferred
  // response as handled even if an abort means we never reach `await response`.
  void response.catch(() => undefined);

  const abort = () => {
    if (settled) return;
    settled = true;
    port.postMessage({
      type: "CLOUD_ANALYSIS_CANCEL",
      requestId: id,
    } satisfies CloudBrokerRequest);
    rejectResponse(new DOMException("云端请求已取消", "AbortError"));
    port.disconnect();
  };

  port.onMessage.addListener((message: CloudBrokerResponse) => {
    if (message.requestId !== id || settled) return;
    settled = true;
    if (message.type === "CLOUD_ANALYSIS_RESULT") {
      resolveResponse(message.result);
    } else if (message.type === "CLOUD_ANALYSIS_ERROR") {
      rejectResponse(new Error(message.error));
    } else {
      rejectResponse(new Error("云端返回了不匹配的单项分析结果"));
    }
  });
  port.onDisconnect.addListener(() => {
    if (settled) return;
    settled = true;
    rejectResponse(new Error("云端分析连接已中断，本地结果仍保留"));
  });
  options.signal?.addEventListener("abort", abort, { once: true });

  // PREPARE is posted before the permission prompt. If the panel closes at
  // any later point, the background port already knows which origin to revoke.
  port.postMessage({
    type: "CLOUD_PERMISSION_PREPARE",
    requestId: id,
    endpoint: options.endpoint,
  } satisfies CloudBrokerRequest);

  // This call happens synchronously in the user's confirmation click stack.
  const permissionRequest = persistentPermission
    ? chrome.permissions.contains({ origins: [origin] })
    : chrome.permissions.request({ origins: [origin] });
  try {
    const granted = await permissionRequest;
    permissionGranted = granted;
    if (!granted) throw new Error("未授予该 AI 端点的网络权限");
    if (options.signal?.aborted) throw new DOMException("云端请求已取消", "AbortError");
    if (settled) return await response;
    await options.beforeStart?.();
    if (options.signal?.aborted) throw new DOMException("云端请求已取消", "AbortError");
    port.postMessage({
      type: "CLOUD_ANALYSIS_START",
      requestId: id,
      endpoint: options.endpoint,
      model: options.model,
      apiKey: options.apiKey,
      mode: options.mode,
      finding,
      replies,
    } satisfies CloudBrokerRequest);
    startPosted = true;
    return await response;
  } catch (error) {
    if (!settled) {
      settled = true;
      port.postMessage({
        type: "CLOUD_ANALYSIS_CANCEL",
        requestId: id,
      } satisfies CloudBrokerRequest);
      port.disconnect();
    }
    if (permissionGranted && !startPosted && !persistentPermission) {
      // A permission prompt can resolve after the reviewed tab has already
      // switched and the original broker port has disconnected. Revoke the
      // late grant here as a foreground fallback; the durable broker lease is
      // still the restart-safe cleanup path.
      let stillGranted = true;
      try {
        await chrome.permissions.remove({ origins: [origin] });
        stillGranted = await chrome.permissions.contains({ origins: [origin] });
      } catch {
        // The explicit contains check below turns this into a visible error.
      }
      if (stillGranted) {
        throw new Error(
          `云端域名权限未能撤销（${origin}），请在扩展管理页检查站点权限。`,
        );
      }
    }
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    if (!settled) {
      // A result always arrives after background cleanup. This branch is only
      // defensive for an unexpected synchronous exit.
      port.disconnect();
    } else {
      try {
        port.disconnect();
      } catch {
        // The abort/disconnect path may already have closed the port.
      }
    }
  }
}

/**
 * Runs one whole-thread analysis against the exact provider origin declared in
 * the manifest. It never requests or removes a runtime permission.
 */
export async function runManagedWholeThreadCloudAnalysis(
  threadTitle: string,
  replies: CapturedReply[],
  options: ManagedWholeThreadCloudAnalysisOptions,
): Promise<WholeThreadCloudAnalysisResult> {
  const origin = endpointPermissionPattern(options.endpoint);
  if (!isPersistentCloudPermissionOrigin(origin)) {
    throw new Error(
      "自动整帖分析仅支持已固定授权的 AI 服务商端点，请检查云端设置。",
    );
  }
  const granted = await chrome.permissions.contains({ origins: [origin] });
  if (!granted) {
    throw new PersistentCloudPermissionRequiredError(origin);
  }
  if (options.signal?.aborted) {
    throw new DOMException("整帖云端分析已取消", "AbortError");
  }
  await options.beforeStart?.();
  if (options.signal?.aborted) {
    throw new DOMException("整帖云端分析已取消", "AbortError");
  }

  // A long pending fetch inside an MV3 service worker can be terminated by
  // Chromium/Tabbit's worker lifecycle, which disconnects the side-panel port
  // even though the provider is still processing. The fixed host permission
  // does not need a background revoke lease, so keep this request in the
  // visible side panel instead. Closing/switching the panel aborts it via the
  // same signal supplied by App.
  const analyze = options.analyze ?? analyzeWholeThreadWithCloud;
  const config = {
    endpoint: options.endpoint,
    model: options.model,
    apiKey: options.apiKey,
    mode: options.mode,
    signal: options.signal,
  } satisfies CloudAnalysisConfig;
  return analyze(threadTitle, replies, config);
}
