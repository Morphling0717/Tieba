import { afterEach, describe, expect, it, vi } from "vitest";
import { REASON_CATEGORIES, REASON_RULES } from "../data/reasons";
import type { CapturedReply, Finding } from "../types";
import {
  analyzeWholeThreadWithCloud,
  buildCloudPayload,
  buildWholeThreadCloudPayload,
  deepAnalyzeFinding,
} from "./cloud";

function reply(
  id: string,
  authorName: string,
  content: string,
  overrides: Partial<CapturedReply> = {},
): CapturedReply {
  return {
    id,
    siteReplyId: id,
    floor: Number(id.replace(/\D/g, "")) || null,
    parentReplyId: null,
    authorName,
    time: "2026-07-22 12:00",
    timestamp: Date.parse("2026-07-22T12:00:00+08:00"),
    content,
    sourcePage: 1,
    sourceUrl: "https://tieba.baidu.com/p/123",
    anchor: `#post-${id}`,
    imageCount: 0,
    isNested: false,
    unexpandedNestedCount: 0,
    ...overrides,
  };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F-personal-r2",
    type: "personal_attack",
    severity: "high",
    score: 78,
    summary: "吧友乙攻击吧友甲",
    replyIds: ["r2"],
    participantNames: ["吧友甲", "吧友乙"],
    evidence: [
      {
        replyId: "r2",
        excerpt: "@\u5427\u53cb\u7532 请不要辱骂",
        signals: ["辱骂"],
        score: 78,
      },
    ],
    reasonCandidates: [
      { reasonId: "R03.01", confidence: 0.9, rationale: "匹配辱骂" },
    ],
    uncertainties: [],
    ...overrides,
  };
}

const replies = [
  reply("r1", "吧友甲", "我发表一个观点"),
  reply("r2", "吧友乙", "@\u5427\u53cb\u7532 联系我 13812345678，你说得太离谱", {
    parentReplyId: "r1",
    imageCount: 2,
    isNested: true,
  }),
  reply("r3", "吧友丙", "请两位冷静"),
];

function wholeThreadReplies(): CapturedReply[] {
  const baseTimestamp = Date.parse("2026-07-22T12:00:00+08:00");
  return Array.from({ length: 134 }, (_, index) => {
    const floor = index + 1;
    const mainId = `main-${floor}`;
    const mainAuthor = `银河测试员${String(floor).padStart(3, "0")}`;
    const nestedAuthor = `月面回复者${String(floor).padStart(3, "0")}`;
    const main = reply(
      mainId,
      mainAuthor,
      floor === 1
        ? `联系 ${nestedAuthor}：13812345678，邮箱 danger@example.com，身份证 11010519491231002X`
        : `${mainAuthor} 对第 ${floor} 楼的正常观点`,
      {
        floor,
        timestamp: baseTimestamp + index * 120_000,
        time: `2026-07-22 12:${String(index % 60).padStart(2, "0")}`,
        imageCount: floor === 1 ? 2 : 0,
      },
    );
    const nested = reply(
      `nested-${floor}`,
      nestedAuthor,
      floor === 1
        ? `回复 ${mainAuthor}：QQ 12345678，微信:abc_123，请勿公开这些资料`
        : `回复 ${mainAuthor}：这是第 ${floor} 楼的楼中楼`,
      {
        floor,
        parentReplyId: mainId,
        timestamp: baseTimestamp + index * 120_000 + 60_000,
        time: `2026-07-22 12:${String((index + 1) % 60).padStart(2, "0")}`,
        isNested: true,
      },
    );
    return [main, nested];
  }).flat();
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("cloud analysis protocol", () => {
  it("sends only minimal anonymized text fields and nearby context", () => {
    const payload = buildCloudPayload(finding(), replies);
    const serialized = JSON.stringify(payload);

    expect(payload.replies.map((item) => item.id)).toEqual(["r1", "r2", "r3"]);
    expect(payload.replies.map((item) => item.authorAlias)).toEqual(["U1", "U2", "U3"]);
    expect(serialized).not.toMatch(/吧友甲|吧友乙|吧友丙|13812345678/u);
    expect(payload.replies[1]?.content).toContain("[\u624b\u673a\u53f7]");
    expect(payload.replies[1]).not.toHaveProperty("imageCount");
    expect(payload.replies[1]).not.toHaveProperty("sourceUrl");
    expect(payload.limitations).toContain("图片未发送且未识别。");
  });

  it("makes one request and filters hallucinated or context-only reply IDs", async () => {
    const providerResult = {
      summary: "U2 的表达需要人工复核",
      type: "personal_attack",
      score: 80,
      replyIds: ["r2", "r1", "invented-id"],
      evidence: [
        { replyId: "r2", explanation: "存在针对性贬损" },
        { replyId: "r1", explanation: "上下文，不是选中证据" },
        { replyId: "invented-id", explanation: "应被丢弃" },
      ],
      reasonCandidates: [
        { reasonId: "R03.01", confidence: 0.91, rationale: "规范直接匹配" },
        { reasonId: "R99.99", confidence: 1, rationale: "并不存在" },
      ],
      uncertainties: ["可能存在反讽"],
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(providerResult) } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await deepAnalyzeFinding(finding(), replies, {
      endpoint: "https://provider.test/v1",
      model: "example-model",
      apiKey: "session-only-key",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://provider.test/v1/chat/completions",
    );
    expect(result.replyIds).toEqual(["r2"]);
    expect(result.evidence).toEqual([
      { replyId: "r2", explanation: "存在针对性贬损" },
    ]);
    expect(result.reasonCandidates.map((item) => item.reasonId)).toEqual([
      "R03.01",
    ]);

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.body).not.toContain("吧友甲");
    expect(request.body).not.toContain("吧友乙");
    expect(JSON.parse(String(request.body))).not.toHaveProperty("enable_thinking");
  });

  it("disables Qwen thinking by default and can explicitly enable deep mode", async () => {
    const providerResult = {
      summary: "需要人工复核",
      type: "personal_attack",
      score: 80,
      replyIds: ["r2"],
      evidence: [{ replyId: "r2", explanation: "存在针对性表达" }],
      reasonCandidates: [],
      uncertainties: [],
    };
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(providerResult) } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const endpoint =
      "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";

    await deepAnalyzeFinding(finding(), replies, {
      endpoint,
      model: "qwen3.7-max",
      apiKey: "session-only-key",
    });
    await deepAnalyzeFinding(finding(), replies, {
      endpoint,
      model: "qwen3.7-max",
      apiKey: "session-only-key",
      mode: "deep",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `${endpoint}/chat/completions`,
    );
    const fastBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as Record<string, unknown>;
    const deepBody = JSON.parse(
      String((fetchMock.mock.calls[1]?.[1] as RequestInit).body),
    ) as Record<string, unknown>;
    expect(fastBody).toMatchObject({
      model: "qwen3.7-max",
      enable_thinking: false,
      stream: false,
      response_format: { type: "json_object" },
    });
    expect(deepBody.enable_thinking).toBe(true);
  });

  it("does not send a Qwen-only field to a look-alike provider hostname", async () => {
    const providerResult = {
      summary: "需要人工复核",
      type: "none",
      score: 0,
      replyIds: [],
      evidence: [],
      reasonCandidates: [],
      uncertainties: [],
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(providerResult) } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await deepAnalyzeFinding(finding(), replies, {
      endpoint: "https://maas.aliyuncs.com.evil.test/v1",
      model: "qwen3.7-max",
      apiKey: "session-only-key",
    });

    const body = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as Record<string, unknown>;
    expect(body).not.toHaveProperty("enable_thinking");
  });

  it("classifies its own deadline as timeout without retrying", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const analysis = deepAnalyzeFinding(finding(), replies, {
      endpoint: "https://provider.test/v1",
      model: "example-model",
      apiKey: "session-only-key",
      timeoutMs: 1_000,
    });
    const rejection = expect(analysis).rejects.toMatchObject({
      code: "timeout",
      message: "云端分析超过 1 秒，已停止；本地结果仍保留。",
    });
    await vi.advanceTimersByTimeAsync(1_000);

    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("classifies an in-flight page change as cancellation", async () => {
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const analysis = deepAnalyzeFinding(finding(), replies, {
      endpoint: "https://provider.test/v1",
      model: "example-model",
      apiKey: "session-only-key",
      signal: controller.signal,
    });
    controller.abort("thread changed");

    await expect(analysis).rejects.toMatchObject({ code: "cancelled" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a failed provider request", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      deepAnalyzeFinding(finding(), replies, {
        endpoint: "https://provider.test/v1",
        model: "example-model",
        apiKey: "session-only-key",
      }),
    ).rejects.toMatchObject({ code: "network" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not call fetch when the external signal was already aborted", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort("thread changed");

    await expect(
      deepAnalyzeFinding(finding(), replies, {
        endpoint: "https://provider.test/v1",
        model: "example-model",
        apiKey: "session-only-key",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("whole-thread cloud analysis protocol", () => {
  it("builds one privacy-safe 268-reply payload with all 112 versioned rules", () => {
    const allReplies = wholeThreadReplies();
    const payload = buildWholeThreadCloudPayload(
      allReplies,
      "银河测试员001 与月面回复者001 的帖子，电话 13812345678",
    );
    const serialized = JSON.stringify(payload);

    expect(allReplies).toHaveLength(268);
    expect(payload.replies).toHaveLength(268);
    expect(payload.rules).toHaveLength(112);
    expect(new Set(payload.rules.map((rule) => rule.category))).toHaveProperty(
      "size",
      16,
    );
    expect(payload.rules).toEqual(
      REASON_RULES.map((rule) => ({
        id: rule.id,
        category: rule.categoryTitle,
        text: rule.text,
      })),
    );
    expect(REASON_CATEGORIES).toHaveLength(16);

    expect(payload.replies[0]).toMatchObject({
      id: "P1",
      floor: 1,
      parentReplyId: null,
      authorAlias: "U1",
      minuteOffset: 0,
      isNested: false,
    });
    expect(payload.replies[1]).toMatchObject({
      id: "P2",
      floor: 1,
      parentReplyId: "P1",
      authorAlias: "U2",
      minuteOffset: 1,
      isNested: true,
    });
    expect(payload.replies[267]).toMatchObject({
      id: "P268",
      parentReplyId: "P267",
      isNested: true,
    });

    expect(payload.threadTitle).toBe("U1 与U2 的帖子，电话 [手机号]");
    expect(payload.replies[0]?.content).toContain("[手机号]");
    expect(payload.replies[0]?.content).toContain("[邮箱]");
    expect(payload.replies[0]?.content).toContain("[身份证]");
    expect(payload.replies[1]?.content).toContain("[QQ号]");
    expect(payload.replies[1]?.content).toContain("[微信号]");
    expect(serialized).not.toMatch(
      /银河测试员|月面回复者|13812345678|danger@example\.com|11010519491231002X|12345678|abc_123/u,
    );
    expect(serialized).not.toContain("main-1");
    expect(serialized).not.toContain("nested-1");
    expect(payload.replies[0]).not.toHaveProperty("sourceUrl");
    expect(payload.replies[0]).not.toHaveProperty("sourcePage");
    expect(payload.replies[0]).not.toHaveProperty("anchor");
    expect(payload.replies[0]).not.toHaveProperty("siteReplyId");
    expect(payload.replies[0]).not.toHaveProperty("authorName");
    expect(payload.replies[0]).not.toHaveProperty("time");
    expect(payload.replies[0]).not.toHaveProperty("timestamp");
    expect(payload.replies[0]).not.toHaveProperty("imageCount");
    expect(payload.limitations).toContain("共 2 张图片未发送且未识别。");
  });

  it("sends all replies and rules once in Qwen fast mode and rejects invented IDs", async () => {
    const allReplies = wholeThreadReplies();
    const providerResult = {
      summary: "发现一组需要人工复核的攻击性回复",
      findings: [
        {
          type: "personal_attack",
          severity: "high",
          score: 88,
          summary: "U2 对 U1 使用了攻击性表达",
          offendingReplyIds: ["P2", "invented-reply"],
          contextReplyIds: ["P1", "P2", "invented-context"],
          evidence: [
            { replyId: "P2", explanation: "存在针对性贬损" },
            { replyId: "P1", explanation: "只是被攻击的上下文" },
            { replyId: "invented-reply", explanation: "模型虚构的回复" },
          ],
          primaryReasonId: "R03.01",
          confidence: 0.91,
          rationale: "直接针对具体用户",
          uncertainties: ["需要结合语气复核"],
        },
        {
          type: "spam",
          severity: "medium",
          score: 65,
          summary: "不存在的回复",
          offendingReplyIds: ["P9999"],
          contextReplyIds: [],
          evidence: [],
          primaryReasonId: "R06.05",
          confidence: 0.9,
          rationale: "重复内容",
          uncertainties: [],
        },
        {
          type: "provocation",
          severity: "medium",
          score: 72,
          summary: "模型为同一回复给出的低置信重复判断",
          offendingReplyIds: ["P2"],
          contextReplyIds: ["P1"],
          evidence: [{ replyId: "P2", explanation: "疑似挑衅" }],
          primaryReasonId: "R04.01",
          confidence: 0.4,
          rationale: "低置信重复候选",
          uncertainties: [],
        },
        {
          type: "other",
          severity: "high",
          score: 99,
          summary: "模型虚构的规则",
          offendingReplyIds: ["P4"],
          contextReplyIds: [],
          evidence: [{ replyId: "P4", explanation: "无有效规范依据" }],
          primaryReasonId: "R99.99",
          confidence: 1,
          rationale: "不存在的规则",
          uncertainties: [],
        },
        {
          type: "provocation",
          severity: "low",
          score: 44,
          summary: "P3 可能带有轻微挑衅",
          offendingReplyIds: ["P3"],
          contextReplyIds: ["P1"],
          evidence: [{ replyId: "P3", explanation: "语气可能偏冲" }],
          primaryReasonId: "R04.01",
          confidence: 0.69,
          rationale: "尚不足以认定违规",
          uncertainties: ["P3 也可能只是普通观点交锋"],
        },
      ],
      uncertainties: ["图片没有发送"],
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(providerResult) } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const endpoint =
      "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";

    const result = await analyzeWholeThreadWithCloud(
      "银河测试员001 的整帖",
      allReplies,
      {
        endpoint,
        model: "qwen3.7-max",
        apiKey: "session-only-key",
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `${endpoint}/chat/completions`,
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request).toMatchObject({
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: {
        Authorization: "Bearer session-only-key",
        "Content-Type": "application/json",
      },
    });
    const requestBody = JSON.parse(String(request.body)) as {
      enable_thinking?: boolean;
      stream?: boolean;
      response_format?: { type?: string };
      messages: Array<{ role: string; content: string }>;
    };
    expect(requestBody).toMatchObject({
      enable_thinking: false,
      stream: false,
      max_completion_tokens: 32_768,
      response_format: { type: "json_object" },
    });
    expect(requestBody).not.toHaveProperty("max_tokens");
    const userMessage = JSON.parse(requestBody.messages[1]!.content) as {
      task: string;
      payload: {
        replies: Array<{ id: string; parentReplyId: string | null }>;
        rules: Array<{ id: string }>;
      };
    };
    const systemMessage = requestBody.messages[0]!.content;
    expect(systemMessage).toContain(
      "findings 只允许收录你结合完整上下文后认为很可能违规（confidence 至少 0.70）",
    );
    expect(systemMessage).toContain(
      "最终认为不违规但值得人工留意的内容，只能写入顶层 uncertainties",
    );
    expect(systemMessage).toContain(
      "对虚构角色、角色行为、剧情、设定、战术或计策的激烈负面评价",
    );
    expect(systemMessage).toContain(
      "有实质分析时不得使用 R12.01",
    );
    expect(systemMessage).toContain(
      "演员、导演、编剧、制作人员、创作者、现实粉丝或用户均属于现实人物或现实群体",
    );
    expect(systemMessage).toContain(
      "summary 对违规数量和是否存在违规的表述必须与 findings 完全一致",
    );
    expect(systemMessage).toContain(
      "如果谈及任何具体回复，必须在该句中写出 payload 中真实存在的 P 标识",
    );
    expect(systemMessage).toContain(
      "不得直接写“8楼”、“第 46 楼”之类猜测的楼层数",
    );
    expect(systemMessage).toContain(
      "不得输出、复述或描述隐藏思维链、内部逐步推理、草稿和未公开推理过程",
    );
    expect(systemMessage).toContain(
      "所有顶层键 summary、findings、uncertainties、report 以及 report 的七个子键每次都必须出现",
    );
    expect(systemMessage).toContain(
      "必须都是 JSON 字符串数组（string[]）",
    );
    expect(systemMessage).toContain(
      "不得写成对象、键值表或嵌套数组",
    );
    for (const key of [
      "discussionOverview",
      "discussionMap",
      "participantDynamics",
      "borderlineCases",
      "normalHeatedDiscussion",
      "coverageNotes",
      "reviewPriorities",
    ]) {
      expect(systemMessage).toContain(`"${key}"`);
    }
    expect(userMessage.task).toContain(
      "未达到或最终认为不违规的候选只写入顶层 uncertainties",
    );
    expect(userMessage.task).toContain(
      "先判断每个候选的对象是虚构角色/剧情/计策还是现实人物/用户",
    );
    expect(userMessage.task).toContain(
      "违规组数和结论必须严格等于 findings 的实际内容",
    );
    expect(userMessage.payload.replies).toHaveLength(268);
    expect(userMessage.payload.rules).toHaveLength(112);
    expect(userMessage.payload.replies[1]).toMatchObject({
      id: "P2",
      parentReplyId: "P1",
    });
    expect(request.body).not.toContain("银河测试员");
    expect(request.body).not.toContain("月面回复者");
    expect(request.body).not.toContain("session-only-key");

    expect(result).toMatchObject({
      summary:
        "模型候选经回复关系与协议校验后整理为 1 组，以下方线索卡和原文复核为准。",
      analyzedReplyCount: 268,
      ruleCount: 112,
      omittedImageCount: 2,
    });
    // Providers/cached responses using the previous protocol remain valid.
    expect(result.report).toBeUndefined();
    expect(result.uncertainties).toHaveLength(3);
    expect(result.uncertainties[0]).toBe("图片没有发送");
    expect(result.uncertainties[1]).toContain("低置信线索（未列为违规）");
    expect(result.uncertainties[1]).toContain("第 2 楼");
    expect(result.uncertainties[2]).toContain("第 2 楼");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      type: "personal_attack",
      severity: "high",
      score: 88,
      replyIds: ["nested-1"],
      contextReplyIds: ["main-1"],
      participantNames: ["月面回复者001"],
      reasonCandidates: [
        {
          reasonId: "R03.01",
          confidence: 0.91,
          rationale: "直接针对具体用户",
        },
      ],
      evidence: [
        {
          replyId: "nested-1",
          signals: ["AI：存在针对性贬损"],
          score: 88,
        },
      ],
    });
  });

  it("turns every model P/U reference into a local floor and real username", async () => {
    const localReplies = [
      reply("main-1", "现实用户甲", "这是主楼内容", { floor: 1 }),
      reply("nested-1", "现实用户乙", "你没有思考能力", {
        floor: 1,
        parentReplyId: "main-1",
        isNested: true,
      }),
      reply("main-2", "现实用户乙", "补充说明", { floor: 2 }),
      reply("main-3", "现实用户乙", "第三次出现", { floor: 3 }),
    ];
    const providerResult = {
      summary: "P2 中 U2 针对 U1；P999 与 U999 无法核实",
      findings: [
        {
          type: "personal_attack",
          severity: "high",
          score: 91,
          summary: "U2 在 P2 贬损 U1，另提到 P404 和 U404",
          offendingReplyIds: ["P2", "P999"],
          contextReplyIds: ["P1", "P404"],
          evidence: [
            {
              replyId: "P2",
              explanation: "P2 的作者 U2 对 U1 进行了智力贬损",
            },
            {
              replyId: "P1",
              explanation: "P1 只是上下文，不应成为违规证据",
            },
          ],
          primaryReasonId: "R03.01",
          confidence: 0.95,
          rationale: "P2 是 U2 直接针对 U1 的回复",
          uncertainties: ["需结合 P1；P404、U404 无法定位"],
        },
      ],
      uncertainties: ["还应人工查看 P2、P999 以及 U2、U999"],
      report: {
        discussionOverview: "讨论从 P1 的观点发展到 P2 的冲突。",
        discussionMap: ["P1 提出观点，P2 随后升级措辞。"],
        participantDynamics: ["U2 在 P2 直接针对 U1。"],
        borderlineCases: ["P404 与 U404 无法定位，应人工确认。"],
        normalHeatedDiscussion: ["P1 语气激烈但仍在讨论作品。"],
        coverageNotes: ["P999 当前不可见。"],
        reviewPriorities: ["优先查看 P2，再结合 P1 复核。"],
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(providerResult) } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await analyzeWholeThreadWithCloud(
      "本地引用映射测试",
      localReplies,
      {
        endpoint: "https://provider.test/v1",
        model: "example-model",
        apiKey: "session-only-key",
      },
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.replyIds).toEqual(["nested-1"]);
    expect(result.findings[0]?.contextReplyIds).toEqual(["main-1"]);
    expect(result.findings[0]?.evidence).toHaveLength(1);
    expect(result.findings[0]?.evidence[0]?.replyId).toBe("nested-1");
    expect(result.summary).toBe(
      "模型候选经回复关系与协议校验后整理为 1 组，以下方线索卡和原文复核为准。",
    );
    expect(result.narrativeReferences?.summary.replyIds).toEqual([]);
    expect(result.report).toMatchObject({
      discussionOverview: expect.stringContaining(
        "第 1 楼的楼中楼（用户“现实用户乙”）",
      ),
      discussionMap: [
        expect.stringContaining("第 1 楼（用户“现实用户甲”）"),
      ],
      participantDynamics: [
        expect.stringContaining(
          "用户“现实用户乙”（出现于第 1 楼的楼中楼、第 2 楼）",
        ),
      ],
      borderlineCases: [expect.stringContaining("无法定位的回复")],
      coverageNotes: [expect.stringContaining("无法定位的回复")],
      reviewPriorities: [
        expect.stringContaining(
          "第 1 楼的楼中楼（用户“现实用户乙”）",
        ),
      ],
    });

    const reportText = result.report
      ? [
          result.report.discussionOverview,
          ...result.report.discussionMap,
          ...result.report.participantDynamics,
          ...result.report.borderlineCases,
          ...result.report.normalHeatedDiscussion,
          ...result.report.coverageNotes,
          ...result.report.reviewPriorities,
        ]
      : [];
    const allUserFacingText = [
      result.summary,
      ...result.uncertainties,
      ...reportText,
      ...result.findings.flatMap((item) => [
        item.summary,
        ...item.uncertainties,
        ...item.evidence.flatMap((evidence) => evidence.signals),
        ...item.reasonCandidates.map((reason) => reason.rationale),
      ]),
    ].join("\n");
    expect(allUserFacingText).not.toMatch(/\b[PU]\d+\b/u);
    expect(allUserFacingText).toContain("无法定位的回复");
    expect(allUserFacingText).toContain("无法定位的用户");
  });

  it("normalizes safe Qwen JSON variations without trusting invented IDs or low confidence", async () => {
    const localReplies = [
      reply("main-1", "用户甲", "主楼观点", { floor: 1 }),
      reply("nested-1", "用户乙", "你根本没有思考能力", {
        floor: 1,
        parentReplyId: "main-1",
        isNested: true,
      }),
      reply("main-2", "用户丙", "边界语气", { floor: 2 }),
      reply("main-3", "用户丁", "普通内容", { floor: 3 }),
    ];
    const providerResult = {
      summary: "发现一组需要人工复核的攻击性回复",
      findings: [
        {
          type: "人身攻击",
          severity: "高风险",
          score: "88",
          summary: "用户乙对用户甲进行了智力贬损",
          offendingReplyIds: ["P2", "P9999"],
          // Qwen commonly omits optional empty arrays.
          primaryReasonId: "R03.01",
          confidence: "91%",
          rationale: "直接针对具体用户进行贬损",
          providerExplanation: "这个额外字段应被安全忽略",
        },
        {
          type: "flame-bait",
          severity: "中",
          score: "61",
          summary: "P3 可能只是语气偏冲",
          offendingReplyIds: ["P3"],
          primaryReasonId: "R04.01",
          confidence: "0.69",
          rationale: "尚不足以认定违规",
        },
        {
          type: "刷屏",
          severity: "低",
          score: "55",
          summary: "模型虚构了回复",
          offendingReplyIds: ["P404"],
          primaryReasonId: "R06.05",
          confidence: "0.9",
          rationale: "不存在的回复不能成为证据",
        },
        {
          type: "其他",
          severity: "严重",
          score: "99",
          summary: "模型虚构了规则",
          offendingReplyIds: ["P4"],
          primaryReasonId: "R99.99",
          confidence: "1",
          rationale: "不存在的规则不能采用",
        },
        {
          type: "spam",
          severity: "low",
          score: "50",
          summary: "带空格的近似回复 ID 也不能采用",
          offendingReplyIds: [" P4 "],
          primaryReasonId: "R06.05",
          confidence: "0.9",
          rationale: "只有本地 payload 中的精确 ID 才能成为证据",
        },
      ],
      providerMetadata: { ignored: true },
      report: {
        // DeepSeek/Qwen may serialize empty optional report sections as null
        // or omit them. They remain non-actionable and normalize safely.
        discussionOverview: null,
        participantDynamics: ["P2 由 U2 发布"],
        providerNotes: "ignored",
      },
    };
    const content = ["```json", JSON.stringify(providerResult), "```"].join(
      "\n",
    );
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content,
                reasoning_content:
                  '{"summary":"不得采用推理内容","findings":[]}',
              },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await analyzeWholeThreadWithCloud(
      "兼容格式测试",
      localReplies,
      {
        endpoint: "https://provider.test/v1",
        model: "example-model",
        apiKey: "session-only-key",
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      type: "personal_attack",
      severity: "high",
      score: 88,
      replyIds: ["nested-1"],
      reasonCandidates: [
        {
          reasonId: "R03.01",
          confidence: 0.91,
        },
      ],
    });
    expect(result.findings[0]?.contextReplyIds).toBeUndefined();
    expect(result.findings[0]?.uncertainties).toEqual([]);
    expect(result.findings[0]?.evidence).toEqual([
      expect.objectContaining({
        replyId: "nested-1",
        signals: ["AI：模型标记该回复，需结合前后文人工复核"],
      }),
    ]);
    expect(result.uncertainties).toHaveLength(1);
    expect(result.uncertainties[0]).toContain(
      "低置信线索（未列为违规）",
    );
    expect(result.uncertainties[0]).toContain("第 2 楼");
    expect(result.report).toEqual({
      discussionOverview: "",
      discussionMap: [],
      participantDynamics: [
        "第 1 楼的楼中楼（用户“用户乙”） 由 用户“用户乙”（出现于第 1 楼的楼中楼） 发布",
      ],
      borderlineCases: [],
      normalHeatedDiscussion: [],
      coverageNotes: [],
      reviewPriorities: [],
    });
    expect(
      result.findings.flatMap((item) => item.replyIds),
    ).not.toContain("main-3");
  });

  it("normalizes DeepSeek narrative objects without widening actionable finding fields", async () => {
    const localReplies = [
      reply("main-1", "用户甲", "主楼观点", { floor: 1 }),
      reply("nested-1", "用户乙", "你根本没有思考能力", {
        floor: 1,
        parentReplyId: "main-1",
        isNested: true,
      }),
      reply("main-2", "用户丙", "普通内容", { floor: 2 }),
    ];
    const providerResult = {
      summary: "发现一组需要复核的攻击性回复",
      findings: [
        {
          type: "personal_attack",
          severity: "high",
          score: 88,
          summary: "P2 对 U1 进行智力贬损",
          offendingReplyIds: ["P2"],
          contextReplyIds: ["P1"],
          evidence: [{ replyId: "P2", explanation: "措辞指向具体用户" }],
          primaryReasonId: "R03.01",
          confidence: 0.9,
          rationale: "P2 直接针对 U1",
          uncertainties: [
            {
              text: "P2 的语气仍需结合 P1 复核",
              replyId: "P1",
              // These action-shaped extras must never be interpreted.
              offendingReplyIds: ["P3"],
              primaryReasonId: "R99.99",
            },
          ],
        },
      ],
      uncertainties: [
        "图片没有发送",
        {
          description: "P2 可能含有反讽",
          replyIds: ["P2", "P999"],
        },
        {
          reason: "U2 的语气需要人工判断",
          replyId: "U2",
          arbitraryProviderMetadata: "恶意字段值",
          offendingReplyIds: ["P3"],
          primaryReasonId: "R99.99",
        },
        {
          summary: "P1 与 P2 的上下文需联合查看",
          relatedReplyId: "P1",
          contextReplyIds: ["P2"],
        },
        null,
        42,
        ["不应把嵌套数组当成说明"],
        { note: "带空格的引用不应被归一化", replyId: " P1 " },
      ],
      report: {
        discussionOverview: {
          summary: "讨论由 P1 开始，随后 P2 升级措辞",
          primaryReasonId: "R99.99",
        },
        discussionMap: [
          "P1 提出观点",
          {
            label: "争论阶段",
            note: "P2 回应 P1",
            replyIds: ["P2"],
            offendingReplyIds: ["P3"],
          },
        ],
        participantDynamics: [
          {
            topic: "参与者互动",
            explanation: "U2 回应 U1",
            relatedReplyIds: ["P2"],
            contextReplyId: "P1",
          },
        ],
        borderlineCases: [
          { text: "P999 当前无法定位", replyId: "P999" },
        ],
        normalHeatedDiscussion: [],
        coverageNotes: [{ note: "图片未识别" }],
        reviewPriorities: [
          { label: "优先", reason: "先查看 P2", replyId: "P2" },
        ],
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            { message: { content: JSON.stringify(providerResult) } },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await analyzeWholeThreadWithCloud(
      "DeepSeek 对象兼容测试",
      localReplies,
      {
        endpoint: "https://provider.test/v1",
        model: "example-model",
        apiKey: "session-only-key",
      },
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.replyIds).toEqual(["nested-1"]);
    expect(result.findings[0]?.contextReplyIds).toEqual(["main-1"]);
    expect(result.findings[0]?.reasonCandidates).toEqual([
      expect.objectContaining({ reasonId: "R03.01", confidence: 0.9 }),
    ]);
    expect(result.findings[0]?.uncertainties[0]).toContain(
      "第 1 楼（用户“用户甲”）",
    );
    expect(result.findings[0]?.uncertainties[0]).toContain(
      "第 1 楼的楼中楼（用户“用户乙”）",
    );
    expect(result.uncertainties).toHaveLength(5);
    expect(result.uncertainties[0]).toBe("图片没有发送");
    expect(result.uncertainties[1]).toContain("无法定位的回复");
    expect(result.uncertainties[2]).toContain(
      "用户“用户乙”（出现于第 1 楼的楼中楼）",
    );
    expect(result.uncertainties[3]).toContain(
      "第 1 楼（用户“用户甲”）",
    );
    expect(result.uncertainties[3]).toContain(
      "第 1 楼的楼中楼（用户“用户乙”）",
    );
    expect(result.uncertainties[4]).toBe("有4条格式异常说明已忽略。");
    expect(result.report).toMatchObject({
      discussionOverview: expect.stringContaining(
        "第 1 楼（用户“用户甲”）",
      ),
      discussionMap: [
        expect.stringContaining("第 1 楼（用户“用户甲”）"),
        expect.stringContaining("争论阶段："),
      ],
      participantDynamics: [expect.stringContaining("参与者互动：")],
      borderlineCases: [expect.stringContaining("无法定位的回复")],
      coverageNotes: ["图片未识别"],
      reviewPriorities: [expect.stringContaining("优先：")],
    });

    const allText = JSON.stringify(result);
    expect(allText).not.toContain("R99.99");
    expect(allText).not.toContain("恶意字段值");
    expect(allText).not.toMatch(/\b[PU]\d+\b/u);
    expect(result.findings.flatMap((item) => item.replyIds)).not.toContain(
      "main-2",
    );
  });

  it("ignores unknown-only narrative objects with a safe diagnostic", async () => {
    const providerResult = {
      summary: "未发现违规",
      findings: [],
      uncertainties: [
        {
          attackerControlledSecret: "DO_NOT_ECHO_THIS_VALUE",
          offendingReplyIds: ["P1"],
          primaryReasonId: "R99.99",
        },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            { message: { content: JSON.stringify(providerResult) } },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await analyzeWholeThreadWithCloud(
      "安全诊断测试",
      [reply("main-1", "用户甲", "测试内容", { floor: 1 })],
      {
        endpoint: "https://provider.test/v1",
        model: "example-model",
        apiKey: "session-only-key",
      },
    );

    expect(result.findings).toEqual([]);
    expect(result.uncertainties).toEqual([
      "有1条格式异常说明已忽略。",
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("attackerControlledSecret");
    expect(serialized).not.toContain("DO_NOT_ECHO_THIS_VALUE");
    expect(serialized).not.toContain("R99.99");
  });

  it("safely truncates overlong normalized narrative objects", async () => {
    const providerResult = {
      summary: "未发现违规",
      findings: [],
      uncertainties: [{ note: "测".repeat(501) }],
      report: {
        discussionOverview: "",
        discussionMap: [{ details: "图".repeat(4_001) }],
        participantDynamics: [],
        borderlineCases: [],
        normalHeatedDiscussion: [],
        coverageNotes: [],
        reviewPriorities: [],
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            { message: { content: JSON.stringify(providerResult) } },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await analyzeWholeThreadWithCloud(
      "长度上限测试",
      [reply("main-1", "用户甲", "测试内容", { floor: 1 })],
      {
        endpoint: "https://provider.test/v1",
        model: "example-model",
        apiKey: "session-only-key",
      },
    );

    expect(result.uncertainties[0]).toHaveLength(500);
    expect(result.uncertainties[0]).toMatch(/…$/u);
    expect(result.report?.discussionMap[0]).toHaveLength(4_000);
    expect(result.report?.discussionMap[0]).toMatch(/…$/u);
  });

  it("still rejects an unknown risk alias instead of coercing it into an actionable finding", async () => {
    const providerResult = {
      summary: "模型返回未知风险类型",
      findings: [
        {
          type: "情绪风险",
          severity: "高",
          score: "90",
          summary: "未知分类不应被猜测映射",
          offendingReplyIds: ["P1"],
          primaryReasonId: "R03.01",
          confidence: "0.95",
          rationale: "分类无法确认",
        },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            { message: { content: JSON.stringify(providerResult) } },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      analyzeWholeThreadWithCloud(
        "未知枚举测试",
        [reply("main-1", "用户甲", "测试内容", { floor: 1 })],
        {
          endpoint: "https://provider.test/v1",
          model: "example-model",
          apiKey: "session-only-key",
        },
      ),
    ).rejects.toMatchObject({
      code: "invalid_response",
      message:
        "整帖云端返回结构不符合协议：findings[0].type（枚举值不符）。",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a length-truncated completion before parsing and never falls back to reasoning content", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"summary":"结果尚未输出完整","findings":[',
                reasoning_content: JSON.stringify({
                  summary: "推理字段不是正式输出",
                  findings: [],
                  uncertainties: [],
                }),
              },
              finish_reason: "length",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      analyzeWholeThreadWithCloud(
        "截断测试",
        [reply("main-1", "用户甲", "测试内容", { floor: 1 })],
        {
          endpoint: "https://provider.test/v1",
          model: "example-model",
          apiKey: "session-only-key",
        },
      ),
    ).rejects.toMatchObject({
      code: "invalid_response",
      message: "模型输出达到长度上限，结果不完整，未采用。",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not truncate or call the provider when the whole thread exceeds the safe budget", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const oversizedReply = reply(
      "oversized-main",
      "测试作者",
      "测".repeat(610_000),
      { floor: 1 },
    );

    await expect(
      analyzeWholeThreadWithCloud("超长帖子", [oversizedReply], {
        endpoint:
          "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        model: "qwen3.7-max",
        apiKey: "session-only-key",
      }),
    ).rejects.toMatchObject({ code: "payload_too_large" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exports only locally verified cross-reply relationships", () => {
    const relationReplies = [
      reply("floor-1", "用户甲", "主楼观点", { floor: 1 }),
      reply("floor-2", "用户甲", "相邻但没有回应任何人", { floor: 2 }),
      reply("floor-3", "用户丙", "回复第 1 楼：我不同意", { floor: 3 }),
      reply("floor-4", "用户丁", "@用户甲 你的观点有问题", { floor: 4 }),
      reply("floor-5", "用户戊", "楼上这条需要补充证据", { floor: 5 }),
      reply("nested-1", "用户己", "楼中楼回复", {
        floor: 1,
        parentReplyId: "floor-1",
        isNested: true,
      }),
    ];

    const payload = buildWholeThreadCloudPayload(relationReplies, "关系测试");
    const related = Object.fromEntries(
      payload.replies.map((item) => [item.id, item.relatedReplyIds]),
    );

    expect(related.P1).toEqual(["P3", "P6"]);
    expect(related.P2).toEqual(["P4"]);
    expect(related.P3).toEqual(["P1"]);
    expect(related.P4).toEqual(["P2", "P5"]);
    expect(related.P5).toEqual(["P4"]);
    expect(related.P6).toEqual(["P1"]);
    // Same author and adjacent main floors do not create a relationship.
    expect(related.P1).not.toContain("P2");
  });

  it("splits unrelated offending replies while retaining a verified cross-floor chain", async () => {
    const localReplies = [
      reply("floor-38", "用户甲", "第一个观点", { floor: 38 }),
      reply("floor-40", "用户乙", "回复第 38 楼：你根本不懂", { floor: 40 }),
      reply("floor-43", "用户丙", "@用户乙 这种说法不成立", { floor: 43 }),
      reply("floor-44", "用户丙", "独立发表另一个观点", { floor: 44 }),
      reply("floor-45", "用户戊", "与上述回复无关", { floor: 45 }),
      reply("floor-46", "用户己", "普通上下文", { floor: 46 }),
    ];
    const providerResult = {
      summary: "模型将多条回复合并了",
      findings: [
        {
          type: "personal_attack",
          severity: "high",
          score: 86,
          summary: "P1、P2、P3、P4、P5 构成一组冲突",
          offendingReplyIds: ["P1", "P2", "P3", "P4", "P5"],
          contextReplyIds: ["P6"],
          evidence: ["P1", "P2", "P3", "P4", "P5"].map((replyId) => ({
            replyId,
            explanation: `${replyId} 存在待复核措辞`,
          })),
          primaryReasonId: "R03.01",
          confidence: 0.9,
          rationale: "模型声称五条是同一争吵链",
          uncertainties: [],
        },
      ],
      uncertainties: [],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(providerResult) } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const result = await analyzeWholeThreadWithCloud(
      "无关楼层拆分测试",
      localReplies,
      {
        endpoint: "https://provider.test/v1",
        model: "example-model",
        apiKey: "session-only-key",
      },
    );

    expect(result.findings.map((item) => item.replyIds)).toEqual([
      ["floor-38", "floor-40", "floor-43"],
      ["floor-44"],
      ["floor-45"],
    ]);
    expect(result.summary).toBe(
      "模型候选经回复关系与协议校验后整理为 3 组，以下方线索卡和原文复核为准。",
    );
    expect(result.summary).not.toContain("一组");
    expect(result.narrativeReferences?.summary.text).toBe(result.summary);
    expect(result.findings.every((item) => !item.contextReplyIds)).toBe(true);
    expect(result.findings.every((item) => item.uncertainties.some(
      (note) => note.includes("本地已按可验证关系拆分"),
    ))).toBe(true);
  });

  it("keeps clickable P-id and unique floor references for every narrative field", async () => {
    const localReplies = [
      reply("floor-8", "用户甲", "主回复", { floor: 8 }),
      reply("nested-8", "用户乙", "你根本没有思考能力", {
        floor: 8,
        parentReplyId: "floor-8",
        isNested: true,
      }),
      reply("floor-46", "用户丙", "另一条独立回复", { floor: 46 }),
    ];
    const providerResult = {
      summary: "先复核8楼和第 46 楼；普通数字2026不是引用",
      findings: [
        {
          type: "personal_attack",
          severity: "high",
          score: 90,
          summary: "P2 回应 P1 并贬损现实用户",
          offendingReplyIds: ["P2"],
          contextReplyIds: ["P1"],
          evidence: [
            {
              replyId: "P2",
              explanation: "P2 直接回应 P1；无关的46楼不应带入本项",
            },
          ],
          primaryReasonId: "R03.01",
          confidence: 0.92,
          rationale: "P2 需结合第8楼的父回复复核",
          uncertainties: ["P1 可能影响语气判断"],
        },
      ],
      uncertainties: ["检查 P2、8楼和46楼；编号 1、2026 不是楼层"],
      report: {
        discussionOverview: "P1 之后出现 P2，另有第46楼的独立讨论。",
        discussionMap: ["先看 P2，再看第 46 楼；普通枚举 1、2、3。"],
        participantDynamics: [],
        borderlineCases: [],
        normalHeatedDiscussion: [],
        coverageNotes: [],
        reviewPriorities: ["优先复核 P2 与 P1。"],
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(providerResult) } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const result = await analyzeWholeThreadWithCloud(
      "可点引用测试",
      localReplies,
      {
        endpoint: "https://provider.test/v1",
        model: "example-model",
        apiKey: "session-only-key",
      },
    );
    const references = result.narrativeReferences!;
    const finding = result.findings[0]!;
    const findingReferences = references.findings[finding.id]!;

    expect(references.summary.replyIds).toEqual(["floor-8", "floor-46"]);
    expect(references.uncertainties[0]?.replyIds).toEqual([
      "nested-8",
      "floor-8",
      "floor-46",
    ]);
    expect(references.report?.discussionMap[0]?.replyIds).toEqual([
      "nested-8",
      "floor-46",
    ]);
    expect(findingReferences.summary.replyIds).toEqual([
      "nested-8",
      "floor-8",
    ]);
    expect(findingReferences.rationale.replyIds).toEqual([
      "nested-8",
      "floor-8",
    ]);
    expect(findingReferences.evidence["nested-8"]?.replyIds).toEqual([
      "nested-8",
      "floor-8",
    ]);
    expect(findingReferences.evidence["nested-8"]?.text).toContain(
      "已移除的无关引用",
    );
    expect(
      JSON.stringify(findingReferences.evidence["nested-8"]),
    ).not.toContain("floor-46");
  });

  it("allows cross-chain spam grouping only for the same author and repeated text", async () => {
    const localReplies = [
      reply("spam-1", "刷屏用户", "重复内容", { floor: 10 }),
      reply("spam-2", "刷屏用户", "  重复内容  ", { floor: 20 }),
      reply("spam-3", "刷屏用户", "不同内容", { floor: 30 }),
    ];
    const providerResult = {
      summary: "发现重复发布",
      findings: [
        {
          type: "spam",
          severity: "medium",
          score: 75,
          summary: "P1、P2、P3 重复发布",
          offendingReplyIds: ["P1", "P2", "P3"],
          contextReplyIds: [],
          evidence: ["P1", "P2", "P3"].map((replyId) => ({
            replyId,
            explanation: `${replyId} 的内容重复`,
          })),
          primaryReasonId: "R06.05",
          confidence: 0.88,
          rationale: "同一用户重复发布",
          uncertainties: [],
        },
      ],
      uncertainties: [],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(providerResult) } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const result = await analyzeWholeThreadWithCloud(
      "刷屏跨链测试",
      localReplies,
      {
        endpoint: "https://provider.test/v1",
        model: "example-model",
        apiKey: "session-only-key",
      },
    );

    expect(result.findings.map((item) => item.replyIds)).toEqual([
      ["spam-1", "spam-2"],
      ["spam-3"],
    ]);
  });
});
