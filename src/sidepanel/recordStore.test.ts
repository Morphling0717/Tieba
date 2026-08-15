import { afterEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_VERSION } from "../types";
import type { ReviewRecord } from "../types";
import {
  loadCloudSettings,
  loadStoredRecords,
  saveCloudSettings,
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
});

describe("cloud settings storage boundary", () => {
  it("stores endpoint/model locally but keeps the API key in session storage", async () => {
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
      endpoint: "https://provider.example/v1",
      model: "model-1",
      apiKey: "session-secret",
      mode: "deep",
    });

    expect(localSet).toHaveBeenCalledWith({
      kr_cloud_settings_v1: {
        provider: "alibaba",
        endpoint: "https://provider.example/v1",
        model: "model-1",
        mode: "deep",
        autoAnalyzeWholeThread: true,
      },
    });
    expect(JSON.stringify(localSet.mock.calls)).not.toContain("session-secret");
    expect(sessionSet).toHaveBeenCalledWith({
      kr_cloud_api_key_v1: "session-secret",
    });
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

  it("clears an unsafe endpoint left by an older version", async () => {
    const localSet = vi.fn().mockResolvedValue(undefined);
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
        },
        session: {
          get: vi.fn().mockResolvedValue({ kr_cloud_api_key_v1: "session-only" }),
        },
      },
    });

    await expect(loadCloudSettings()).resolves.toEqual({
      provider: "alibaba",
      endpoint: "",
      model: "model-1",
      apiKey: "session-only",
      mode: "fast",
      autoAnalyzeWholeThread: true,
    });
    expect(localSet).toHaveBeenCalledWith({
      kr_cloud_settings_v1: {
        provider: "alibaba",
        endpoint: "",
        model: "model-1",
        mode: "fast",
        autoAnalyzeWholeThread: true,
      },
    });
  });

  it("loads an older cloud setting without a mode as fast mode", async () => {
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({
            kr_cloud_settings_v1: {
              endpoint: "https://provider.example/v1",
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
      provider: "alibaba",
      endpoint: "https://provider.example/v1",
      model: "model-1",
      apiKey: "session-only",
      mode: "fast",
      autoAnalyzeWholeThread: true,
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
      endpoint: "https://provider.example/v1",
      model: "model-1",
      apiKey: "session-secret",
      mode: "fast",
      autoAnalyzeWholeThread: false,
    });

    expect(localSet).toHaveBeenCalledWith({
      kr_cloud_settings_v1: {
        provider: "alibaba",
        endpoint: "https://provider.example/v1",
        model: "model-1",
        mode: "fast",
        autoAnalyzeWholeThread: false,
      },
    });
  });

  it("infers DeepSeek for legacy settings and never moves its key to local storage", async () => {
    const localSet = vi.fn().mockResolvedValue(undefined);
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
        },
        session: {
          get: vi.fn().mockResolvedValue({
            kr_cloud_api_key_v1: "deepseek-session-key",
          }),
        },
      },
    });

    await expect(loadCloudSettings()).resolves.toEqual({
      provider: "deepseek",
      endpoint: "https://api.deepseek.com/chat/completions",
      model: "deepseek-v4-pro",
      apiKey: "deepseek-session-key",
      mode: "deep",
      autoAnalyzeWholeThread: true,
    });
    expect(JSON.stringify(localSet.mock.calls)).not.toContain(
      "deepseek-session-key",
    );
  });
});
