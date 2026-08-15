import { afterEach, describe, expect, it, vi } from "vitest";
import type { CapturedReply } from "../types";
import { analyzeWholeThreadWithCloud } from "./cloud";

function reply(index: number): CapturedReply {
  return {
    id: `reply-${index}`,
    siteReplyId: `site-${index}`,
    floor: index,
    parentReplyId: null,
    authorName: `测试用户${index}`,
    time: "2026-08-15 10:00",
    timestamp: Date.parse("2026-08-15T10:00:00+08:00") + index,
    content: index === 1 ? "针对现实用户的贬损" : `第 ${index} 条正常讨论`,
    sourcePage: 1,
    sourceUrl: "https://tieba.baidu.com/p/123",
    anchor: `#post-${index}`,
    imageCount: 0,
    isNested: false,
    unexpandedNestedCount: 0,
  };
}

const replies = Array.from({ length: 10 }, (_, index) => reply(index + 1));

function validFinding(uncertainties: unknown[] = []): Record<string, unknown> {
  return {
    type: "personal_attack",
    severity: "high",
    score: 90,
    summary: "P1 对 U10 作出直接贬损",
    offendingReplyIds: ["P1"],
    contextReplyIds: ["P10"],
    evidence: [{ replyId: "P1", explanation: "P1 指向 U10" }],
    primaryReasonId: "R03.01",
    confidence: 0.91,
    rationale: "结合 P1 与 P10 可以定位",
    uncertainties,
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("whole-thread narrative normalization fuzz", () => {
  it("localizes token variants without matching P/U inside ASCII or fullwidth words", async () => {
    const providerResult = {
      summary:
        "查看 p1、u10、P 1、U\t10、Ｐ１、Ｕ１０、P999、U999；保留 CPU31 与 ＣＰＵ３１。",
      findings: [validFinding()],
      uncertainties: [
        "p1/u10/P 1/U 10/Ｐ１/Ｕ１０/P999/U999；CPU31；ＣＰＵ３１；foo_P1；ｆｏｏ＿Ｐ１",
      ],
      report: {
        discussionOverview: "p1 与 Ｕ１０ 的互动；另有 CPU31 和 ＣＰＵ３１",
        discussionMap: ["P 1 -> u10，未知 P999/U999"],
        participantDynamics: [],
        borderlineCases: [],
        normalHeatedDiscussion: [],
        coverageNotes: [],
        reviewPriorities: [],
      },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(responseFor(providerResult)));

    const result = await analyzeWholeThreadWithCloud("引用变体", replies, {
      endpoint: "https://provider.test/v1",
      model: "test-model",
      apiKey: "session-only-key",
    });
    const serialized = JSON.stringify(result);

    expect(result.findings).toHaveLength(1);
    expect(serialized).toContain("第 1 楼");
    expect(serialized).toContain("测试用户10");
    expect(serialized).toContain("无法定位的回复");
    expect(serialized).toContain("无法定位的用户");
    expect(serialized).toContain("CPU31");
    expect(serialized).toContain("ＣＰＵ３１");
    expect(serialized).toContain("foo_P1");
    expect(serialized).toContain("ｆｏｏ＿Ｐ１");
    expect(serialized).not.toMatch(
      /(?<![A-Za-z0-9_Ａ-Ｚａ-ｚ０-９＿])[PpUuＰｐＵｕ][\t\p{Zs}]*[0-9０-９]+(?![A-Za-z0-9_Ａ-Ｚａ-ｚ０-９＿])/u,
    );
  });

  it("survives deterministic mixed narrative shapes without echoing unknown fields or creating findings", async () => {
    let state = 0x5eed1234;
    const next = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };

    for (let run = 0; run < 24; run += 1) {
      const secret = `DO_NOT_ECHO_${run}_${next()}`;
      const ignoredWhitespace = `IGNORED_SPACE_${run}`;
      const ignoredLowercase = `IGNORED_LOWER_${run}`;
      const variants: unknown[] = [
        `复核 P1、P10、P999、U1、U10、U999（${run}）`,
        {
          label: "阶段",
          note: "P1 与 U10 的上下文",
          replyIds: ["P1", "P10", "P999"],
          unknownProviderField: secret,
          offendingReplyIds: ["P10"],
          primaryReasonId: "R99.99",
        },
        { note: "未知编号", replyId: "P999", secret },
        { note: ignoredWhitespace, replyId: " P1 ", secret },
        { note: ignoredLowercase, replyId: "p1", secret },
        { note: "非字符串引用", replyIds: ["P1", 10], secret },
        { note: "测".repeat(4_500), secret },
        { unknownOnly: secret, primaryReasonId: "R99.99" },
        null,
        next(),
        ["嵌套数组", { secret }],
      ];
      const mixed = Array.from(
        { length: 18 },
        () => variants[next() % variants.length],
      );
      // Ensure every run exercises both accepted provider prose and rejected
      // action-shaped/unknown-only values, regardless of the PRNG picks.
      mixed.push(variants[0], variants[1], variants[3], variants[4], variants[7]);

      const providerResult = {
        summary: "发现一项明确线索，P1 需结合 P10 复核",
        findings: [validFinding(mixed)],
        uncertainties: mixed,
        report: {
          discussionOverview: {
            overview: "P1 与 U10 的讨论概览",
            unknownProviderField: secret,
            primaryReasonId: "R99.99",
          },
          discussionMap: mixed,
          participantDynamics: mixed,
          borderlineCases: mixed,
          normalHeatedDiscussion: mixed,
          coverageNotes: mixed,
          reviewPriorities: mixed,
        },
      };
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(responseFor(providerResult)),
      );

      const result = await analyzeWholeThreadWithCloud(
        `混合形状 ${run}`,
        replies,
        {
          endpoint: "https://provider.test/v1",
          model: "test-model",
          apiKey: "session-only-key",
        },
      );
      const serialized = JSON.stringify(result);

      expect(result.findings, `run ${run}`).toHaveLength(1);
      expect(result.findings[0]?.replyIds, `run ${run}`).toEqual(["reply-1"]);
      expect(serialized, `run ${run}`).not.toContain(secret);
      expect(serialized, `run ${run}`).not.toContain(ignoredWhitespace);
      expect(serialized, `run ${run}`).not.toContain(ignoredLowercase);
      expect(serialized, `run ${run}`).not.toContain("R99.99");
      expect(serialized, `run ${run}`).not.toMatch(
        /(?<![A-Za-z0-9_Ａ-Ｚａ-ｚ０-９＿])[PpUuＰｐＵｕ][\t\p{Zs}]*[0-9０-９]+(?![A-Za-z0-9_Ａ-Ｚａ-ｚ０-９＿])/u,
      );
    }
  });

  it("bounds oversized and non-array narrative containers with safe diagnostics", async () => {
    const providerResult = {
      summary: "未发现达到门槛的违规",
      findings: [],
      uncertainties: Array.from({ length: 80 }, (_, index) =>
        index % 2 === 0 ? `第 ${index} 项提到 P1` : { note: `对象 ${index} 提到 U1` },
      ),
      report: {
        discussionOverview: ["不是字符串或对象"],
        discussionMap: 42,
        participantDynamics: { note: "容器类型错误" },
        borderlineCases: null,
        normalHeatedDiscussion: "不是数组",
        coverageNotes: undefined,
        reviewPriorities: Array.from({ length: 130 }, (_, index) =>
          `优先级 ${index}：P10`,
        ),
      },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(responseFor(providerResult)));

    const result = await analyzeWholeThreadWithCloud("边界", replies, {
      endpoint: "https://provider.test/v1",
      model: "test-model",
      apiKey: "session-only-key",
    });
    const serialized = JSON.stringify(result);

    expect(result.findings).toEqual([]);
    expect(result.uncertainties).toHaveLength(50);
    expect(result.uncertainties.at(-1)).toMatch(/^有\d+条格式异常说明已忽略。$/u);
    expect(result.report?.discussionOverview).toBe("有1条格式异常说明已忽略。");
    expect(result.report?.discussionMap).toEqual(["有1条格式异常说明已忽略。"]);
    expect(result.report?.participantDynamics).toEqual(["有1条格式异常说明已忽略。"]);
    expect(result.report?.borderlineCases).toEqual([]);
    expect(result.report?.normalHeatedDiscussion).toEqual(["有1条格式异常说明已忽略。"]);
    expect(result.report?.coverageNotes).toEqual([]);
    expect(result.report?.reviewPriorities).toHaveLength(100);
    expect(result.report?.reviewPriorities.at(-1)).toMatch(
      /^有\d+条格式异常说明已忽略。$/u,
    );
    expect(serialized).not.toMatch(
      /(?<![A-Za-z0-9_Ａ-Ｚａ-ｚ０-９＿])[PpUuＰｐＵｕ][\t\p{Zs}]*[0-9０-９]+(?![A-Za-z0-9_Ａ-Ｚａ-ｚ０-９＿])/u,
    );
  });

  it("keeps an empty overview and never turns a truncated long token into P1", async () => {
    const providerResult = {
      summary: "未发现达到门槛的违规",
      findings: [],
      uncertainties: [
        `${"甲".repeat(497)}P1234`,
        `${"乙".repeat(497)}p1234A`,
      ],
      report: {
        discussionOverview: "",
        discussionMap: [],
        participantDynamics: [],
        borderlineCases: [],
        normalHeatedDiscussion: [],
        coverageNotes: [],
        reviewPriorities: [],
      },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(responseFor(providerResult)));

    const result = await analyzeWholeThreadWithCloud("截断边界", replies, {
      endpoint: "https://provider.test/v1",
      model: "test-model",
      apiKey: "session-only-key",
    });
    const serialized = JSON.stringify(result);

    expect(result.report?.discussionOverview).toBe("");
    expect(result.uncertainties).toHaveLength(2);
    expect(result.uncertainties.every((item) => item.endsWith("…"))).toBe(true);
    expect(serialized).not.toContain("第 1 楼");
    expect(serialized).not.toContain("P1234");
    expect(serialized).not.toContain("p1234A");
  });

  it("maps a string report to its overview and ignores array/scalar reports", async () => {
    const reports: unknown[] = [
      "P1 与 U10 的长文概览",
      [],
      42,
      true,
      null,
    ];

    for (const report of reports) {
      const providerResult = {
        summary: "未发现达到门槛的违规",
        findings: [],
        uncertainties: [],
        report,
      };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(responseFor(providerResult)));
      const result = await analyzeWholeThreadWithCloud("报告兼容", replies, {
        endpoint: "https://provider.test/v1",
        model: "test-model",
        apiKey: "session-only-key",
      });

      if (typeof report === "string") {
        expect(result.report?.discussionOverview).toContain("第 1 楼");
        expect(result.report?.discussionOverview).toContain("测试用户10");
      } else {
        expect(result.report).toBeUndefined();
      }
    }
  });
});
