import { afterEach, describe, expect, it, vi } from "vitest";
import type { CapturedReply, Finding } from "../types";
import { analyzeWholeThreadWithCloud, deepAnalyzeFinding } from "./cloud";

const reply: CapturedReply = {
  id: "reply-1",
  siteReplyId: "reply-1",
  floor: 2,
  parentReplyId: null,
  authorName: "测试用户",
  time: null,
  timestamp: null,
  content: "需要人工复核的测试文字",
  sourcePage: 1,
  sourceUrl: "https://tieba.baidu.com/p/1",
  anchor: "#reply-1",
  imageCount: 0,
  isNested: false,
  unexpandedNestedCount: 0,
};

const finding: Finding = {
  id: "finding-1",
  type: "provocation",
  severity: "medium",
  score: 70,
  summary: "需要复核",
  replyIds: [reply.id],
  participantNames: [reply.authorName!],
  evidence: [],
  reasonCandidates: [],
  uncertainties: [],
};

const providerResult = {
  summary: "需要人工复核",
  type: "provocation",
  score: 70,
  replyIds: [reply.id],
  evidence: [{ replyId: reply.id, explanation: "存在针对性表达" }],
  reasonCandidates: [],
  uncertainties: [],
};

afterEach(() => vi.unstubAllGlobals());

describe("DeepSeek OpenAI-compatible request", () => {
  it("uses official JSON Output for the deep whole-thread request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: "未发现达到门槛的违规线索。",
                  findings: [],
                  uncertainties: [],
                  report: {
                    discussionOverview: "测试讨论。",
                    discussionMap: [],
                    participantDynamics: [],
                    borderlineCases: [],
                    normalHeatedDiscussion: [],
                    coverageNotes: [],
                    reviewPriorities: [],
                  },
                }),
                reasoning_content: "不得回传的隐藏推理",
              },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await analyzeWholeThreadWithCloud("测试帖", [reply], {
      endpoint: "https://api.deepseek.com/chat/completions",
      model: "deepseek-v4-pro",
      apiKey: "session-only-key",
      mode: "deep",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "deepseek-v4-pro",
      thinking: { type: "enabled" },
      reasoning_effort: "max",
      max_tokens: 32_768,
      stream: false,
      response_format: { type: "json_object" },
    });
    expect(body).not.toHaveProperty("temperature");
    const messages = body.messages as Array<{ content: string }>;
    const messageText = messages.map((message) => message.content).join("\n");
    expect(messageText).toContain("json");
    expect(messageText).toContain('"findings"');
    expect(messageText).not.toContain("reasoning_content");
    expect(result.summary).toBe("未发现达到门槛的违规线索。");
    expect(JSON.stringify(result)).not.toContain("隐藏推理");
  });

  it("uses the exact completion URL and disables thinking in fast mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(providerResult) } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await deepAnalyzeFinding(finding, [reply], {
      endpoint: "https://api.deepseek.com/chat/completions",
      model: "deepseek-v4-pro",
      apiKey: "session-only-key",
      mode: "fast",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.deepseek.com/chat/completions",
    );
    const body = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "deepseek-v4-pro",
      thinking: { type: "disabled" },
      max_tokens: 4_096,
      temperature: 0,
      stream: false,
      response_format: { type: "json_object" },
    });
    expect(JSON.stringify(body.messages)).toContain("json");
    expect(JSON.stringify(body.messages)).not.toContain("reasoning_content");
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("enable_thinking");
  });

  it("enables thinking at max reasoning effort in deep mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(providerResult),
                reasoning_content: "不应展示或解析的隐藏推理",
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await deepAnalyzeFinding(finding, [reply], {
      endpoint: "https://api.deepseek.com/chat/completions",
      model: "deepseek-v4-pro",
      apiKey: "session-only-key",
      mode: "deep",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as Record<string, unknown>;
    expect(body).toMatchObject({
      thinking: { type: "enabled" },
      reasoning_effort: "max",
      max_tokens: 4_096,
      response_format: { type: "json_object" },
    });
    expect(body).not.toHaveProperty("temperature");
    expect(JSON.stringify(body.messages)).toContain("json");
    expect(JSON.stringify(body.messages)).not.toContain("reasoning_content");
    expect(result.summary).toBe(providerResult.summary);
    expect(JSON.stringify(result)).not.toContain("隐藏推理");
  });

  it("rejects an empty final answer without adopting reasoning_content or retrying", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "   ",
                reasoning_content: JSON.stringify(providerResult),
              },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      deepAnalyzeFinding(finding, [reply], {
        endpoint: "https://api.deepseek.com/chat/completions",
        model: "deepseek-v4-pro",
        apiKey: "session-only-key",
        mode: "deep",
      }),
    ).rejects.toMatchObject({
      code: "invalid_response",
      message:
        "模型返回了空的最终回答，结果未采用；本次不会自动重试。",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
