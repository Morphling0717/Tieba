import type { CloudProvider, ReviewRecord } from "../types";
import {
  mergeReviewRecords,
  validateReviewRecord,
} from "../lib/records";
import {
  mergeAnalysisHistory,
  validateAnalysisHistoryEntry,
  type AnalysisHistoryEntry,
} from "../lib/analysisHistory";
import {
  DEFAULT_CLOUD_ANALYSIS_MODE,
  normalizeCloudAnalysisMode,
  type CloudAnalysisMode,
  type CloudTokenUsage,
} from "../lib/cloud";
import {
  canonicalCloudProviderEndpoint,
  CLOUD_PROVIDER_DEFAULTS,
  DEFAULT_CLOUD_PROVIDER,
  normalizeCloudProvider,
  persistableCloudEndpoint,
} from "../lib/cloudPermission";

const RECORDS_KEY = "kr_tieba_review_records_v1";
const REVIEW_RECORDS_WEB_LOCK_NAME = "kr-review-records-storage-v1";
const THEME_KEY = "kr_ui_theme_v1";
const LEGACY_CLOUD_SETTINGS_KEY = "kr_cloud_settings_v1";
export const CLOUD_SETTINGS_KEY = "kr_cloud_settings_v2";
const LEGACY_SESSION_CLOUD_API_KEY = "kr_cloud_api_key_v1";
const LEGACY_WIP_CLOUD_API_SECRET_KEY = "kr_cloud_api_secret_v1";
const LEGACY_PROVIDER_CLOUD_API_SECRET_KEY = "kr_cloud_api_secret_v1";
const CLOUD_API_SECRET_KEY = "kr_cloud_api_secret_v2";
const SHARED_LEGACY_CLOUD_API_RETIREMENT_KEY =
  "kr_cloud_api_secret_v2_shared_legacy_retired";
const CLOUD_USAGE_KEY = "kr_cloud_usage_v1";
export const ANALYSIS_HISTORY_STORAGE_PREFIX = "kr_analysis_history_v1_";

export const MAX_ANALYSIS_HISTORY_ENTRIES = 100;
export const MAX_ANALYSIS_HISTORY_ENTRY_BYTES = 4 * 1024 * 1024;
export const MAX_ANALYSIS_HISTORY_TOTAL_BYTES = 4 * 1024 * 1024;
const ANALYSIS_HISTORY_WEB_LOCK_NAME = "kr-analysis-history-storage-v1";

export const CLOUD_SETTINGS_SCHEMA_VERSION = 2 as const;
const CLOUD_API_SECRET_SCHEMA_VERSION = 2 as const;
const SHARED_LEGACY_RETIREMENT_SCHEMA_VERSION = 1 as const;
const MAX_CLOUD_API_KEY_LENGTH = 8_192;

export type ThemeMode = "light" | "dark";

export const DEFAULT_THEME_MODE: ThemeMode = "light";

export interface CloudUsageLedgerEntry {
  attemptId: string;
  calledAt: string;
  provider: CloudProvider;
  model: string;
  usage: CloudTokenUsage;
}

function validUsageEntry(value: unknown): value is CloudUsageLedgerEntry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CloudUsageLedgerEntry>;
  const usage = candidate.usage;
  return (
    typeof candidate.attemptId === "string" &&
    candidate.attemptId.length > 0 &&
    candidate.attemptId.length <= 128 &&
    typeof candidate.calledAt === "string" &&
    Number.isFinite(Date.parse(candidate.calledAt)) &&
    (candidate.provider === "alibaba" || candidate.provider === "deepseek") &&
    typeof candidate.model === "string" &&
    candidate.model.length > 0 &&
    candidate.model.length <= 160 &&
    Boolean(usage) &&
    [usage?.inputTokens, usage?.outputTokens, usage?.totalTokens].every(
      (count) => Number.isSafeInteger(count) && (count ?? -1) >= 0 && (count ?? Infinity) <= 10_000_000,
    ) &&
    usage!.inputTokens + usage!.outputTokens === usage!.totalTokens
  );
}

export async function recordCloudUsage(
  entry: CloudUsageLedgerEntry,
): Promise<void> {
  if (!validUsageEntry(entry) || typeof chrome === "undefined" || !chrome.storage?.local) return;
  const stored = await chrome.storage.local.get(CLOUD_USAGE_KEY);
  const current = Array.isArray(stored[CLOUD_USAGE_KEY])
    ? stored[CLOUD_USAGE_KEY].filter(validUsageEntry)
    : [];
  const next = [entry, ...current.filter((item) => item.attemptId !== entry.attemptId)]
    .sort((left, right) => Date.parse(right.calledAt) - Date.parse(left.calledAt))
    .slice(0, 500);
  await chrome.storage.local.set({ [CLOUD_USAGE_KEY]: next });
}

export async function loadMonthlyCloudUsage(
  now = new Date(),
): Promise<CloudUsageLedgerEntry[]> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return [];
  const stored = await chrome.storage.local.get(CLOUD_USAGE_KEY);
  if (!Array.isArray(stored[CLOUD_USAGE_KEY])) return [];
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
  return stored[CLOUD_USAGE_KEY]
    .filter(validUsageEntry)
    .filter((entry) => {
      const calledAt = Date.parse(entry.calledAt);
      return calledAt >= monthStart && calledAt < nextMonth;
    });
}

function normalizeThemeMode(value: unknown): ThemeMode {
  return value === "dark" ? "dark" : DEFAULT_THEME_MODE;
}

export async function loadThemeMode(): Promise<ThemeMode> {
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    const stored = await chrome.storage.local.get(THEME_KEY);
    return normalizeThemeMode(stored[THEME_KEY]);
  }

  try {
    return normalizeThemeMode(globalThis.localStorage?.getItem(THEME_KEY));
  } catch {
    return DEFAULT_THEME_MODE;
  }
}

export async function saveThemeMode(theme: ThemeMode): Promise<void> {
  const normalized = normalizeThemeMode(theme);
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    await chrome.storage.local.set({ [THEME_KEY]: normalized });
    return;
  }

  try {
    globalThis.localStorage?.setItem(THEME_KEY, normalized);
  } catch {
    // The standalone demo remains usable when storage is unavailable.
  }
}

let reviewRecordsMutationTail: Promise<void> = Promise.resolve();

function runReviewRecordsMutation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const runWithCrossContextLock = async (): Promise<T> => {
    const lockManager = globalThis.navigator?.locks;
    if (!lockManager || typeof lockManager.request !== "function") {
      return operation();
    }
    return await lockManager.request<Promise<T>>(
      REVIEW_RECORDS_WEB_LOCK_NAME,
      { mode: "exclusive" },
      () => operation(),
    );
  };
  const result = reviewRecordsMutationTail.then(
    runWithCrossContextLock,
    runWithCrossContextLock,
  );
  reviewRecordsMutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function strictStoredReviewRecords(value: unknown): ReviewRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(
      "本机人工决定存储已损坏；为避免覆盖未知数据，本次未保存任何内容。数据不会自动删除。",
    );
  }
  try {
    return mergeReviewRecords([], value.map(validateReviewRecord));
  } catch (caught) {
    throw new Error(
      "本机人工决定存储包含无效记录；为避免覆盖未知数据，本次未保存任何内容。数据不会自动删除。",
      { cause: caught },
    );
  }
}

export async function loadStoredRecords(): Promise<ReviewRecord[]> {
  return runReviewRecordsMutation(async () => {
    if (typeof chrome === "undefined" || !chrome.storage?.local) return [];
    const result = await chrome.storage.local.get(RECORDS_KEY);
    const stored = result[RECORDS_KEY];
    if (!Array.isArray(stored)) return [];

    const valid: ReviewRecord[] = [];
    for (const candidate of stored) {
      try {
        valid.push(validateReviewRecord(candidate));
      } catch {
        // 0.1.2 accepted arbitrary text in otherwise legitimate string fields.
        // Invalid legacy/imported entries are discarded instead of exposing or
        // re-exporting usernames, reply bodies, or unsafe links.
      }
    }
    const normalized = mergeReviewRecords([], valid);
    if (normalized.length !== stored.length || JSON.stringify(normalized) !== JSON.stringify(stored)) {
      await chrome.storage.local.set({ [RECORDS_KEY]: normalized });
    }
    return normalized;
  });
}

/**
 * Merges decisions into the latest durable value while holding an
 * extension-origin lock. Returning the merged array lets each side-panel
 * context replace stale UI state with the authoritative persisted result.
 */
export async function saveStoredRecords(
  incoming: readonly ReviewRecord[],
): Promise<ReviewRecord[]> {
  return runReviewRecordsMutation(async () => {
    const validatedIncoming = mergeReviewRecords([], incoming);
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      return validatedIncoming;
    }
    const stored = await chrome.storage.local.get(RECORDS_KEY);
    const existing = strictStoredReviewRecords(stored[RECORDS_KEY]);
    const merged = mergeReviewRecords(existing, validatedIncoming);
    await chrome.storage.local.set({ [RECORDS_KEY]: merged });
    return merged;
  });
}

interface StoredCloudApiSecret {
  schemaVersion: typeof CLOUD_API_SECRET_SCHEMA_VERSION;
  provider: CloudProvider;
  apiKey: string;
}

interface StoredSharedLegacyRetirement {
  schemaVersion: typeof SHARED_LEGACY_RETIREMENT_SCHEMA_VERSION;
  provider: CloudProvider;
}

function cloudApiSecretStorageKey(provider: CloudProvider): string {
  return `${CLOUD_API_SECRET_KEY}_${provider}`;
}

function legacyProviderCloudApiSecretStorageKey(
  provider: CloudProvider,
): string {
  return `${LEGACY_PROVIDER_CLOUD_API_SECRET_KEY}_${provider}`;
}

function validCloudApiKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_CLOUD_API_KEY_LENGTH &&
    value.trim().length > 0 &&
    !/[\r\n\0]/u.test(value)
  );
}

function assertValidCloudApiKey(apiKey: string): void {
  if (!validCloudApiKey(apiKey)) {
    throw new Error("API 密钥格式无效：不能为空、包含换行或超过长度上限。");
  }
}

function storedCloudApiKey(
  value: unknown,
  provider: CloudProvider,
): string {
  if (!value || typeof value !== "object") return "";
  const candidate = value as Partial<StoredCloudApiSecret>;
  return candidate.schemaVersion === CLOUD_API_SECRET_SCHEMA_VERSION &&
    candidate.provider === provider &&
    validCloudApiKey(candidate.apiKey)
    ? candidate.apiKey
    : "";
}

function legacyProviderCloudApiKey(
  value: unknown,
  provider: CloudProvider,
): string {
  if (!value || typeof value !== "object") return "";
  const candidate = value as {
    schemaVersion?: unknown;
    provider?: unknown;
    apiKey?: unknown;
  };
  return candidate.schemaVersion === 1 &&
    candidate.provider === provider &&
    validCloudApiKey(candidate.apiKey)
    ? candidate.apiKey
    : "";
}

function sharedLegacyCloudApiKey(value: unknown): string {
  if (validCloudApiKey(value)) return value;
  if (!value || typeof value !== "object") return "";
  const candidate = value as { schemaVersion?: unknown; apiKey?: unknown };
  return candidate.schemaVersion === 1 && validCloudApiKey(candidate.apiKey)
    ? candidate.apiKey
    : "";
}

async function restrictLocalStorageToTrustedContexts(
  failClosed: boolean,
): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    return;
  }
  const setAccessLevel = chrome.storage.local.setAccessLevel;
  if (typeof setAccessLevel !== "function") {
    // Real extension contexts always expose chrome.runtime.id. Keeping the
    // no-runtime branch permissive lets the standalone demo and small unit
    // harnesses use storage-shaped fakes, while an installed extension fails
    // closed if its Chrome build cannot enforce trusted-only local storage.
    if (failClosed && Boolean(chrome.runtime?.id)) {
      throw new Error(
        "当前 Chrome 无法限制密钥存储的访问范围；不会读取或保存密钥。",
      );
    }
    return;
  }
  try {
    await chrome.storage.local.setAccessLevel({
      accessLevel: "TRUSTED_CONTEXTS",
    });
  } catch (caught) {
    if (failClosed) {
      throw new Error("无法限制密钥存储的访问范围；不会读取或保存密钥。", {
        cause: caught,
      });
    }
  }
}

let analysisHistoryMutationTail: Promise<void> = Promise.resolve();

function runAnalysisHistoryMutation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const runWithCrossContextLock = async (): Promise<T> => {
    const lockManager = globalThis.navigator?.locks;
    if (!lockManager || typeof lockManager.request !== "function") {
      return operation();
    }
    return await lockManager.request<Promise<T>>(
      ANALYSIS_HISTORY_WEB_LOCK_NAME,
      { mode: "exclusive" },
      () => operation(),
    );
  };
  const result = analysisHistoryMutationTail.then(
    runWithCrossContextLock,
    runWithCrossContextLock,
  );
  analysisHistoryMutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function analysisHistoryStorageKey(attemptId: string): string {
  if (
    typeof attemptId !== "string" ||
    !/^[A-Za-z0-9:_-]{1,128}$/u.test(attemptId)
  ) {
    throw new Error("分析历史的任务编号无效，无法访问该条记录。");
  }
  return `${ANALYSIS_HISTORY_STORAGE_PREFIX}${attemptId}`;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function serializedAnalysisHistoryByteLength(value: unknown): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (caught) {
    throw new Error("分析历史无法序列化，未保存任何内容。", {
      cause: caught,
    });
  }
  if (serialized === undefined) {
    throw new Error("分析历史无法序列化，未保存任何内容。");
  }
  return utf8ByteLength(serialized);
}

function analysisHistoryEntryByteLength(entry: AnalysisHistoryEntry): number {
  return serializedAnalysisHistoryByteLength(entry);
}

function analysisHistoryStorageItemByteLength(
  storageKey: string,
  value: unknown,
): number {
  return utf8ByteLength(storageKey) + serializedAnalysisHistoryByteLength(value);
}

function assertAnalysisHistoryEntrySize(entry: AnalysisHistoryEntry): void {
  if (analysisHistoryEntryByteLength(entry) > MAX_ANALYSIS_HISTORY_ENTRY_BYTES) {
    throw new Error(
      "单条分析历史超过 4 MiB 存储上限，未保存任何内容。",
    );
  }
}

function assertAnalysisHistoryTotalSize(
  totalBytes: number,
  operation: "load" | "mutation" = "mutation",
): void {
  if (totalBytes > MAX_ANALYSIS_HISTORY_TOTAL_BYTES) {
    if (operation === "load") {
      throw new Error(
        "AI 分析历史的存储键和值 JSON 总大小超过 4 MiB 上限，已停止读取；现有数据不会自动删除。",
      );
    }
    throw new Error(
      "AI 分析历史的存储键和值 JSON 总大小超过 4 MiB 上限，未保存任何内容。请先删除不需要的历史；不会自动删除旧历史。",
    );
  }
}

interface StoredAnalysisHistorySnapshot {
  entries: AnalysisHistoryEntry[];
  invalidKeys: string[];
  totalBytes: number;
}

function inspectStoredAnalysisHistory(
  stored: Record<string, unknown>,
): StoredAnalysisHistorySnapshot {
  const entries: AnalysisHistoryEntry[] = [];
  const invalidKeys: string[] = [];
  let totalBytes = 0;
  for (const [storageKey, value] of Object.entries(stored)) {
    if (!storageKey.startsWith(ANALYSIS_HISTORY_STORAGE_PREFIX)) continue;
    try {
      // Count the raw persisted key and value even when validation below
      // rejects the item. Unknown prefix data consumes the same durable quota
      // and must never be hidden from the pre-write budget check.
      totalBytes += analysisHistoryStorageItemByteLength(storageKey, value);
      const entry = validateAnalysisHistoryEntry(value);
      if (analysisHistoryStorageKey(entry.attemptId) !== storageKey) {
        invalidKeys.push(storageKey);
      } else {
        entries.push(entry);
      }
    } catch {
      invalidKeys.push(storageKey);
    }
  }
  return { entries, invalidKeys, totalBytes };
}

function assertStoredAnalysisHistoryIntegrity(
  snapshot: StoredAnalysisHistorySnapshot,
): void {
  if (snapshot.invalidKeys.length === 0) return;
  throw new Error(
    `检测到 ${snapshot.invalidKeys.length} 条损坏或任务编号不匹配的 AI 分析历史。为避免把未知状态当作空历史，已停止读取；数据不会自动删除。`,
  );
}

function projectedAnalysisHistoryStorageSize(
  stored: Record<string, unknown>,
  updates: Readonly<Record<string, AnalysisHistoryEntry>>,
): number {
  const storageKeys = new Set(
    Object.keys(stored).filter((storageKey) =>
      storageKey.startsWith(ANALYSIS_HISTORY_STORAGE_PREFIX),
    ),
  );
  for (const storageKey of Object.keys(updates)) storageKeys.add(storageKey);
  let totalBytes = 0;
  for (const storageKey of storageKeys) {
    const value = Object.prototype.hasOwnProperty.call(updates, storageKey)
      ? updates[storageKey]
      : stored[storageKey];
    totalBytes += analysisHistoryStorageItemByteLength(storageKey, value);
  }
  return totalBytes;
}

function analysisHistoryCollectionStorageSize(
  entries: readonly AnalysisHistoryEntry[],
): number {
  return entries.reduce((totalBytes, entry) => {
    const storageKey = analysisHistoryStorageKey(entry.attemptId);
    return (
      totalBytes + analysisHistoryStorageItemByteLength(storageKey, entry)
    );
  }, 0);
}

function sortAnalysisHistory(
  entries: readonly AnalysisHistoryEntry[],
): AnalysisHistoryEntry[] {
  return [...entries].sort(
    (left, right) =>
      Date.parse(right.completedAt) - Date.parse(left.completedAt) ||
      left.attemptId.localeCompare(right.attemptId),
  );
}

async function getAllLocalStorage(): Promise<Record<string, unknown>> {
  let stored: unknown;
  try {
    stored = await chrome.storage.local.get(null);
  } catch (caught) {
    throw new Error(
      "无法读取本机 AI 分析历史；不会把未知状态当作空历史，也未修改任何数据。",
      { cause: caught },
    );
  }
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    throw new Error(
      "无法读取本机 AI 分析历史：存储接口返回格式异常；不会把未知状态当作空历史，也未修改任何数据。",
    );
  }
  return stored as Record<string, unknown>;
}

async function restrictAnalysisHistoryStorage(): Promise<void> {
  try {
    await restrictLocalStorageToTrustedContexts(true);
  } catch (caught) {
    throw new Error(
      "无法限制 AI 分析历史存储的访问范围；不会读取或修改历史。",
      { cause: caught },
    );
  }
}

function validateAnalysisHistoryEntries(
  entries: readonly AnalysisHistoryEntry[],
): AnalysisHistoryEntry[] {
  return entries.map((candidate) => {
    const entry = validateAnalysisHistoryEntry(candidate);
    // Validate the key before any mutation and measure the normalized value
    // that will actually be written, not the caller's untrusted object.
    analysisHistoryStorageKey(entry.attemptId);
    assertAnalysisHistoryEntrySize(entry);
    return entry;
  });
}

function assertAnalysisHistoryCapacity(entries: readonly AnalysisHistoryEntry[]): void {
  if (entries.length > MAX_ANALYSIS_HISTORY_ENTRIES) {
    throw new Error(
      "分析历史已达到 100 条上限；请先删除不需要的历史后再保存。不会自动删除旧历史。",
    );
  }
}

function assertAnalysisHistoryCollectionFits(
  entries: readonly AnalysisHistoryEntry[],
): void {
  assertAnalysisHistoryCapacity(entries);
  assertAnalysisHistoryTotalSize(analysisHistoryCollectionStorageSize(entries));
}

/** Loads every valid history item, newest completion first. */
export async function loadAnalysisHistory(): Promise<AnalysisHistoryEntry[]> {
  await restrictAnalysisHistoryStorage();
  if (typeof chrome === "undefined" || !chrome.storage?.local) return [];

  // A read started after a save/delete call should observe that mutation.
  await analysisHistoryMutationTail;
  const snapshot = inspectStoredAnalysisHistory(await getAllLocalStorage());
  assertStoredAnalysisHistoryIntegrity(snapshot);
  const entries = validateAnalysisHistoryEntries(snapshot.entries);
  assertAnalysisHistoryCapacity(entries);
  assertAnalysisHistoryTotalSize(snapshot.totalBytes, "load");
  return sortAnalysisHistory(entries);
}

/** Upserts one attempt without reading and rewriting an aggregate array. */
export async function saveAnalysisHistoryEntry(
  candidate: AnalysisHistoryEntry,
): Promise<void> {
  return runAnalysisHistoryMutation(async () => {
    await restrictAnalysisHistoryStorage();
    if (typeof chrome === "undefined" || !chrome.storage?.local) return;

    const [entry] = validateAnalysisHistoryEntries([candidate]);
    const storageKey = analysisHistoryStorageKey(entry.attemptId);
    const stored = await getAllLocalStorage();
    const snapshot = inspectStoredAnalysisHistory(stored);
    assertStoredAnalysisHistoryIntegrity(snapshot);
    const merged = validateAnalysisHistoryEntries(
      mergeAnalysisHistory(snapshot.entries, [entry]),
    );
    assertAnalysisHistoryCapacity(merged);
    const entryToStore = merged.find(
      (mergedEntry) => mergedEntry.attemptId === entry.attemptId,
    )!;
    const updates =
      JSON.stringify(stored[storageKey]) === JSON.stringify(entryToStore)
        ? {}
        : { [storageKey]: entryToStore };
    assertAnalysisHistoryTotalSize(
      projectedAnalysisHistoryStorageSize(stored, updates),
    );
    if (Object.keys(updates).length > 0) {
      await chrome.storage.local.set(updates);
    }
  });
}

/** Deletes exactly one attempt; settings, credentials, usage, and records are untouched. */
export async function deleteAnalysisHistoryEntry(
  attemptId: string,
): Promise<void> {
  return runAnalysisHistoryMutation(async () => {
    await restrictAnalysisHistoryStorage();
    if (typeof chrome === "undefined" || !chrome.storage?.local) return;
    await chrome.storage.local.remove(analysisHistoryStorageKey(attemptId));
  });
}

/** Removes history items (including damaged ones) and no other local keys. */
export async function clearAnalysisHistory(): Promise<void> {
  return runAnalysisHistoryMutation(async () => {
    await restrictAnalysisHistoryStorage();
    if (typeof chrome === "undefined" || !chrome.storage?.local) return;
    const keys = Object.keys(await getAllLocalStorage()).filter((storageKey) =>
      storageKey.startsWith(ANALYSIS_HISTORY_STORAGE_PREFIX),
    );
    if (keys.length > 0) await chrome.storage.local.remove(keys);
  });
}

/**
 * Merges imported entries with durable history, then upserts each attempt in
 * its own key. Validation and capacity checks complete before the first write.
 */
export async function replaceAnalysisHistory(
  incoming: readonly AnalysisHistoryEntry[],
): Promise<AnalysisHistoryEntry[]> {
  return runAnalysisHistoryMutation(async () => {
    await restrictAnalysisHistoryStorage();
    const validatedIncoming = validateAnalysisHistoryEntries(incoming);
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      const merged = validateAnalysisHistoryEntries(
        mergeAnalysisHistory([], validatedIncoming),
      );
      assertAnalysisHistoryCollectionFits(merged);
      return sortAnalysisHistory(merged);
    }

    const stored = await getAllLocalStorage();
    const snapshot = inspectStoredAnalysisHistory(stored);
    assertStoredAnalysisHistoryIntegrity(snapshot);
    const merged = validateAnalysisHistoryEntries(
      mergeAnalysisHistory(snapshot.entries, validatedIncoming),
    );
    assertAnalysisHistoryCapacity(merged);

    const updates: Record<string, AnalysisHistoryEntry> = {};
    for (const entry of merged) {
      const storageKey = analysisHistoryStorageKey(entry.attemptId);
      if (JSON.stringify(stored[storageKey]) === JSON.stringify(entry)) continue;
      updates[storageKey] = entry;
    }
    assertAnalysisHistoryTotalSize(
      projectedAnalysisHistoryStorageSize(stored, updates),
    );
    if (Object.keys(updates).length > 0) {
      await chrome.storage.local.set(updates);
    }
    return sortAnalysisHistory(merged);
  });
}

async function writeCloudApiKey(
  provider: CloudProvider,
  apiKey: string,
  retireSharedLegacy = false,
): Promise<void> {
  assertValidCloudApiKey(apiKey);
  await restrictLocalStorageToTrustedContexts(true);
  const items: Record<string, unknown> = {
    [cloudApiSecretStorageKey(provider)]: {
      schemaVersion: CLOUD_API_SECRET_SCHEMA_VERSION,
      provider,
      apiKey,
    } satisfies StoredCloudApiSecret,
  };
  if (retireSharedLegacy) {
    items[SHARED_LEGACY_CLOUD_API_RETIREMENT_KEY] = {
      schemaVersion: SHARED_LEGACY_RETIREMENT_SCHEMA_VERSION,
      provider,
    } satisfies StoredSharedLegacyRetirement;
  }
  await chrome.storage.local.set(items);
}

async function removeStorageKeysBestEffort(
  area: chrome.storage.StorageArea | undefined,
  keys: string | string[],
): Promise<void> {
  if (!area?.remove) return;
  try {
    await area.remove(keys);
  } catch {
    // Cleanup is retried later; a successfully written v2 credential remains
    // authoritative and must not appear missing because cleanup failed.
  }
}

async function clearSharedLegacyCloudApiKey(): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.storage) return;
  await Promise.all([
    removeStorageKeysBestEffort(
      chrome.storage.local,
      LEGACY_WIP_CLOUD_API_SECRET_KEY,
    ),
    removeStorageKeysBestEffort(
      chrome.storage.session,
      LEGACY_SESSION_CLOUD_API_KEY,
    ),
  ]);
}

function sharedLegacyRetirementProvider(value: unknown): CloudProvider | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<StoredSharedLegacyRetirement>;
  return candidate.schemaVersion === SHARED_LEGACY_RETIREMENT_SCHEMA_VERSION &&
    (candidate.provider === "deepseek" || candidate.provider === "alibaba")
    ? candidate.provider
    : null;
}

async function retireSharedLegacyCloudApiKey(
  provider: CloudProvider,
): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  await restrictLocalStorageToTrustedContexts(true);
  await chrome.storage.local.set({
    [SHARED_LEGACY_CLOUD_API_RETIREMENT_KEY]: {
      schemaVersion: SHARED_LEGACY_RETIREMENT_SCHEMA_VERSION,
      provider,
    } satisfies StoredSharedLegacyRetirement,
  });
  await clearSharedLegacyCloudApiKey();
}

async function migrateSharedCloudApiKeyForActiveProvider(
  provider: CloudProvider,
): Promise<string> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return "";
  await restrictLocalStorageToTrustedContexts(true);
  const [local, session] = await Promise.all([
    chrome.storage.local.get([
      LEGACY_WIP_CLOUD_API_SECRET_KEY,
      SHARED_LEGACY_CLOUD_API_RETIREMENT_KEY,
    ]),
    chrome.storage.session?.get
      ? chrome.storage.session.get(LEGACY_SESSION_CLOUD_API_KEY)
      : Promise.resolve({}),
  ]);
  if (
    sharedLegacyRetirementProvider(
      local[SHARED_LEGACY_CLOUD_API_RETIREMENT_KEY],
    )
  ) {
    await clearSharedLegacyCloudApiKey();
    return "";
  }
  const sessionRecord = session as Record<string, unknown>;
  const legacy =
    sharedLegacyCloudApiKey(local[LEGACY_WIP_CLOUD_API_SECRET_KEY]) ||
    sharedLegacyCloudApiKey(sessionRecord[LEGACY_SESSION_CLOUD_API_KEY]);
  if (!legacy) return "";

  // This function is called only after loadCloudSettings has established the
  // active provider. A generic provider lookup never consumes shared legacy
  // credentials, preventing an old DeepSeek key from being sent to Alibaba (or
  // vice versa) when the user merely switches the settings draft.
  // The credential and the non-secret retirement marker are written in one
  // storage operation. Even if best-effort cleanup of an old session slot
  // later fails, clearing the v2 credential cannot make that old copy migrate
  // back and silently "resurrect" a key the user removed.
  await writeCloudApiKey(provider, legacy, true);
  await clearSharedLegacyCloudApiKey();
  return legacy;
}

/**
 * Loads the API credential from its own Chrome-local secret record.
 *
 * The local area is intentional: unlike chrome.storage.session it survives a
 * Chrome restart and an extension update. The secret is never read from a web
 * page's localStorage, included in the persisted CloudSettings record, or
 * placed in exported data.
 */
export async function loadCloudApiKey(
  provider: CloudProvider,
): Promise<string> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return "";

  // Returning a durable credential is only safe after Chrome confirms that
  // page content scripts cannot access the local storage area.
  await restrictLocalStorageToTrustedContexts(true);
  const storageKey = cloudApiSecretStorageKey(provider);
  const legacyProviderKey = legacyProviderCloudApiSecretStorageKey(provider);
  const local = await chrome.storage.local.get([
    storageKey,
    legacyProviderKey,
  ]);
  const persisted = storedCloudApiKey(local[storageKey], provider);
  if (persisted) return persisted;

  const legacyProvider = legacyProviderCloudApiKey(
    local[legacyProviderKey],
    provider,
  );
  if (!legacyProvider) return "";

  await writeCloudApiKey(provider, legacyProvider);
  await removeStorageKeysBestEffort(chrome.storage.local, legacyProviderKey);
  return legacyProvider;
}

/** Persists an API credential only in the extension's non-synced local area. */
export async function saveCloudApiKey(
  provider: CloudProvider,
  apiKey: string,
): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  // A blank password field means "leave the saved credential unchanged".
  // Deletion is deliberately available only through clearCloudApiKey.
  if (!apiKey) return;
  // A newly saved provider credential makes every ambiguous pre-v2 shared
  // credential obsolete. Persist the non-secret retirement marker atomically
  // with the credential so a later cleanup failure can never resurrect it.
  await writeCloudApiKey(provider, apiKey, true);
}

/** Removes both the durable secret and any pre-migration session copy. */
export async function clearCloudApiKey(
  provider: CloudProvider,
): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.storage) return;
  await restrictLocalStorageToTrustedContexts(false);
  if (!chrome.storage.local?.remove) return;
  await chrome.storage.local.remove([
    cloudApiSecretStorageKey(provider),
    legacyProviderCloudApiSecretStorageKey(provider),
  ]);
}

export interface CloudSettings {
  schemaVersion: typeof CLOUD_SETTINGS_SCHEMA_VERSION;
  provider: CloudProvider;
  endpoint: string;
  model: string;
  apiKey: string;
  mode: CloudAnalysisMode;
  autoReadWholeThread: boolean;
  autoAnalyzeWholeThread: boolean;
}

interface StoredCloudSettings {
  schemaVersion?: unknown;
  provider?: unknown;
  endpoint?: unknown;
  model?: unknown;
  mode?: unknown;
  autoReadWholeThread?: unknown;
  autoAnalyzeWholeThread?: unknown;
}

function defaultCloudSettings(): CloudSettings {
  const provider = DEFAULT_CLOUD_PROVIDER;
  return {
    schemaVersion: CLOUD_SETTINGS_SCHEMA_VERSION,
    provider,
    ...CLOUD_PROVIDER_DEFAULTS[provider],
    apiKey: "",
    mode: DEFAULT_CLOUD_ANALYSIS_MODE,
    autoReadWholeThread: true,
    autoAnalyzeWholeThread: false,
  };
}

function persistableSettings(settings: CloudSettings) {
  return {
    schemaVersion: CLOUD_SETTINGS_SCHEMA_VERSION,
    provider: settings.provider,
    endpoint: settings.endpoint,
    model: settings.model,
    mode: settings.mode,
    autoReadWholeThread: settings.autoReadWholeThread,
    autoAnalyzeWholeThread: settings.autoAnalyzeWholeThread,
  };
}

export async function loadCloudSettings(): Promise<CloudSettings> {
  if (typeof chrome === "undefined" || !chrome.storage) {
    return defaultCloudSettings();
  }
  const [currentLocal, legacyLocal] = await Promise.all([
    chrome.storage.local.get(CLOUD_SETTINGS_KEY),
    chrome.storage.local.get(LEGACY_CLOUD_SETTINGS_KEY),
  ]);
  const current = currentLocal[CLOUD_SETTINGS_KEY] as
    | StoredCloudSettings
    | undefined;
  const legacy = legacyLocal[LEGACY_CLOUD_SETTINGS_KEY] as
    | StoredCloudSettings
    | undefined;
  const hasCurrent =
    current !== null &&
    typeof current === "object" &&
    current.schemaVersion === CLOUD_SETTINGS_SCHEMA_VERSION;
  const settings = hasCurrent ? current : legacy;
  const provider = normalizeCloudProvider(
    settings?.provider,
    typeof settings?.endpoint === "string" ? settings.endpoint : undefined,
  );
  let apiKey = await loadCloudApiKey(provider);
  if (apiKey) {
    // The current provider already has an unambiguous durable credential, so
    // any shared pre-v2 copy is obsolete and must not later migrate elsewhere.
    await retireSharedLegacyCloudApiKey(provider);
  } else {
    apiKey = await migrateSharedCloudApiKeyForActiveProvider(provider);
  }
  const defaults = CLOUD_PROVIDER_DEFAULTS[provider];
  const mode = normalizeCloudAnalysisMode(settings?.mode);
  let endpoint = defaults.endpoint;
  let endpointWasUnsafe = false;
  try {
    endpoint = canonicalCloudProviderEndpoint(provider, settings?.endpoint);
  } catch {
    endpoint = persistableCloudEndpoint(defaults.endpoint);
    endpointWasUnsafe = true;
  }
  const normalized: CloudSettings = {
    schemaVersion: CLOUD_SETTINGS_SCHEMA_VERSION,
    provider,
    endpoint,
    model:
      typeof settings?.model === "string" ? settings.model : defaults.model,
    apiKey,
    mode,
    // Migration is intentionally conservative: reading is free, sending a
    // new paid request must be opted into again in settings v2.
    autoReadWholeThread: hasCurrent
      ? settings?.autoReadWholeThread !== false
      : true,
    autoAnalyzeWholeThread: hasCurrent
      ? settings?.autoAnalyzeWholeThread === true
      : false,
  };

  if (!hasCurrent || endpointWasUnsafe) {
    await chrome.storage.local.set({
      [CLOUD_SETTINGS_KEY]: persistableSettings(normalized),
    });
  }
  if (legacy !== undefined) {
    // The sanitized v2 record is authoritative. Remove the old blob only
    // after the replacement write succeeds so query-string credentials or a
    // legacy inline key cannot linger indefinitely in local storage.
    await removeStorageKeysBestEffort(
      chrome.storage.local,
      LEGACY_CLOUD_SETTINGS_KEY,
    );
  }
  return normalized;
}

export async function saveCloudSettings(
  settings: Omit<
    CloudSettings,
    | "schemaVersion"
    | "mode"
    | "autoReadWholeThread"
    | "autoAnalyzeWholeThread"
  > & {
    schemaVersion?: typeof CLOUD_SETTINGS_SCHEMA_VERSION;
    mode?: CloudAnalysisMode;
    autoReadWholeThread?: boolean;
    autoAnalyzeWholeThread?: boolean;
  },
): Promise<void> {
  const provider = normalizeCloudProvider(settings.provider, settings.endpoint);
  const endpoint = canonicalCloudProviderEndpoint(provider, settings.endpoint);
  // When a replacement credential is present, secure it first. A denied
  // TRUSTED_CONTEXTS restriction must not partially activate settings that the
  // user reasonably expects to have a usable saved credential.
  await saveCloudApiKey(provider, settings.apiKey);
  await chrome.storage.local.set({
    [CLOUD_SETTINGS_KEY]: {
      schemaVersion: CLOUD_SETTINGS_SCHEMA_VERSION,
      provider,
      endpoint,
      model: settings.model,
      mode: normalizeCloudAnalysisMode(settings.mode),
      autoReadWholeThread: settings.autoReadWholeThread !== false,
      autoAnalyzeWholeThread: settings.autoAnalyzeWholeThread === true,
    },
  });
  if (settings.apiKey) {
    await clearSharedLegacyCloudApiKey();
  }
}
