import { describe, expect, it, vi } from "vitest";
import {
  CLOUD_ANALYSIS_PORT_NAME,
  installCloudAnalysisBroker,
  type CloudBrokerRequest,
  type CloudBrokerResponse,
} from "./cloudBroker";
import {
  CloudAnalysisError,
  analyzeWholeThreadWithCloud,
  deepAnalyzeFinding,
  type CloudAnalysisResult,
  type WholeThreadCloudAnalysisResult,
} from "./lib/cloud";
import { PERSISTENT_CLOUD_PERMISSION_ORIGINS } from "./lib/cloudPermission";
import type { CapturedReply, Finding } from "./types";

class FakeEvent<T extends (...args: never[]) => void> {
  listeners: T[] = [];
  addListener(listener: T): void {
    this.listeners.push(listener);
  }
  emit(...args: Parameters<T>): void {
    for (const listener of this.listeners) listener(...args);
  }
}

class FakePort {
  name = CLOUD_ANALYSIS_PORT_NAME;
  onMessage = new FakeEvent<(message: CloudBrokerRequest) => void>();
  onDisconnect = new FakeEvent<() => void>();
  responses: CloudBrokerResponse[] = [];
  postMessage(message: CloudBrokerResponse): void {
    this.responses.push(message);
  }
}

const reply: CapturedReply = {
  id: "r1",
  siteReplyId: "r1",
  floor: 1,
  parentReplyId: null,
  authorName: "用户甲",
  time: null,
  timestamp: null,
  content: "测试回复",
  sourcePage: 1,
  sourceUrl: "https://tieba.baidu.com/p/1",
  anchor: "#r1",
  imageCount: 0,
  isNested: false,
  unexpandedNestedCount: 0,
};

const finding: Finding = {
  id: "f1",
  type: "provocation",
  severity: "medium",
  score: 60,
  summary: "测试线索",
  replyIds: ["r1"],
  participantNames: ["用户甲"],
  evidence: [],
  reasonCandidates: [],
  uncertainties: [],
};

const result: CloudAnalysisResult = {
  summary: "需人工复核",
  type: "provocation",
  score: 60,
  replyIds: ["r1"],
  evidence: [],
  reasonCandidates: [],
  uncertainties: [],
};

const wholeThreadResult: WholeThreadCloudAnalysisResult = {
  summary: "整帖中有一处需要人工复核",
  findings: [finding],
  uncertainties: [],
  analyzedReplyCount: 1,
  ruleCount: 112,
  omittedImageCount: 0,
};

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

function harness(options: {
  granted?: boolean;
  removeResult?: boolean;
  storedLeases?: unknown[];
  storedGuards?: unknown[];
  analyze?: typeof deepAnalyzeFinding;
  analyzeWholeThread?: typeof analyzeWholeThreadWithCloud;
  now?: () => Date;
} = {}) {
  const onConnect = new FakeEvent<(port: FakePort) => void>();
  const onAdded = new FakeEvent<(permissions: { origins?: string[] }) => void>();
  const storage = new Map<string, unknown>();
  storage.set("kr_cloud_permission_leases_v1", options.storedLeases ?? []);
  storage.set(
    "kr_cloud_permission_late_grant_guards_v1",
    options.storedGuards ?? [],
  );
  const events: string[] = [];
  let granted = options.granted ?? true;
  const contains = vi.fn(async () => granted);
  const remove = vi.fn(async () => {
    events.push("remove");
    const removed = options.removeResult ?? true;
    if (removed) granted = false;
    return removed;
  });
  const analyze = vi.fn(
    options.analyze ??
      (async () => {
        events.push("analyze");
        return result;
      }),
  );
  const analyzeWholeThread = vi.fn(
    options.analyzeWholeThread ??
      (async () => {
        events.push("analyzeWholeThread");
        return wholeThreadResult;
      }),
  );
  const broker = installCloudAnalysisBroker(
    {
      runtime: { onConnect },
      permissions: { contains, remove, onAdded },
      storage: {
        async get(keys) {
          const requested = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(requested.map((key) => [key, storage.get(key)]));
        },
        async set(items) {
          for (const [key, value] of Object.entries(items)) storage.set(key, value);
        },
      },
    },
    { analyze, analyzeWholeThread, now: options.now },
  );
  return {
    analyze,
    analyzeWholeThread,
    broker,
    contains,
    events,
    onAdded,
    onConnect,
    remove,
    setGranted(value: boolean) {
      granted = value;
    },
    storage,
  };
}

function prepareAndStart(port: FakePort): void {
  port.onMessage.emit({
    type: "CLOUD_PERMISSION_PREPARE",
    requestId: "request-1",
    endpoint: "https://api.example.com/v1",
  });
  port.onMessage.emit({
    type: "CLOUD_ANALYSIS_START",
    requestId: "request-1",
    endpoint: "https://api.example.com/v1",
    model: "model",
    apiKey: "session-key",
    finding,
    replies: [reply],
  });
}

describe("cloud analysis background broker", () => {
  it("固定百炼权限用一次整帖消息返回结果，且绝不写入租约或撤销权限", async () => {
    const fixedEndpoint =
      "https://ws-7ee35od4h2zs6dft.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
    const state = harness();
    const port = new FakePort();
    state.onConnect.emit(port);

    port.onMessage.emit({
      type: "CLOUD_PERMISSION_PREPARE",
      requestId: "whole-thread-1",
      endpoint: fixedEndpoint,
    });
    port.onMessage.emit({
      type: "CLOUD_WHOLE_THREAD_ANALYSIS_START",
      requestId: "whole-thread-1",
      endpoint: fixedEndpoint,
      model: "qwen3.7-max",
      apiKey: "session-key",
      mode: "fast",
      threadTitle: "测试帖子",
      replies: [reply],
    });

    await eventually(() =>
      expect(state.analyzeWholeThread).toHaveBeenCalledOnce(),
    );
    await eventually(() =>
      expect(port.responses).toContainEqual({
        type: "CLOUD_WHOLE_THREAD_ANALYSIS_RESULT",
        requestId: "whole-thread-1",
        result: wholeThreadResult,
      }),
    );
    expect(state.analyzeWholeThread).toHaveBeenCalledWith(
      "测试帖子",
      [reply],
      expect.objectContaining({
        endpoint: fixedEndpoint,
        model: "qwen3.7-max",
        apiKey: "session-key",
        mode: "fast",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(state.contains).toHaveBeenCalledWith({
      origins: [PERSISTENT_CLOUD_PERMISSION_ORIGINS[0]],
    });
    expect(state.remove).not.toHaveBeenCalled();
    expect(
      state.storage.get("kr_cloud_permission_late_grant_guards_v1"),
    ).toEqual([]);
    expect(state.storage.get("kr_cloud_permission_leases_v1")).toEqual([]);
    expect(state.analyze).not.toHaveBeenCalled();
  });

  it("固定百炼权限缺失时拒绝整帖正文，且不会尝试 request/remove 绕过", async () => {
    const fixedEndpoint =
      "https://ws-7ee35od4h2zs6dft.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
    const state = harness({ granted: false });
    const port = new FakePort();
    state.onConnect.emit(port);

    port.onMessage.emit({
      type: "CLOUD_PERMISSION_PREPARE",
      requestId: "whole-thread-no-permission",
      endpoint: fixedEndpoint,
    });
    port.onMessage.emit({
      type: "CLOUD_WHOLE_THREAD_ANALYSIS_START",
      requestId: "whole-thread-no-permission",
      endpoint: fixedEndpoint,
      model: "qwen3.7-max",
      apiKey: "session-key",
      threadTitle: "测试帖子",
      replies: [reply],
    });

    await eventually(() =>
      expect(port.responses).toContainEqual({
        type: "CLOUD_ANALYSIS_ERROR",
        requestId: "whole-thread-no-permission",
        error: "未授予该 AI 端点的网络权限",
        code: "permission_missing",
      }),
    );
    expect(state.analyzeWholeThread).not.toHaveBeenCalled();
    expect(state.remove).not.toHaveBeenCalled();
    expect(
      state.storage.get("kr_cloud_permission_late_grant_guards_v1"),
    ).toEqual([]);
    expect(state.storage.get("kr_cloud_permission_leases_v1")).toEqual([]);
  });

  it("启动恢复会丢弃旧数据中伪造的固定权限清理标记", async () => {
    const state = harness({
      storedLeases: [
        {
          requestId: "must-not-revoke-fixed",
          origin: PERSISTENT_CLOUD_PERMISSION_ORIGINS[0],
          guardUntil: "2026-07-22T10:05:00.000Z",
        },
      ],
      storedGuards: [
        {
          requestId: "must-not-guard-fixed",
          origin: PERSISTENT_CLOUD_PERMISSION_ORIGINS[0],
          guardUntil: "2026-07-22T10:05:00.000Z",
        },
      ],
    });

    await expect(state.broker.getCleanupStatus()).resolves.toBeNull();
    expect(state.remove).not.toHaveBeenCalled();
    expect(state.storage.get("kr_cloud_permission_leases_v1")).toEqual([]);
    expect(
      state.storage.get("kr_cloud_permission_late_grant_guards_v1"),
    ).toEqual([]);
  });

  it("PREPARE 持久化最小 late-grant guard，未 START 断连后仍保留", async () => {
    const now = () => new Date("2026-07-22T10:00:00.000Z");
    const state = harness({ granted: false, now });
    const port = new FakePort();
    state.onConnect.emit(port);

    port.onMessage.emit({
      type: "CLOUD_PERMISSION_PREPARE",
      requestId: "request-guard-1",
      endpoint: "https://api.example.com/v1?api-version=2026-01",
    });

    await eventually(() => {
      expect(
        state.storage.get("kr_cloud_permission_late_grant_guards_v1"),
      ).toEqual([
        {
          requestId: "request-guard-1",
          origin: "https://api.example.com/*",
          guardUntil: "2026-07-22T10:05:00.000Z",
        },
      ]);
    });
    const serialized = JSON.stringify(
      state.storage.get("kr_cloud_permission_late_grant_guards_v1"),
    );
    expect(serialized).not.toMatch(
      /endpoint|api-version|apiKey|session-key|测试回复|replies/u,
    );

    port.onDisconnect.emit();
    await eventually(() => expect(state.contains).toHaveBeenCalled());
    expect(
      state.storage.get("kr_cloud_permission_late_grant_guards_v1"),
    ).toHaveLength(1);
    expect(state.storage.get("kr_cloud_permission_leases_v1")).toEqual([]);
  });

  it("未 START 的 CANCEL 同样保留 guard 等待迟到授权", async () => {
    const state = harness({ granted: false });
    const port = new FakePort();
    state.onConnect.emit(port);
    port.onMessage.emit({
      type: "CLOUD_PERMISSION_PREPARE",
      requestId: "request-cancelled",
      endpoint: "https://api.example.com/v1",
    });
    await eventually(() =>
      expect(
        state.storage.get("kr_cloud_permission_late_grant_guards_v1"),
      ).toHaveLength(1),
    );

    port.onMessage.emit({
      type: "CLOUD_ANALYSIS_CANCEL",
      requestId: "request-cancelled",
    });

    await eventually(() => expect(state.contains).toHaveBeenCalled());
    expect(
      state.storage.get("kr_cloud_permission_late_grant_guards_v1"),
    ).toHaveLength(1);
    expect(state.analyze).not.toHaveBeenCalled();
  });

  it("正常授权的 onAdded 不会抢在仍连接的请求 START 前撤权", async () => {
    const state = harness();
    const port = new FakePort();
    state.onConnect.emit(port);
    port.onMessage.emit({
      type: "CLOUD_PERMISSION_PREPARE",
      requestId: "request-normal-grant",
      endpoint: "https://api.example.com/v1",
    });
    await eventually(() =>
      expect(
        state.storage.get("kr_cloud_permission_late_grant_guards_v1"),
      ).toHaveLength(1),
    );

    state.onAdded.emit({ origins: ["https://api.example.com/"] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(state.broker.getCleanupStatus()).resolves.toBeNull();
    expect(state.remove).not.toHaveBeenCalled();

    port.onMessage.emit({
      type: "CLOUD_ANALYSIS_START",
      requestId: "request-normal-grant",
      endpoint: "https://api.example.com/v1",
      model: "model",
      apiKey: "session-key",
      finding,
      replies: [reply],
    });
    await eventually(() => expect(state.analyze).toHaveBeenCalledOnce());
    await eventually(() =>
      expect(port.responses).toContainEqual({
        type: "CLOUD_ANALYSIS_RESULT",
        requestId: "request-normal-grant",
        result,
      }),
    );
  });

  it("START 接管后用 active marker 替换 guard，再在完成后全部清除", async () => {
    let finish!: (value: CloudAnalysisResult) => void;
    const state = harness({
      analyze: async () =>
        await new Promise<CloudAnalysisResult>((resolve) => {
          finish = resolve;
        }),
    });
    const port = new FakePort();
    state.onConnect.emit(port);

    prepareAndStart(port);

    await eventually(() => expect(state.analyze).toHaveBeenCalledOnce());
    expect(
      state.storage.get("kr_cloud_permission_late_grant_guards_v1"),
    ).toEqual([]);
    expect(state.storage.get("kr_cloud_permission_leases_v1")).toEqual([
      {
        requestId: "request-1",
        origin: "https://api.example.com/*",
        guardUntil: expect.any(String),
      },
    ]);

    finish(result);
    await eventually(() =>
      expect(state.storage.get("kr_cloud_permission_leases_v1")).toEqual([]),
    );
  });

  it("将确认时冻结的分析模式传给云端分析器", async () => {
    const state = harness();
    const port = new FakePort();
    state.onConnect.emit(port);
    port.onMessage.emit({
      type: "CLOUD_PERMISSION_PREPARE",
      requestId: "request-mode",
      endpoint: "https://api.example.com/v1",
    });
    port.onMessage.emit({
      type: "CLOUD_ANALYSIS_START",
      requestId: "request-mode",
      endpoint: "https://api.example.com/v1",
      model: "qwen3.7-max",
      apiKey: "session-key",
      mode: "deep",
      finding,
      replies: [reply],
    });

    await eventually(() => expect(state.analyze).toHaveBeenCalledOnce());
    expect(state.analyze.mock.calls[0]?.[2]).toMatchObject({
      model: "qwen3.7-max",
      mode: "deep",
    });
  });

  it("onAdded 回收侧栏销毁后才授予的域名权限", async () => {
    const state = harness({ granted: false });
    const port = new FakePort();
    state.onConnect.emit(port);
    port.onMessage.emit({
      type: "CLOUD_PERMISSION_PREPARE",
      requestId: "request-late-grant",
      endpoint: "https://api.example.com/v1",
    });
    await eventually(() =>
      expect(
        state.storage.get("kr_cloud_permission_late_grant_guards_v1"),
      ).toHaveLength(1),
    );
    port.onDisconnect.emit();
    await eventually(() => expect(state.contains).toHaveBeenCalled());

    state.setGranted(true);
    state.onAdded.emit({ origins: ["https://api.example.com/"] });

    await eventually(() => {
      expect(state.remove).toHaveBeenCalledWith({
        origins: ["https://api.example.com/*"],
      });
      expect(
        state.storage.get("kr_cloud_permission_late_grant_guards_v1"),
      ).toEqual([]);
    });
    await expect(state.broker.getCleanupStatus()).resolves.toBeNull();
  });

  it("late-grant 撤权失败时保留 guard 并暴露清理错误", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const state = harness({ granted: false, removeResult: false });
    const port = new FakePort();
    state.onConnect.emit(port);
    port.onMessage.emit({
      type: "CLOUD_PERMISSION_PREPARE",
      requestId: "request-late-failure",
      endpoint: "https://api.example.com/v1",
    });
    await eventually(() =>
      expect(
        state.storage.get("kr_cloud_permission_late_grant_guards_v1"),
      ).toHaveLength(1),
    );
    port.onDisconnect.emit();
    await eventually(() => expect(state.contains).toHaveBeenCalled());

    state.setGranted(true);
    state.onAdded.emit({ origins: ["https://api.example.com/*"] });

    await eventually(() =>
      expect(
        state.storage.get("kr_cloud_permission_cleanup_errors_v1"),
      ).toMatchObject({
        "https://api.example.com/*": expect.stringContaining("未能撤销"),
      }),
    );
    expect(
      state.storage.get("kr_cloud_permission_late_grant_guards_v1"),
    ).toHaveLength(1);
    await expect(state.broker.getCleanupStatus()).resolves.toContain(
      "https://api.example.com/*",
    );
  });

  it("过期 guard 只在下一次安全时机惰性清理", async () => {
    const state = harness({
      granted: false,
      now: () => new Date("2026-07-22T10:00:00.000Z"),
      storedGuards: [
        {
          requestId: "expired-guard",
          origin: "https://api.example.com/*",
          guardUntil: "2026-07-22T09:59:59.000Z",
          endpoint: "https://api.example.com/v1?api_key=must-not-survive",
        },
      ],
    });

    await expect(state.broker.getCleanupStatus()).resolves.toBeNull();

    expect(
      state.storage.get("kr_cloud_permission_late_grant_guards_v1"),
    ).toEqual([]);
    expect(state.remove).not.toHaveBeenCalled();
    expect(JSON.stringify([...state.storage.values()])).not.toContain(
      "must-not-survive",
    );
  });

  it("在返回结果前由后台撤销临时域名权限", async () => {
    const state = harness();
    const port = new FakePort();
    const originalPost = port.postMessage.bind(port);
    port.postMessage = (message) => {
      state.events.push("post");
      originalPost(message);
    };
    state.onConnect.emit(port);

    prepareAndStart(port);

    await eventually(() => {
      expect(port.responses).toContainEqual({
        type: "CLOUD_ANALYSIS_RESULT",
        requestId: "request-1",
        result,
      });
    });
    expect(state.events).toEqual(["analyze", "remove", "post"]);
    expect(state.remove).toHaveBeenCalledWith({
      origins: ["https://api.example.com/*"],
    });
    expect(state.storage.get("kr_cloud_permission_leases_v1")).toEqual([]);
  });

  it("云端超时后先撤销临时权限，再返回明确错误且不重试", async () => {
    const state = harness({
      analyze: async () => {
        throw new CloudAnalysisError(
          "云端分析超过 90 秒，已停止；本地结果仍保留。",
          "timeout",
        );
      },
    });
    const port = new FakePort();
    const originalPost = port.postMessage.bind(port);
    port.postMessage = (message) => {
      state.events.push("post");
      originalPost(message);
    };
    state.onConnect.emit(port);

    prepareAndStart(port);

    await eventually(() => {
      expect(port.responses).toContainEqual({
        type: "CLOUD_ANALYSIS_ERROR",
        requestId: "request-1",
        error: "云端分析超过 90 秒，已停止；本地结果仍保留。",
        code: "timeout",
      });
    });
    expect(state.events).toEqual(["remove", "post"]);
    expect(state.analyze).toHaveBeenCalledOnce();
    expect(state.storage.get("kr_cloud_permission_leases_v1")).toEqual([]);
    expect(
      state.storage.get("kr_cloud_permission_late_grant_guards_v1"),
    ).toEqual([]);
  });

  it("侧栏连接断开时中止请求并撤销权限", async () => {
    let signal: AbortSignal | undefined;
    const state = harness({
      analyze: async (_finding, _replies, config) => {
        signal = config.signal;
        return await new Promise<CloudAnalysisResult>((_resolve, reject) => {
          config.signal?.addEventListener("abort", () => {
            reject(new CloudAnalysisError("已取消", "cancelled"));
          });
        });
      },
    });
    const port = new FakePort();
    state.onConnect.emit(port);
    prepareAndStart(port);
    await eventually(() => expect(state.analyze).toHaveBeenCalledOnce());

    port.onDisconnect.emit();

    await eventually(() => expect(state.remove).toHaveBeenCalledOnce());
    expect(signal?.aborted).toBe(true);
    expect(port.responses).toEqual([]);
    expect(state.storage.get("kr_cloud_permission_leases_v1")).toEqual([]);
  });

  it("permissions.remove=false 会返回可见错误并保留重试标记", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const state = harness({ removeResult: false });
    const port = new FakePort();
    state.onConnect.emit(port);

    prepareAndStart(port);

    await eventually(() => {
      expect(port.responses[0]).toMatchObject({
        type: "CLOUD_ANALYSIS_ERROR",
        requestId: "request-1",
        code: "permission_cleanup",
      });
    });
    await expect(state.broker.getCleanupStatus()).resolves.toContain(
      "https://api.example.com/*",
    );
    const durableLease = state.storage.get("kr_cloud_permission_leases_v1");
    expect(durableLease).toEqual([
      {
        requestId: "request-1",
        origin: "https://api.example.com/*",
        guardUntil: expect.any(String),
      },
    ]);
    // This object is intentionally safe for chrome.storage.local: the marker
    // survives a full browser restart but never persists API keys or replies.
    expect(JSON.stringify(durableLease)).not.toMatch(
      /session-key|测试回复|apiKey|replies|endpoint|\/v1/u,
    );
  });

  it("后台 worker 重启时回收上次留下的 lease", async () => {
    const state = harness({
      storedLeases: [
        {
          requestId: "stale",
          endpoint: "https://api.example.com/v1",
          origin: "https://api.example.com/*",
          createdAt: "2026-07-22T00:00:00.000Z",
        },
      ],
    });

    await expect(state.broker.getCleanupStatus()).resolves.toBeNull();

    expect(state.remove).toHaveBeenCalledOnce();
    expect(state.storage.get("kr_cloud_permission_leases_v1")).toEqual([]);
  });

  it("旧版 lease 撤权失败时也会剥离完整 endpoint", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const state = harness({
      removeResult: false,
      storedLeases: [
        {
          requestId: "stale-secret",
          endpoint: "https://api.example.com/v1?api_key=must-not-persist",
          origin: "https://api.example.com/*",
          createdAt: "2026-07-22T00:00:00.000Z",
        },
      ],
    });

    await expect(state.broker.getCleanupStatus()).resolves.toContain(
      "https://api.example.com/*",
    );
    const durableLease = state.storage.get("kr_cloud_permission_leases_v1");
    expect(durableLease).toEqual([
      {
        requestId: "stale-secret",
        origin: "https://api.example.com/*",
        guardUntil: expect.any(String),
      },
    ]);
    expect(JSON.stringify(durableLease)).not.toContain("must-not-persist");
  });
});
