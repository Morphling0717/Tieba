import { afterEach, describe, expect, it, vi } from "vitest";
import type { CapturedReply } from "../types";
import {
  analyzeWholeThreadWithCloud,
  type WholeThreadCloudAnalysisResultV3,
} from "./cloud";

function reply(index: number): CapturedReply {
  return {
    id: `reply-${index}`,
    siteReplyId: `site-${index}`,
    floor: index,
    parentReplyId: index === 2 ? "reply-1" : null,
    authorName: `测试用户${index}`,
    time: "2026-08-15 10:00",
    timestamp: Date.parse("2026-08-15T10:00:00+08:00") + index,
    content: index === 1 ? "针对现实用户的贬损" : `第 ${index} 条正常讨论`,
    sourcePage: 1,
    sourceUrl: "https://tieba.baidu.com/p/123",
    anchor: `#post-${index}`,
    imageCount: 0,
    isNested: index === 2,
    unexpandedNestedCount: 0,
  };
}

const replies = Array.from({ length: 10 }, (_, index) => reply(index + 1));

function validFinding(overrides: Record<string, unknown> = {}) {
  return {
    type: "personal_attack",
    severity: "high",
    score: 90,
    summary: "一名现实用户直接贬损另一名用户",
    offendingReplyIds: ["P1"],
    contextReplyIds: [],
    evidence: [{ replyId: "P1", explanation: "措辞直接指向现实用户" }],
    primaryReasonId: "R03.01",
    confidence: 0.91,
    rationale: "对象与措辞均明确，建议结合原文确认",
    uncertainties: [],
    ...overrides,
  };
}

function validV3Result(overrides: Record<string, unknown> = {}) {
  return {
    summary: "发现1组需要人工复核的高置信线索。",
    findings: [validFinding()],
    report: {
      overview: "讨论由作品观点交换转为现实用户冲突。",
      stages: [],
      interactions: [],
      notes: [],
    },
    ...overrides,
  };
}

function responseFor(providerResult: unknown): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(providerResult) } }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function assertV3(
  result: Awaited<ReturnType<typeof analyzeWholeThreadWithCloud>>,
): asserts result is WholeThreadCloudAnalysisResultV3 {
  expect(result.protocolVersion).toBe(3);
  if (result.protocolVersion !== 3) throw new Error("expected protocol v3");
}

function allV3Prose(result: WholeThreadCloudAnalysisResultV3): string {
  return [
    result.summary,
    result.report.overview,
    ...result.report.stages.flatMap((item) => [item.title, item.summary]),
    ...result.report.interactions.flatMap((item) => [item.title, item.summary]),
    ...result.report.notes.flatMap((item) => [item.title, item.summary]),
    ...result.findings.flatMap((item) => [
      item.summary,
      ...item.uncertainties,
      ...item.evidence.flatMap((evidence) => evidence.signals),
      ...item.reasonCandidates.map((reason) => reason.rationale),
    ]),
  ].join("\n");
}

afterEach(() => vi.unstubAllGlobals());

describe("whole-thread v3 narrative normalization fuzz", () => {
  it("keeps references structural, maps only exact allowlisted reply IDs, and removes protocol tokens from prose", async () => {
    const providerResult = validV3Result({
      summary:
        "查看 p1、u10、P 1、U\t10、Ｐ１、Ｕ１０、R03.01、Ｒ０３．０１；保留 CPU31 与 foo_P1。",
      findings: [
        validFinding({
          summary: "P1 对 U10 作出贬损，可能涉及 R03.01",
          rationale: "结合 P1 与 P10，并按 R03.01 复核",
          evidence: [
            { replyId: "P1", explanation: "P1 的作者指向 U10" },
          ],
          uncertainties: ["P10 的语气仍需人工判断"],
        }),
      ],
      report: {
        overview: "P1 与 U10 的互动；另有 CPU31 和 foo_P1",
        stages: [
          {
            title: "P1 开始讨论",
            summary: "涉及 P1、P999 与 R03.01",
            replyIds: ["P1", "P999", " P2 ", "p2"],
          },
        ],
        interactions: [
          {
            title: "用户互动",
            summary: "U1 回应 U2",
            replyIds: ["P1", "P2", "P1"],
          },
        ],
        notes: [
          {
            kind: "needs_human_check",
            title: "P999 无法定位",
            summary: "P1 仍需结合 P999 检查",
            replyIds: ["P1", "P999"],
          },
        ],
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(responseFor(providerResult)));

    const result = await analyzeWholeThreadWithCloud("引用变体", replies, {
      endpoint: "https://provider.test/v1",
      model: "test-model",
      apiKey: "session-only-key",
    });
    assertV3(result);

    expect(result.report.stages[0]?.replyIds).toEqual(["reply-1"]);
    expect(result.report.interactions[0]?.replyIds).toEqual([
      "reply-1",
      "reply-2",
    ]);
    expect(result.report.notes[0]?.replyIds).toEqual(["reply-1"]);
    expect(result.uncertainties).toEqual([
      expect.stringContaining("相关回复"),
    ]);
    const prose = allV3Prose(result);
    expect(prose).toContain("CPU31");
    expect(prose).toContain("foo_P1");
    expect(prose).not.toMatch(
      /(?<![A-Za-z0-9_Ａ-Ｚａ-ｚ０-９＿])[PpUuＰｐＵｕ][\t\p{Zs}]*[0-9０-９]+(?![A-Za-z0-9_Ａ-Ｚａ-ｚ０-９＿])/u,
    );
    expect(prose).not.toMatch(
      /(?<![A-Za-z0-9_Ａ-Ｚａ-ｚ０-９＿])[RrＲｒ][\t\p{Zs}]*[0-9０-９]+[\t\p{Zs}]*[.．][\t\p{Zs}]*[0-9０-９]+/u,
    );
    expect(result.findings[0]?.reasonCandidates[0]?.reasonId).toBe("R03.01");
  });

  it("bounds every v3 prose/list field and drops malformed narrative objects without echoing unknown fields", async () => {
    const secret = "DO_NOT_ECHO_PROVIDER_SECRET";
    const stages: unknown[] = Array.from({ length: 14 }, (_, index) => ({
      title: `阶段${index}${"题".repeat(40)}`,
      summary: `${"段".repeat(190)} P1`,
      replyIds: [index % 2 === 0 ? "P1" : "P999"],
      unknownProviderField: secret,
    }));
    stages.splice(2, 0, { title: "缺少摘要" }, null);
    const interactions = Array.from({ length: 9 }, (_, index) => ({
      title: `互动${index}`,
      summary: "关键互动",
      replyIds: ["P2"],
    }));
    const notes = [
      ...Array.from({ length: 8 }, (_, index) => ({
        kind: "needs_human_check",
        title: `待确认${index}`,
        summary: "需要人工确认",
        replyIds: ["P1"],
      })),
      ...Array.from({ length: 6 }, (_, index) => ({
        kind: "heated_but_allowed",
        title: `正常激烈${index}`,
        summary: "有实质观点",
        replyIds: ["P2"],
      })),
      { kind: "invented", title: secret, summary: secret, replyIds: ["P1"] },
    ];
    const providerResult = validV3Result({
      summary: `${"总".repeat(220)} P1`,
      findings: [
        validFinding({
          summary: `${"线".repeat(130)} P1`,
          rationale: `${"理".repeat(210)} R03.01`,
          evidence: [
            { replyId: "P1", explanation: `${"证".repeat(190)} U1` },
          ],
          uncertainties: Array.from({ length: 7 }, () =>
            `${"疑".repeat(180)} P1`,
          ),
        }),
      ],
      report: {
        overview: `${"概".repeat(280)} P1`,
        stages,
        interactions,
        notes,
      },
      unknownProviderField: secret,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(responseFor(providerResult)));

    const result = await analyzeWholeThreadWithCloud("上限", replies, {
      endpoint: "https://provider.test/v1",
      model: "test-model",
      apiKey: "session-only-key",
    });
    assertV3(result);

    expect(result.summary).toHaveLength(180);
    expect(result.report.overview).toHaveLength(240);
    expect(result.report.stages).toHaveLength(8);
    expect(result.report.interactions).toHaveLength(5);
    expect(
      result.report.notes.filter((item) => item.kind === "needs_human_check"),
    ).toHaveLength(5);
    expect(
      result.report.notes.filter((item) => item.kind === "heated_but_allowed"),
    ).toHaveLength(3);
    expect(result.report.stages.every((item) => item.title.length <= 32)).toBe(
      true,
    );
    expect(result.report.stages.every((item) => item.summary.length <= 160)).toBe(
      true,
    );
    expect(result.findings[0]?.summary).toHaveLength(100);
    expect(result.findings[0]?.reasonCandidates[0]?.rationale).toHaveLength(180);
    expect(result.findings[0]?.evidence[0]?.signals[0]).toHaveLength(163);
    expect(result.findings[0]?.uncertainties).toHaveLength(3);
    expect(
      result.findings[0]?.uncertainties.every((item) => item.length <= 160),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("keeps the top summary to two sentences", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        responseFor(
          validV3Result({
            summary: "第一句。第二句！第三句不应进入结果。",
            findings: [],
          }),
        ),
      ),
    );

    const result = await analyzeWholeThreadWithCloud("句数", replies, {
      endpoint: "https://provider.test/v1",
      model: "test-model",
      apiKey: "session-only-key",
    });
    assertV3(result);
    expect(result.summary).toBe("第一句。第二句！");
  });

  it("survives deterministic mixed v3 report shapes without creating clickable unknown references", async () => {
    let state = 0x5eed1234;
    const next = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };

    for (let run = 0; run < 20; run += 1) {
      const secret = `SECRET_${run}_${next()}`;
      const variants: unknown[] = [
        {
          title: "有效阶段",
          summary: "P1 的讨论",
          replyIds: ["P1", "P999", " P2 ", "p2"],
          secret,
        },
        { title: "缺少引用", summary: "忽略", secret },
        { title: secret, summary: 42, replyIds: ["P1"] },
        { title: "非字符串引用", summary: "忽略", replyIds: ["P1", 2] },
        null,
        ["嵌套数组"],
        next(),
      ];
      const mixed = Array.from(
        { length: 16 },
        () => variants[next() % variants.length],
      );
      mixed.push(variants[0]);
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          responseFor(
            validV3Result({
              findings: [],
              summary: "未发现达到门槛的线索。",
              report: {
                overview: "正常讨论。",
                stages: mixed,
                interactions: mixed,
                notes: [],
              },
            }),
          ),
        ),
      );

      const result = await analyzeWholeThreadWithCloud(
        `混合形状${run}`,
        replies,
        {
          endpoint: "https://provider.test/v1",
          model: "test-model",
          apiKey: "session-only-key",
        },
      );
      assertV3(result);
      expect(
        result.report.stages.flatMap((item) => item.replyIds),
        `run ${run}`,
      ).not.toContain("reply-2");
      expect(
        result.report.interactions.flatMap((item) => item.replyIds),
        `run ${run}`,
      ).not.toContain("reply-2");
      expect(JSON.stringify(result), `run ${run}`).not.toContain(secret);
    }
  });
});
