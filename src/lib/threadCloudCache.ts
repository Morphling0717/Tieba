import { REASON_VERSION } from "../data/reasons";
import type { CloudProvider } from "../types";
import {
  CLOUD_ANALYZER_VERSION,
  WHOLE_THREAD_ANALYSIS_TIMEOUT_MS,
  type CloudAnalysisMode,
  type WholeThreadCloudAnalysisResult,
} from "./cloud";
import { normalizeCloudProvider } from "./cloudPermission";
import type { ReviewSession } from "./session";
import {
  createAnalysisKey,
  createSnapshotId,
  isAnalysisKey,
  isSnapshotId,
  type AnalysisKey,
  type SnapshotId,
} from "./threadIdentity";

export const THREAD_CLOUD_CACHE_SCHEMA_VERSION = 3 as const;
export const THREAD_CLOUD_TRANSPORT_VERSION = "sidepanel-v3" as const;
export const THREAD_CLOUD_BILLING_RECEIPT_SCHEMA_VERSION = 1 as const;

const THREAD_CLOUD_CACHE_V3_STORAGE_PREFIX = "kr_whole_thread_cloud_v3_";
const THREAD_CLOUD_BILLING_RECEIPT_STORAGE_PREFIX =
  "kr_thread_cloud_billing_v1_";
const THREAD_CLOUD_BILLING_LOCK_PREFIX = "kr-thread-cloud-billing-v1:";

const LEGACY_THREAD_CLOUD_TRANSPORT_VERSION = "sidepanel-v1" as const;
const LEGACY_THREAD_CLOUD_ANALYZER_VERSION = "2.3.0" as const;

export interface ThreadCloudCacheIdentity {
  schemaVersion: typeof THREAD_CLOUD_CACHE_SCHEMA_VERSION;
  snapshotId: SnapshotId;
  analysisKey: AnalysisKey;
  analyzerVersion: typeof CLOUD_ANALYZER_VERSION;
  rulesVersion: typeof REASON_VERSION;
  transportVersion: typeof THREAD_CLOUD_TRANSPORT_VERSION;
}

export type ThreadCloudCacheStatus =
  | "preparing"
  | "running"
  | "success"
  | "failed_before_send"
  | "failed_after_send"
  | "cancelled_before_send"
  | "cancelled_after_send"
  | "unknown_after_disconnect";

export type ThreadCloudErrorCategory =
  | "configuration"
  | "permission"
  | "capture_incomplete"
  | "network"
  | "timeout"
  | "provider"
  | "validation"
  | "aborted"
  | "storage"
  | "disconnect"
  | "unknown";

/** Deliberately contains no provider error text, which may echo private input. */
export interface ThreadCloudCacheError {
  category: ThreadCloudErrorCategory;
  code: string;
}

export interface ThreadCloudTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

interface ThreadCloudCacheEntryBase extends ThreadCloudCacheIdentity {
  status: ThreadCloudCacheStatus;
  attemptId: string;
  startedAt: string;
  updatedAt: string;
  sentAt: string | null;
  deadlineAt: string | null;
  error: ThreadCloudCacheError | null;
}

export type ThreadCloudCacheEntry =
  | (ThreadCloudCacheEntryBase & {
      status: "preparing" | "running";
      result?: never;
      completedAt?: never;
      usage?: never;
    })
  | (ThreadCloudCacheEntryBase & {
      status: "success";
      result: WholeThreadCloudAnalysisResult;
      completedAt: string;
      usage?: ThreadCloudTokenUsage;
    })
  | (ThreadCloudCacheEntryBase & {
      status:
        | "failed_before_send"
        | "failed_after_send"
        | "cancelled_before_send"
        | "cancelled_after_send"
        | "unknown_after_disconnect";
      result?: never;
      completedAt: string;
      usage?: never;
    });

export type ThreadCloudPreparingCacheEntry = Extract<
  ThreadCloudCacheEntry,
  { status: "preparing" | "running" }
> & { status: "preparing" };

export type ThreadCloudBillingReceiptStatus =
  | "preparing"
  | "sent"
  | "success"
  | "failed_before_send"
  | "history_deleted";

/**
 * Minimal durable proof that one immutable snapshot has already claimed or
 * sent a paid analysis. It deliberately contains no thread identity, source
 * text, user names, provider endpoint, API key, result, or free-form error.
 */
export interface ThreadCloudBillingReceipt {
  schemaVersion: typeof THREAD_CLOUD_BILLING_RECEIPT_SCHEMA_VERSION;
  snapshotId: SnapshotId;
  attemptId: string;
  analysisKey: AnalysisKey;
  status: ThreadCloudBillingReceiptStatus;
  startedAt: string;
  updatedAt: string;
  sentAt: string | null;
}

export interface ClaimThreadCloudAnalysisStartOptions {
  force?: boolean;
}

/** Kept for background cleanup and exact v2 migration only. */
export const threadCloudCacheStorageKey = (tabId: number): string =>
  `kr_whole_thread_cloud_v2_${tabId}`;

export const threadCloudCacheV3StorageKey = (
  analysisKey: AnalysisKey,
): string => `${THREAD_CLOUD_CACHE_V3_STORAGE_PREFIX}${analysisKey}`;

export const threadCloudBillingReceiptStorageKey = (
  snapshotId: SnapshotId | string,
): string => {
  if (!isSnapshotId(snapshotId)) {
    throw new TypeError("Invalid whole-thread billing snapshot id");
  }
  return `${THREAD_CLOUD_BILLING_RECEIPT_STORAGE_PREFIX}${snapshotId}`;
};

export function threadCloudCacheIdentity(
  session: Pick<ReviewSession, "title" | "replies">,
  settings: {
    provider?: CloudProvider;
    endpoint: string;
    model: string;
    mode: CloudAnalysisMode;
  },
): ThreadCloudCacheIdentity {
  const snapshotId = createSnapshotId(session);
  const provider =
    settings.provider ?? normalizeCloudProvider(undefined, settings.endpoint);
  return {
    schemaVersion: THREAD_CLOUD_CACHE_SCHEMA_VERSION,
    snapshotId,
    analysisKey: createAnalysisKey({
      snapshotId,
      provider,
      endpoint: settings.endpoint,
      model: settings.model,
      mode: settings.mode,
      analyzerVersion: CLOUD_ANALYZER_VERSION,
      rulesVersion: REASON_VERSION,
      transportVersion: THREAD_CLOUD_TRANSPORT_VERSION,
    }),
    analyzerVersion: CLOUD_ANALYZER_VERSION,
    rulesVersion: REASON_VERSION,
    transportVersion: THREAD_CLOUD_TRANSPORT_VERSION,
  };
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Number.isFinite(Date.parse(value))
  );
}

function isError(value: unknown): value is ThreadCloudCacheError {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    [
      "configuration",
      "permission",
      "capture_incomplete",
      "network",
      "timeout",
      "provider",
      "validation",
      "aborted",
      "storage",
      "disconnect",
      "unknown",
    ].includes(candidate.category as string) &&
    typeof candidate.code === "string" &&
    candidate.code.length > 0 &&
    candidate.code.length <= 80
  );
}

function hasWholeThreadResultShape(
  value: unknown,
): value is WholeThreadCloudAnalysisResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<WholeThreadCloudAnalysisResult>;
  return (
    typeof result.summary === "string" &&
    Array.isArray(result.findings) &&
    Array.isArray(result.uncertainties) &&
    typeof result.analyzedReplyCount === "number" &&
    Number.isFinite(result.analyzedReplyCount) &&
    typeof result.ruleCount === "number" &&
    Number.isFinite(result.ruleCount) &&
    typeof result.omittedImageCount === "number" &&
    Number.isFinite(result.omittedImageCount)
  );
}

function validSentState(
  status: ThreadCloudCacheStatus,
  sentAt: unknown,
  deadlineAt: unknown,
): boolean {
  if (
    status === "preparing" ||
    status === "failed_before_send" ||
    status === "cancelled_before_send"
  ) {
    return sentAt === null && deadlineAt === null;
  }
  return isIsoDate(sentAt) && isIsoDate(deadlineAt);
}

function isVersionTag(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 64 &&
    /^[A-Za-z0-9._-]+$/u.test(value)
  );
}

function isAttemptId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9:_-]{1,128}$/u.test(value)
  );
}

const billingReceiptKeys = [
  "schemaVersion",
  "snapshotId",
  "attemptId",
  "analysisKey",
  "status",
  "startedAt",
  "updatedAt",
  "sentAt",
] as const;

function isBillingReceipt(value: unknown): value is ThreadCloudBillingReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const ownKeys = Object.keys(candidate);
  if (
    ownKeys.length !== billingReceiptKeys.length ||
    billingReceiptKeys.some(
      (key) => !Object.prototype.hasOwnProperty.call(candidate, key),
    )
  ) {
    return false;
  }
  const status = candidate.status as ThreadCloudBillingReceiptStatus;
  if (
    candidate.schemaVersion !== THREAD_CLOUD_BILLING_RECEIPT_SCHEMA_VERSION ||
    !isSnapshotId(candidate.snapshotId) ||
    !isAttemptId(candidate.attemptId) ||
    !isAnalysisKey(candidate.analysisKey) ||
    ![
      "preparing",
      "sent",
      "success",
      "failed_before_send",
      "history_deleted",
    ].includes(status) ||
    !isIsoDate(candidate.startedAt) ||
    !isIsoDate(candidate.updatedAt) ||
    Date.parse(candidate.updatedAt as string) <
      Date.parse(candidate.startedAt as string)
  ) {
    return false;
  }
  return status === "preparing" || status === "failed_before_send"
    ? candidate.sentAt === null
    : isIsoDate(candidate.sentAt);
}

function billingReceiptStatusForEntry(
  entry: ThreadCloudCacheEntry,
): ThreadCloudBillingReceiptStatus {
  if (entry.status === "preparing") return "preparing";
  if (
    entry.status === "failed_before_send" ||
    entry.status === "cancelled_before_send"
  ) {
    return "failed_before_send";
  }
  if (entry.status === "success") return "success";
  if (entry.error?.code === "history_deleted") return "history_deleted";
  return "sent";
}

function billingReceiptFromEntry(
  entry: ThreadCloudCacheEntry,
): ThreadCloudBillingReceipt {
  const status = billingReceiptStatusForEntry(entry);
  const receipt: ThreadCloudBillingReceipt = {
    schemaVersion: THREAD_CLOUD_BILLING_RECEIPT_SCHEMA_VERSION,
    snapshotId: entry.snapshotId,
    attemptId: entry.attemptId,
    analysisKey: entry.analysisKey,
    status,
    startedAt: entry.startedAt,
    updatedAt: entry.updatedAt,
    sentAt:
      status === "preparing" || status === "failed_before_send"
        ? null
        : entry.sentAt,
  };
  if (!isBillingReceipt(receipt)) {
    throw new TypeError("Invalid whole-thread billing receipt");
  }
  return receipt;
}

async function readThreadCloudBillingReceiptUnlocked(
  snapshotId: SnapshotId | string,
): Promise<ThreadCloudBillingReceipt | null> {
  const key = threadCloudBillingReceiptStorageKey(snapshotId);
  const stored = await chrome.storage.local.get(key);
  const value = stored[key];
  if (value === undefined) return null;
  if (!isBillingReceipt(value) || value.snapshotId !== snapshotId) {
    throw new TypeError(
      "Stored whole-thread billing receipt is damaged or mismatched",
    );
  }
  return value;
}

const snapshotBillingMutationTails = new Map<string, Promise<void>>();

function runWithSnapshotBillingLock<T>(
  snapshotId: SnapshotId,
  operation: () => Promise<T>,
): Promise<T> {
  const runWithCrossContextLock = async (): Promise<T> => {
    const lockManager = globalThis.navigator?.locks;
    if (!lockManager || typeof lockManager.request !== "function") {
      return operation();
    }
    return await lockManager.request<Promise<T>>(
      `${THREAD_CLOUD_BILLING_LOCK_PREFIX}${snapshotId}`,
      { mode: "exclusive" },
      () => operation(),
    );
  };
  const previous = snapshotBillingMutationTails.get(snapshotId) ??
    Promise.resolve();
  const result = previous.then(runWithCrossContextLock, runWithCrossContextLock);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  snapshotBillingMutationTails.set(snapshotId, tail);
  void tail.then(() => {
    if (snapshotBillingMutationTails.get(snapshotId) === tail) {
      snapshotBillingMutationTails.delete(snapshotId);
    }
  });
  return result;
}

/**
 * Validates the durable v3 envelope without requiring today's analyzer,
 * rules, or transport versions. Snapshot-wide sent markers must remain
 * readable after an extension update so a new AnalysisKey cannot silently
 * trigger another paid request for the same source snapshot.
 */
function hasCacheEntryStructure(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const status = candidate.status as ThreadCloudCacheStatus;
  if (
    candidate.schemaVersion !== THREAD_CLOUD_CACHE_SCHEMA_VERSION ||
    !isSnapshotId(candidate.snapshotId) ||
    !isAnalysisKey(candidate.analysisKey) ||
    !isVersionTag(candidate.analyzerVersion) ||
    !isVersionTag(candidate.rulesVersion) ||
    !isVersionTag(candidate.transportVersion) ||
    ![
      "preparing",
      "running",
      "success",
      "failed_before_send",
      "failed_after_send",
      "cancelled_before_send",
      "cancelled_after_send",
      "unknown_after_disconnect",
    ].includes(status) ||
    typeof candidate.attemptId !== "string" ||
    candidate.attemptId.length === 0 ||
    candidate.attemptId.length > 128 ||
    !isIsoDate(candidate.startedAt) ||
    !isIsoDate(candidate.updatedAt) ||
    !validSentState(status, candidate.sentAt, candidate.deadlineAt)
  ) {
    return false;
  }

  if (status === "preparing" || status === "running") {
    return candidate.error === null && candidate.result === undefined;
  }
  if (status === "success") {
    return (
      candidate.error === null &&
      isIsoDate(candidate.completedAt) &&
      hasWholeThreadResultShape(candidate.result)
    );
  }
  return (
    isError(candidate.error) &&
    isIsoDate(candidate.completedAt) &&
    candidate.result === undefined
  );
}

function isCacheEntry(value: unknown): value is ThreadCloudCacheEntry {
  if (!hasCacheEntryStructure(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.analyzerVersion === CLOUD_ANALYZER_VERSION &&
    candidate.rulesVersion === REASON_VERSION &&
    candidate.transportVersion === THREAD_CLOUD_TRANSPORT_VERSION
  );
}

function sameIdentity(
  entry: ThreadCloudCacheEntry,
  identity: ThreadCloudCacheIdentity,
): boolean {
  return (
    entry.schemaVersion === identity.schemaVersion &&
    entry.snapshotId === identity.snapshotId &&
    entry.analysisKey === identity.analysisKey &&
    entry.analyzerVersion === identity.analyzerVersion &&
    entry.rulesVersion === identity.rulesVersion &&
    entry.transportVersion === identity.transportVersion
  );
}

function replaceSensitiveNames(value: string, names: readonly string[]): string {
  let result = value;
  for (const name of names) {
    if (name.length > 0) result = result.split(name).join("相关用户");
  }
  return result;
}

function scrubNarrative(value: unknown, names: readonly string[]): unknown {
  if (typeof value === "string") return replaceSensitiveNames(value, names);
  if (Array.isArray(value)) {
    return value.map((item) => scrubNarrative(item, names));
  }
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      [
        "apiKey",
        "author",
        "authorName",
        "participantNames",
        "content",
        "excerpt",
        "replies",
        "threadTitle",
      ].includes(key)
    ) {
      continue;
    }
    result[key] = scrubNarrative(item, names);
  }
  return result;
}

/**
 * Successful results are cached without source excerpts or original user
 * names. The UI can hydrate those display-only fields from the live snapshot.
 */
export function sanitizeThreadCloudResultForCache(
  result: WholeThreadCloudAnalysisResult,
  extraSensitiveNames: readonly string[] = [],
): WholeThreadCloudAnalysisResult {
  const names = [
    ...new Set(
      [
        ...extraSensitiveNames,
        ...result.findings.flatMap((finding) => finding.participantNames),
      ]
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ].sort((left, right) => right.length - left.length);
  const scrubbed = scrubNarrative(result, names) as Record<string, unknown>;
  const findings = result.findings.map((finding) => ({
    ...finding,
    summary: replaceSensitiveNames(finding.summary, names),
    participantNames: [],
    evidence: finding.evidence.map((evidence) => ({
      ...evidence,
      excerpt: "",
      signals: evidence.signals.map((signal) =>
        replaceSensitiveNames(signal, names),
      ),
    })),
    reasonCandidates: finding.reasonCandidates.map((reason) => ({
      ...reason,
      rationale: replaceSensitiveNames(reason.rationale, names),
    })),
    uncertainties: finding.uncertainties.map((uncertainty) =>
      replaceSensitiveNames(uncertainty, names),
    ),
  }));
  return {
    ...(scrubbed as unknown as WholeThreadCloudAnalysisResult),
    findings,
  };
}

function sanitizeUsage(
  usage: ThreadCloudTokenUsage | undefined,
): ThreadCloudTokenUsage | undefined {
  if (!usage) return undefined;
  const finiteNonNegative = (value: number | undefined) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : undefined;
  const sanitized = {
    inputTokens: finiteNonNegative(usage.inputTokens),
    outputTokens: finiteNonNegative(usage.outputTokens),
    totalTokens: finiteNonNegative(usage.totalTokens),
  };
  return Object.values(sanitized).some((value) => value !== undefined)
    ? sanitized
    : undefined;
}

function serializeEntry(
  entry: ThreadCloudCacheEntry,
  extraSensitiveNames: readonly string[] = [],
): ThreadCloudCacheEntry {
  const base: ThreadCloudCacheEntryBase = {
    schemaVersion: THREAD_CLOUD_CACHE_SCHEMA_VERSION,
    snapshotId: entry.snapshotId,
    analysisKey: entry.analysisKey,
    analyzerVersion: entry.analyzerVersion,
    rulesVersion: entry.rulesVersion,
    transportVersion: entry.transportVersion,
    status: entry.status,
    attemptId: entry.attemptId,
    startedAt: entry.startedAt,
    updatedAt: entry.updatedAt,
    sentAt: entry.sentAt,
    deadlineAt: entry.deadlineAt,
    error: entry.error
      ? { category: entry.error.category, code: entry.error.code }
      : null,
  };
  if (entry.status === "success") {
    const usage = sanitizeUsage(entry.usage);
    return {
      ...base,
      status: "success",
      completedAt: entry.completedAt,
      result: sanitizeThreadCloudResultForCache(
        entry.result,
        extraSensitiveNames,
      ),
      ...(usage ? { usage } : {}),
    };
  }
  if (entry.status !== "preparing" && entry.status !== "running") {
    return { ...base, status: entry.status, completedAt: entry.completedAt! };
  }
  return { ...base, status: entry.status };
}

function receiptForCacheWrite(
  existing: ThreadCloudBillingReceipt | null,
  proposed: ThreadCloudBillingReceipt,
): ThreadCloudBillingReceipt {
  if (
    !existing ||
    existing.status === "failed_before_send" ||
    existing.attemptId === proposed.attemptId
  ) {
    return proposed;
  }
  // A cache write from a different attempt must never erase a protective
  // claim. Only an explicit force claim may replace it.
  return existing;
}

export async function loadThreadCloudBillingReceipt(
  snapshotId: SnapshotId | string,
): Promise<ThreadCloudBillingReceipt | null> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return null;
  return readThreadCloudBillingReceiptUnlocked(snapshotId);
}

export async function claimThreadCloudAnalysisStart(
  preparingEntry: ThreadCloudPreparingCacheEntry,
  options: ClaimThreadCloudAnalysisStartOptions = {},
): Promise<ThreadCloudBillingReceipt | null> {
  const sanitized = serializeEntry(preparingEntry);
  if (sanitized.status !== "preparing" || !isCacheEntry(sanitized)) {
    throw new TypeError("Invalid preparing whole-thread analysis cache entry");
  }
  return runWithSnapshotBillingLock(sanitized.snapshotId, async () => {
    const existing = await readThreadCloudBillingReceiptUnlocked(
      sanitized.snapshotId,
    );
    if (
      !options.force &&
      existing &&
      existing.status !== "failed_before_send"
    ) {
      return existing;
    }
    const receipt = billingReceiptFromEntry(sanitized);
    await chrome.storage.local.set({
      [threadCloudCacheV3StorageKey(sanitized.analysisKey)]: sanitized,
      [threadCloudBillingReceiptStorageKey(sanitized.snapshotId)]: receipt,
    });
    return null;
  });
}

export async function loadThreadCloudCache(
  identity: ThreadCloudCacheIdentity,
): Promise<ThreadCloudCacheEntry | null> {
  const key = threadCloudCacheV3StorageKey(identity.analysisKey);
  const localStored = await chrome.storage.local.get(key);
  const localEntry = localStored[key];
  if (localEntry !== undefined) {
    if (!isCacheEntry(localEntry) || !sameIdentity(localEntry, identity)) {
      throw new TypeError(
        "Stored whole-thread analysis cache is damaged or mismatched",
      );
    }
    return localEntry;
  }

  // v3 originally lived in storage.session. Migrate an exact, valid entry on
  // first read so extension reloads and updates no longer discard paid results
  // or sent-request markers.
  const sessionStored = await chrome.storage.session.get(key);
  const sessionEntry = sessionStored[key];
  if (sessionEntry === undefined) return null;
  if (!isCacheEntry(sessionEntry) || !sameIdentity(sessionEntry, identity)) {
    throw new TypeError(
      "Stored whole-thread session cache is damaged or mismatched",
    );
  }
  await saveThreadCloudCache(sessionEntry);
  await chrome.storage.session.remove(key);
  return serializeEntry(sessionEntry);
}

/**
 * Finds the newest durable task marker for one snapshot, even when the
 * provider/model/rules version changed and therefore produced another
 * AnalysisKey. This is the final duplicate-charge guard after a user deletes
 * the displayable report but deliberately keeps the sent-request marker.
 */
export async function loadLatestThreadCloudCacheForSnapshot(
  snapshotId: SnapshotId | string,
): Promise<ThreadCloudCacheEntry | null> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return null;
  const stored = await chrome.storage.local.get(null);
  const candidates: ThreadCloudCacheEntry[] = [];
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(THREAD_CLOUD_CACHE_V3_STORAGE_PREFIX)) continue;
    if (!hasCacheEntryStructure(value)) {
      throw new TypeError("Stored whole-thread cache prefix contains damage");
    }
    const entry = value as ThreadCloudCacheEntry;
    if (key !== threadCloudCacheV3StorageKey(entry.analysisKey)) {
      throw new TypeError("Stored whole-thread cache key is mismatched");
    }
    if (
      entry.snapshotId === snapshotId &&
      (entry.status === "preparing" ||
        entry.status === "success" ||
        entry.sentAt !== null)
    ) {
      candidates.push(entry);
    }
  }
  candidates.sort(
    (left, right) =>
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
      left.attemptId.localeCompare(right.attemptId),
  );
  return candidates[0] ?? null;
}

export async function saveThreadCloudCache(
  entry: ThreadCloudCacheEntry,
  extraSensitiveNames: readonly string[] = [],
): Promise<void> {
  const sanitized = serializeEntry(entry, extraSensitiveNames);
  if (!isCacheEntry(sanitized)) {
    throw new TypeError("Invalid whole-thread analysis cache entry");
  }
  await runWithSnapshotBillingLock(sanitized.snapshotId, async () => {
    const existing = await readThreadCloudBillingReceiptUnlocked(
      sanitized.snapshotId,
    );
    const receipt = receiptForCacheWrite(
      existing,
      billingReceiptFromEntry(sanitized),
    );
    await chrome.storage.local.set({
      [threadCloudCacheV3StorageKey(sanitized.analysisKey)]: sanitized,
      [threadCloudBillingReceiptStorageKey(sanitized.snapshotId)]: receipt,
    });
  });
}

export async function clearThreadCloudCache(
  identityOrLegacyTabId: ThreadCloudCacheIdentity | AnalysisKey | number,
): Promise<void> {
  if (typeof identityOrLegacyTabId === "number") {
    const key = threadCloudCacheStorageKey(identityOrLegacyTabId);
    await Promise.all([
      chrome.storage.local.remove(key),
      chrome.storage.session.remove(key),
    ]);
    return;
  }
  const analysisKey =
    typeof identityOrLegacyTabId === "string"
      ? identityOrLegacyTabId
      : identityOrLegacyTabId.analysisKey;
  const key = threadCloudCacheV3StorageKey(analysisKey);
  await Promise.all([
    chrome.storage.local.remove(key),
    chrome.storage.session.remove(key),
  ]);
}

interface LegacyThreadCloudCacheIdentity {
  tabId: number;
  threadId: string | null;
  sessionUpdatedAt: string;
  endpoint: string;
  model: string;
  mode: CloudAnalysisMode;
  analyzerVersion: typeof LEGACY_THREAD_CLOUD_ANALYZER_VERSION;
  transportVersion: typeof LEGACY_THREAD_CLOUD_TRANSPORT_VERSION;
}

export type LegacyThreadCloudSuccessEntry = LegacyThreadCloudCacheIdentity & {
  status: "success";
  result: WholeThreadCloudAnalysisResult;
};

export type LegacyThreadCloudPendingEntry = LegacyThreadCloudCacheIdentity & {
  status: "pending";
  startedAt: string;
};

function legacyIdentity(
  session: ReviewSession,
  settings: { endpoint: string; model: string; mode: CloudAnalysisMode },
): LegacyThreadCloudCacheIdentity {
  return {
    tabId: session.tabId,
    threadId: session.threadId,
    sessionUpdatedAt: session.updatedAt,
    endpoint: settings.endpoint,
    model: settings.model,
    mode: settings.mode,
    analyzerVersion: LEGACY_THREAD_CLOUD_ANALYZER_VERSION,
    transportVersion: LEGACY_THREAD_CLOUD_TRANSPORT_VERSION,
  };
}

function sameLegacyIdentity(
  candidate: Record<string, unknown>,
  identity: LegacyThreadCloudCacheIdentity,
): boolean {
  return Object.entries(identity).every(
    ([key, value]) => candidate[key] === value,
  );
}

async function loadExactLegacyEntry(
  session: ReviewSession,
  settings: { endpoint: string; model: string; mode: CloudAnalysisMode },
): Promise<Record<string, unknown> | null> {
  const identity = legacyIdentity(session, settings);
  const key = threadCloudCacheStorageKey(identity.tabId);
  const stored = await chrome.storage.session.get(key);
  const candidate = stored[key];
  if (
    !candidate ||
    typeof candidate !== "object" ||
    !sameLegacyIdentity(candidate as Record<string, unknown>, identity)
  ) {
    return null;
  }
  return candidate as Record<string, unknown>;
}

/** Reads only an exact v2 success. It never copies legacy private data to v3. */
export async function loadLegacyThreadCloudSuccess(
  session: ReviewSession,
  settings: { endpoint: string; model: string; mode: CloudAnalysisMode },
): Promise<LegacyThreadCloudSuccessEntry | null> {
  const candidate = await loadExactLegacyEntry(session, settings);
  if (
    !candidate ||
    candidate.status !== "success" ||
    !hasWholeThreadResultShape(candidate.result)
  ) {
    return null;
  }
  return candidate as unknown as LegacyThreadCloudSuccessEntry;
}

export async function loadLegacyThreadCloudPending(
  session: ReviewSession,
  settings: { endpoint: string; model: string; mode: CloudAnalysisMode },
): Promise<LegacyThreadCloudPendingEntry | null> {
  const candidate = await loadExactLegacyEntry(session, settings);
  if (
    !candidate ||
    candidate.status !== "pending" ||
    !isIsoDate(candidate.startedAt)
  ) {
    return null;
  }
  return candidate as unknown as LegacyThreadCloudPendingEntry;
}

/**
 * Conservatively migrates v2 pending to an unknown-after-disconnect marker.
 * Callers must surface a paid retry confirmation; this helper never retries.
 */
export async function migrateLegacyThreadCloudPendingToUnknown(
  session: ReviewSession,
  settings: {
    provider?: CloudProvider;
    endpoint: string;
    model: string;
    mode: CloudAnalysisMode;
  },
  attemptId: string,
): Promise<ThreadCloudCacheEntry | null> {
  const pending = await loadLegacyThreadCloudPending(session, settings);
  if (!pending) return null;
  const identity = threadCloudCacheIdentity(session, settings);
  const sentAt = pending.startedAt;
  const deadlineAt = new Date(
    Date.parse(sentAt) + WHOLE_THREAD_ANALYSIS_TIMEOUT_MS[settings.mode],
  ).toISOString();
  const now = new Date().toISOString();
  const migrated: ThreadCloudCacheEntry = {
    ...identity,
    status: "unknown_after_disconnect",
    attemptId,
    startedAt: pending.startedAt,
    updatedAt: now,
    sentAt,
    deadlineAt,
    completedAt: now,
    error: { category: "disconnect", code: "legacy_pending_unknown" },
  };
  await saveThreadCloudCache(migrated);
  return migrated;
}

export function threadCloudCacheRequiresPaidRetryConfirmation(
  entry: ThreadCloudCacheEntry,
): boolean {
  return entry.sentAt !== null;
}
