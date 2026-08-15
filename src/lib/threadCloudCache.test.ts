import { afterEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_VERSION } from "../types";
import type { ReviewSession } from "./session";
import {
  clearThreadCloudCache,
  loadThreadCloudCache,
  saveThreadCloudCache,
  THREAD_CLOUD_TRANSPORT_VERSION,
  threadCloudCacheIdentity,
  threadCloudCacheStorageKey,
  type ThreadCloudCacheEntry,
} from "./threadCloudCache";
import { CLOUD_ANALYZER_VERSION } from "./cloud";

function session(overrides: Partial<ReviewSession> = {}): ReviewSession {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionSchemaVersion: 3,
    tabId: 42,
    threadId: "99000000001",
    threadUrl: "https://tieba.baidu.com/p/99000000001",
    title: "测试帖子",
    pages: {},
    replies: [],
    coverage: {
      captureMode: "api",
      visibleReplyCount: 0,
      mainReplyCount: 0,
      nestedReplyCount: 0,
      imageCount: 0,
      unexpandedLzlCount: 0,
      analyzedPageNumbers: [],
      hasUnanalyzedImages: false,
      declaredReplyCount: 0,
      dynamicContentMayRemain: false,
      reachedReplyListEnd: true,
      unstableReplyIdCount: 0,
      isComplete: true,
      apiCoverage: {
        mainPagesFetched: 1,
        mainPagesTotal: 1,
        mainRepliesFetched: 0,
        nestedParentsFetched: 0,
        nestedParentsTotal: 0,
        nestedRepliesFetched: 0,
        nestedRepliesDeclared: 0,
        failedRequestCount: 0,
        unavailableReplyCount: 0,
        readableTextComplete: true,
      },
    },
    errors: [],
    warnings: [],
    updatedAt: "2026-07-28T03:00:00.000Z",
    ...overrides,
  };
}

function createStorageHarness(initial: Record<string, unknown> = {}) {
  const storage = new Map(Object.entries(initial));
  const get = vi.fn(async (key: string) => ({
    [key]: storage.get(key),
  }));
  const set = vi.fn(async (values: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(values)) storage.set(key, value);
  });
  const remove = vi.fn(async (key: string) => {
    storage.delete(key);
  });
  vi.stubGlobal("chrome", {
    storage: {
      session: { get, set, remove },
    },
  });
  return { storage, get, set, remove };
}

const settings = {
  endpoint:
    "https://ws-7ee35od4h2zs6dft.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  model: "qwen3.7-max",
  mode: "fast" as const,
};

afterEach(() => vi.unstubAllGlobals());

describe("whole-thread cloud session cache", () => {
  it("includes analyzer and side-panel transport versions in the cache identity", () => {
    expect(threadCloudCacheIdentity(session(), settings)).toMatchObject({
      analyzerVersion: CLOUD_ANALYZER_VERSION,
      transportVersion: THREAD_CLOUD_TRANSPORT_VERSION,
    });
    expect(THREAD_CLOUD_TRANSPORT_VERSION).toBe("sidepanel-v1");
  });

  it("stores a pending marker with an ISO start time to prevent duplicate requests", async () => {
    createStorageHarness();
    const identity = threadCloudCacheIdentity(session(), settings);
    const entry: ThreadCloudCacheEntry = {
      ...identity,
      status: "pending",
      startedAt: "2026-07-28T03:02:00.000Z",
    };

    await saveThreadCloudCache(entry);

    await expect(loadThreadCloudCache(identity)).resolves.toEqual(entry);
  });

  it("stores a successful result only in chrome.storage.session", async () => {
    const harness = createStorageHarness();
    const identity = threadCloudCacheIdentity(session(), settings);
    const entry: ThreadCloudCacheEntry = {
      ...identity,
      status: "success",
      result: {
        summary: "整帖已审阅",
        findings: [],
        uncertainties: [],
        analyzedReplyCount: 268,
        ruleCount: 112,
        omittedImageCount: 3,
      },
    };

    await saveThreadCloudCache(entry);
    await expect(loadThreadCloudCache(identity)).resolves.toEqual(entry);

    expect(harness.set).toHaveBeenCalledTimes(1);
    expect(
      harness.storage.get(threadCloudCacheStorageKey(identity.tabId)),
    ).toEqual(entry);
    expect(JSON.stringify(harness.set.mock.calls)).not.toContain("apiKey");
    expect(JSON.stringify(harness.set.mock.calls)).not.toContain("session-secret");
  });

  it("restores a failure marker so automatic analysis does not retry", async () => {
    createStorageHarness();
    const identity = threadCloudCacheIdentity(session(), settings);
    const entry: ThreadCloudCacheEntry = {
      ...identity,
      status: "failed",
      error: "云端请求超时，本地结果仍保留。",
    };

    await saveThreadCloudCache(entry);

    await expect(loadThreadCloudCache(identity)).resolves.toEqual(entry);
  });

  it("rejects stale results whenever the thread snapshot or model identity changes", async () => {
    const identity = threadCloudCacheIdentity(session(), settings);
    const entry: ThreadCloudCacheEntry = {
      ...identity,
      status: "success",
      result: {
        summary: "旧结果",
        findings: [],
        uncertainties: [],
        analyzedReplyCount: 268,
        ruleCount: 112,
        omittedImageCount: 0,
      },
    };
    createStorageHarness({
      [threadCloudCacheStorageKey(identity.tabId)]: entry,
    });

    await expect(
      loadThreadCloudCache({
        ...identity,
        sessionUpdatedAt: "2026-07-28T03:01:00.000Z",
      }),
    ).resolves.toBeNull();
    await expect(
      loadThreadCloudCache({ ...identity, model: "another-model" }),
    ).resolves.toBeNull();
    await expect(
      loadThreadCloudCache({
        ...identity,
        analyzerVersion: "1.0.0" as typeof identity.analyzerVersion,
      }),
    ).resolves.toBeNull();
    await expect(
      loadThreadCloudCache({
        ...identity,
        transportVersion:
          "background-v1" as typeof identity.transportVersion,
      }),
    ).resolves.toBeNull();
  });

  it("ignores malformed session data and can clear the tab cache", async () => {
    const identity = threadCloudCacheIdentity(session(), settings);
    const key = threadCloudCacheStorageKey(identity.tabId);
    const harness = createStorageHarness({
      [key]: { ...identity, status: "success", result: { summary: "不完整" } },
    });

    await expect(loadThreadCloudCache(identity)).resolves.toBeNull();
    await clearThreadCloudCache(identity.tabId);

    expect(harness.remove).toHaveBeenCalledWith(key);
    expect(harness.storage.has(key)).toBe(false);
  });

  it("rejects pending markers without a valid ISO start time", async () => {
    const identity = threadCloudCacheIdentity(session(), settings);
    const key = threadCloudCacheStorageKey(identity.tabId);
    createStorageHarness({
      [key]: { ...identity, status: "pending", startedAt: "not-a-date" },
    });

    await expect(loadThreadCloudCache(identity)).resolves.toBeNull();
  });
});
