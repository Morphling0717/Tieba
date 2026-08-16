import { describe, expect, it } from "vitest";
import type { WholeThreadCloudAnalysisResultV3 } from "./cloud";
import type { CapturedReply } from "../types";
import {
  createAnalysisHistoryEntry,
  findLatestByAnalysisKey,
  findLatestBySnapshotId,
  mergeAnalysisHistory,
  parseAnalysisHistoryExport,
  serializeAnalysisHistoryExport,
  validateAnalysisHistoryEntry,
} from "./analysisHistory";
import {
  sha256Hex,
  type AnalysisKey,
  type SnapshotId,
} from "./threadIdentity";

const reply: CapturedReply = {
  id: "123456789",
  siteReplyId: "123456789",
  floor: 21,
  parentReplyId: null,
  authorName: "历史测试用户",
  time: "2026-08-16 16:00",
  timestamp: Date.UTC(2026, 7, 16, 8),
  content: "绝不能进入持久历史的原始回复正文",
  sourcePage: 2,
  sourceUrl: "https://tieba.baidu.com/p/10912965767?pn=2",
  anchor: "[data-pid='123456789']",
  imageCount: 1,
  isNested: false,
  unexpandedNestedCount: 0,
};

const result: WholeThreadCloudAnalysisResultV3 = {
  protocolVersion: 3,
  summary: "历史测试用户参与了一段需要复核的讨论。",
  findings: [
    {
      id: "AI-1-1-personal_attack-123456789",
      type: "personal_attack",
      severity: "medium",
      score: 76,
      summary: "历史测试用户使用了轻度人身指摘。",
      replyIds: [reply.id],
      participantNames: ["历史测试用户"],
      evidence: [
        {
          replyId: reply.id,
          excerpt: "绝不能进入历史的证据摘录",
          signals: ["历史测试用户的措辞指向对方"],
          score: 76,
        },
      ],
      reasonCandidates: [
        {
          reasonId: "R03.01",
          confidence: 0.82,
          rationale: "历史测试用户的文字需要结合语境复核。",
        },
      ],
      uncertainties: ["无法仅凭历史测试用户这一句判断完整语气。"],
    },
  ],
  report: {
    overview: "历史测试用户参与了主要争论。",
    stages: [
      {
        title: "争议出现",
        summary: "历史测试用户加入讨论。",
        replyIds: [reply.id],
      },
    ],
    interactions: [],
    notes: [],
  },
  uncertainties: [],
  analyzedReplyCount: 1,
  ruleCount: 112,
  omittedImageCount: 1,
  usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
};

function createEntry(completedAt = "2026-08-16T08:02:00.000Z") {
  const snapshotId = sha256Hex("snapshot") as SnapshotId;
  const analysisKey = sha256Hex("analysis") as AnalysisKey;
  return createAnalysisHistoryEntry({
    attemptId: "00000000-0000-4000-8000-000000000001",
    snapshotId,
    analysisKey,
    threadId: "10912965767",
    threadUrl: "https://tieba.baidu.com/p/10912965767?pn=2#reply",
    threadTitle: "AI 历史持久化测试帖",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    mode: "deep",
    analyzerVersion: "3.0.0",
    rulesVersion: "2026.07",
    transportVersion: "sidepanel-v3",
    startedAt: "2026-08-16T08:00:00.000Z",
    completedAt,
    coverage: {
      visibleReplyCount: 1,
      imageCount: 1,
      unavailableReplyCount: 0,
    },
    usage: result.usage,
    result,
    replies: [reply],
  });
}

describe("durable AI analysis history", () => {
  it("stores the AI report and reply locations without source text, usernames, or excerpts", () => {
    const entry = createEntry();
    expect(entry.threadUrl).toBe("https://tieba.baidu.com/p/10912965767");
    expect(entry.result.summary).toContain("相关用户");
    expect(entry.result.findings[0]?.participantNames).toEqual([]);
    expect(entry.result.findings[0]?.evidence[0]?.excerpt).toBe("");
    expect(entry.replyRefs).toEqual([
      {
        id: reply.id,
        floor: 21,
        parentReplyId: null,
        isNested: false,
        sourcePage: 2,
      },
    ]);
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain("历史测试用户");
    expect(serialized).not.toContain("绝不能进入持久历史的原始回复正文");
    expect(serialized).not.toContain("绝不能进入历史的证据摘录");
    expect(serialized).not.toContain("sourceUrl");
    expect(serialized).not.toContain("anchor");
  });

  it("rejects imported unknown fields, non-empty excerpts, and usernames", () => {
    const entry = createEntry();
    expect(() => validateAnalysisHistoryEntry({ ...entry, apiKey: "secret" }))
      .toThrow();
    expect(() => validateAnalysisHistoryEntry({
      ...entry,
      result: {
        ...entry.result,
        findings: entry.result.findings.map((finding) => ({
          ...finding,
          participantNames: ["不应保存"],
        })),
      },
    })).toThrow();
    expect(() => validateAnalysisHistoryEntry({
      ...entry,
      result: {
        ...entry.result,
        findings: entry.result.findings.map((finding) => ({
          ...finding,
          evidence: finding.evidence.map((evidence) => ({
            ...evidence,
            excerpt: "原文",
          })),
        })),
      },
    })).toThrow();
  });

  it("round-trips an export and rejects a thread-id mismatch", () => {
    const entry = createEntry();
    expect(parseAnalysisHistoryExport(serializeAnalysisHistoryExport([entry])))
      .toEqual([entry]);
    expect(() => validateAnalysisHistoryEntry({
      ...entry,
      threadId: "999",
    })).toThrow("帖子地址与帖子编号不一致");
  });

  it("keeps each paid attempt and finds the newest result for an analysis key", () => {
    const first = createEntry("2026-08-16T08:02:00.000Z");
    const second = {
      ...createEntry("2026-08-16T08:05:00.000Z"),
      attemptId: "00000000-0000-4000-8000-000000000002",
    };
    const merged = mergeAnalysisHistory([first], [second]);
    expect(merged.map((entry) => entry.attemptId)).toEqual([
      second.attemptId,
      first.attemptId,
    ]);
    expect(findLatestByAnalysisKey(merged, first.analysisKey)?.attemptId)
      .toBe(second.attemptId);
  });

  it("rejects an attempt-id collision when any immutable identity changes", () => {
    const original = createEntry();
    const conflicts = [
      {
        ...original,
        snapshotId: sha256Hex("different-snapshot") as SnapshotId,
      },
      {
        ...original,
        analysisKey: sha256Hex("different-analysis") as AnalysisKey,
      },
      {
        ...original,
        threadId: "10912965768",
        threadUrl: "https://tieba.baidu.com/p/10912965768",
      },
      { ...original, provider: "alibaba" as const },
      { ...original, model: "deepseek-v4-pro-updated" },
      { ...original, mode: "fast" as const },
      { ...original, analyzerVersion: "3.0.1" },
      { ...original, rulesVersion: "2026.08" },
      { ...original, transportVersion: "sidepanel-v4" },
      { ...original, startedAt: "2026-08-16T08:01:00.000Z" },
    ];

    for (const conflicting of conflicts) {
      expect(() => mergeAnalysisHistory([original], [conflicting]))
        .toThrow("不可变身份发生冲突");
    }
  });

  it("allows the newer copy of an attempt only when its immutable identity is unchanged", () => {
    const older = createEntry("2026-08-16T08:02:00.000Z");
    const newer = {
      ...older,
      completedAt: "2026-08-16T08:03:00.000Z",
      threadTitle: "同一任务的更新后标题",
      result: {
        ...older.result,
        summary: "同一任务较新的终态结果",
      },
    };

    expect(mergeAnalysisHistory([older], [newer])).toEqual([newer]);
    expect(mergeAnalysisHistory([newer], [older])).toEqual([newer]);
  });

  it("finds the newest result for a snapshot across analysis versions", () => {
    const original = createEntry("2026-08-16T08:02:00.000Z");
    const upgraded = {
      ...createEntry("2026-08-16T08:05:00.000Z"),
      attemptId: "00000000-0000-4000-8000-000000000002",
      analysisKey: sha256Hex("analysis-v2") as AnalysisKey,
      analyzerVersion: "4.0.0",
      transportVersion: "sidepanel-v4",
    };
    const otherSnapshot = {
      ...createEntry("2026-08-16T08:10:00.000Z"),
      attemptId: "00000000-0000-4000-8000-000000000003",
      snapshotId: sha256Hex("other-snapshot") as SnapshotId,
      analysisKey: sha256Hex("other-analysis") as AnalysisKey,
    };

    expect(
      findLatestBySnapshotId(
        [original, upgraded, otherSnapshot],
        original.snapshotId,
      ),
    ).toEqual(upgraded);
    expect(
      findLatestBySnapshotId([original], sha256Hex("missing")),
    ).toBeNull();
  });
});
