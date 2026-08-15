import type {
  CloudAnalysisMode,
  WholeThreadCloudAnalysisResult,
} from "./cloud";
import { CLOUD_ANALYZER_VERSION } from "./cloud";
import type { ReviewSession } from "./session";

export const THREAD_CLOUD_TRANSPORT_VERSION = "sidepanel-v1" as const;

export interface ThreadCloudCacheIdentity {
  tabId: number;
  threadId: string | null;
  sessionUpdatedAt: string;
  endpoint: string;
  model: string;
  mode: CloudAnalysisMode;
  analyzerVersion: typeof CLOUD_ANALYZER_VERSION;
  transportVersion: typeof THREAD_CLOUD_TRANSPORT_VERSION;
}

export type ThreadCloudCacheEntry =
  | (ThreadCloudCacheIdentity & {
      status: "pending";
      startedAt: string;
    })
  | (ThreadCloudCacheIdentity & {
      status: "success";
      result: WholeThreadCloudAnalysisResult;
    })
  | (ThreadCloudCacheIdentity & {
      status: "failed";
      error: string;
    });

export const threadCloudCacheStorageKey = (tabId: number): string =>
  `kr_whole_thread_cloud_v2_${tabId}`;

export function threadCloudCacheIdentity(
  session: ReviewSession,
  settings: {
    endpoint: string;
    model: string;
    mode: CloudAnalysisMode;
  },
): ThreadCloudCacheIdentity {
  return {
    tabId: session.tabId,
    threadId: session.threadId,
    sessionUpdatedAt: session.updatedAt,
    endpoint: settings.endpoint,
    model: settings.model,
    mode: settings.mode,
    analyzerVersion: CLOUD_ANALYZER_VERSION,
    transportVersion: THREAD_CLOUD_TRANSPORT_VERSION,
  };
}

function isCacheEntry(value: unknown): value is ThreadCloudCacheEntry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.tabId !== "number" ||
    (candidate.threadId !== null && typeof candidate.threadId !== "string") ||
    typeof candidate.sessionUpdatedAt !== "string" ||
    typeof candidate.endpoint !== "string" ||
    typeof candidate.model !== "string" ||
    (candidate.mode !== "fast" && candidate.mode !== "deep") ||
    candidate.analyzerVersion !== CLOUD_ANALYZER_VERSION ||
    candidate.transportVersion !== THREAD_CLOUD_TRANSPORT_VERSION
  ) {
    return false;
  }
  if (candidate.status === "pending") {
    return (
      typeof candidate.startedAt === "string" &&
      candidate.startedAt.length > 0 &&
      Number.isFinite(Date.parse(candidate.startedAt))
    );
  }
  if (candidate.status === "failed") {
    return typeof candidate.error === "string";
  }
  if (candidate.status !== "success") return false;
  const result = candidate.result as
    | Partial<WholeThreadCloudAnalysisResult>
    | undefined;
  return Boolean(
    result &&
      typeof result.summary === "string" &&
      Array.isArray(result.findings) &&
      Array.isArray(result.uncertainties) &&
      typeof result.analyzedReplyCount === "number" &&
      typeof result.ruleCount === "number" &&
      typeof result.omittedImageCount === "number",
  );
}

function sameIdentity(
  entry: ThreadCloudCacheEntry,
  identity: ThreadCloudCacheIdentity,
): boolean {
  return (
    entry.tabId === identity.tabId &&
    entry.threadId === identity.threadId &&
    entry.sessionUpdatedAt === identity.sessionUpdatedAt &&
    entry.endpoint === identity.endpoint &&
    entry.model === identity.model &&
    entry.mode === identity.mode &&
    entry.analyzerVersion === identity.analyzerVersion &&
    entry.transportVersion === identity.transportVersion
  );
}

export async function loadThreadCloudCache(
  identity: ThreadCloudCacheIdentity,
): Promise<ThreadCloudCacheEntry | null> {
  const key = threadCloudCacheStorageKey(identity.tabId);
  const stored = await chrome.storage.session.get(key);
  const entry = stored[key];
  if (!isCacheEntry(entry) || !sameIdentity(entry, identity)) return null;
  return entry;
}

export async function saveThreadCloudCache(
  entry: ThreadCloudCacheEntry,
): Promise<void> {
  await chrome.storage.session.set({
    [threadCloudCacheStorageKey(entry.tabId)]: entry,
  });
}

export async function clearThreadCloudCache(tabId: number): Promise<void> {
  await chrome.storage.session.remove(threadCloudCacheStorageKey(tabId));
}
