import { afterEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_VERSION, type Finding } from "../types";
import { CLOUD_ANALYZER_VERSION } from "./cloud";
import type { ReviewSession } from "./session";
import {
  claimThreadCloudAnalysisStart,
  clearThreadCloudCache,
  loadLegacyThreadCloudSuccess,
  loadLatestThreadCloudCacheForSnapshot,
  loadThreadCloudBillingReceipt,
  loadThreadCloudCache,
  migrateLegacyThreadCloudPendingToUnknown,
  saveThreadCloudCache,
  THREAD_CLOUD_CACHE_SCHEMA_VERSION,
  THREAD_CLOUD_BILLING_RECEIPT_SCHEMA_VERSION,
  THREAD_CLOUD_TRANSPORT_VERSION,
  threadCloudBillingReceiptStorageKey,
  threadCloudCacheIdentity,
  threadCloudCacheRequiresPaidRetryConfirmation,
  threadCloudCacheStorageKey,
  threadCloudCacheV3StorageKey,
  type ThreadCloudCacheEntry,
  type ThreadCloudPreparingCacheEntry,
} from "./threadCloudCache";

function session(overrides: Partial<ReviewSession> = {}): ReviewSession {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionSchemaVersion: 3,
    tabId: 42,
    threadId: "99000000001",
    threadUrl: "https://tieba.baidu.com/p/99000000001",
    title: "测试帖子",
    pages: {},
    replies: [
      {
        id: "reply-1",
        siteReplyId: "9001",
        floor: 1,
        parentReplyId: null,
        authorName: "测试用户甲",
        time: "2026-07-28 11:00",
        timestamp: 1_753_675_200,
        content: "帖子正文中的测试内容",
        sourcePage: 1,
        sourceUrl: "https://tieba.baidu.com/p/99000000001",
        anchor: "#post_content_9001",
        imageCount: 0,
        isNested: false,
        unexpandedNestedCount: 0,
      },
    ],
    coverage: {
      captureMode: "api",
      visibleReplyCount: 1,
      mainReplyCount: 1,
      nestedReplyCount: 0,
      imageCount: 0,
      unexpandedLzlCount: 0,
      analyzedPageNumbers: [1],
      hasUnanalyzedImages: false,
      declaredReplyCount: 0,
      dynamicContentMayRemain: false,
      reachedReplyListEnd: true,
      unstableReplyIdCount: 0,
      isComplete: true,
      apiCoverage: {
        mainPagesFetched: 1,
        mainPagesTotal: 1,
        mainRepliesFetched: 1,
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

function createStorageArea(initial: Record<string, unknown> = {}) {
  const storage = new Map(Object.entries(initial));
  const get = vi.fn(async (key: string | string[] | null) => {
    if (key === null) return Object.fromEntries(storage);
    if (Array.isArray(key)) {
      return Object.fromEntries(
        key.filter((item) => storage.has(item)).map((item) => [item, storage.get(item)]),
      );
    }
    return { [key]: storage.get(key) };
  });
  const set = vi.fn(async (values: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(values)) storage.set(key, value);
  });
  const remove = vi.fn(async (key: string) => storage.delete(key));
  return { storage, get, set, remove };
}

function createStorageHarness(
  initial: {
    local?: Record<string, unknown>;
    session?: Record<string, unknown>;
  } = {},
) {
  const local = createStorageArea(initial.local);
  const session = createStorageArea(initial.session);
  vi.stubGlobal("chrome", {
    storage: {
      local: { get: local.get, set: local.set, remove: local.remove },
      session: {
        get: session.get,
        set: session.set,
        remove: session.remove,
      },
    },
  });
  return { local, session };
}

const settings = {
  provider: "alibaba" as const,
  endpoint: "https://provider.example/v1",
  model: "qwen3.7-max",
  mode: "fast" as const,
};

function result() {
  const finding: Finding = {
    id: "AI-1",
    type: "personal_attack",
    severity: "high",
    score: 0.93,
    summary: "测试用户甲发布了需要复核的内容",
    replyIds: ["reply-1"],
    participantNames: ["测试用户甲"],
    evidence: [
      {
        replyId: "reply-1",
        excerpt: "帖子正文中的测试内容",
        signals: ["测试用户甲存在人身攻击"],
        score: 0.93,
      },
    ],
    reasonCandidates: [
      {
        reasonId: "R12.01",
        confidence: 0.9,
        rationale: "测试用户甲使用攻击性表达",
      },
    ],
    uncertainties: [],
  };
  return {
    summary: "整帖已审阅",
    findings: [finding],
    uncertainties: [],
    analyzedReplyCount: 1,
    ruleCount: 112,
    omittedImageCount: 0,
  };
}

function runningEntry(): ThreadCloudCacheEntry {
  const identity = threadCloudCacheIdentity(session(), settings);
  return {
    ...identity,
    status: "running",
    attemptId: "attempt-1",
    startedAt: "2026-07-28T03:02:00.000Z",
    updatedAt: "2026-07-28T03:02:01.000Z",
    sentAt: "2026-07-28T03:02:01.000Z",
    deadlineAt: "2026-07-28T03:05:01.000Z",
    error: null,
  };
}

function preparingEntry(
  model = settings.model,
  attemptId = "preparing-attempt",
): ThreadCloudPreparingCacheEntry {
  const identity = threadCloudCacheIdentity(session(), { ...settings, model });
  return {
    ...identity,
    status: "preparing",
    attemptId,
    startedAt: "2026-07-28T03:02:00.000Z",
    updatedAt: "2026-07-28T03:02:00.000Z",
    sentAt: null,
    deadlineAt: null,
    error: null,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("whole-thread cloud cache v3", () => {
  it("keys the cache by snapshot plus every analysis input version", () => {
    const identity = threadCloudCacheIdentity(session(), settings);
    const sameFromAnotherTab = threadCloudCacheIdentity(
      session({ tabId: 99, updatedAt: "2027-01-01T00:00:00.000Z" }),
      settings,
    );

    expect(identity).toMatchObject({
      schemaVersion: THREAD_CLOUD_CACHE_SCHEMA_VERSION,
      analyzerVersion: CLOUD_ANALYZER_VERSION,
      transportVersion: THREAD_CLOUD_TRANSPORT_VERSION,
    });
    expect(identity.snapshotId).toBe(sameFromAnotherTab.snapshotId);
    expect(identity.analysisKey).toBe(sameFromAnotherTab.analysisKey);
    expect(identity.analysisKey).not.toBe(
      threadCloudCacheIdentity(session(), { ...settings, model: "other" })
        .analysisKey,
    );
    expect(JSON.stringify(identity)).not.toContain("测试帖子");
    expect(JSON.stringify(identity)).not.toContain("测试用户甲");
  });

  it("atomically stores cache plus a minimal snapshot billing receipt", async () => {
    const harness = createStorageHarness();
    const entry = runningEntry();

    await saveThreadCloudCache(entry);

    await expect(loadThreadCloudCache(entry)).resolves.toEqual(entry);
    expect(
      harness.local.storage.get(
        threadCloudCacheV3StorageKey(entry.analysisKey),
      ),
    ).toEqual(entry);
    const receipt = harness.local.storage.get(
      threadCloudBillingReceiptStorageKey(entry.snapshotId),
    );
    expect(receipt).toEqual({
      schemaVersion: THREAD_CLOUD_BILLING_RECEIPT_SCHEMA_VERSION,
      snapshotId: entry.snapshotId,
      attemptId: entry.attemptId,
      analysisKey: entry.analysisKey,
      status: "sent",
      startedAt: entry.startedAt,
      updatedAt: entry.updatedAt,
      sentAt: entry.sentAt,
    });
    expect(harness.local.set).toHaveBeenLastCalledWith({
      [threadCloudCacheV3StorageKey(entry.analysisKey)]: entry,
      [threadCloudBillingReceiptStorageKey(entry.snapshotId)]: receipt,
    });
    expect(JSON.stringify(receipt)).not.toContain("测试帖子");
    expect(JSON.stringify(receipt)).not.toContain("测试用户甲");
    expect(JSON.stringify(receipt)).not.toContain(settings.endpoint);
    expect(harness.local.storage.has(threadCloudCacheStorageKey(42))).toBe(
      false,
    );
    expect(harness.session.set).not.toHaveBeenCalled();
  });

  it("removes usernames, reply excerpts and accidental extra fields from success cache", async () => {
    const harness = createStorageHarness();
    const identity = threadCloudCacheIdentity(session(), settings);
    const entry = {
      ...identity,
      status: "success" as const,
      attemptId: "attempt-2",
      startedAt: "2026-07-28T03:02:00.000Z",
      updatedAt: "2026-07-28T03:04:00.000Z",
      sentAt: "2026-07-28T03:02:01.000Z",
      deadlineAt: "2026-07-28T03:05:01.000Z",
      completedAt: "2026-07-28T03:04:00.000Z",
      error: null,
      result: {
        ...result(),
        summary: "报告中未列为线索的用户乙参与了讨论",
      },
      usage: { inputTokens: 123.9, outputTokens: 45, totalTokens: 168 },
      apiKey: "session-secret",
      endpoint: settings.endpoint,
    } satisfies ThreadCloudCacheEntry & Record<string, unknown>;

    await saveThreadCloudCache(entry, ["报告中未列为线索的用户乙"]);

    const serialized = JSON.stringify(harness.local.set.mock.calls);
    expect(serialized).not.toContain("session-secret");
    expect(serialized).not.toContain("provider.example");
    expect(serialized).not.toContain("测试用户甲");
    expect(serialized).not.toContain("报告中未列为线索的用户乙");
    expect(serialized).not.toContain("帖子正文中的测试内容");
    const loaded = await loadThreadCloudCache(identity);
    expect(loaded?.status).toBe("success");
    if (loaded?.status === "success") {
      expect(loaded.result.findings[0]?.participantNames).toEqual([]);
      expect(loaded.result.findings[0]?.evidence[0]?.excerpt).toBe("");
      expect(loaded.usage?.inputTokens).toBe(123);
    }
    await expect(
      loadThreadCloudBillingReceipt(identity.snapshotId),
    ).resolves.toMatchObject({
      attemptId: entry.attemptId,
      status: "success",
      sentAt: entry.sentAt,
    });
  });

  it("persists classified before-send and after-send failures without free-form error text", async () => {
    createStorageHarness();
    const identity = threadCloudCacheIdentity(session(), settings);
    const before: ThreadCloudCacheEntry = {
      ...identity,
      status: "failed_before_send",
      attemptId: "before",
      startedAt: "2026-07-28T03:02:00.000Z",
      updatedAt: "2026-07-28T03:02:00.000Z",
      completedAt: "2026-07-28T03:02:00.000Z",
      sentAt: null,
      deadlineAt: null,
      error: { category: "configuration", code: "missing_api_key" },
    };
    await saveThreadCloudCache(before);
    expect(threadCloudCacheRequiresPaidRetryConfirmation(before)).toBe(false);
    await expect(
      loadThreadCloudBillingReceipt(identity.snapshotId),
    ).resolves.toMatchObject({
      attemptId: "before",
      status: "failed_before_send",
      sentAt: null,
    });

    const after: ThreadCloudCacheEntry = {
      ...identity,
      status: "failed_after_send",
      attemptId: "after",
      startedAt: "2026-07-28T03:02:00.000Z",
      updatedAt: "2026-07-28T03:05:01.000Z",
      completedAt: "2026-07-28T03:05:01.000Z",
      sentAt: "2026-07-28T03:02:01.000Z",
      deadlineAt: "2026-07-28T03:05:01.000Z",
      error: { category: "timeout", code: "provider_timeout" },
    };
    await saveThreadCloudCache(after);
    expect(threadCloudCacheRequiresPaidRetryConfirmation(after)).toBe(true);
    await expect(loadThreadCloudCache(identity)).resolves.toEqual(after);
    await expect(
      loadThreadCloudBillingReceipt(identity.snapshotId),
    ).resolves.toMatchObject({
      attemptId: "after",
      status: "sent",
      sentAt: after.sentAt,
    });
  });

  it("fails closed when an exact local cache is malformed", async () => {
    const entry = runningEntry();
    createStorageHarness({
      local: {
        [threadCloudCacheV3StorageKey(entry.analysisKey)]: {
          ...entry,
          deadlineAt: null,
        },
      },
    });

    await expect(loadThreadCloudCache(entry)).rejects.toThrow("damaged");
  });

  it("fails closed when an exact cache key contains another identity", async () => {
    const expected = runningEntry();
    const mismatched = {
      ...expected,
      snapshotId: threadCloudCacheIdentity(
        session({ title: "另一个快照" }),
        settings,
      ).snapshotId,
    };
    createStorageHarness({
      local: {
        [threadCloudCacheV3StorageKey(expected.analysisKey)]: mismatched,
      },
    });

    await expect(loadThreadCloudCache(expected)).rejects.toThrow("mismatched");
  });

  it("restores success and running state when session storage was cleared", async () => {
    const harness = createStorageHarness();
    const running = runningEntry();
    const successIdentity = threadCloudCacheIdentity(session(), {
      ...settings,
      model: "qwen3.7-max-success",
    });
    const success: ThreadCloudCacheEntry = {
      ...successIdentity,
      status: "success",
      attemptId: "attempt-success",
      startedAt: "2026-07-28T03:02:00.000Z",
      updatedAt: "2026-07-28T03:04:00.000Z",
      sentAt: "2026-07-28T03:02:01.000Z",
      deadlineAt: "2026-07-28T03:05:01.000Z",
      completedAt: "2026-07-28T03:04:00.000Z",
      error: null,
      result: result(),
    };

    await saveThreadCloudCache(running);
    await saveThreadCloudCache(success);
    harness.session.storage.clear();

    await expect(loadThreadCloudCache(running)).resolves.toEqual(running);
    await expect(loadThreadCloudCache(successIdentity)).resolves.toMatchObject({
      status: "success",
      attemptId: "attempt-success",
    });
  });

  it("migrates an exact v3 session entry into local storage", async () => {
    const entry = runningEntry();
    const key = threadCloudCacheV3StorageKey(entry.analysisKey);
    const harness = createStorageHarness({ session: { [key]: entry } });

    await expect(loadThreadCloudCache(entry)).resolves.toEqual(entry);

    expect(harness.local.storage.get(key)).toEqual(entry);
    expect(harness.session.storage.has(key)).toBe(false);
    const receiptKey = threadCloudBillingReceiptStorageKey(entry.snapshotId);
    expect(harness.local.storage.get(receiptKey)).toMatchObject({
      attemptId: entry.attemptId,
      status: "sent",
    });
    expect(harness.local.set).toHaveBeenCalledWith({
      [key]: entry,
      [receiptKey]: expect.objectContaining({
        attemptId: entry.attemptId,
        status: "sent",
      }),
    });
    expect(harness.session.remove).toHaveBeenCalledWith(key);
  });

  it("finds the newest sent marker for a snapshot across analysis keys", async () => {
    const first = runningEntry();
    const newerIdentity = threadCloudCacheIdentity(session(), {
      ...settings,
      model: "qwen-new-version",
    });
    const newer: ThreadCloudCacheEntry = {
      ...newerIdentity,
      status: "unknown_after_disconnect",
      attemptId: "deleted-report-marker",
      startedAt: "2026-07-28T03:02:00.000Z",
      updatedAt: "2026-07-28T03:06:00.000Z",
      sentAt: "2026-07-28T03:02:01.000Z",
      deadlineAt: "2026-07-28T03:05:01.000Z",
      completedAt: "2026-07-28T03:06:00.000Z",
      error: { category: "storage", code: "history_deleted" },
    };
    createStorageHarness({
      local: {
        [threadCloudCacheV3StorageKey(first.analysisKey)]: first,
        [threadCloudCacheV3StorageKey(newer.analysisKey)]: newer,
        unrelated: { snapshotId: first.snapshotId },
      },
    });

    await expect(
      loadLatestThreadCloudCacheForSnapshot(first.snapshotId),
    ).resolves.toEqual(newer);
  });

  it("includes a cross-analysis-key preparing claim in snapshot scans", async () => {
    const preparing = preparingEntry("another-model", "other-key-preparing");
    createStorageHarness({
      local: {
        [threadCloudCacheV3StorageKey(preparing.analysisKey)]: preparing,
      },
    });

    await expect(
      loadLatestThreadCloudCacheForSnapshot(preparing.snapshotId),
    ).resolves.toEqual(preparing);
  });

  it("keeps a sent marker visible after analyzer, rules, and transport upgrades", async () => {
    const currentIdentity = threadCloudCacheIdentity(session(), settings);
    const oldVersionMarker = {
      ...currentIdentity,
      analyzerVersion: "2.9.0",
      rulesVersion: "2025.12",
      transportVersion: "sidepanel-v2",
      status: "unknown_after_disconnect",
      attemptId: "old-version-sent-marker",
      startedAt: "2026-07-28T03:02:00.000Z",
      updatedAt: "2026-07-28T03:06:00.000Z",
      sentAt: "2026-07-28T03:02:01.000Z",
      deadlineAt: "2026-07-28T03:05:01.000Z",
      completedAt: "2026-07-28T03:06:00.000Z",
      error: { category: "storage", code: "history_deleted" },
    };
    createStorageHarness({
      local: {
        [threadCloudCacheV3StorageKey(currentIdentity.analysisKey)]:
          oldVersionMarker,
      },
    });

    await expect(loadThreadCloudCache(currentIdentity)).rejects.toThrow(
      "mismatched",
    );
    await expect(
      loadLatestThreadCloudCacheForSnapshot(currentIdentity.snapshotId),
    ).resolves.toEqual(oldVersionMarker);
  });

  it("fails closed for a damaged strict billing receipt", async () => {
    const harness = createStorageHarness();
    const entry = runningEntry();
    await saveThreadCloudCache(entry);
    const receiptKey = threadCloudBillingReceiptStorageKey(entry.snapshotId);
    harness.local.storage.set(receiptKey, {
      ...(harness.local.storage.get(receiptKey) as Record<string, unknown>),
      threadId: "must-not-be-stored",
    });

    await expect(
      loadThreadCloudBillingReceipt(entry.snapshotId),
    ).rejects.toThrow("damaged");
  });

  it("fails closed when any v3 cache-prefix item is damaged or key-mismatched", async () => {
    const entry = runningEntry();
    const harness = createStorageHarness({
      local: {
        [threadCloudCacheV3StorageKey(entry.analysisKey)]: entry,
      },
    });
    const damagedIdentity = threadCloudCacheIdentity(session(), {
      ...settings,
      model: "damaged-prefix",
    });
    harness.local.storage.set(
      threadCloudCacheV3StorageKey(damagedIdentity.analysisKey),
      { ...damagedIdentity, status: "running" },
    );

    await expect(
      loadLatestThreadCloudCacheForSnapshot(entry.snapshotId),
    ).rejects.toThrow("damage");

    harness.local.storage.delete(
      threadCloudCacheV3StorageKey(damagedIdentity.analysisKey),
    );
    harness.local.storage.set(
      `${threadCloudCacheV3StorageKey(entry.analysisKey)}0`,
      entry,
    );
    await expect(
      loadLatestThreadCloudCacheForSnapshot(entry.snapshotId),
    ).rejects.toThrow("mismatched");
  });

  it("serializes same-snapshot claims across module contexts", async () => {
    const harness = createStorageHarness();
    const lockTails = new Map<string, Promise<void>>();
    const request = vi.fn(
      async (
        name: string,
        _options: { mode: string },
        callback: () => Promise<unknown>,
      ) => {
        const previous = lockTails.get(name) ?? Promise.resolve();
        const result = previous.then(callback, callback);
        lockTails.set(
          name,
          result.then(
            () => undefined,
            () => undefined,
          ),
        );
        return result;
      },
    );
    vi.stubGlobal("navigator", { locks: { request } });
    vi.resetModules();
    const contextA = await import("./threadCloudCache");
    vi.resetModules();
    const contextB = await import("./threadCloudCache");
    const first = preparingEntry("claim-model-a", "claim-attempt-a");
    const second = preparingEntry("claim-model-b", "claim-attempt-b");

    const outcomes = await Promise.all([
      contextA.claimThreadCloudAnalysisStart(first),
      contextB.claimThreadCloudAnalysisStart(second),
    ]);

    expect(outcomes.filter((outcome) => outcome === null)).toHaveLength(1);
    const winner = outcomes[0] === null ? first : second;
    const blocked = outcomes[0] === null ? outcomes[1] : outcomes[0];
    expect(blocked).toMatchObject({
      attemptId: winner.attemptId,
      status: "preparing",
    });
    expect(
      harness.local.storage.get(
        threadCloudBillingReceiptStorageKey(first.snapshotId),
      ),
    ).toMatchObject({ attemptId: winner.attemptId, status: "preparing" });
    expect(
      [...harness.local.storage.keys()].filter((key) =>
        key.startsWith("kr_whole_thread_cloud_v3_"),
      ),
    ).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("allows a new claim after before-send failure and force-overrides sent", async () => {
    createStorageHarness();
    const first = preparingEntry("claim-a", "claim-a");
    const second = preparingEntry("claim-b", "claim-b");
    const forced = preparingEntry("claim-c", "claim-c");
    await expect(claimThreadCloudAnalysisStart(first)).resolves.toBeNull();
    await expect(claimThreadCloudAnalysisStart(second)).resolves.toMatchObject({
      attemptId: first.attemptId,
      status: "preparing",
    });
    await saveThreadCloudCache({
      ...first,
      status: "failed_before_send",
      completedAt: "2026-07-28T03:02:02.000Z",
      updatedAt: "2026-07-28T03:02:02.000Z",
      error: { category: "configuration", code: "before_send" },
    });
    await expect(claimThreadCloudAnalysisStart(second)).resolves.toBeNull();
    await saveThreadCloudCache({
      ...second,
      status: "running",
      updatedAt: "2026-07-28T03:02:03.000Z",
      sentAt: "2026-07-28T03:02:03.000Z",
      deadlineAt: "2026-07-28T03:05:03.000Z",
    });
    await expect(
      claimThreadCloudAnalysisStart(forced, { force: true }),
    ).resolves.toBeNull();
    await expect(
      loadThreadCloudBillingReceipt(first.snapshotId),
    ).resolves.toMatchObject({
      attemptId: forced.attemptId,
      status: "preparing",
    });
  });

  it("records a deleted history as a durable terminal receipt", async () => {
    createStorageHarness();
    const identity = threadCloudCacheIdentity(session(), settings);
    await saveThreadCloudCache({
      ...identity,
      status: "unknown_after_disconnect",
      attemptId: "deleted-history-attempt",
      startedAt: "2026-07-28T03:02:00.000Z",
      updatedAt: "2026-07-28T03:06:00.000Z",
      sentAt: "2026-07-28T03:02:01.000Z",
      deadlineAt: "2026-07-28T03:05:01.000Z",
      completedAt: "2026-07-28T03:06:00.000Z",
      error: { category: "storage", code: "history_deleted" },
    });

    await expect(
      loadThreadCloudBillingReceipt(identity.snapshotId),
    ).resolves.toMatchObject({
      attemptId: "deleted-history-attempt",
      status: "history_deleted",
    });
  });

  it("clears cache copies but deliberately retains the billing receipt", async () => {
    const entry = runningEntry();
    const v3Key = threadCloudCacheV3StorageKey(entry.analysisKey);
    const v2Key = threadCloudCacheStorageKey(42);
    const harness = createStorageHarness({
      local: { [v2Key]: {} },
      session: { [v3Key]: entry, [v2Key]: {} },
    });
    await saveThreadCloudCache(entry);
    const receiptKey = threadCloudBillingReceiptStorageKey(entry.snapshotId);

    await clearThreadCloudCache(entry);
    await clearThreadCloudCache(42);

    for (const area of [harness.local, harness.session]) {
      expect(area.storage.has(v3Key)).toBe(false);
      expect(area.storage.has(v2Key)).toBe(false);
      expect(area.remove).toHaveBeenCalledWith(v3Key);
      expect(area.remove).toHaveBeenCalledWith(v2Key);
    }
    expect(harness.local.storage.has(receiptKey)).toBe(true);
    await expect(
      loadThreadCloudBillingReceipt(entry.snapshotId),
    ).resolves.toMatchObject({ attemptId: entry.attemptId, status: "sent" });
  });
});

describe("whole-thread cloud cache v2 migration", () => {
  function legacyBase() {
    return {
      tabId: 42,
      threadId: "99000000001",
      sessionUpdatedAt: "2026-07-28T03:00:00.000Z",
      endpoint: settings.endpoint,
      model: settings.model,
      mode: settings.mode,
      analyzerVersion: "2.3.0",
      transportVersion: "sidepanel-v1",
    };
  }

  it("reads an exact legacy success but rejects a different snapshot identity", async () => {
    createStorageHarness({
      session: {
        [threadCloudCacheStorageKey(42)]: {
          ...legacyBase(),
          status: "success",
          result: result(),
        },
      },
    });

    await expect(
      loadLegacyThreadCloudSuccess(session(), settings),
    ).resolves.toMatchObject({ status: "success" });
    await expect(
      loadLegacyThreadCloudSuccess(
        session({ updatedAt: "2026-07-28T03:00:01.000Z" }),
        settings,
      ),
    ).resolves.toBeNull();
  });

  it("converts exact legacy pending to unknown and never starts a request", async () => {
    const harness = createStorageHarness({
      session: {
        [threadCloudCacheStorageKey(42)]: {
          ...legacyBase(),
          status: "pending",
          startedAt: "2026-07-28T03:02:00.000Z",
        },
      },
    });

    const migrated = await migrateLegacyThreadCloudPendingToUnknown(
      session(),
      settings,
      "migrated-attempt",
    );

    expect(migrated).toMatchObject({
      status: "unknown_after_disconnect",
      sentAt: "2026-07-28T03:02:00.000Z",
      error: { category: "disconnect", code: "legacy_pending_unknown" },
    });
    expect(harness.local.set).toHaveBeenCalledTimes(1);
    expect(harness.session.get).toHaveBeenCalledTimes(1);
  });
});
