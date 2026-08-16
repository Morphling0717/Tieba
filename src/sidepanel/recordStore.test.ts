import { afterEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_VERSION } from "../types";
import type { ReviewRecord } from "../types";
import { CLOUD_PROVIDER_DEFAULTS } from "../lib/cloudPermission";
import {
  createAnalysisHistoryEntry,
  type AnalysisHistoryEntry,
} from "../lib/analysisHistory";
import {
  ANALYSIS_HISTORY_STORAGE_PREFIX,
  CLOUD_SETTINGS_KEY,
  CLOUD_SETTINGS_SCHEMA_VERSION,
  DEFAULT_THEME_MODE,
  MAX_ANALYSIS_HISTORY_ENTRIES,
  MAX_ANALYSIS_HISTORY_ENTRY_BYTES,
  MAX_ANALYSIS_HISTORY_TOTAL_BYTES,
  clearAnalysisHistory,
  clearCloudApiKey,
  deleteAnalysisHistoryEntry,
  loadAnalysisHistory,
  loadCloudApiKey,
  loadCloudSettings,
  loadMonthlyCloudUsage,
  loadStoredRecords,
  loadThemeMode,
  saveCloudSettings,
  saveCloudApiKey,
  saveAnalysisHistoryEntry,
  saveStoredRecords,
  saveThemeMode,
  recordCloudUsage,
  replaceAnalysisHistory,
} from "./recordStore";

const RECORDS_KEY = "kr_tieba_review_records_v1";

function record(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: "00000000-0000-4000-8000-000000000001",
    threadId: "123",
    threadUrl: "https://tieba.baidu.com/p/123?fr=frs",
    replyIds: ["101"],
    decision: "watch",
    primaryReasonId: null,
    internalTags: ["provocation"],
    reviewedAt: "2026-07-22T04:00:00.000Z",
    analyzerVersions: { local: "1.0.0", cloud: null, rules: "2026.07" },
    ...overrides,
  };
}

function analysisHistoryEntry(
  overrides: Partial<AnalysisHistoryEntry> = {},
): AnalysisHistoryEntry {
  const base = createAnalysisHistoryEntry({
    attemptId: "attempt:history-1",
    snapshotId: "a".repeat(64) as AnalysisHistoryEntry["snapshotId"],
    analysisKey: "b".repeat(64) as AnalysisHistoryEntry["analysisKey"],
    threadId: "123",
    threadUrl: "https://tieba.baidu.com/p/123",
    threadTitle: "合成历史测试帖",
    provider: "deepseek",
    model: "deepseek-chat",
    mode: "fast",
    analyzerVersion: "3.0.0",
    rulesVersion: "2026.07",
    transportVersion: "sidepanel-v3",
    startedAt: "2026-08-16T02:00:00.000Z",
    completedAt: "2026-08-16T02:01:00.000Z",
    coverage: {
      visibleReplyCount: 1,
      imageCount: 0,
      unavailableReplyCount: 0,
    },
    result: {
      protocolVersion: 3,
      summary: "未发现需要优先复核的内容。",
      findings: [],
      report: {
        overview: "讨论围绕合成测试主题展开。",
        stages: [],
        interactions: [],
        notes: [],
      },
      uncertainties: [],
      analyzedReplyCount: 1,
      ruleCount: 112,
      omittedImageCount: 0,
    },
    replies: [
      {
        id: "101",
        siteReplyId: "101",
        floor: 1,
        parentReplyId: null,
        authorName: "不会进入历史的用户名",
        time: "2026-08-16 10:00",
        timestamp: 1_755_312_000,
        content: "不会进入历史的回复正文",
        sourcePage: 1,
        sourceUrl: "https://tieba.baidu.com/p/123?pn=1",
        anchor: "[data-pid='101']",
        imageCount: 0,
        isNested: false,
        unexpandedNestedCount: 0,
      },
    ],
  });
  return { ...base, ...overrides };
}

function installHistoryLocalStorage(
  state: Record<string, unknown> = {},
) {
  const setAccessLevel = vi.fn().mockResolvedValue(undefined);
  const get = vi.fn(async (keys: string | string[] | null) => {
    if (keys === null) return { ...state };
    const requested = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(
      requested
        .filter((key) => Object.prototype.hasOwnProperty.call(state, key))
        .map((key) => [key, state[key]]),
    );
  });
  const set = vi.fn(async (items: Record<string, unknown>) => {
    await Promise.resolve();
    Object.assign(state, items);
  });
  const remove = vi.fn(async (keys: string | string[]) => {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
  });
  const sessionState: Record<string, unknown> = {};
  const session = {
    get: vi.fn(async () => ({ ...sessionState })),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(sessionState, items);
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete sessionState[key];
      }
    }),
  };
  vi.stubGlobal("chrome", {
    runtime: { id: "history-test-extension" },
    storage: {
      local: { get, set, remove, setAccessLevel },
      session,
    },
  });
  return { state, get, set, remove, setAccessLevel, session, sessionState };
}

function installHistoryWebLocks() {
  let tail: Promise<void> = Promise.resolve();
  let activeRequestCount = 0;
  let maximumActiveRequestCount = 0;
  const request = vi.fn(
    (
      name: string,
      options: { mode?: string },
      callback: () => unknown,
    ) => {
      const run = async () => {
        activeRequestCount += 1;
        maximumActiveRequestCount = Math.max(
          maximumActiveRequestCount,
          activeRequestCount,
        );
        try {
          return await callback();
        } finally {
          activeRequestCount -= 1;
        }
      };
      const result = tail.then(run, run);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  );
  vi.stubGlobal("navigator", { locks: { request } });
  return {
    request,
    maximumActiveRequestCount: () => maximumActiveRequestCount,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("loadStoredRecords", () => {
  it("normalizes safe legacy records and removes unsafe stored entries", async () => {
    const stored = [
      record(),
      record({
        id: "00000000-0000-4000-8000-000000000002",
        internalTags: ["用户名-用户甲"],
      }),
    ];
    const set = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({ [RECORDS_KEY]: stored }),
          set,
        },
      },
    });

    const loaded = await loadStoredRecords();

    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.threadUrl).toBe("https://tieba.baidu.com/p/123");
    expect(JSON.stringify(loaded)).not.toContain("用户甲");
    expect(set).toHaveBeenCalledWith({ [RECORDS_KEY]: loaded });
  });

  it("returns an empty list for an invalid storage container", async () => {
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({ [RECORDS_KEY]: { bad: true } }),
          set: vi.fn(),
        },
      },
    });

    await expect(loadStoredRecords()).resolves.toEqual([]);
  });

  it("uses the module queue fallback to merge concurrent decisions without Web Locks", async () => {
    vi.stubGlobal("navigator", {});
    const storage = installHistoryLocalStorage();
    const first = record({
      id: "00000000-0000-4000-8000-000000000101",
      reviewedAt: "2026-08-16T04:01:00.000Z",
    });
    const second = record({
      id: "00000000-0000-4000-8000-000000000102",
      reviewedAt: "2026-08-16T04:02:00.000Z",
    });

    await Promise.all([
      saveStoredRecords([first]),
      saveStoredRecords([second]),
    ]);

    const stored = storage.state[RECORDS_KEY] as ReviewRecord[];
    expect(stored.map((item) => item.id)).toEqual([second.id, first.id]);
    expect(stored.every((item) => item.threadUrl === "https://tieba.baidu.com/p/123"))
      .toBe(true);
    expect(storage.set).toHaveBeenCalledTimes(2);
  });

  it("serializes two independent side-panel contexts and preserves both decisions", async () => {
    const storage = installHistoryLocalStorage();
    const locks = installHistoryWebLocks();
    const first = record({
      id: "00000000-0000-4000-8000-000000000111",
      reviewedAt: "2026-08-16T04:01:00.000Z",
    });
    const second = record({
      id: "00000000-0000-4000-8000-000000000112",
      reviewedAt: "2026-08-16T04:02:00.000Z",
    });
    vi.resetModules();
    const firstContext = await import("./recordStore");
    vi.resetModules();
    const secondContext = await import("./recordStore");

    const [firstResult, secondResult] = await Promise.all([
      firstContext.saveStoredRecords([first]),
      secondContext.saveStoredRecords([second]),
    ]);

    const stored = storage.state[RECORDS_KEY] as ReviewRecord[];
    expect(stored.map((item) => item.id)).toEqual([second.id, first.id]);
    expect(stored.every((item) => item.threadUrl === "https://tieba.baidu.com/p/123"))
      .toBe(true);
    expect([firstResult.length, secondResult.length].sort()).toEqual([1, 2]);
    expect(locks.request).toHaveBeenCalledTimes(2);
    for (const [name, options] of locks.request.mock.calls) {
      expect(name).toBe("kr-review-records-storage-v1");
      expect(options).toEqual({ mode: "exclusive" });
    }
    expect(locks.maximumActiveRequestCount()).toBe(1);
  });

  it("fails closed when the records lock cannot be acquired", async () => {
    const storage = installHistoryLocalStorage();
    const request = vi.fn().mockRejectedValue(new Error("records lock unavailable"));
    vi.stubGlobal("navigator", { locks: { request } });

    await expect(saveStoredRecords([record()])).rejects.toThrow(
      /records lock unavailable/u,
    );
    expect(storage.get).not.toHaveBeenCalled();
    expect(storage.set).not.toHaveBeenCalled();
    expect(storage.state).toEqual({});
  });

  it("leaves the previous decisions untouched when the atomic set fails", async () => {
    const existing = record({
      id: "00000000-0000-4000-8000-000000000121",
    });
    const storage = installHistoryLocalStorage({ [RECORDS_KEY]: [existing] });
    const before = structuredClone(storage.state);
    storage.set.mockImplementationOnce(async () => {
      throw new Error("records quota exceeded");
    });

    await expect(
      saveStoredRecords([
        record({ id: "00000000-0000-4000-8000-000000000122" }),
      ]),
    ).rejects.toThrow(/quota exceeded/u);
    expect(storage.state).toEqual(before);
    expect(storage.set).toHaveBeenCalledOnce();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it("fails closed instead of overwriting a damaged records container", async () => {
    const damaged = [
      record({ id: "00000000-0000-4000-8000-000000000131" }),
      { unsafe: "reply body must remain untouched" },
    ];
    const storage = installHistoryLocalStorage({ [RECORDS_KEY]: damaged });

    await expect(
      saveStoredRecords([
        record({ id: "00000000-0000-4000-8000-000000000132" }),
      ]),
    ).rejects.toThrow(/包含无效记录.*未保存任何内容.*不会自动删除/u);
    expect(storage.state[RECORDS_KEY]).toBe(damaged);
    expect(storage.set).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
  });
});

describe("analysis history durable storage", () => {
  it("survives a module reload in local storage without using session storage", async () => {
    const state: Record<string, unknown> = {};
    const firstStorage = installHistoryLocalStorage(state);
    const entry = analysisHistoryEntry();

    await saveAnalysisHistoryEntry(entry);

    expect(state[`${ANALYSIS_HISTORY_STORAGE_PREFIX}${entry.attemptId}`]).toEqual(entry);
    expect(JSON.stringify(state)).not.toContain("不会进入历史的用户名");
    expect(JSON.stringify(state)).not.toContain("不会进入历史的回复正文");
    expect(firstStorage.session.set).not.toHaveBeenCalled();
    expect(firstStorage.setAccessLevel.mock.invocationCallOrder[0]!).toBeLessThan(
      firstStorage.get.mock.invocationCallOrder[0]!,
    );

    vi.resetModules();
    const secondStorage = installHistoryLocalStorage(state);
    const reloadedStore = await import("./recordStore");

    await expect(reloadedStore.loadAnalysisHistory()).resolves.toEqual([entry]);
    expect(secondStorage.get).toHaveBeenCalledWith(null);
    expect(secondStorage.session.get).not.toHaveBeenCalled();
    expect(secondStorage.setAccessLevel).toHaveBeenCalledWith({
      accessLevel: "TRUSTED_CONTEXTS",
    });
  });

  it("uses the module queue fallback without Web Locks and keeps concurrent saves", async () => {
    vi.stubGlobal("navigator", {});
    const storage = installHistoryLocalStorage();
    const older = analysisHistoryEntry({
      attemptId: "attempt:concurrent-older",
      completedAt: "2026-08-16T02:01:00.000Z",
    });
    const newer = analysisHistoryEntry({
      attemptId: "attempt:concurrent-newer",
      completedAt: "2026-08-16T02:02:00.000Z",
    });

    await Promise.all([
      saveAnalysisHistoryEntry(older),
      saveAnalysisHistoryEntry(newer),
    ]);

    expect(
      Object.keys(storage.state).filter((key) =>
        key.startsWith(ANALYSIS_HISTORY_STORAGE_PREFIX),
      ),
    ).toHaveLength(2);
    await expect(loadAnalysisHistory()).resolves.toEqual([newer, older]);
    expect(storage.set).toHaveBeenCalledTimes(2);
    for (const [items] of storage.set.mock.calls) {
      expect(Object.keys(items)).toHaveLength(1);
      expect(Object.keys(items)[0]).toMatch(/^kr_analysis_history_v1_/u);
    }
  });

  it("serializes two independent side-panel contexts before the 100-entry limit", async () => {
    const existing = Array.from(
      { length: MAX_ANALYSIS_HISTORY_ENTRIES - 1 },
      (_, index) =>
        analysisHistoryEntry({ attemptId: `attempt:cross-context-${index}` }),
    );
    const storage = installHistoryLocalStorage(
      Object.fromEntries(
        existing.map((entry) => [
          `${ANALYSIS_HISTORY_STORAGE_PREFIX}${entry.attemptId}`,
          entry,
        ]),
      ),
    );
    const locks = installHistoryWebLocks();
    vi.resetModules();
    const firstContext = await import("./recordStore");
    vi.resetModules();
    const secondContext = await import("./recordStore");

    const results = await Promise.allSettled([
      firstContext.saveAnalysisHistoryEntry(
        analysisHistoryEntry({ attemptId: "attempt:cross-context-first" }),
      ),
      secondContext.saveAnalysisHistoryEntry(
        analysisHistoryEntry({ attemptId: "attempt:cross-context-second" }),
      ),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const [rejected] = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(String(rejected?.reason)).toMatch(/100 条上限/u);
    expect(
      Object.keys(storage.state).filter((key) =>
        key.startsWith(ANALYSIS_HISTORY_STORAGE_PREFIX),
      ),
    ).toHaveLength(MAX_ANALYSIS_HISTORY_ENTRIES);
    expect(storage.set).toHaveBeenCalledOnce();
    expect(locks.request).toHaveBeenCalledTimes(2);
    expect(
      locks.request.mock.calls.map(([name, options]) => [name, options]),
    ).toEqual([
      ["kr-analysis-history-storage-v1", { mode: "exclusive" }],
      ["kr-analysis-history-storage-v1", { mode: "exclusive" }],
    ]);
    expect(locks.maximumActiveRequestCount()).toBe(1);
  });

  it("uses the same exclusive origin lock for every history mutation", async () => {
    const storage = installHistoryLocalStorage();
    const locks = installHistoryWebLocks();
    const entry = analysisHistoryEntry({ attemptId: "attempt:all-mutations" });

    await saveAnalysisHistoryEntry(entry);
    await replaceAnalysisHistory([entry]);
    await deleteAnalysisHistoryEntry(entry.attemptId);
    storage.state[`${ANALYSIS_HISTORY_STORAGE_PREFIX}damaged`] = { bad: true };
    await clearAnalysisHistory();

    expect(locks.request).toHaveBeenCalledTimes(4);
    for (const [name, options] of locks.request.mock.calls) {
      expect(name).toBe("kr-analysis-history-storage-v1");
      expect(options).toEqual({ mode: "exclusive" });
    }
    expect(locks.maximumActiveRequestCount()).toBe(1);
  });

  it("does not run a mutation without the origin lock when lock acquisition fails", async () => {
    const storage = installHistoryLocalStorage();
    const request = vi.fn().mockRejectedValue(new Error("lock unavailable"));
    vi.stubGlobal("navigator", { locks: { request } });

    await expect(
      saveAnalysisHistoryEntry(
        analysisHistoryEntry({ attemptId: "attempt:lock-failure" }),
      ),
    ).rejects.toThrow(/lock unavailable/u);
    expect(request).toHaveBeenCalledOnce();
    expect(storage.setAccessLevel).not.toHaveBeenCalled();
    expect(storage.get).not.toHaveBeenCalled();
    expect(storage.set).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it("fails closed on damaged or key-mismatched items without deleting them", async () => {
    const valid = analysisHistoryEntry({ attemptId: "attempt:valid" });
    const mismatched = analysisHistoryEntry({ attemptId: "attempt:inside" });
    const damaged = {
      schemaVersion: 1,
      attemptId: "attempt:broken",
      threadUrl: "javascript:alert(1)",
    };
    const storage = installHistoryLocalStorage({
      [`${ANALYSIS_HISTORY_STORAGE_PREFIX}${valid.attemptId}`]: valid,
      [`${ANALYSIS_HISTORY_STORAGE_PREFIX}broken`]: damaged,
      [`${ANALYSIS_HISTORY_STORAGE_PREFIX}outside`]: mismatched,
      [CLOUD_SETTINGS_KEY]: { provider: "deepseek" },
    });
    const encodedValues: string[] = [];
    vi.stubGlobal(
      "TextEncoder",
      class InspectingTextEncoder {
        encode(value: string) {
          encodedValues.push(value);
          return { byteLength: value.length };
        }
      },
    );

    await expect(loadAnalysisHistory()).rejects.toThrow(
      /2 条损坏或任务编号不匹配.*未知状态.*不会自动删除/u,
    );
    expect(encodedValues).toContain(JSON.stringify(damaged));
    expect(storage.set).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
    expect(storage.state[`${ANALYSIS_HISTORY_STORAGE_PREFIX}broken`]).toBeDefined();
  });

  it("fails closed before reading history when trusted-only access cannot be set", async () => {
    const storage = installHistoryLocalStorage();
    storage.setAccessLevel.mockRejectedValueOnce(new Error("access denied"));

    await expect(loadAnalysisHistory()).rejects.toThrow(
      /无法限制 AI 分析历史存储的访问范围.*不会读取或修改历史/u,
    );
    expect(storage.get).not.toHaveBeenCalled();
    expect(storage.set).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it("does not treat a failed get(null) as an empty history", async () => {
    const storage = installHistoryLocalStorage();
    storage.get.mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(loadAnalysisHistory()).rejects.toThrow(
      /无法读取本机 AI 分析历史.*不会把未知状态当作空历史.*未修改/u,
    );
    expect(storage.get).toHaveBeenCalledWith(null);
    expect(storage.set).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it("does not treat a malformed get(null) response as an empty history", async () => {
    const storage = installHistoryLocalStorage();
    storage.get.mockResolvedValueOnce(null as never);

    await expect(loadAnalysisHistory()).rejects.toThrow(
      /存储接口返回格式异常.*不会把未知状态当作空历史.*未修改/u,
    );
    expect(storage.set).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it("deletes one attempt and clears only the analysis-history prefix", async () => {
    const first = analysisHistoryEntry({ attemptId: "attempt:delete-first" });
    const second = analysisHistoryEntry({ attemptId: "attempt:delete-second" });
    const records = [record()];
    const settings = { schemaVersion: 2, provider: "deepseek" };
    const secret = {
      schemaVersion: 2,
      provider: "deepseek",
      apiKey: "must-stay",
    };
    const usage = [{ attemptId: "usage-attempt", totalTokens: 12 }];
    const storage = installHistoryLocalStorage({
      [`${ANALYSIS_HISTORY_STORAGE_PREFIX}${first.attemptId}`]: first,
      [`${ANALYSIS_HISTORY_STORAGE_PREFIX}${second.attemptId}`]: second,
      [`${ANALYSIS_HISTORY_STORAGE_PREFIX}damaged`]: { bad: true },
      [CLOUD_SETTINGS_KEY]: settings,
      kr_cloud_api_secret_v2_deepseek: secret,
      kr_cloud_usage_v1: usage,
      [RECORDS_KEY]: records,
    });
    Object.assign(storage.sessionState, { kr_cloud_api_key_v1: "session-must-stay" });

    await deleteAnalysisHistoryEntry(first.attemptId);
    expect(storage.remove).toHaveBeenNthCalledWith(
      1,
      `${ANALYSIS_HISTORY_STORAGE_PREFIX}${first.attemptId}`,
    );
    expect(storage.state[`${ANALYSIS_HISTORY_STORAGE_PREFIX}${second.attemptId}`]).toEqual(second);

    await clearAnalysisHistory();

    expect(
      Object.keys(storage.state).filter((key) =>
        key.startsWith(ANALYSIS_HISTORY_STORAGE_PREFIX),
      ),
    ).toEqual([]);
    expect(storage.state[CLOUD_SETTINGS_KEY]).toBe(settings);
    expect(storage.state.kr_cloud_api_secret_v2_deepseek).toBe(secret);
    expect(storage.state.kr_cloud_usage_v1).toBe(usage);
    expect(storage.state[RECORDS_KEY]).toBe(records);
    expect(storage.sessionState.kr_cloud_api_key_v1).toBe("session-must-stay");
    expect(storage.session.remove).not.toHaveBeenCalled();
  });

  it("merges an import with existing attempts instead of deleting them", async () => {
    const existing = analysisHistoryEntry({
      attemptId: "attempt:existing",
      completedAt: "2026-08-16T02:01:00.000Z",
    });
    const updatedExisting = {
      ...existing,
      threadTitle: "导入后的标题",
      completedAt: "2026-08-16T02:03:00.000Z",
    };
    const imported = analysisHistoryEntry({
      attemptId: "attempt:imported",
      completedAt: "2026-08-16T02:02:00.000Z",
    });
    const storage = installHistoryLocalStorage({
      [`${ANALYSIS_HISTORY_STORAGE_PREFIX}${existing.attemptId}`]: existing,
    });

    await expect(
      replaceAnalysisHistory([updatedExisting, imported]),
    ).resolves.toEqual([updatedExisting, imported]);
    expect(storage.state[`${ANALYSIS_HISTORY_STORAGE_PREFIX}${existing.attemptId}`]).toEqual(
      updatedExisting,
    );
    expect(storage.state[`${ANALYSIS_HISTORY_STORAGE_PREFIX}${imported.attemptId}`]).toEqual(
      imported,
    );
    expect(storage.set).toHaveBeenCalledOnce();
    expect(Object.keys(storage.set.mock.calls[0]![0])).toHaveLength(2);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it("does not write when an import is already identical to durable history", async () => {
    const existing = analysisHistoryEntry({ attemptId: "attempt:unchanged" });
    const storage = installHistoryLocalStorage({
      [`${ANALYSIS_HISTORY_STORAGE_PREFIX}${existing.attemptId}`]: existing,
    });

    await expect(replaceAnalysisHistory([existing])).resolves.toEqual([existing]);
    expect(storage.set).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it("counts storage keys and rejects when value JSON alone reaches 4 MiB", async () => {
    const existing = Array.from({ length: 7 }, (_, index) =>
      analysisHistoryEntry({ attemptId: `attempt:total-save-${index}` }),
    );
    const incoming = analysisHistoryEntry({ attemptId: "attempt:total-save-overflow" });
    const storage = installHistoryLocalStorage(
      Object.fromEntries(
        existing.map((entry) => [
          `${ANALYSIS_HISTORY_STORAGE_PREFIX}${entry.attemptId}`,
          entry,
        ]),
      ),
    );
    vi.stubGlobal(
      "TextEncoder",
      class BoundaryTextEncoder {
        encode(value: string) {
          return value.startsWith(ANALYSIS_HISTORY_STORAGE_PREFIX)
            ? { byteLength: value.length }
            : {
                byteLength:
                  MAX_ANALYSIS_HISTORY_TOTAL_BYTES / (existing.length + 1),
              };
        }
      },
    );

    await expect(saveAnalysisHistoryEntry(incoming)).rejects.toThrow(
      /存储键和值 JSON 总大小超过 4 MiB 上限.*不会自动删除旧历史/u,
    );
    expect(storage.set).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
    expect(Object.keys(storage.state)).toHaveLength(existing.length);
  });

  it("allows a save whose storage keys plus value JSON are exactly 4 MiB", async () => {
    const existing = Array.from({ length: 7 }, (_, index) =>
      analysisHistoryEntry({ attemptId: `attempt:total-boundary-${index}` }),
    );
    const incoming = analysisHistoryEntry({ attemptId: "attempt:total-boundary-last" });
    const storage = installHistoryLocalStorage(
      Object.fromEntries(
        existing.map((entry) => [
          `${ANALYSIS_HISTORY_STORAGE_PREFIX}${entry.attemptId}`,
          entry,
        ]),
      ),
    );
    const allEntries = [...existing, incoming];
    const storageKeys = allEntries.map(
      (entry) => `${ANALYSIS_HISTORY_STORAGE_PREFIX}${entry.attemptId}`,
    );
    const keyBytes = storageKeys.reduce(
      (total, storageKey) => total + storageKey.length,
      0,
    );
    const baseValueBytes = Math.floor(
      (MAX_ANALYSIS_HISTORY_TOTAL_BYTES - keyBytes) / allEntries.length,
    );
    const finalValueBytes =
      MAX_ANALYSIS_HISTORY_TOTAL_BYTES -
      keyBytes -
      baseValueBytes * (allEntries.length - 1);
    const valueBytesByAttempt = new Map(
      allEntries.map((entry, index) => [
        entry.attemptId,
        index === allEntries.length - 1 ? finalValueBytes : baseValueBytes,
      ]),
    );
    vi.stubGlobal(
      "TextEncoder",
      class BoundaryTextEncoder {
        encode(value: string) {
          if (value.startsWith(ANALYSIS_HISTORY_STORAGE_PREFIX)) {
            return { byteLength: value.length };
          }
          const parsed = JSON.parse(value) as { attemptId: string };
          return { byteLength: valueBytesByAttempt.get(parsed.attemptId)! };
        }
      },
    );

    await expect(saveAnalysisHistoryEntry(incoming)).resolves.toBeUndefined();
    expect(storage.set).toHaveBeenCalledOnce();
    expect(Object.keys(storage.state)).toHaveLength(8);
  });

  it("rejects a merged import above 4 MiB before its first write", async () => {
    const existing = Array.from({ length: 7 }, (_, index) =>
      analysisHistoryEntry({ attemptId: `attempt:total-import-existing-${index}` }),
    );
    const incoming = Array.from({ length: 2 }, (_, index) =>
      analysisHistoryEntry({ attemptId: `attempt:total-import-new-${index}` }),
    );
    const storage = installHistoryLocalStorage(
      Object.fromEntries(
        existing.map((entry) => [
          `${ANALYSIS_HISTORY_STORAGE_PREFIX}${entry.attemptId}`,
          entry,
        ]),
      ),
    );
    vi.stubGlobal(
      "TextEncoder",
      class BoundaryTextEncoder {
        encode(value: string) {
          return value.startsWith(ANALYSIS_HISTORY_STORAGE_PREFIX)
            ? { byteLength: value.length }
            : {
                byteLength:
                  MAX_ANALYSIS_HISTORY_TOTAL_BYTES /
                  (existing.length + incoming.length - 1),
              };
        }
      },
    );

    await expect(replaceAnalysisHistory(incoming)).rejects.toThrow(
      /存储键和值 JSON 总大小超过 4 MiB 上限/u,
    );
    expect(storage.set).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
    expect(Object.keys(storage.state)).toHaveLength(existing.length);
  });

  it("uses one atomic storage set so a failed import leaves no partial keys", async () => {
    const existing = analysisHistoryEntry({ attemptId: "attempt:atomic-existing" });
    const first = analysisHistoryEntry({ attemptId: "attempt:atomic-first" });
    const second = analysisHistoryEntry({ attemptId: "attempt:atomic-second" });
    const existingKey = `${ANALYSIS_HISTORY_STORAGE_PREFIX}${existing.attemptId}`;
    const storage = installHistoryLocalStorage({ [existingKey]: existing });
    const before = { ...storage.state };
    storage.set.mockImplementationOnce(async () => {
      throw new Error("QUOTA_BYTES quota exceeded");
    });

    await expect(replaceAnalysisHistory([first, second])).rejects.toThrow(
      /quota exceeded/u,
    );

    expect(storage.set).toHaveBeenCalledOnce();
    expect(Object.keys(storage.set.mock.calls[0]![0]).sort()).toEqual(
      [first, second]
        .map((entry) => `${ANALYSIS_HISTORY_STORAGE_PREFIX}${entry.attemptId}`)
        .sort(),
    );
    expect(storage.state).toEqual(before);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it("rejects a 101st attempt explicitly without evicting older history", async () => {
    const entries = Array.from(
      { length: MAX_ANALYSIS_HISTORY_ENTRIES },
      (_, index) =>
        analysisHistoryEntry({ attemptId: `attempt:capacity-${index}` }),
    );
    const state = Object.fromEntries(
      entries.map((entry) => [
        `${ANALYSIS_HISTORY_STORAGE_PREFIX}${entry.attemptId}`,
        entry,
      ]),
    );
    const storage = installHistoryLocalStorage(state);

    await expect(
      saveAnalysisHistoryEntry(
        analysisHistoryEntry({ attemptId: "attempt:capacity-overflow" }),
      ),
    ).rejects.toThrow(/100 条上限.*不会自动删除旧历史/u);

    expect(storage.set).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
    expect(Object.keys(storage.state)).toHaveLength(MAX_ANALYSIS_HISTORY_ENTRIES);
  });

  it("rejects an entry above 4 MiB before reading or writing history", async () => {
    const storage = installHistoryLocalStorage();
    const entry = analysisHistoryEntry();
    vi.stubGlobal(
      "TextEncoder",
      class OversizedTextEncoder {
        encode() {
          return { byteLength: MAX_ANALYSIS_HISTORY_ENTRY_BYTES + 1 };
        }
      },
    );

    await expect(saveAnalysisHistoryEntry(entry)).rejects.toThrow(
      /4 MiB 存储上限/u,
    );
    expect(storage.setAccessLevel).toHaveBeenCalledOnce();
    expect(storage.get).not.toHaveBeenCalled();
    expect(storage.set).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
  });
});

describe("theme storage boundary", () => {
  it("loads a valid Chrome-local theme and normalizes unknown stored values", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ kr_ui_theme_v1: "dark" })
      .mockResolvedValueOnce({ kr_ui_theme_v1: "system" });
    vi.stubGlobal("chrome", {
      storage: {
        local: { get },
      },
    });

    await expect(loadThemeMode()).resolves.toBe("dark");
    await expect(loadThemeMode()).resolves.toBe(DEFAULT_THEME_MODE);
    expect(get).toHaveBeenNthCalledWith(1, "kr_ui_theme_v1");
    expect(get).toHaveBeenNthCalledWith(2, "kr_ui_theme_v1");
  });

  it("persists the theme only in Chrome local storage", async () => {
    const localSet = vi.fn().mockResolvedValue(undefined);
    const sessionSet = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", {
      storage: {
        local: { set: localSet },
        session: { set: sessionSet },
      },
    });

    await saveThemeMode("dark");

    expect(localSet).toHaveBeenCalledOnce();
    expect(localSet).toHaveBeenCalledWith({ kr_ui_theme_v1: "dark" });
    expect(sessionSet).not.toHaveBeenCalled();
  });

  it("uses localStorage for a standalone demo when Chrome APIs are absent", async () => {
    const values = new Map<string, string>();
    const getItem = vi.fn((key: string) => values.get(key) ?? null);
    const setItem = vi.fn((key: string, value: string) => {
      values.set(key, value);
    });
    vi.stubGlobal("chrome", undefined);
    vi.stubGlobal("localStorage", { getItem, setItem });

    await saveThemeMode("dark");
    await expect(loadThemeMode()).resolves.toBe("dark");

    expect(setItem).toHaveBeenCalledWith("kr_ui_theme_v1", "dark");
    expect(getItem).toHaveBeenCalledWith("kr_ui_theme_v1");
  });

  it("keeps the demo usable when localStorage is unavailable", async () => {
    vi.stubGlobal("chrome", undefined);
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => {
        throw new DOMException("Storage is disabled", "SecurityError");
      }),
      setItem: vi.fn(() => {
        throw new DOMException("Storage is disabled", "SecurityError");
      }),
    });

    await expect(loadThemeMode()).resolves.toBe(DEFAULT_THEME_MODE);
    await expect(saveThemeMode("dark")).resolves.toBeUndefined();
  });
});

describe("cloud API secret storage boundary", () => {
  it("loads only the requested provider's v2 durable secret", async () => {
    const sessionGet = vi.fn();
    const setAccessLevel = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          setAccessLevel,
          get: vi.fn().mockResolvedValue({
            kr_cloud_api_secret_v2_deepseek: {
              schemaVersion: 2,
              provider: "deepseek",
              apiKey: "durable-secret",
            },
          }),
        },
        session: { get: sessionGet },
      },
    });

    await expect(loadCloudApiKey("deepseek")).resolves.toBe("durable-secret");
    expect(sessionGet).not.toHaveBeenCalled();
    expect(setAccessLevel).toHaveBeenCalledWith({
      accessLevel: "TRUSTED_CONTEXTS",
    });
  });

  it("does not return a durable secret when Chrome refuses trusted-only access", async () => {
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          setAccessLevel: vi.fn().mockRejectedValue(new Error("denied")),
          get: vi.fn().mockResolvedValue({
            kr_cloud_api_secret_v2_deepseek: {
              schemaVersion: 2,
              provider: "deepseek",
              apiKey: "must-remain-unread",
            },
          }),
        },
      },
    });

    await expect(loadCloudApiKey("deepseek")).rejects.toThrow("不会读取或保存密钥");
  });

  it("fails closed in an installed extension when trusted-only access is unavailable", async () => {
    const get = vi.fn();
    const set = vi.fn();
    vi.stubGlobal("chrome", {
      runtime: { id: "installed-extension" },
      storage: { local: { get, set } },
    });

    await expect(loadCloudApiKey("deepseek")).rejects.toThrow(
      "不会读取或保存密钥",
    );
    await expect(saveCloudApiKey("deepseek", "must-not-be-written")).rejects.toThrow(
      "不会读取或保存密钥",
    );
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it("does not let a generic provider lookup consume shared legacy credentials", async () => {
    const localSet = vi.fn();
    const localRemove = vi.fn();
    const sessionGet = vi.fn().mockResolvedValue({
      kr_cloud_api_key_v1: "shared-session-secret",
    });
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({
            kr_cloud_api_secret_v1: {
              schemaVersion: 1,
              apiKey: "shared-local-secret",
            },
          }),
          set: localSet,
          remove: localRemove,
        },
        session: { get: sessionGet },
      },
    });

    await expect(loadCloudApiKey("deepseek")).resolves.toBe("");
    expect(sessionGet).not.toHaveBeenCalled();
    expect(localSet).not.toHaveBeenCalled();
    expect(localRemove).not.toHaveBeenCalled();
  });

  it("migrates a WIP single-slot key only after settings establish the active provider", async () => {
    const localSet = vi.fn().mockResolvedValue(undefined);
    const localRemove = vi.fn().mockResolvedValue(undefined);
    const sessionRemove = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async (key: string | string[]) => {
            if (key === CLOUD_SETTINGS_KEY) {
              return {
                [CLOUD_SETTINGS_KEY]: {
                  schemaVersion: CLOUD_SETTINGS_SCHEMA_VERSION,
                  provider: "deepseek",
                  endpoint: "https://api.deepseek.com/chat/completions",
                  model: "deepseek-chat",
                },
              };
            }
            if (
              key === "kr_cloud_api_secret_v1" ||
              (Array.isArray(key) && key.includes("kr_cloud_api_secret_v1"))
            ) {
              return {
                kr_cloud_api_secret_v1: {
                  schemaVersion: 1,
                  apiKey: "wip-single-slot-secret",
                },
              };
            }
            return {};
          }),
          set: localSet,
          remove: localRemove,
        },
        session: {
          get: vi.fn().mockResolvedValue({}),
          remove: sessionRemove,
        },
      },
    });

    await expect(loadCloudSettings()).resolves.toMatchObject({
      provider: "deepseek",
      apiKey: "wip-single-slot-secret",
    });
    expect(localSet).toHaveBeenCalledWith({
      kr_cloud_api_secret_v2_deepseek: {
        schemaVersion: 2,
        provider: "deepseek",
        apiKey: "wip-single-slot-secret",
      },
      kr_cloud_api_secret_v2_shared_legacy_retired: {
        schemaVersion: 1,
        provider: "deepseek",
      },
    });
    expect(localSet.mock.invocationCallOrder[0]).toBeLessThan(
      localRemove.mock.invocationCallOrder[0]!,
    );
    expect(localRemove).toHaveBeenCalledWith("kr_cloud_api_secret_v1");
    expect(sessionRemove).toHaveBeenCalledWith("kr_cloud_api_key_v1");
  });

  it("keeps a shared legacy key when trusted-context restriction blocks migration", async () => {
    const localSet = vi.fn();
    const localRemove = vi.fn();
    const sessionRemove = vi.fn();
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          setAccessLevel: vi.fn().mockRejectedValue(new Error("denied")),
          get: vi.fn(async (key: string | string[]) => {
            if (key === CLOUD_SETTINGS_KEY) {
              return {
                [CLOUD_SETTINGS_KEY]: {
                  schemaVersion: CLOUD_SETTINGS_SCHEMA_VERSION,
                  provider: "deepseek",
                  endpoint: CLOUD_PROVIDER_DEFAULTS.deepseek.endpoint,
                  model: "deepseek-chat",
                },
              };
            }
            return {};
          }),
          set: localSet,
          remove: localRemove,
        },
        session: {
          get: vi.fn().mockResolvedValue({
            kr_cloud_api_key_v1: "shared-session-secret",
          }),
          remove: sessionRemove,
        },
      },
    });

    await expect(loadCloudSettings()).rejects.toThrow("不会读取或保存密钥");
    expect(localSet).not.toHaveBeenCalled();
    expect(localRemove).not.toHaveBeenCalled();
    expect(sessionRemove).not.toHaveBeenCalled();
  });

  it("saves providers independently, preserves on blank, and clears only one provider", async () => {
    const localSet = vi.fn().mockResolvedValue(undefined);
    const localRemove = vi.fn().mockResolvedValue(undefined);
    const sessionSet = vi.fn();
    const sessionRemove = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", {
      storage: {
        local: { set: localSet, remove: localRemove },
        session: { set: sessionSet, remove: sessionRemove },
      },
    });

    await saveCloudApiKey("deepseek", "durable-secret");
    expect(localSet).toHaveBeenCalledWith({
      kr_cloud_api_secret_v2_deepseek: {
        schemaVersion: 2,
        provider: "deepseek",
        apiKey: "durable-secret",
      },
      kr_cloud_api_secret_v2_shared_legacy_retired: {
        schemaVersion: 1,
        provider: "deepseek",
      },
    });
    await saveCloudApiKey("alibaba", "other-provider-secret");
    expect(localSet).toHaveBeenCalledWith({
      kr_cloud_api_secret_v2_alibaba: {
        schemaVersion: 2,
        provider: "alibaba",
        apiKey: "other-provider-secret",
      },
      kr_cloud_api_secret_v2_shared_legacy_retired: {
        schemaVersion: 1,
        provider: "alibaba",
      },
    });
    localSet.mockClear();
    await saveCloudApiKey("deepseek", "");
    expect(localSet).not.toHaveBeenCalled();
    expect(sessionSet).not.toHaveBeenCalled();

    await clearCloudApiKey("deepseek");
    expect(localRemove).toHaveBeenCalledWith([
      "kr_cloud_api_secret_v2_deepseek",
      "kr_cloud_api_secret_v1_deepseek",
    ]);
    expect(JSON.stringify(localRemove.mock.calls)).not.toContain(
      "kr_cloud_api_secret_v2_alibaba",
    );
    expect(sessionRemove).not.toHaveBeenCalled();
  });

  it("does not resurrect a cleared key when shared legacy cleanup previously failed", async () => {
    const localState: Record<string, unknown> = {
      [CLOUD_SETTINGS_KEY]: {
        schemaVersion: CLOUD_SETTINGS_SCHEMA_VERSION,
        provider: "deepseek",
        endpoint: CLOUD_PROVIDER_DEFAULTS.deepseek.endpoint,
        model: "deepseek-chat",
        mode: "fast",
        autoReadWholeThread: true,
        autoAnalyzeWholeThread: false,
      },
    };
    const sessionState: Record<string, unknown> = {
      kr_cloud_api_key_v1: "legacy-secret-that-must-not-return",
    };
    const valuesFor = (
      state: Record<string, unknown>,
      keys: string | string[],
    ) => {
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(
        requested
          .filter((key) => key in state)
          .map((key) => [key, state[key]]),
      );
    };
    const localRemove = vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete localState[key];
      }
    });
    vi.stubGlobal("chrome", {
      runtime: { id: "installed-extension" },
      storage: {
        local: {
          setAccessLevel: vi.fn().mockResolvedValue(undefined),
          get: vi.fn(async (keys: string | string[]) =>
            valuesFor(localState, keys),
          ),
          set: vi.fn(async (items: Record<string, unknown>) => {
            Object.assign(localState, items);
          }),
          remove: localRemove,
        },
        session: {
          get: vi.fn(async (keys: string | string[]) =>
            valuesFor(sessionState, keys),
          ),
          remove: vi.fn().mockRejectedValue(new Error("cleanup denied")),
        },
      },
    });

    await expect(loadCloudSettings()).resolves.toMatchObject({
      apiKey: "legacy-secret-that-must-not-return",
    });
    expect(localState.kr_cloud_api_secret_v2_shared_legacy_retired).toEqual({
      schemaVersion: 1,
      provider: "deepseek",
    });

    await clearCloudApiKey("deepseek");
    expect(localState.kr_cloud_api_secret_v2_deepseek).toBeUndefined();
    await expect(loadCloudSettings()).resolves.toMatchObject({ apiKey: "" });
    expect(localState.kr_cloud_api_secret_v2_deepseek).toBeUndefined();
    expect(sessionState.kr_cloud_api_key_v1).toBe(
      "legacy-secret-that-must-not-return",
    );
  });

  it("recovers the provider key from local storage after a fresh browser session", async () => {
    const localState: Record<string, unknown> = {};
    const localArea = {
      setAccessLevel: vi.fn().mockResolvedValue(undefined),
      get: vi.fn(async (keys: string | string[]) => {
        const requested = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(
          requested
            .filter((key) => key in localState)
            .map((key) => [key, localState[key]]),
        );
      }),
      set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(localState, items);
      }),
      remove: vi.fn(async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete localState[key];
      }),
    };
    vi.stubGlobal("chrome", {
      storage: { local: localArea, session: { get: vi.fn().mockResolvedValue({}) } },
    });
    await saveCloudApiKey("deepseek", "restart-durable-secret");

    // A new Chrome session has an empty storage.session object, while the
    // extension's storage.local data remains attached to the same profile/id.
    vi.stubGlobal("chrome", {
      storage: { local: localArea, session: { get: vi.fn().mockResolvedValue({}) } },
    });
    await expect(loadCloudApiKey("deepseek")).resolves.toBe(
      "restart-durable-secret",
    );
  });

  it("never returns a secret stored under the wrong provider identity", async () => {
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({
            kr_cloud_api_secret_v2_deepseek: {
              schemaVersion: 2,
              provider: "alibaba",
              apiKey: "wrong-provider-secret",
            },
          }),
        },
        session: { get: vi.fn().mockResolvedValue({}) },
      },
    });

    await expect(loadCloudApiKey("deepseek")).resolves.toBe("");
  });

  it("rejects control characters and excessive credential length before writing", async () => {
    const localSet = vi.fn();
    vi.stubGlobal("chrome", {
      storage: { local: { set: localSet } },
    });

    for (const invalid of ["line\nbreak", "line\rbreak", "nul\0byte", "x".repeat(8_193)]) {
      await expect(saveCloudApiKey("deepseek", invalid)).rejects.toThrow(
        "API 密钥格式无效",
      );
    }
    expect(localSet).not.toHaveBeenCalled();
  });

  it("fails closed when Chrome refuses to restrict local storage before a write", async () => {
    const localSet = vi.fn();
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          setAccessLevel: vi.fn().mockRejectedValue(new Error("denied")),
          set: localSet,
        },
      },
    });

    await expect(
      saveCloudApiKey("deepseek", "must-not-be-written"),
    ).rejects.toThrow("不会读取或保存密钥");
    expect(localSet).not.toHaveBeenCalled();
  });

  it("never falls back to page localStorage outside an extension context", async () => {
    const getItem = vi.fn(() => "web-page-secret");
    const setItem = vi.fn();
    const removeItem = vi.fn();
    vi.stubGlobal("chrome", undefined);
    vi.stubGlobal("localStorage", { getItem, setItem, removeItem });

    await expect(loadCloudApiKey("deepseek")).resolves.toBe("");
    await expect(saveCloudApiKey("deepseek", "must-not-be-written")).resolves.toBeUndefined();
    await expect(clearCloudApiKey("deepseek")).resolves.toBeUndefined();
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });
});

describe("cloud settings storage boundary", () => {
  it("stores the API key in a separate durable local secret record", async () => {
    const localSet = vi.fn().mockResolvedValue(undefined);
    const sessionRemove = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", {
      storage: {
        local: { set: localSet },
        session: { remove: sessionRemove },
      },
    });

    await saveCloudSettings({
      provider: "alibaba",
      endpoint: CLOUD_PROVIDER_DEFAULTS.alibaba.endpoint,
      model: "model-1",
      apiKey: "session-secret",
      mode: "deep",
    });

    const settingsWrite = {
      [CLOUD_SETTINGS_KEY]: {
        schemaVersion: CLOUD_SETTINGS_SCHEMA_VERSION,
        provider: "alibaba",
        endpoint: CLOUD_PROVIDER_DEFAULTS.alibaba.endpoint,
        model: "model-1",
        mode: "deep",
        autoReadWholeThread: true,
        autoAnalyzeWholeThread: false,
      },
    };
    const secretWrite = {
      kr_cloud_api_secret_v2_alibaba: {
        schemaVersion: 2,
        provider: "alibaba",
        apiKey: "session-secret",
      },
      kr_cloud_api_secret_v2_shared_legacy_retired: {
        schemaVersion: 1,
        provider: "alibaba",
      },
    };
    expect(localSet).toHaveBeenCalledWith(settingsWrite);
    expect(localSet).toHaveBeenCalledWith(secretWrite);
    expect(JSON.stringify(settingsWrite)).not.toContain("session-secret");
    expect(sessionRemove).toHaveBeenCalledWith("kr_cloud_api_key_v1");
  });

  it("rejects credential query parameters before any durable write", async () => {
    const localSet = vi.fn();
    const sessionSet = vi.fn();
    vi.stubGlobal("chrome", {
      storage: {
        local: { set: localSet },
        session: { set: sessionSet },
      },
    });

    await expect(
      saveCloudSettings({
        provider: "alibaba",
        endpoint: "https://provider.example/v1?api_key=do-not-store",
        model: "model-1",
        apiKey: "session-secret",
      }),
    ).rejects.toThrow();
    expect(localSet).not.toHaveBeenCalled();
    expect(sessionSet).not.toHaveBeenCalled();
  });

  it("rejects an endpoint belonging to a different provider before saving its key", async () => {
    const localSet = vi.fn();
    vi.stubGlobal("chrome", {
      storage: { local: { set: localSet } },
    });

    await expect(
      saveCloudSettings({
        provider: "deepseek",
        endpoint: CLOUD_PROVIDER_DEFAULTS.alibaba.endpoint,
        model: "deepseek-chat",
        apiKey: "deepseek-secret",
      }),
    ).rejects.toThrow("与所选服务商不匹配");
    expect(localSet).not.toHaveBeenCalled();
  });

  it("treats an empty key during an ordinary settings save as unchanged", async () => {
    const localSet = vi.fn().mockResolvedValue(undefined);
    const localRemove = vi.fn();
    vi.stubGlobal("chrome", {
      storage: {
        local: { set: localSet, remove: localRemove },
      },
    });

    await saveCloudSettings({
      provider: "deepseek",
      endpoint: CLOUD_PROVIDER_DEFAULTS.deepseek.endpoint,
      model: "deepseek-chat",
      apiKey: "",
    });

    expect(localSet).toHaveBeenCalledOnce();
    expect(localSet).toHaveBeenCalledWith({
      [CLOUD_SETTINGS_KEY]: expect.objectContaining({
        provider: "deepseek",
      }),
    });
    expect(localRemove).not.toHaveBeenCalled();
  });

  it("clears an unsafe endpoint left by an older version", async () => {
    const localSet = vi.fn().mockResolvedValue(undefined);
    const localRemove = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({
            kr_cloud_settings_v1: {
              endpoint: "https://provider.example/v1?token=old-secret",
              model: "model-1",
            },
          }),
          set: localSet,
          remove: localRemove,
        },
        session: {
          get: vi.fn().mockResolvedValue({ kr_cloud_api_key_v1: "session-only" }),
        },
      },
    });

    await expect(loadCloudSettings()).resolves.toEqual({
      schemaVersion: CLOUD_SETTINGS_SCHEMA_VERSION,
      provider: "alibaba",
      endpoint: CLOUD_PROVIDER_DEFAULTS.alibaba.endpoint,
      model: "model-1",
      apiKey: "session-only",
      mode: "fast",
      autoReadWholeThread: true,
      autoAnalyzeWholeThread: false,
    });
    expect(localSet).toHaveBeenCalledWith({
      [CLOUD_SETTINGS_KEY]: {
        schemaVersion: CLOUD_SETTINGS_SCHEMA_VERSION,
        provider: "alibaba",
        endpoint: CLOUD_PROVIDER_DEFAULTS.alibaba.endpoint,
        model: "model-1",
        mode: "fast",
        autoReadWholeThread: true,
        autoAnalyzeWholeThread: false,
      },
    });
    expect(localRemove).toHaveBeenCalledWith("kr_cloud_settings_v1");
  });

  it("repairs a persisted provider/endpoint mismatch to the provider canonical endpoint", async () => {
    const localSet = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async (key: string | string[]) => {
            if (key === CLOUD_SETTINGS_KEY) {
              return {
                [CLOUD_SETTINGS_KEY]: {
                  schemaVersion: CLOUD_SETTINGS_SCHEMA_VERSION,
                  provider: "deepseek",
                  endpoint: CLOUD_PROVIDER_DEFAULTS.alibaba.endpoint,
                  model: "deepseek-chat",
                },
              };
            }
            if (Array.isArray(key)) {
              return {
                kr_cloud_api_secret_v2_deepseek: {
                  schemaVersion: 2,
                  provider: "deepseek",
                  apiKey: "deepseek-secret",
                },
              };
            }
            return {};
          }),
          set: localSet,
        },
      },
    });

    await expect(loadCloudSettings()).resolves.toMatchObject({
      provider: "deepseek",
      endpoint: CLOUD_PROVIDER_DEFAULTS.deepseek.endpoint,
      apiKey: "deepseek-secret",
    });
    expect(localSet).toHaveBeenCalledWith({
      [CLOUD_SETTINGS_KEY]: expect.objectContaining({
        provider: "deepseek",
        endpoint: CLOUD_PROVIDER_DEFAULTS.deepseek.endpoint,
      }),
    });
  });

  it("loads an older cloud setting without a mode as fast mode", async () => {
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({
            kr_cloud_settings_v1: {
              endpoint: CLOUD_PROVIDER_DEFAULTS.alibaba.endpoint,
              model: "model-1",
            },
          }),
          set: vi.fn(),
        },
        session: {
          get: vi.fn().mockResolvedValue({ kr_cloud_api_key_v1: "session-only" }),
        },
      },
    });

    await expect(loadCloudSettings()).resolves.toEqual({
      schemaVersion: CLOUD_SETTINGS_SCHEMA_VERSION,
      provider: "alibaba",
      endpoint: CLOUD_PROVIDER_DEFAULTS.alibaba.endpoint,
      model: "model-1",
      apiKey: "session-only",
      mode: "fast",
      autoReadWholeThread: true,
      autoAnalyzeWholeThread: false,
    });
  });

  it("persists an explicit whole-thread auto-analysis opt-out", async () => {
    const localSet = vi.fn().mockResolvedValue(undefined);
    const sessionSet = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", {
      storage: {
        local: { set: localSet },
        session: { set: sessionSet },
      },
    });

    await saveCloudSettings({
      provider: "alibaba",
      endpoint: CLOUD_PROVIDER_DEFAULTS.alibaba.endpoint,
      model: "model-1",
      apiKey: "session-secret",
      mode: "fast",
      autoAnalyzeWholeThread: false,
    });

    expect(localSet).toHaveBeenCalledWith({
      [CLOUD_SETTINGS_KEY]: {
        schemaVersion: CLOUD_SETTINGS_SCHEMA_VERSION,
        provider: "alibaba",
        endpoint: CLOUD_PROVIDER_DEFAULTS.alibaba.endpoint,
        model: "model-1",
        mode: "fast",
        autoReadWholeThread: true,
        autoAnalyzeWholeThread: false,
      },
    });
  });

  it("infers DeepSeek for legacy settings and migrates its key outside CloudSettings", async () => {
    const localSet = vi.fn().mockResolvedValue(undefined);
    const localRemove = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({
            kr_cloud_settings_v1: {
              endpoint: "https://api.deepseek.com/chat/completions",
              model: "deepseek-v4-pro",
              mode: "deep",
            },
          }),
          set: localSet,
          remove: localRemove,
        },
        session: {
          get: vi.fn().mockResolvedValue({
            kr_cloud_api_key_v1: "deepseek-session-key",
          }),
        },
      },
    });

    await expect(loadCloudSettings()).resolves.toEqual({
      schemaVersion: CLOUD_SETTINGS_SCHEMA_VERSION,
      provider: "deepseek",
      endpoint: "https://api.deepseek.com/chat/completions",
      model: "deepseek-v4-pro",
      apiKey: "deepseek-session-key",
      mode: "deep",
      autoReadWholeThread: true,
      autoAnalyzeWholeThread: false,
    });
    const settingsWrite = localSet.mock.calls.find(
      ([value]) => CLOUD_SETTINGS_KEY in value,
    )?.[0];
    const secretWrite = localSet.mock.calls.find(
      ([value]) => "kr_cloud_api_secret_v2_deepseek" in value,
    )?.[0];
    expect(JSON.stringify(settingsWrite)).not.toContain("deepseek-session-key");
    expect(secretWrite).toEqual({
      kr_cloud_api_secret_v2_deepseek: {
        schemaVersion: 2,
        provider: "deepseek",
        apiKey: "deepseek-session-key",
      },
      kr_cloud_api_secret_v2_shared_legacy_retired: {
        schemaVersion: 1,
        provider: "deepseek",
      },
    });
    expect(localRemove).toHaveBeenCalledWith("kr_cloud_settings_v1");
  });
});

describe("cloud usage ledger", () => {
  it("stores only provider/model/time/token metadata and deduplicates attempts", async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    const existing = [{
      attemptId: "attempt-1",
      calledAt: "2026-08-01T00:00:00.000Z",
      provider: "alibaba",
      model: "old-model",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }];
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({ kr_cloud_usage_v1: existing }),
          set,
        },
      },
    });

    await recordCloudUsage({
      attemptId: "attempt-1",
      calledAt: "2026-08-16T02:00:00.000Z",
      provider: "deepseek",
      model: "deepseek-chat",
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
    });

    const saved = set.mock.calls[0]?.[0].kr_cloud_usage_v1;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ attemptId: "attempt-1", model: "deepseek-chat" });
    expect(JSON.stringify(saved)).not.toMatch(/content|author|apiKey|endpoint/u);
  });

  it("returns only entries from the requested local calendar month", async () => {
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({
            kr_cloud_usage_v1: [
              {
                attemptId: "august",
                calledAt: "2026-08-15T04:00:00.000Z",
                provider: "alibaba",
                model: "qwen",
                usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
              },
              {
                attemptId: "july",
                calledAt: "2026-07-31T04:00:00.000Z",
                provider: "alibaba",
                model: "qwen",
                usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
              },
            ],
          }),
        },
      },
    });

    await expect(loadMonthlyCloudUsage(new Date(2026, 7, 16))).resolves.toMatchObject([
      { attemptId: "august" },
    ]);
  });
});
