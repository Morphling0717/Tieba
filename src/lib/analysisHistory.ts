import { z } from "zod";
import type { CapturedReply, CloudProvider, Finding } from "../types";
import {
  type CloudAnalysisMode,
  type CloudTokenUsage,
  type WholeThreadCloudAnalysisResult,
  type WholeThreadCloudAnalysisResultV3,
} from "./cloud";
import { sanitizeThreadCloudResultForCache } from "./threadCloudCache";
import {
  isAnalysisKey,
  isSnapshotId,
  type AnalysisKey,
  type SnapshotId,
} from "./threadIdentity";

export const ANALYSIS_HISTORY_SCHEMA_VERSION = 1 as const;

export interface AnalysisHistoryReplyRef {
  id: string;
  floor: number | null;
  parentReplyId: string | null;
  isNested: boolean;
  sourcePage: number;
}

export interface AnalysisHistoryCoverage {
  visibleReplyCount: number;
  imageCount: number;
  unavailableReplyCount: number;
}

export interface AnalysisHistoryEntryV1 {
  schemaVersion: typeof ANALYSIS_HISTORY_SCHEMA_VERSION;
  attemptId: string;
  snapshotId: SnapshotId;
  analysisKey: AnalysisKey;
  threadId: string;
  threadUrl: string;
  threadTitle: string;
  provider: CloudProvider;
  model: string;
  mode: CloudAnalysisMode;
  analyzerVersion: string;
  rulesVersion: string;
  transportVersion: string;
  startedAt: string;
  completedAt: string;
  coverage: AnalysisHistoryCoverage;
  usage?: CloudTokenUsage;
  result: WholeThreadCloudAnalysisResult;
  replyRefs: AnalysisHistoryReplyRef[];
}

export type AnalysisHistoryEntry = AnalysisHistoryEntryV1;

export type CreateAnalysisHistoryEntryInput = Omit<
  AnalysisHistoryEntryV1,
  "schemaVersion" | "threadId" | "threadUrl" | "result" | "replyRefs"
> & {
  threadId: string | null;
  threadUrl: string;
  result: WholeThreadCloudAnalysisResult;
  replies: readonly CapturedReply[];
};

export interface AnalysisHistoryExportV1 {
  schemaVersion: typeof ANALYSIS_HISTORY_SCHEMA_VERSION;
  exportedAt: string;
  entries: AnalysisHistoryEntryV1[];
}

const replyIdPattern =
  /^(?:\d{1,30}|\d{1,30}-first-floor|(?:\d{1,30}|thread)-page-\d{1,6}-floor-\d{1,10}(?:-nested-\d{1,6})?|\d{1,30}-nested-\d{1,6}|kr-(?:lzl(?:-temp)?|comment-temp)-[A-Za-z0-9-]{16,120})$/u;
const safeReplyId = z.string().trim().regex(replyIdPattern);
const safeText = (maximum: number, minimum = 0) =>
  z.string().trim().min(minimum).max(maximum);
const isoDate = z.iso.datetime({ offset: true });
const finiteCount = (maximum = 1_000_000) =>
  z.number().int().min(0).max(maximum);

const tokenUsageSchema = z
  .strictObject({
    inputTokens: finiteCount(10_000_000),
    outputTokens: finiteCount(10_000_000),
    totalTokens: finiteCount(10_000_000),
  })
  .superRefine((usage, context) => {
    if (usage.inputTokens + usage.outputTokens !== usage.totalTokens) {
      context.addIssue({
        code: "custom",
        path: ["totalTokens"],
        message: "token 总数必须等于输入与输出之和",
      });
    }
  });

const evidenceSchema = z.strictObject({
  replyId: safeReplyId,
  // Durable history deliberately never stores a source excerpt.
  excerpt: z.literal(""),
  signals: z.array(safeText(800, 1)).max(100),
  score: z.number().finite().min(0).max(100),
});

const reasonCandidateSchema = z.strictObject({
  reasonId: z.string().trim().regex(/^R\d{2}\.\d{2}$/u),
  confidence: z.number().finite().min(0).max(1),
  rationale: safeText(800, 1),
});

const findingSchema = z.strictObject({
  id: safeText(300, 1),
  type: z.enum([
    "personal_attack",
    "provocation",
    "harassment",
    "spam",
    "privacy",
    "other",
  ]),
  severity: z.enum(["low", "medium", "high", "critical"]),
  score: z.number().finite().min(0).max(100),
  summary: safeText(3_000, 1),
  replyIds: z.array(safeReplyId).max(100),
  contextReplyIds: z.array(safeReplyId).max(100).optional(),
  participantNames: z.array(z.never()).max(0),
  evidence: z.array(evidenceSchema).max(100),
  reasonCandidates: z.array(reasonCandidateSchema).max(50),
  uncertainties: z.array(safeText(4_000, 1)).max(50),
});

const narrativeItemV3Schema = z.strictObject({
  title: safeText(32, 1),
  summary: safeText(160, 1),
  replyIds: z.array(safeReplyId).max(50),
});

const reviewNoteV3Schema = narrativeItemV3Schema.extend({
  kind: z.enum(["needs_human_check", "heated_but_allowed"]),
});

const resultBase = {
  summary: safeText(3_000, 1),
  findings: z.array(findingSchema).max(300),
  uncertainties: z.array(safeText(4_000, 1)).max(50),
  analyzedReplyCount: finiteCount(),
  ruleCount: finiteCount(10_000),
  omittedImageCount: finiteCount(),
  usage: tokenUsageSchema.optional(),
};

const resultV3Schema = z.strictObject({
  ...resultBase,
  protocolVersion: z.literal(3),
  report: z.strictObject({
    overview: safeText(240),
    stages: z.array(narrativeItemV3Schema).max(8),
    interactions: z.array(narrativeItemV3Schema).max(5),
    notes: z.array(reviewNoteV3Schema).max(8),
  }),
});

const legacyReportSchema = z.strictObject({
  discussionOverview: safeText(20_000),
  discussionMap: z.array(safeText(4_000, 1)).max(100),
  participantDynamics: z.array(safeText(4_000, 1)).max(100),
  borderlineCases: z.array(safeText(4_000, 1)).max(100),
  normalHeatedDiscussion: z.array(safeText(4_000, 1)).max(100),
  coverageNotes: z.array(safeText(4_000, 1)).max(100),
  reviewPriorities: z.array(safeText(4_000, 1)).max(100),
});

const legacyResultSchema = z.strictObject({
  ...resultBase,
  protocolVersion: z.literal(2).optional(),
  report: legacyReportSchema.optional(),
});

const resultSchema = z.union([resultV3Schema, legacyResultSchema]);

const replyRefSchema = z.strictObject({
  id: safeReplyId,
  floor: z.number().int().min(1).max(10_000_000).nullable(),
  parentReplyId: safeReplyId.nullable(),
  isNested: z.boolean(),
  sourcePage: z.number().int().min(1).max(1_000_000),
});

const historyEntrySchema = z
  .strictObject({
    schemaVersion: z.literal(ANALYSIS_HISTORY_SCHEMA_VERSION),
    attemptId: z.string().trim().regex(/^[A-Za-z0-9:_-]{1,128}$/u),
    snapshotId: z.string().refine(isSnapshotId, "snapshotId 格式无效"),
    analysisKey: z.string().refine(isAnalysisKey, "analysisKey 格式无效"),
    threadId: z.string().regex(/^\d{1,30}$/u),
    threadUrl: z.string().url(),
    threadTitle: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value)),
    provider: z.enum(["alibaba", "deepseek"]),
    model: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value)),
    mode: z.enum(["fast", "deep"]),
    analyzerVersion: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/u),
    rulesVersion: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/u),
    transportVersion: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/u),
    startedAt: isoDate,
    completedAt: isoDate,
    coverage: z.strictObject({
      visibleReplyCount: finiteCount(),
      imageCount: finiteCount(),
      unavailableReplyCount: finiteCount(),
    }),
    usage: tokenUsageSchema.optional(),
    result: resultSchema,
    replyRefs: z.array(replyRefSchema).max(10_000),
  })
  .superRefine((entry, context) => {
    const canonical = canonicalThread(entry.threadUrl);
    if (!canonical || canonical.threadId !== entry.threadId) {
      context.addIssue({
        code: "custom",
        path: ["threadUrl"],
        message: "帖子地址与帖子编号不一致",
      });
    } else if (canonical.url !== entry.threadUrl) {
      context.addIssue({
        code: "custom",
        path: ["threadUrl"],
        message: "帖子地址必须是无查询参数的规范地址",
      });
    }
    if (Date.parse(entry.completedAt) < Date.parse(entry.startedAt)) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "完成时间不得早于开始时间",
      });
    }
    if (entry.result.analyzedReplyCount > entry.coverage.visibleReplyCount) {
      context.addIssue({
        code: "custom",
        path: ["result", "analyzedReplyCount"],
        message: "分析数量不得超过快照可见文字数量",
      });
    }
  });

const historyExportSchema = z.strictObject({
  schemaVersion: z.literal(ANALYSIS_HISTORY_SCHEMA_VERSION),
  exportedAt: isoDate,
  entries: z.array(historyEntrySchema).max(100),
});

function canonicalThread(value: string): { threadId: string; url: string } | null {
  try {
    const url = new URL(value);
    const threadId = url.pathname.match(/^\/p\/(\d+)(?:\/|$)/u)?.[1];
    if (
      url.protocol !== "https:" ||
      url.hostname !== "tieba.baidu.com" ||
      !threadId
    ) {
      return null;
    }
    return { threadId, url: `https://tieba.baidu.com/p/${threadId}` };
  } catch {
    return null;
  }
}

function replaceNames(value: string, names: readonly string[]): string {
  let output = value;
  for (const name of names) output = output.split(name).join("相关用户");
  return output;
}

function sanitizeFinding(finding: Finding, names: readonly string[]): Finding {
  return {
    id: finding.id,
    type: finding.type,
    severity: finding.severity,
    score: finding.score,
    summary: replaceNames(finding.summary, names),
    replyIds: [...new Set(finding.replyIds)],
    ...(finding.contextReplyIds
      ? { contextReplyIds: [...new Set(finding.contextReplyIds)] }
      : {}),
    participantNames: [],
    evidence: finding.evidence.map((evidence) => ({
      replyId: evidence.replyId,
      excerpt: "",
      signals: evidence.signals.map((signal) => replaceNames(signal, names)),
      score: evidence.score,
    })),
    reasonCandidates: finding.reasonCandidates.map((candidate) => ({
      reasonId: candidate.reasonId,
      confidence: candidate.confidence,
      rationale: replaceNames(candidate.rationale, names),
    })),
    uncertainties: finding.uncertainties.map((item) => replaceNames(item, names)),
  };
}

function sanitizeResult(
  result: WholeThreadCloudAnalysisResult,
  replies: readonly CapturedReply[],
): WholeThreadCloudAnalysisResult {
  const names = [
    ...new Set(
      [
        ...replies.flatMap((reply) => reply.authorName?.trim() || []),
        ...result.findings.flatMap((finding) => finding.participantNames),
      ]
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ].sort((left, right) => right.length - left.length);
  const cached = sanitizeThreadCloudResultForCache(result);
  const common = {
    summary: replaceNames(cached.summary, names),
    findings: cached.findings.map((finding) => sanitizeFinding(finding, names)),
    uncertainties: cached.uncertainties.map((item) => replaceNames(item, names)),
    analyzedReplyCount: cached.analyzedReplyCount,
    ruleCount: cached.ruleCount,
    omittedImageCount: cached.omittedImageCount,
    ...(cached.usage ? { usage: { ...cached.usage } } : {}),
  };
  if (cached.protocolVersion === 3) {
    return {
      ...common,
      protocolVersion: 3,
      report: {
        overview: replaceNames(cached.report.overview, names),
        stages: cached.report.stages.map((item) => ({
          title: replaceNames(item.title, names),
          summary: replaceNames(item.summary, names),
          replyIds: [...new Set(item.replyIds)],
        })),
        interactions: cached.report.interactions.map((item) => ({
          title: replaceNames(item.title, names),
          summary: replaceNames(item.summary, names),
          replyIds: [...new Set(item.replyIds)],
        })),
        notes: cached.report.notes.map((item) => ({
          kind: item.kind,
          title: replaceNames(item.title, names),
          summary: replaceNames(item.summary, names),
          replyIds: [...new Set(item.replyIds)],
        })),
      },
    } satisfies WholeThreadCloudAnalysisResultV3;
  }
  return {
    ...common,
    ...(cached.protocolVersion === 2 ? { protocolVersion: 2 as const } : {}),
    ...(cached.report
      ? {
          report: {
            discussionOverview: replaceNames(cached.report.discussionOverview, names),
            discussionMap: cached.report.discussionMap.map((item) => replaceNames(item, names)),
            participantDynamics: cached.report.participantDynamics.map((item) => replaceNames(item, names)),
            borderlineCases: cached.report.borderlineCases.map((item) => replaceNames(item, names)),
            normalHeatedDiscussion: cached.report.normalHeatedDiscussion.map((item) => replaceNames(item, names)),
            coverageNotes: cached.report.coverageNotes.map((item) => replaceNames(item, names)),
            reviewPriorities: cached.report.reviewPriorities.map((item) => replaceNames(item, names)),
          },
        }
      : {}),
  };
}

function collectReferencedReplyIds(result: WholeThreadCloudAnalysisResult): Set<string> {
  const ids = new Set<string>();
  const add = (values: readonly string[] | undefined) => {
    for (const value of values ?? []) ids.add(value);
  };
  for (const finding of result.findings) {
    add(finding.replyIds);
    add(finding.contextReplyIds);
    add(finding.evidence.map((evidence) => evidence.replyId));
  }
  if (result.protocolVersion === 3) {
    for (const item of [
      ...result.report.stages,
      ...result.report.interactions,
      ...result.report.notes,
    ]) {
      add(item.replyIds);
    }
  }
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (key === "replyIds" && Array.isArray(item)) {
        add(item.filter((id): id is string => typeof id === "string"));
      } else {
        visit(item);
      }
    }
  };
  visit(result.narrativeReferences);
  return ids;
}

export function createAnalysisHistoryEntry(
  input: CreateAnalysisHistoryEntryInput,
): AnalysisHistoryEntryV1 {
  const canonical = canonicalThread(input.threadUrl);
  if (!canonical || (input.threadId !== null && input.threadId !== canonical.threadId)) {
    throw new TypeError("AI 分析历史只能关联规范的贴吧帖子地址");
  }
  const result = sanitizeResult(input.result, input.replies);
  const threadTitle = input.threadTitle.replace(/\s+/gu, " ").trim().slice(0, 300) ||
    `帖子 ${canonical.threadId}`;
  const referenced = collectReferencedReplyIds(input.result);
  const replyRefs = input.replies
    .filter((reply) => referenced.has(reply.id))
    .map((reply) => ({
      id: reply.id,
      floor: reply.floor,
      parentReplyId: reply.parentReplyId,
      isNested: reply.isNested,
      sourcePage: reply.sourcePage,
    }));
  return validateAnalysisHistoryEntry({
    schemaVersion: ANALYSIS_HISTORY_SCHEMA_VERSION,
    attemptId: input.attemptId,
    snapshotId: input.snapshotId,
    analysisKey: input.analysisKey,
    threadId: canonical.threadId,
    threadUrl: canonical.url,
    threadTitle,
    provider: input.provider,
    model: input.model,
    mode: input.mode,
    analyzerVersion: input.analyzerVersion,
    rulesVersion: input.rulesVersion,
    transportVersion: input.transportVersion,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    coverage: input.coverage,
    ...(input.usage ? { usage: input.usage } : {}),
    result,
    replyRefs,
  });
}

export function validateAnalysisHistoryEntry(
  value: unknown,
): AnalysisHistoryEntryV1 {
  return historyEntrySchema.parse(value) as AnalysisHistoryEntryV1;
}

export function validateAnalysisHistoryExport(
  value: unknown,
): AnalysisHistoryExportV1 {
  return historyExportSchema.parse(value) as AnalysisHistoryExportV1;
}

const immutableAttemptIdentityKeys = [
  "snapshotId",
  "analysisKey",
  "threadId",
  "threadUrl",
  "provider",
  "model",
  "mode",
  "analyzerVersion",
  "rulesVersion",
  "transportVersion",
  "startedAt",
] as const satisfies readonly (keyof AnalysisHistoryEntry)[];

function hasImmutableAttemptIdentityConflict(
  current: AnalysisHistoryEntry,
  candidate: AnalysisHistoryEntry,
): boolean {
  return immutableAttemptIdentityKeys.some(
    (key) => current[key] !== candidate[key],
  );
}

export function mergeAnalysisHistory(
  existing: readonly AnalysisHistoryEntry[],
  incoming: readonly AnalysisHistoryEntry[],
): AnalysisHistoryEntry[] {
  const byAttempt = new Map<string, AnalysisHistoryEntry>();
  for (const candidate of [...existing, ...incoming]) {
    const entry = validateAnalysisHistoryEntry(candidate);
    const current = byAttempt.get(entry.attemptId);
    if (
      current &&
      hasImmutableAttemptIdentityConflict(current, entry)
    ) {
      throw new TypeError(
        `分析任务 ${entry.attemptId} 的不可变身份发生冲突，已拒绝覆盖原历史。`,
      );
    }
    if (!current || Date.parse(entry.completedAt) >= Date.parse(current.completedAt)) {
      byAttempt.set(entry.attemptId, entry);
    }
  }
  return [...byAttempt.values()].sort(
    (left, right) =>
      Date.parse(right.completedAt) - Date.parse(left.completedAt) ||
      left.attemptId.localeCompare(right.attemptId),
  );
}

export function serializeAnalysisHistoryExport(
  entries: readonly AnalysisHistoryEntry[],
  exportedAt = new Date().toISOString(),
): string {
  const envelope = validateAnalysisHistoryExport({
    schemaVersion: ANALYSIS_HISTORY_SCHEMA_VERSION,
    exportedAt,
    entries: mergeAnalysisHistory([], entries),
  });
  return JSON.stringify(envelope, null, 2);
}

export function parseAnalysisHistoryExport(serialized: string): AnalysisHistoryEntry[] {
  if (serialized.length > 64 * 1024 * 1024) {
    throw new TypeError("AI 分析历史文件过大");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new TypeError("AI 分析历史文件不是有效 JSON", { cause: error });
  }
  return mergeAnalysisHistory([], validateAnalysisHistoryExport(parsed).entries);
}

export function findLatestByAnalysisKey(
  entries: readonly AnalysisHistoryEntry[],
  analysisKey: AnalysisKey | string,
): AnalysisHistoryEntry | null {
  return (
    mergeAnalysisHistory([], entries)
      .filter((entry) => entry.analysisKey === analysisKey)
      .sort((left, right) => Date.parse(right.completedAt) - Date.parse(left.completedAt))[0] ??
    null
  );
}

/**
 * Finds the newest successful result for one immutable snapshot regardless of
 * analyzer, rules, transport, provider, model, or mode version. Callers use
 * this broader lookup to surface an older result without silently creating a
 * new paid request after an extension or protocol upgrade.
 */
export function findLatestBySnapshotId(
  entries: readonly AnalysisHistoryEntry[],
  snapshotId: SnapshotId | string,
): AnalysisHistoryEntry | null {
  return (
    mergeAnalysisHistory([], entries)
      .filter((entry) => entry.snapshotId === snapshotId)
      .sort((left, right) => Date.parse(right.completedAt) - Date.parse(left.completedAt))[0] ??
    null
  );
}
