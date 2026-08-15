import { afterEach, describe, expect, it, vi } from "vitest";
import {
  endpointPermissionPattern,
  ExtensionRequestError,
  PersistentCloudPermissionRequiredError,
  requestPersistentCloudPermission,
  runManagedCloudAnalysis,
  runManagedWholeThreadCloudAnalysis,
  sendExtensionMessage,
} from "./bridge";
import type { CloudBrokerRequest, CloudBrokerResponse } from "../cloudBroker";
import type {
  CloudAnalysisResult,
  WholeThreadCloudAnalysisResult,
} from "../lib/cloud";
import { PERSISTENT_CLOUD_PERMISSION_ORIGINS } from "../lib/cloudPermission";
import type { CapturedReply, Finding } from "../types";

afterEach(() => vi.unstubAllGlobals());

describe("endpointPermissionPattern", () => {
  it("requests only the selected HTTPS host", () => {
    expect(endpointPermissionPattern("https://api.example.com/v1/chat/completions"))
      .toBe("https://api.example.com/*");
  });

  it("normalizes local endpoints without persisting a port-specific pattern", () => {
    expect(endpointPermissionPattern("http://127.0.0.1:11434/v1"))
      .toBe("http://127.0.0.1/*");
  });
});

describe("requestPersistentCloudPermission", () => {
  it("在调用返回前同步请求当前 DeepSeek 精确 origin", () => {
    let resolvePermission!: (granted: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      resolvePermission = resolve;
    });
    const request = vi.fn(() => pending);
    vi.stubGlobal("chrome", { permissions: { request } });

    const result = requestPersistentCloudPermission(
      "https://api.deepseek.com/chat/completions",
    );

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({
      origins: ["https://api.deepseek.com/*"],
    });
    resolvePermission(true);
    return expect(result).resolves.toBe(true);
  });

  it("拒绝为自定义整帖端点申请宽泛权限", () => {
    const request = vi.fn();
    vi.stubGlobal("chrome", { permissions: { request } });

    expect(() =>
      requestPersistentCloudPermission("https://api.example.com/v1"),
    ).toThrow("仅支持已固定授权");
    expect(request).not.toHaveBeenCalled();
  });
});

describe("sendExtensionMessage", () => {
  it("preserves a structured background error code", async () => {
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn().mockResolvedValue({
          ok: false,
          error: "未获得百度贴吧页面读取权限",
          code: "TIEBA_PERMISSION_MISSING",
        }),
      },
    });

    const promise = sendExtensionMessage({ type: "CAPTURE_ACTIVE_PAGE" });
    await expect(promise).rejects.toBeInstanceOf(ExtensionRequestError);
    await expect(promise).rejects.toMatchObject({
      code: "TIEBA_PERMISSION_MISSING",
    });
  });
});

const reply: CapturedReply = {
  id: "r1",
  siteReplyId: "r1",
  floor: 1,
  parentReplyId: null,
  authorName: "用户甲",
  time: null,
  timestamp: null,
  content: "测试",
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
  summary: "测试",
  replyIds: ["r1"],
  participantNames: ["用户甲"],
  evidence: [],
  reasonCandidates: [],
  uncertainties: [],
};
const cloudResult: CloudAnalysisResult = {
  summary: "需复核",
  type: "provocation",
  score: 60,
  replyIds: ["r1"],
  evidence: [],
  reasonCandidates: [],
  uncertainties: [],
};
const wholeThreadCloudResult: WholeThreadCloudAnalysisResult = {
  summary: "整帖中有一处需要复核",
  findings: [finding],
  uncertainties: [],
  analyzedReplyCount: 1,
  ruleCount: 112,
  omittedImageCount: 0,
};

describe("runManagedCloudAnalysis", () => {
  it("固定百炼域名只核对既有权限，不 request/remove", async () => {
    const events: string[] = [];
    const messageListeners: Array<(message: CloudBrokerResponse) => void> = [];
    const port = {
      onMessage: {
        addListener(listener: (message: CloudBrokerResponse) => void) {
          messageListeners.push(listener);
        },
      },
      onDisconnect: { addListener: vi.fn() },
      postMessage(message: CloudBrokerRequest) {
        events.push(message.type);
        if (message.type === "CLOUD_ANALYSIS_START") {
          queueMicrotask(() => {
            for (const listener of messageListeners) {
              listener({
                type: "CLOUD_ANALYSIS_RESULT",
                requestId: message.requestId,
                result: cloudResult,
              });
            }
          });
        }
      },
      disconnect: vi.fn(),
    };
    const contains = vi.fn(async () => {
      events.push("permissions.contains");
      return true;
    });
    const request = vi.fn();
    const remove = vi.fn();
    vi.stubGlobal("chrome", {
      runtime: { connect: vi.fn(() => port) },
      permissions: { contains, request, remove },
    });

    await expect(
      runManagedCloudAnalysis(finding, [reply], {
        endpoint:
          "https://ws-7ee35od4h2zs6dft.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        model: "qwen3.7-max",
        apiKey: "session-key",
        beforeStart: async () => {
          events.push("beforeStart");
        },
      }),
    ).resolves.toEqual(cloudResult);

    expect(events).toEqual([
      "CLOUD_PERMISSION_PREPARE",
      "permissions.contains",
      "beforeStart",
      "CLOUD_ANALYSIS_START",
    ]);
    expect(contains).toHaveBeenCalledWith({
      origins: [PERSISTENT_CLOUD_PERMISSION_ORIGINS[0]],
    });
    expect(request).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("先向后台声明 lease，再由确认点击申请权限并发起请求", async () => {
    const events: string[] = [];
    const starts: Array<Extract<CloudBrokerRequest, { type: "CLOUD_ANALYSIS_START" }>> = [];
    const messageListeners: Array<(message: CloudBrokerResponse) => void> = [];
    const disconnectListeners: Array<() => void> = [];
    const port = {
      onMessage: {
        addListener(listener: (message: CloudBrokerResponse) => void) {
          messageListeners.push(listener);
        },
      },
      onDisconnect: {
        addListener(listener: () => void) {
          disconnectListeners.push(listener);
        },
      },
      postMessage(message: CloudBrokerRequest) {
        events.push(message.type);
        if (message.type === "CLOUD_ANALYSIS_START") {
          starts.push(message);
          queueMicrotask(() => {
            for (const listener of messageListeners) {
              listener({
                type: "CLOUD_ANALYSIS_RESULT",
                requestId: message.requestId,
                result: cloudResult,
              });
            }
          });
        }
      },
      disconnect: vi.fn(),
    };
    const request = vi.fn(async () => {
      events.push("permissions.request");
      return true;
    });
    vi.stubGlobal("chrome", {
      runtime: { connect: vi.fn(() => port) },
      permissions: { request },
    });

    const promise = runManagedCloudAnalysis(finding, [reply], {
      endpoint: "https://api.example.com/v1",
      model: "model",
      apiKey: "session-key",
      mode: "deep",
      beforeStart: async () => {
        events.push("beforeStart");
      },
    });

    expect(events).toEqual([
      "CLOUD_PERMISSION_PREPARE",
      "permissions.request",
    ]);
    await expect(promise).resolves.toEqual(cloudResult);
    expect(events).toEqual([
      "CLOUD_PERMISSION_PREPARE",
      "permissions.request",
      "beforeStart",
      "CLOUD_ANALYSIS_START",
    ]);
    expect(request).toHaveBeenCalledWith({
      origins: ["https://api.example.com/*"],
    });
    expect(port.disconnect).toHaveBeenCalled();
    expect(starts).toHaveLength(1);
    expect(starts[0]?.mode).toBe("deep");
  });

  it("权限被拒绝时只取消 lease，不启动云端请求", async () => {
    const sent: CloudBrokerRequest[] = [];
    const port = {
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
      postMessage(message: CloudBrokerRequest) {
        sent.push(message);
      },
      disconnect: vi.fn(),
    };
    vi.stubGlobal("chrome", {
      runtime: { connect: vi.fn(() => port) },
      permissions: { request: vi.fn().mockResolvedValue(false) },
    });

    await expect(
      runManagedCloudAnalysis(finding, [reply], {
        endpoint: "https://api.example.com/v1",
        model: "model",
        apiKey: "session-key",
      }),
    ).rejects.toThrow("未授予");

    expect(sent.map((message) => message.type)).toEqual([
      "CLOUD_PERMISSION_PREPARE",
      "CLOUD_ANALYSIS_CANCEL",
    ]);
  });

  it("预览后的会话校验失效时不会发送云端正文", async () => {
    const sent: CloudBrokerRequest[] = [];
    const port = {
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
      postMessage(message: CloudBrokerRequest) {
        sent.push(message);
      },
      disconnect: vi.fn(),
    };
    vi.stubGlobal("chrome", {
      runtime: { connect: vi.fn(() => port) },
      permissions: {
        request: vi.fn().mockResolvedValue(true),
        remove: vi.fn().mockResolvedValue(true),
        contains: vi.fn().mockResolvedValue(false),
      },
    });

    await expect(
      runManagedCloudAnalysis(finding, [reply], {
        endpoint: "https://api.example.com/v1",
        model: "model",
        apiKey: "session-key",
        beforeStart: async () => {
          throw new Error("帖子内容已更新，请重新预检");
        },
      }),
    ).rejects.toThrow("帖子内容已更新");

    expect(sent.map((message) => message.type)).toEqual([
      "CLOUD_PERMISSION_PREPARE",
      "CLOUD_ANALYSIS_CANCEL",
    ]);
  });

  it("切页中止后权限弹窗才允许时会撤销迟到的授权", async () => {
    const sent: CloudBrokerRequest[] = [];
    let resolvePermission!: (granted: boolean) => void;
    const permission = new Promise<boolean>((resolve) => {
      resolvePermission = resolve;
    });
    const remove = vi.fn().mockResolvedValue(true);
    const contains = vi.fn().mockResolvedValue(false);
    const port = {
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
      postMessage(message: CloudBrokerRequest) {
        sent.push(message);
      },
      disconnect: vi.fn(),
    };
    vi.stubGlobal("chrome", {
      runtime: { connect: vi.fn(() => port) },
      permissions: {
        request: vi.fn(() => permission),
        remove,
        contains,
      },
    });
    const controller = new AbortController();
    const analysis = runManagedCloudAnalysis(finding, [reply], {
      endpoint: "https://api.example.com/v1",
      model: "model",
      apiKey: "session-key",
      signal: controller.signal,
    });

    controller.abort();
    resolvePermission(true);

    await expect(analysis).rejects.toThrow("云端请求已取消");
    expect(sent.map((message) => message.type)).toEqual([
      "CLOUD_PERMISSION_PREPARE",
      "CLOUD_ANALYSIS_CANCEL",
    ]);
    expect(remove).toHaveBeenCalledWith({
      origins: ["https://api.example.com/*"],
    });
    expect(contains).toHaveBeenCalledWith({
      origins: ["https://api.example.com/*"],
    });
  });
});

describe("runManagedWholeThreadCloudAnalysis", () => {
  it("用固定权限在侧栏直接分析一次整帖，不连接后台或 request/remove", async () => {
    const events: string[] = [];
    const controller = new AbortController();
    const analyze = vi.fn(async () => {
      events.push("analyze");
      return wholeThreadCloudResult;
    });
    const connect = vi.fn();
    const contains = vi.fn(async () => {
      events.push("permissions.contains");
      return true;
    });
    const request = vi.fn();
    const remove = vi.fn();
    vi.stubGlobal("chrome", {
      runtime: { connect },
      permissions: { contains, request, remove },
    });

    const analysis = runManagedWholeThreadCloudAnalysis("测试帖子", [reply], {
      endpoint:
        "https://ws-7ee35od4h2zs6dft.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      model: "qwen3.7-max",
      apiKey: "session-key",
      mode: "fast",
      signal: controller.signal,
      beforeStart: async () => {
        events.push("beforeStart");
      },
      analyze,
    });

    await expect(analysis).resolves.toEqual(wholeThreadCloudResult);
    expect(events).toEqual([
      "permissions.contains",
      "beforeStart",
      "analyze",
    ]);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(analyze).toHaveBeenCalledWith(
      "测试帖子",
      [reply],
      expect.objectContaining({
        endpoint:
          "https://ws-7ee35od4h2zs6dft.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        model: "qwen3.7-max",
        apiKey: "session-key",
        mode: "fast",
        signal: controller.signal,
      }),
    );
    expect(contains).toHaveBeenCalledWith({
      origins: [PERSISTENT_CLOUD_PERMISSION_ORIGINS[0]],
    });
    expect(connect).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("固定权限尚未生效时不调用分析器，也不连接后台或 request/remove", async () => {
    const analyze = vi.fn();
    const beforeStart = vi.fn();
    const connect = vi.fn();
    const request = vi.fn();
    const remove = vi.fn();
    vi.stubGlobal("chrome", {
      runtime: { connect },
      permissions: {
        contains: vi.fn().mockResolvedValue(false),
        request,
        remove,
      },
    });

    await expect(
      runManagedWholeThreadCloudAnalysis("不得发送的标题", [reply], {
        endpoint:
          "https://ws-7ee35od4h2zs6dft.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        model: "qwen3.7-max",
        apiKey: "session-key",
        beforeStart,
        analyze,
      }),
    ).rejects.toBeInstanceOf(PersistentCloudPermissionRequiredError);

    expect(analyze).not.toHaveBeenCalled();
    expect(beforeStart).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("DeepSeek 固定域名也可在侧栏直接分析整帖", async () => {
    const analyze = vi.fn().mockResolvedValue(wholeThreadCloudResult);
    const contains = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("chrome", {
      runtime: { connect: vi.fn() },
      permissions: {
        contains,
        request: vi.fn(),
        remove: vi.fn(),
      },
    });

    await expect(
      runManagedWholeThreadCloudAnalysis("测试帖子", [reply], {
        endpoint: "https://api.deepseek.com/chat/completions",
        model: "deepseek-v4-pro",
        apiKey: "session-key",
        mode: "deep",
        analyze,
      }),
    ).resolves.toEqual(wholeThreadCloudResult);

    expect(contains).toHaveBeenCalledWith({
      origins: ["https://api.deepseek.com/*"],
    });
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it("拒绝把自动整帖分析发往未在清单固定的临时端点，且零权限/网络请求", async () => {
    const connect = vi.fn();
    const contains = vi.fn();
    const request = vi.fn();
    const remove = vi.fn();
    const analyze = vi.fn();
    const beforeStart = vi.fn();
    vi.stubGlobal("chrome", {
      runtime: { connect },
      permissions: {
        contains,
        request,
        remove,
      },
    });

    await expect(
      runManagedWholeThreadCloudAnalysis("测试帖子", [reply], {
        endpoint: "https://api.example.com/v1",
        model: "model",
        apiKey: "session-key",
        beforeStart,
        analyze,
      }),
    ).rejects.toThrow("仅支持已固定授权");
    expect(contains).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
    expect(beforeStart).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("beforeStart 校验失败或 signal 已取消时都不会调用分析器", async () => {
    const endpoint =
      "https://ws-7ee35od4h2zs6dft.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
    const analyze = vi.fn();
    const connect = vi.fn();
    vi.stubGlobal("chrome", {
      runtime: { connect },
      permissions: {
        contains: vi.fn().mockResolvedValue(true),
        request: vi.fn(),
        remove: vi.fn(),
      },
    });

    await expect(
      runManagedWholeThreadCloudAnalysis("测试帖子", [reply], {
        endpoint,
        model: "qwen3.7-max",
        apiKey: "session-key",
        beforeStart: async () => {
          throw new Error("帖子内容已更新，请重新预检");
        },
        analyze,
      }),
    ).rejects.toThrow("帖子内容已更新");

    const controller = new AbortController();
    controller.abort();
    await expect(
      runManagedWholeThreadCloudAnalysis("测试帖子", [reply], {
        endpoint,
        model: "qwen3.7-max",
        apiKey: "session-key",
        signal: controller.signal,
        analyze,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(analyze).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });
});
