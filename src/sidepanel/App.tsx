import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import {
  CLOUD_ANALYZER_VERSION,
  DEFAULT_CLOUD_ANALYSIS_MODE,
  type CloudNarrativeNote,
  type CloudAnalysisMode,
  type CloudAnalysisResult,
  type LegacyWholeThreadCloudReport,
  type WholeThreadCloudReportV3,
  WHOLE_THREAD_ANALYSIS_TIMEOUT_MS,
  type WholeThreadCloudFindingNarrativeReferences,
  type WholeThreadCloudReportNarrativeReferences,
  type WholeThreadCloudAnalysisResult,
} from "../lib/cloud";
import {
  buildCloudPreflight,
  type CloudPreflight,
} from "../lib/cloudPreflight";
import {
  CLOUD_PROVIDER_DEFAULTS,
  DEFAULT_CLOUD_PROVIDER,
} from "../lib/cloudPermission";
import {
  createReviewRecord,
  parseReviewRecords,
  serializeReviewRecords,
} from "../lib/records";
import {
  createAnalysisHistoryEntry,
  findLatestByAnalysisKey,
  findLatestBySnapshotId,
  mergeAnalysisHistory,
  parseAnalysisHistoryExport,
  serializeAnalysisHistoryExport,
  type AnalysisHistoryEntry,
  type AnalysisHistoryReplyRef,
} from "../lib/analysisHistory";
import { copyText } from "../lib/clipboard";
import type { ReviewSession } from "../lib/session";
import { createSnapshotId } from "../lib/threadIdentity";
import {
  isCaptureProgressMessage,
  isSessionClearedMessage,
  isSessionSuspendedMessage,
  isSessionUpdatedMessage,
  type CaptureProgressMessage,
} from "../messages";
import {
  REASON_CATEGORIES,
  REASON_RULES,
  REASON_VERSION,
  getReasonById,
} from "../data/reasons";
import type {
  CapturedReply,
  CloudProvider,
  Finding,
  ReviewRecord,
  RiskType,
} from "../types";
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
  THREAD_CLOUD_TRANSPORT_VERSION,
  threadCloudCacheIdentity,
  type ThreadCloudBillingReceipt,
  type ThreadCloudCacheEntry,
  type ThreadCloudCacheIdentity,
  type ThreadCloudPreparingCacheEntry,
} from "../lib/threadCloudCache";
import {
  getActiveTabId,
  isPersistentCloudPermissionRequired,
  requestPersistentCloudPermission,
  runManagedCloudAnalysis,
  runManagedWholeThreadCloudAnalysis,
  sendExtensionMessage,
} from "./bridge";
import {
  clearCloudApiKey,
  DEFAULT_THEME_MODE,
  loadCloudApiKey,
  loadCloudSettings,
  loadAnalysisHistory,
  loadMonthlyCloudUsage,
  loadStoredRecords,
  loadThemeMode,
  saveCloudSettings,
  recordCloudUsage,
  deleteAnalysisHistoryEntry,
  replaceAnalysisHistory,
  saveAnalysisHistoryEntry,
  saveStoredRecords,
  saveThemeMode,
  type CloudSettings,
  type CloudUsageLedgerEntry,
  type ThemeMode,
} from "./recordStore";
import {
  DEMO_REVIEW_FIXTURES,
  DEMO_SESSION,
  type DemoReviewScenarioId,
} from "./demo";

type View = "review" | "reasons" | "history" | "settings";
type Decision = ReviewRecord["decision"];
type AnalysisJobStatus = ThreadCloudCacheEntry["status"];

interface AnalysisJobView extends ThreadCloudCacheIdentity {
  attemptId: string;
  tabId: number;
  threadId: string | null;
  title: string;
  status: AnalysisJobStatus;
  startedAt: string;
  sentAt: string | null;
  deadlineAt: string | null;
  error: string | null;
  result: WholeThreadCloudAnalysisResult | null;
  restoredFromOlderVersion?: boolean;
}

interface PaidRetryConfirmation {
  session: ReviewSession;
  reason: "retry_after_send" | "reanalyze_success";
}

type WholeThreadAnalysisIntent =
  | { kind: "initial" }
  | { kind: "retry_before_send"; attemptId: string }
  | { kind: "paid_retry" };

interface SnapshotReviewDraft {
  selectedFindingId: string | null;
  selectedReasonId: string | null;
  decision: Decision;
  expandedFindingIds: string[];
}
type PendingCloudConfirmation = CloudPreflight & {
  findingId: string;
  tabId: number;
  threadId: string | null;
  sessionUpdatedAt: string;
  endpoint: string;
  model: string;
  mode: CloudAnalysisMode;
  provider: CloudProvider;
};

const riskLabels: Record<RiskType, string> = {
  personal_attack: "人身攻击",
  provocation: "挑衅引战",
  harassment: "挂人骚扰",
  spam: "刷屏重复",
  privacy: "隐私风险",
  other: "其他风险",
};

const severityLabels = {
  low: "留意",
  medium: "中风险",
  high: "高风险",
  critical: "紧急",
} as const;

const cloudModeLabels: Record<CloudAnalysisMode, string> = {
  fast: "快速（关闭模型思考，整帖最长 3 分钟）",
  deep: "深度（开启模型思考，整帖最长 10 分钟）",
};

const cloudProviderLabels: Record<CloudProvider, string> = {
  alibaba: "阿里云百炼（Qwen）",
  deepseek: "DeepSeek",
};

const MAX_LOCAL_IMPORT_BYTES = 8 * 1024 * 1024;

function canonicalTiebaThread(
  threadUrl: string,
): { threadId: string; threadUrl: string } | null {
  try {
    const url = new URL(threadUrl);
    const threadId = url.pathname.match(/^\/p\/(\d+)(?:\/|$)/u)?.[1];
    if (
      url.protocol !== "https:" ||
      url.hostname !== "tieba.baidu.com" ||
      !threadId
    ) {
      return null;
    }
    return {
      threadId,
      threadUrl: `https://tieba.baidu.com/p/${threadId}`,
    };
  } catch {
    return null;
  }
}

function sessionHasCanonicalThreadIdentity(session: ReviewSession): boolean {
  const canonical = canonicalTiebaThread(session.threadUrl);
  return Boolean(
    session.threadId &&
      canonical &&
      canonical.threadId === session.threadId,
  );
}

function billingReceiptBlocksNewRequest(
  receipt: ThreadCloudBillingReceipt | null,
): receipt is ThreadCloudBillingReceipt {
  return Boolean(receipt && receipt.status !== "failed_before_send");
}

function billingReceiptBlockMessage(
  receipt: ThreadCloudBillingReceipt,
): string {
  switch (receipt.status) {
    case "preparing":
      return "同一内容快照已有另一项任务正在准备。为避免并发重复计费，本次不会创建或发送新请求。";
    case "sent":
      return "同一内容快照已有请求发出，但结果尚未确认。为避免重复计费，不会自动重发。";
    case "success":
      return "同一内容快照已有成功分析的计费记录。当前没有可安全恢复的精确报告，不会自动再次付费。";
    case "history_deleted":
      return "这份本机 AI 报告已删除；防重复计费标记仍保留。重新分析必须由你明确确认再次付费。";
    case "failed_before_send":
      return "上一次任务在正文发送前失败，可以安全重新开始。";
  }
}

function analysisHistoryPersistenceError(caught: unknown): string {
  const message =
    caught instanceof Error && caught.message.trim()
      ? caught.message.trim()
      : "本机 AI 分析历史保存失败。";
  return /(?:100\s*条|4\s*MiB)/iu.test(message)
    ? `${message} 可先在“历史”页导出备份，再删除不需要的报告后重试。`
    : message;
}

function historyEntryMatchesSessionThread(
  entry: AnalysisHistoryEntry,
  session: ReviewSession,
): boolean {
  const canonical = canonicalTiebaThread(session.threadUrl);
  return Boolean(
    session.threadId &&
      canonical &&
      canonical.threadId === session.threadId &&
      entry.threadId === session.threadId &&
      entry.threadUrl === canonical.threadUrl,
  );
}

function decisionLabel(value: Decision): string {
  if (value === "delete") return "建议删除";
  if (value === "keep") return "确认保留";
  if (value === "watch") return "继续观察";
  return "尚未决定";
}

function historyReplyLabel(reply: AnalysisHistoryReplyRef): string {
  if (reply.floor === 1 && !reply.isNested) return "主楼（1楼）";
  if (reply.floor !== null) {
    return reply.isNested
      ? `第 ${reply.floor} 楼的楼中楼`
      : `第 ${reply.floor} 楼`;
  }
  return reply.isNested
    ? `第 ${reply.sourcePage} 页的楼中楼`
    : `第 ${reply.sourcePage} 页的回复`;
}

function reviewRecordMatchesHistoryEntry(
  record: ReviewRecord,
  entry: AnalysisHistoryEntry,
): boolean {
  if (
    record.analysisAttemptId !== entry.attemptId ||
    record.snapshotId !== entry.snapshotId ||
    record.threadId !== entry.threadId
  ) {
    return false;
  }
  return (
    !record.findingId ||
    entry.result.findings.some((finding) => finding.id === record.findingId)
  );
}

function friendlyTime(value: string | null): string {
  if (!value) return "时间未知";
  return value.replace(/^\s+|\s+$/gu, "");
}

function floorLabel(reply: CapturedReply): string {
  const floor =
    typeof reply.floor === "number" &&
    Number.isFinite(reply.floor) &&
    reply.floor > 0
      ? reply.floor
      : null;
  if (reply.isNested) {
    return floor ? `第 ${floor} 楼的楼中楼` : "楼中楼（父楼未知）";
  }
  if (floor === 1) return "主楼（1楼）";
  return floor ? `第 ${floor} 楼` : "主回复（楼层未知）";
}

/**
 * Cloud prose may refer to the deliberately anonymous wire identifiers. Keep
 * those identifiers off the review surface: the reviewer needs the real
 * floor and locally held display name, neither of which is sent back out.
 */
function resolveCloudAliases(
  value: string,
  replies: readonly CapturedReply[],
): string {
  const authors: string[] = [];
  const seenAuthors = new Set<string>();
  for (const reply of replies) {
    const author = reply.authorName?.trim();
    if (author && !seenAuthors.has(author)) {
      seenAuthors.add(author);
      authors.push(author);
    }
  }

  return value.replace(
    /(^|[^A-Za-z0-9_])([PU])(\d+)(?=$|[^A-Za-z0-9_])/gu,
    (
      _alias,
      prefix: string,
      kind: string,
      rawIndex: string,
    ) => {
      const index = Number(rawIndex) - 1;
      if (!Number.isSafeInteger(index) || index < 0) {
        return `${prefix}${kind === "P" ? "无法定位的回复" : "无法定位的用户"}`;
      }
      if (kind === "U") {
        return `${prefix}${authors[index] ?? "无法定位的用户"}`;
      }
      const reply = replies[index];
      if (!reply) return `${prefix}无法定位的回复`;
      const author = reply.authorName?.trim() || "用户未知";
      return `${prefix}${floorLabel(reply)}（${author}）`;
    },
  );
}

function elapsedLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes} 分 ${rest} 秒` : `${rest} 秒`;
}

function resolveCloudReasonReferences(value: string): string {
  return value.replace(
    /(^|[^A-Za-z0-9_])(R\d{2}\.\d{2})(?=$|[^A-Za-z0-9_])/giu,
    (_match, prefix: string, rawReasonId: string) => {
      const reason = getReasonById(rawReasonId.toUpperCase());
      if (!reason) {
        return `${prefix}当前理由库中不存在对应条目的规范（模型引用无效）`;
      }
      const detail = reason.text.replace(/[。！？；]+$/u, "");
      return `${prefix}“${detail}”这一规范`;
    },
  );
}

function resolveCloudDisplayText(
  value: string,
  replies: readonly CapturedReply[],
): string {
  return resolveCloudReasonReferences(resolveCloudAliases(value, replies));
}

function cloudNarrativeLines(
  value: string,
  replies: readonly CapturedReply[],
): string[] {
  return resolveCloudDisplayText(value, replies)
    .replace(
      /^\s*(第(?:[一二三四五六七八九十百零〇两]+|\d+)\s*阶段[^：:\n]{0,240}[：:])\s*/u,
      "$1\n",
    )
    .replace(
      /([、，])\s*(?=(?:主楼（1楼）|第\s*\d+\s*楼|楼中楼（父楼未知）))/gu,
      "$1\n",
    )
    .replace(/([。！？；])\s*(?=\S)/gu, "$1\n")
    .replace(/([：:])\s*(?=\d+[.)、])/gu, "$1\n")
    .replace(/\s+(?=\d+[.)、])/gu, "\n")
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean);
}

const NARRATIVE_REPLY_PREVIEW_LENGTH = 240;

function narrativeReplyText(reply: CapturedReply): {
  preview: string;
  full: string | null;
  unavailable: boolean;
} {
  const content = reply.content.trim();
  if (!content) {
    return {
      preview:
        reply.imageCount > 0
          ? `这条回复只包含 ${reply.imageCount} 张未识别图片，接口没有返回可读文字。`
          : "接口没有返回这条回复的可读文字。",
      full: null,
      unavailable: true,
    };
  }
  if (/^[※*＊⋯…·\s]+$/u.test(content)) {
    return {
      preview: "贴吧接口仅返回屏蔽占位符，扩展无法还原这条回复原本的文字。",
      full: null,
      unavailable: true,
    };
  }
  const characters = Array.from(content);
  if (characters.length <= NARRATIVE_REPLY_PREVIEW_LENGTH) {
    return { preview: content, full: null, unavailable: false };
  }
  return {
    preview: `${characters.slice(0, NARRATIVE_REPLY_PREVIEW_LENGTH).join("")}…`,
    full: content,
    unavailable: false,
  };
}

function NarrativeReplyEvidence({
  replyId,
  reply,
  onJump,
  ordinal,
  jumping,
}: {
  replyId: string;
  reply: CapturedReply;
  onJump: (replyId: string) => void;
  ordinal?: number;
  jumping?: boolean;
}) {
  const text = narrativeReplyText(reply);
  const author = reply.authorName?.trim() || "用户未知";
  const location = floorLabel(reply);
  return (
    <article
      className="narrative-reference-evidence"
      aria-label={`${location}，${author}的回复`}
    >
      <header>
        <b>{location}</b>
        <span>{author}</span>
        {ordinal && <small>第 {ordinal} 条</small>}
        <time>{friendlyTime(reply.time)}</time>
      </header>
      <div className={text.unavailable ? "narrative-evidence-unavailable" : ""}>
        <small>{text.unavailable ? "读取说明" : "原文摘录"}</small>
        <blockquote>{text.preview}</blockquote>
        {reply.imageCount > 0 && !text.unavailable && (
          <p>另含 {reply.imageCount} 张未识别图片，本处只显示接口返回的文字。</p>
        )}
      </div>
      {text.full && (
        <details className="narrative-evidence-full-text">
          <summary>展开完整回复</summary>
          <blockquote>{text.full}</blockquote>
        </details>
      )}
      <button
        type="button"
        onClick={() => onJump(replyId)}
        aria-label={`在原帖定位：${location}，${author}，${friendlyTime(reply.time)}`}
        aria-busy={jumping || undefined}
      >
        {jumping ? "定位中…" : "在原帖定位"} <Icon name="arrow" />
      </button>
    </article>
  );
}

function NarrativeReferenceLinks({
  replyIds,
  replies,
  onJump,
  layout = "wrapped",
  showExcerpt = false,
  jumpingReplyId = null,
}: {
  replyIds: readonly string[] | undefined;
  replies: Map<string, CapturedReply>;
  onJump: (replyId: string) => void;
  layout?: "wrapped" | "stacked";
  showExcerpt?: boolean;
  jumpingReplyId?: string | null;
}) {
  const referencedReplies = [...new Set(replyIds ?? [])].flatMap((replyId) => {
    const reply = replies.get(replyId);
    return reply ? [{ replyId, reply }] : [];
  });
  if (referencedReplies.length === 0) return null;
  const groups = [...referencedReplies.reduce((grouped, item) => {
    const author = item.reply.authorName?.trim() || "用户未知";
    const key = item.reply.isNested
      ? item.reply.parentReplyId
        ? JSON.stringify([item.reply.parentReplyId, author])
        : item.replyId
      : item.replyId;
    const current = grouped.get(key) ?? [];
    current.push(item);
    grouped.set(key, current);
    return grouped;
  }, new Map<string, typeof referencedReplies>()).values()];

  return (
    <details
      className={`narrative-reference-links ${layout === "stacked" ? "is-stacked" : ""} ${showExcerpt ? "has-excerpts" : ""}`}
    >
      <summary>
        相关回复 {referencedReplies.length} 条
      </summary>
      <div aria-label="这段说明引用的原帖回复">
        {groups.map((group) => {
          const first = group[0]!;
          if (group.length === 1) {
            if (showExcerpt) {
              return (
                <NarrativeReplyEvidence
                  key={first.replyId}
                  replyId={first.replyId}
                  reply={first.reply}
                  onJump={onJump}
                  jumping={jumpingReplyId === first.replyId}
                />
              );
            }
            return (
              <button type="button" key={first.replyId} onClick={() => onJump(first.replyId)}>
                <span className="visually-hidden">定位引用：</span>
                <b>{floorLabel(first.reply)}</b>
                <span>{first.reply.authorName?.trim() || "用户未知"}</span>
                <Icon name="arrow" />
              </button>
            );
          }
          return (
            <details
              className="narrative-reference-group"
              key={JSON.stringify([
                first.reply.parentReplyId,
                first.reply.authorName?.trim() || "用户未知",
              ])}
            >
              <summary>
                <b>{floorLabel(first.reply)}</b>
                <span>{first.reply.authorName?.trim() || "用户未知"} · {group.length} 条</span>
              </summary>
              <div>
                {group.map(({ replyId, reply }, index) => (
                  showExcerpt ? (
                    <NarrativeReplyEvidence
                      key={replyId}
                      replyId={replyId}
                      reply={reply}
                      onJump={onJump}
                      ordinal={index + 1}
                      jumping={jumpingReplyId === replyId}
                    />
                  ) : (
                    <button type="button" key={replyId} onClick={() => onJump(replyId)}>
                      <span>第 {index + 1} 条 · {friendlyTime(reply.time)}</span>
                      <Icon name="arrow" />
                    </button>
                  )
                ))}
              </div>
            </details>
          );
        })}
      </div>
    </details>
  );
}

function CloudNarrative({
  value,
  replies,
  className,
  references,
  replyMap,
  onJump,
}: {
  value: string;
  replies: readonly CapturedReply[];
  className: string;
  references?: CloudNarrativeNote;
  replyMap?: Map<string, CapturedReply>;
  onJump?: (replyId: string) => void;
}) {
  return (
    <div className={className}>
      {cloudNarrativeLines(value, replies).map((line, index) => (
        <p key={`${index}:${line}`}>{line}</p>
      ))}
      {replyMap && onJump && (
        <NarrativeReferenceLinks
          replyIds={references?.replyIds}
          replies={replyMap}
          onJump={onJump}
        />
      )}
    </div>
  );
}

function WholeThreadReportSection({
  title,
  label,
  items,
  replies,
  references,
  replyMap,
  onJump,
  ordered = false,
  tone = "neutral",
}: {
  title: string;
  label: string;
  items: readonly string[];
  replies: readonly CapturedReply[];
  references?: readonly CloudNarrativeNote[];
  replyMap: Map<string, CapturedReply>;
  onJump: (replyId: string) => void;
  ordered?: boolean;
  tone?: "neutral" | "priority" | "caution" | "safe" | "coverage";
}) {
  const notes = items.flatMap((item, index) => {
    const lines = cloudNarrativeLines(item, replies);
    return lines.length > 0 ? [{ lines, reference: references?.[index] }] : [];
  });
  if (notes.length === 0) return null;

  const List = ordered ? "ol" : "ul";
  return (
    <section className={`cloud-report-section tone-${tone}`}>
      <header>
        <small>{label}</small>
        <h3>{title}</h3>
      </header>
      <List>
        {notes.map(({ lines, reference }, index) => (
          <li key={`${index}:${lines.join("\n")}`}>
            {lines.map((line, lineIndex) => (
              <p key={`${lineIndex}:${line}`}>{line}</p>
            ))}
            <NarrativeReferenceLinks
              replyIds={reference?.replyIds}
              replies={replyMap}
              onJump={onJump}
              layout="stacked"
            />
          </li>
        ))}
      </List>
    </section>
  );
}

function WholeThreadLongReport({
  report,
  replies,
  references,
  replyMap,
  onJump,
  placement,
}: {
  report: LegacyWholeThreadCloudReport;
  replies: readonly CapturedReply[];
  references?: WholeThreadCloudReportNarrativeReferences;
  replyMap: Map<string, CapturedReply>;
  onJump: (replyId: string) => void;
  placement: "before-findings" | "after-findings";
}) {
  if (placement === "before-findings") {
    return (
      <div className="cloud-report-sections cloud-report-context">
        {report.discussionOverview.trim() && (
          <section className="cloud-report-section cloud-report-discussion">
            <header>
              <small>整帖理解</small>
              <h3>讨论主题与整体走向</h3>
            </header>
            <CloudNarrative
              value={report.discussionOverview}
              replies={replies}
              className="cloud-report-prose"
              references={references?.discussionOverview}
              replyMap={replyMap}
              onJump={onJump}
            />
          </section>
        )}
        <WholeThreadReportSection
          title="议题与讨论脉络"
          label="讨论地图"
          items={report.discussionMap}
          replies={replies}
          references={references?.discussionMap}
          replyMap={replyMap}
          onJump={onJump}
        />
        <WholeThreadReportSection
          title="参与者与回复关系"
          label="互动结构"
          items={report.participantDynamics}
          replies={replies}
          references={references?.participantDynamics}
          replyMap={replyMap}
          onJump={onJump}
        />
        <WholeThreadReportSection
          title="吧务复核优先级"
          label="建议顺序"
          items={report.reviewPriorities}
          replies={replies}
          references={references?.reviewPriorities}
          replyMap={replyMap}
          onJump={onJump}
          ordered
          tone="priority"
        />
      </div>
    );
  }

  return (
    <div className="cloud-report-sections cloud-report-qualifiers">
      <WholeThreadReportSection
        title="边界案例（暂不列为违规）"
        label="需人工权衡"
        items={report.borderlineCases}
        replies={replies}
        references={references?.borderlineCases}
        replyMap={replyMap}
        onJump={onJump}
        tone="caution"
      />
      <WholeThreadReportSection
        title="激烈但正常的讨论"
        label="不建议处罚"
        items={report.normalHeatedDiscussion}
        replies={replies}
        references={references?.normalHeatedDiscussion}
        replyMap={replyMap}
        onJump={onJump}
        tone="safe"
      />
      <WholeThreadReportSection
        title="覆盖范围与未审内容"
        label="审阅局限"
        items={report.coverageNotes}
        replies={replies}
        references={references?.coverageNotes}
        replyMap={replyMap}
        onJump={onJump}
        tone="coverage"
      />
    </div>
  );
}

function WholeThreadFindingItem({
  finding,
  index,
  replies,
  references,
  selected,
  expanded,
  jumpingReplyId,
  onSelect,
  onToggle,
  onJump,
}: {
  finding: Finding;
  index: number;
  replies: Map<string, CapturedReply>;
  references?: WholeThreadCloudFindingNarrativeReferences;
  selected: boolean;
  expanded: boolean;
  jumpingReplyId: string | null;
  onSelect: () => void;
  onToggle: () => void;
  onJump: (replyId: string) => void;
}) {
  const orderedReplies = [...replies.values()];
  const candidate = finding.reasonCandidates[0];
  const reason = candidate ? getReasonById(candidate.reasonId) : undefined;
  const titleId = `cloud-finding-title-${finding.id.replace(/[^A-Za-z0-9_-]/gu, "-")}`;
  const detailId = `cloud-finding-detail-${finding.id.replace(/[^A-Za-z0-9_-]/gu, "-")}`;
  const primaryReplyId = finding.replyIds[0] ?? null;
  const primaryReply = primaryReplyId ? replies.get(primaryReplyId) : undefined;
  const primaryEvidence = primaryReplyId
    ? finding.evidence.find((item) => item.replyId === primaryReplyId)
    : undefined;
  const primaryExcerpt = primaryEvidence?.excerpt ?? primaryReply?.content.trim();
  const confidence = candidate
    ? `${Math.round(candidate.confidence * 100)}%`
    : "未提供";
  return (
    <article
      className={`cloud-finding-item ${selected ? "selected" : ""}`}
      aria-labelledby={titleId}
    >
      <div className="cloud-finding-topline">
        <span>待复核 {index + 1}</span>
        <span className={`severity-badge ${finding.severity}`}>
          {severityLabels[finding.severity]}
        </span>
        <span>模型把握 {confidence}</span>
      </div>
      <h4 id={titleId}>{riskLabels[finding.type]}：{resolveCloudDisplayText(finding.summary, orderedReplies)}</h4>
      {primaryReplyId && (
        <button
          className="cloud-reply-link cloud-primary-evidence"
          type="button"
          onClick={() => onJump(primaryReplyId)}
          aria-busy={jumpingReplyId === primaryReplyId || undefined}
        >
          <span className="cloud-reply-content">
            <span className="cloud-reply-meta">
              <b>{primaryReply ? floorLabel(primaryReply) : "无法定位的回复"}</b>
              <small>{primaryReply?.authorName?.trim() || "用户未知"}</small>
              <time>{friendlyTime(primaryReply?.time ?? null)}</time>
            </span>
            {primaryExcerpt && (
              <span className="cloud-reply-excerpt" title={primaryExcerpt}>
                “{primaryExcerpt}”
              </span>
            )}
          </span>
          <span className="jump-hint">
            {jumpingReplyId === primaryReplyId ? "定位中…" : "查看原文"} <Icon name="arrow" />
          </span>
        </button>
      )}
      {reason && (
        <div className="cloud-finding-reason">
          <small>可能涉及规范</small>
          <p>{reason.text}</p>
        </div>
      )}
      <div className="cloud-finding-actions">
        <button
          className="secondary-button cloud-finding-select"
          type="button"
          aria-pressed={selected}
          onClick={onSelect}
        >
          {selected ? "已选为处理对象" : "选择处理"}
        </button>
        <button
          className="text-button cloud-finding-expand"
          type="button"
          aria-expanded={expanded}
          aria-controls={detailId}
          onClick={onToggle}
        >
          {expanded ? "收起详情" : "查看依据与上下文"}
        </button>
      </div>
      {expanded && (
        <div className="cloud-finding-detail" id={detailId}>
          {finding.replyIds.length > 1 && (
            <section className="cloud-finding-evidence">
              <h5>其他支持定性的证据</h5>
              <div className="cloud-reply-links" aria-label="其他涉及的原帖回复">
                {finding.replyIds.slice(1).map((replyId) => {
                  const reply = replies.get(replyId);
                  const evidence = finding.evidence.find((item) => item.replyId === replyId);
                  const excerpt = evidence?.excerpt ?? reply?.content.trim();
                  return (
                    <button
                      className="cloud-reply-link"
                      key={replyId}
                      type="button"
                      onClick={() => onJump(replyId)}
                      aria-busy={jumpingReplyId === replyId || undefined}
                    >
                      <span className="cloud-reply-content">
                        <span className="cloud-reply-meta">
                          <b>{reply ? floorLabel(reply) : "无法定位的回复"}</b>
                          <small>{reply?.authorName?.trim() || "用户未知"}</small>
                          <time>{friendlyTime(reply?.time ?? null)}</time>
                        </span>
                        {excerpt && <span className="cloud-reply-excerpt">“{excerpt}”</span>}
                      </span>
                      <span className="jump-hint">查看原文 <Icon name="arrow" /></span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}
          {(finding.contextReplyIds?.length ?? 0) > 0 && (
            <section className="cloud-finding-context">
              <h5>普通上下文（不作为违规证据）</h5>
              <div className="cloud-reply-links cloud-context-reply-links">
                {finding.contextReplyIds?.map((replyId) => {
                  const reply = replies.get(replyId);
                  return (
                    <button
                      className="cloud-reply-link cloud-context-reply-link"
                      key={replyId}
                      type="button"
                      onClick={() => onJump(replyId)}
                      aria-busy={jumpingReplyId === replyId || undefined}
                    >
                      <span className="cloud-reply-content">
                        <span className="cloud-reply-meta">
                          <b>{reply ? floorLabel(reply) : "无法定位的回复"}</b>
                          <small>{reply?.authorName?.trim() || "用户未知"}</small>
                          <time>{friendlyTime(reply?.time ?? null)}</time>
                        </span>
                      </span>
                      <span className="jump-hint">查看原文 <Icon name="arrow" /></span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}
          {candidate?.rationale && (
            <section className="cloud-finding-rationale">
              <h5>为什么可能涉及这条规范</h5>
              <CloudNarrative
                value={candidate.rationale}
                replies={orderedReplies}
                className="cloud-finding-rationale-copy"
                references={references?.rationale}
                replyMap={replies}
                onJump={onJump}
              />
            </section>
          )}
          {finding.uncertainties.length > 0 && (
            <section className="cloud-finding-cautions">
              <h5>为什么仍需人工确认</h5>
              <ul>
                {finding.uncertainties.map((item, uncertaintyIndex) => (
                  <li key={`${uncertaintyIndex}:${item}`}>
                    {cloudNarrativeLines(item, orderedReplies).map((line, lineIndex) => (
                      <p key={`${lineIndex}:${line}`}>{line}</p>
                    ))}
                    <NarrativeReferenceLinks
                      replyIds={references?.uncertainties[uncertaintyIndex]?.replyIds}
                      replies={replies}
                      onJump={onJump}
                      layout="stacked"
                    />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </article>
  );
}

function StructuredNarrativeItems({
  title,
  items,
  replies,
  onJump,
}: {
  title: string;
  items: WholeThreadCloudReportV3["stages"];
  replies: Map<string, CapturedReply>;
  onJump: (replyId: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section className="structured-report-group">
      <h4>{title}</h4>
      <ol>
        {items.map((item, index) => (
          <li key={`${index}:${item.title}`}>
            <strong>{item.title}</strong>
            <p>{item.summary}</p>
            <NarrativeReferenceLinks
              replyIds={item.replyIds}
              replies={replies}
              onJump={onJump}
              layout="stacked"
            />
          </li>
        ))}
      </ol>
    </section>
  );
}

function WholeThreadV3Details({
  report,
  replies,
  onJump,
}: {
  report: WholeThreadCloudReportV3;
  replies: Map<string, CapturedReply>;
  onJump: (replyId: string) => void;
}) {
  const allowedNotes = report.notes.filter(
    (note) => note.kind === "heated_but_allowed",
  );
  return (
    <details className="analysis-details">
      <summary>分析详情（讨论背景与正常激烈内容）</summary>
      <div className="analysis-details-body">
        {report.overview && (
          <section className="structured-report-overview">
            <h4>讨论背景</h4>
            <p>{report.overview}</p>
          </section>
        )}
        <StructuredNarrativeItems
          title="讨论阶段"
          items={report.stages}
          replies={replies}
          onJump={onJump}
        />
        <StructuredNarrativeItems
          title="关键互动"
          items={report.interactions}
          replies={replies}
          onJump={onJump}
        />
        <StructuredNarrativeItems
          title="激烈但暂未列为线索"
          items={allowedNotes}
          replies={replies}
          onJump={onJump}
        />
      </div>
    </details>
  );
}

function Icon({ name }: { name: "shield" | "scan" | "copy" | "arrow" | "download" | "trash" | "cloud" | "sun" | "moon" }) {
  const paths = {
    shield: <path d="M12 3 5.5 5.5v5.7c0 4.2 2.8 7.8 6.5 9.8 3.7-2 6.5-5.6 6.5-9.8V5.5L12 3Z" />,
    scan: <><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M8 12h8M12 8v8"/></>,
    copy: <><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></>,
    arrow: <><path d="M5 12h14M13 6l6 6-6 6"/></>,
    download: <><path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/></>,
    trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14"/></>,
    cloud: <><path d="M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 8.5 4.5 4.5 0 0 0 7 18Z"/><path d="M12 11v5M9.5 13.5 12 11l2.5 2.5"/></>,
    sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"/></>,
    moon: <path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5 8.5 8.5 0 1 0 20.5 14.2Z"/>,
  };
  return <svg aria-hidden="true" className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

interface CaptureStructureIssue {
  count: number | null;
  message: string | null;
}

function captureStructureIssue(
  session: Pick<ReviewSession, "coverage" | "errors" | "warnings">,
): CaptureStructureIssue | null {
  const { coverage } = session;
  const api = coverage.apiCoverage;
  if (
    coverage.captureMode !== "api" ||
    !api ||
    api.readableTextComplete
  ) {
    return null;
  }

  const message = [...session.errors, ...session.warnings].find(
    (issue) =>
      /缺少稳定\s*ID|未识别的数据节点|稳定\s*ID\s*重复|分页总数发生漂移|节点诊断数据不一致|终页数量差额未通过空页哨兵验证|无法(?:安全)?(?:解析|纳入|识别)/u.test(
        issue,
      ),
  ) ?? null;
  const countMatch = message?.match(/(\d+)\s*个[^，。；]{0,12}节点/u);
  const countFromMessage = countMatch ? Number(countMatch[1]) : null;
  if (message) {
    return {
      count: Number.isSafeInteger(countFromMessage) ? countFromMessage : null,
      message,
    };
  }
  return null;
}

function aiTextScopeNote(session: ReviewSession): string | null {
  const api = session.coverage.apiCoverage;
  if (!api?.readableTextComplete) return null;

  const exclusions: string[] = [];
  if (api.unavailableReplyCount > 0) {
    exclusions.push(
      `不会把 ${api.unavailableReplyCount} 条站点统计差额当作已读取内容`,
    );
  }
  if (session.coverage.imageCount > 0) {
    exclusions.push(
      `不包含 ${session.coverage.imageCount} 张图片中的文字`,
    );
  }
  return exclusions.length > 0
    ? `本次 AI 只分析已读取的文字；${exclusions.join("，")}。`
    : null;
}

function CoverageCard({ session }: { session: ReviewSession }) {
  const { coverage } = session;
  const dynamic = coverage.captureMode === "dynamic";
  const api = coverage.captureMode === "api";
  const apiCoverage = coverage.apiCoverage;
  const readableTextComplete = Boolean(
    api && apiCoverage?.readableTextComplete,
  );
  const structureIssue = captureStructureIssue(session);
  const apiReplyBreakdown = api
    ? `主层 ${coverage.mainReplyCount} 条（含主帖），楼中楼 ${coverage.nestedReplyCount} 条，合计 ${coverage.visibleReplyCount} 条可读内容。`
    : "";
  const scopeTitle = coverage.isComplete
    ? "已覆盖完整帖子"
    : api && apiCoverage?.readableTextComplete
      ? "接口可见文字已全部读取"
      : api
        ? "整帖接口读取仍有缺口"
    : dynamic
      ? "仅分析已累计内容"
      : "仅分析已访问内容";
  const stateLabel = coverage.isComplete
    ? "完整"
    : api && apiCoverage?.readableTextComplete
      ? "文字已读完"
      : "部分";
  return (
    <section className="coverage-card">
      <div className="coverage-topline">
        <div>
          <span className="eyebrow">当前采集范围</span>
          <strong>{scopeTitle}</strong>
        </div>
        <span className={`coverage-state ${coverage.isComplete || readableTextComplete ? "complete" : "partial"}`}>
          {stateLabel}
        </span>
      </div>
      <div className={`metrics ${api ? "api-metrics" : ""}`}>
        {api ? (
          <>
            <div><strong>{coverage.visibleReplyCount}</strong><span>可读内容合计</span></div>
            <div><strong>{apiCoverage ? `${apiCoverage.mainPagesFetched}/${apiCoverage.mainPagesTotal}` : "—"}</strong><span>主回复分页</span></div>
            <div><strong>{apiCoverage?.mainRepliesFetched ?? "—"}</strong><span>主层回复</span></div>
            <div><strong>{apiCoverage ? `${apiCoverage.nestedParentsFetched}/${apiCoverage.nestedParentsTotal}` : "—"}</strong><span>楼中楼父楼</span></div>
            <div className="nested-text-metric">
              <strong>{apiCoverage ? `${apiCoverage.nestedRepliesFetched} 条` : "—"}</strong>
              <span>楼中楼已读</span>
              {apiCoverage && <small>贴吧标注 {apiCoverage.nestedRepliesDeclared} 条</small>}
            </div>
            <div><strong>{apiCoverage?.failedRequestCount ?? "—"}</strong><span>失败请求</span></div>
            <div><strong>{apiCoverage ? `${apiCoverage.unavailableReplyCount} 条` : "—"}</strong><span>站点统计差额</span></div>
            <div><strong>{coverage.imageCount}</strong><span>未识别图片</span></div>
          </>
        ) : (
          <>
            <div><strong>{dynamic ? coverage.visibleReplyCount : coverage.analyzedPageNumbers.length}</strong><span>{dynamic ? "已累计回复" : "已访问页"}</span></div>
            <div><strong>{dynamic ? coverage.declaredReplyCount ?? "—" : coverage.visibleReplyCount}</strong><span>{dynamic ? "页面标注回复" : "文字回复"}</span></div>
            <div><strong>{coverage.unexpandedLzlCount}</strong><span>未展开</span></div>
            <div><strong>{coverage.imageCount}</strong><span>未识别图片</span></div>
          </>
        )}
      </div>
      {!coverage.isComplete && (
        <p className="coverage-note">
          {api
            ? apiCoverage?.readableTextComplete
              ? `${apiReplyBreakdown} 已读完接口当前能返回的主层和楼中楼。${apiCoverage.unavailableReplyCount > 0 ? ` 另有 ${apiCoverage.unavailableReplyCount} 条站点统计差额，可能来自已删除、审核中、当前账号不可见或不同接口的统计时点；这不是仍待抓取的回复。楼中楼标注差值与该数字可能重叠，不能相加。` : ""}${coverage.imageCount > 0 ? ` 另有 ${coverage.imageCount} 张图片未识别文字，文字分析不包含图片内容。` : ""}`
              : structureIssue
                ? `接口实际返回了${structureIssue.count === null ? "无法可靠解析的" : ` ${structureIssue.count} 个`}回复节点，但节点缺少稳定 ID 或结构无法识别。为避免漏读，暂不发送 AI。`
                : `接口分页尚未完整结束或请求失败；失败请求 ${apiCoverage?.failedRequestCount ?? 0} 个，不能据此判断整帖安全。`
            : dynamic
            ? coverage.reachedReplyListEnd
              ? "已到当前回复列表末尾；楼中楼、图片和虚拟列表缺口仍不会被当作已完整审阅。"
              : "继续滚动或手动展开后会自动补采；尚未挂载的回复不会被当作已审阅。"
            : "翻到下一页后会自动继续采集；楼中楼和图片未读部分不会被当作已审阅。"}
          {coverage.unstableReplyIdCount > 0
            ? ` 其中 ${coverage.unstableReplyIdCount} 条楼中楼缺少站点 ID，重载后的去重或跳转可能不完整。`
            : ""}
        </p>
      )}
    </section>
  );
}

interface CaptureDiagnosis {
  blocking: boolean;
  limitReached: boolean;
  structureUncertain: boolean;
  title: string;
  retryLabel: string;
}

export function buildCaptureDiagnosis(
  session: Pick<ReviewSession, "coverage" | "errors" | "warnings">,
): CaptureDiagnosis {
  const { coverage } = session;
  const api = coverage.apiCoverage;
  const limitReached = session.errors.some((error) =>
    /超过安全上限|结果已截断/u.test(error),
  );
  if (coverage.captureMode !== "api" || !api) {
    return {
      blocking: true,
      limitReached,
      structureUncertain: false,
      title: "整帖接口未完成，当前只有页面局部内容",
      retryLabel: "重新尝试整帖读取",
    };
  }
  if (!api.readableTextComplete) {
    const structureIssue = captureStructureIssue(session);
    const missingMainPages = Math.max(
      0,
      api.mainPagesTotal - api.mainPagesFetched,
    );
    const missingParents = Math.max(
      0,
      api.nestedParentsTotal - api.nestedParentsFetched,
    );
    const title = limitReached
      ? "读取达到安全上限，不能作为完整快照"
        : missingMainPages > 0
          ? `主回复仍缺 ${missingMainPages} 页`
        : api.failedRequestCount > 0
          ? `有 ${api.failedRequestCount} 个只读请求失败`
          : missingParents > 0
            ? `仍有 ${missingParents} 个楼中楼父楼未读完`
            : structureIssue
              ? structureIssue.count === null
                ? "接口回复结构无法可靠解析"
                : `有 ${structureIssue.count} 个接口回复节点无法可靠解析`
            : "接口返回内容未通过完整性校验";
    return {
      blocking: true,
      limitReached,
      structureUncertain: structureIssue !== null,
      title,
      retryLabel: api.failedRequestCount > 0
        ? "稍后重新读取整帖"
        : "重新读取整帖",
    };
  }
  return {
    blocking: false,
    limitReached: false,
    structureUncertain: false,
    title: "接口可见文字已读完",
    retryLabel: "重新读取整帖",
  };
}

function CaptureDiagnostics({ session }: { session: ReviewSession }) {
  const diagnosis = buildCaptureDiagnosis(session);
  const [open, setOpen] = useState(diagnosis.blocking);
  if (!diagnosis.blocking) return null;
  const hasDangerIssue =
    session.errors.length > 0 || diagnosis.structureUncertain;
  return (
    <details
      className={`coverage-details capture-diagnostics ${diagnosis.blocking ? "blocking" : ""} ${diagnosis.structureUncertain ? "structure-uncertain" : ""}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{diagnosis.title}</summary>
      <CoverageCard session={session} />
      {(session.errors.length > 0 || session.warnings.length > 0) && (
        <section className={`capture-issues ${hasDangerIssue ? "has-errors" : ""}`}>
          <strong>
            {hasDangerIssue
              ? "本次读取的具体问题"
              : "已读文字之外仍需人工注意"}
          </strong>
          <ul>
            {[...session.errors, ...session.warnings].map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </section>
      )}
    </details>
  );
}

function FindingCard({
  finding,
  replies,
  selected,
  cloudResult,
  cloudBusy,
  source,
  onSelectReason,
  onJump,
  onDeepAnalyze,
}: {
  finding: Finding;
  replies: Map<string, CapturedReply>;
  selected: boolean;
  cloudResult?: CloudAnalysisResult;
  cloudBusy: boolean;
  source: "cloud" | "local";
  onSelectReason: (reasonId: string) => void;
  onJump: (replyId: string) => void;
  onDeepAnalyze?: () => void;
}) {
  const bestReason = finding.reasonCandidates[0]
    ? getReasonById(finding.reasonCandidates[0].reasonId)
    : undefined;
  const orderedReplies = [...replies.values()];
  return (
    <article className={`finding-card severity-${finding.severity}`}>
      <div className="finding-heading">
        <div>
          <div className="finding-kicker">
            <span className={`severity-badge ${finding.severity}`}>{severityLabels[finding.severity]}</span>
            <span>{riskLabels[finding.type]}</span>
            <span>{source === "cloud" ? "整帖 AI" : "本地线索"}</span>
          </div>
          <h3>
            {source === "cloud"
              ? resolveCloudDisplayText(finding.summary, orderedReplies)
              : finding.summary}
          </h3>
        </div>
        <div className="score"><strong>{finding.score}</strong><span>线索分</span></div>
      </div>

      <div className="evidence-list">
        {finding.evidence.map((evidence) => {
          const reply = replies.get(evidence.replyId);
          return (
            <button className="evidence-row" key={evidence.replyId} onClick={() => onJump(evidence.replyId)}>
              <span className="evidence-meta">
                <b>{reply ? floorLabel(reply) : evidence.replyId}</b>
                <span>{reply?.authorName ?? "用户未知"}</span>
                <span className="jump-hint">查看原文 <Icon name="arrow" /></span>
              </span>
              <span className="evidence-quote">“{evidence.excerpt}”</span>
              <span className="signal-row">
                {evidence.signals.map((signal) => (
                  <i key={signal}>
                    {source === "cloud"
                      ? resolveCloudDisplayText(signal, orderedReplies)
                      : signal}
                  </i>
                ))}
              </span>
            </button>
          );
        })}
      </div>

      {bestReason && (
        <label className={`reason-suggestion ${selected ? "selected" : ""}`}>
          <input type="radio" name="reason" checked={selected} onChange={() => onSelectReason(bestReason.id)} />
          <span><small>建议理由 · {bestReason.id}</small>{bestReason.text}</span>
        </label>
      )}

      {cloudResult && (
        <div className="cloud-result">
          <span className="eyebrow">云端补充判断</span>
          <p>{resolveCloudDisplayText(cloudResult.summary, orderedReplies)}</p>
          {cloudResult.uncertainties.length > 0 && (
            <div className="cloud-result-cautions">
              <small>仍需留意</small>
              <ul>
                {cloudResult.uncertainties.map((item) => (
                  <li key={item}>{resolveCloudDisplayText(item, orderedReplies)}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {onDeepAnalyze ? (
        <div className="finding-actions">
          <button className="secondary-button" onClick={onDeepAnalyze} disabled={cloudBusy}>
            <Icon name="cloud" />{cloudBusy ? "正在脱敏分析…" : "深度分析此冲突"}
          </button>
          <span>不会自动执行处罚</span>
        </div>
      ) : (
        <div className="finding-actions">
          <span>模型只提供线索，必须回到原文人工决定</span>
        </div>
      )}
    </article>
  );
}

export function App({ initialTheme }: { initialTheme?: ThemeMode } = {}) {
  const [view, setView] = useState<View>("review");
  const [themeMode, setThemeMode] = useState<ThemeMode>(
    initialTheme ?? DEFAULT_THEME_MODE,
  );
  const [session, setSession] = useState<ReviewSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [captureProgress, setCaptureProgress] =
    useState<CaptureProgressMessage | null>(null);
  const [captureStartedAt, setCaptureStartedAt] = useState<number | null>(null);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeTone, setNoticeTone] = useState<"success" | "warning">(
    "success",
  );
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const [selectedReasonId, setSelectedReasonId] = useState<string | null>(null);
  const [decision, setDecision] = useState<Decision>("undecided");
  const [expandedFindingIds, setExpandedFindingIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [jumpingReplyId, setJumpingReplyId] = useState<string | null>(null);
  const [records, setRecords] = useState<ReviewRecord[]>([]);
  const [recordsReady, setRecordsReady] = useState(false);
  const [recordsLoadError, setRecordsLoadError] = useState<string | null>(null);
  const [analysisHistory, setAnalysisHistory] = useState<AnalysisHistoryEntry[]>([]);
  const [analysisHistoryReady, setAnalysisHistoryReady] = useState(false);
  const [analysisHistoryLoadError, setAnalysisHistoryLoadError] =
    useState<string | null>(null);
  const [historyDeleteAttemptId, setHistoryDeleteAttemptId] =
    useState<string | null>(null);
  const [monthlyUsage, setMonthlyUsage] = useState<CloudUsageLedgerEntry[]>([]);
  const [reasonQuery, setReasonQuery] = useState("");
  const [reasonCategory, setReasonCategory] = useState(
    REASON_CATEGORIES[0]?.id ?? "all",
  );
  const [reasonVisibleCount, setReasonVisibleCount] = useState(20);

  function showNotice(
    message: string,
    tone: "success" | "warning" = "success",
  ): void {
    setNoticeTone(tone);
    setNotice(message);
  }
  const [cloudSettings, setCloudSettings] = useState<CloudSettings>({
    schemaVersion: 2,
    provider: DEFAULT_CLOUD_PROVIDER,
    ...CLOUD_PROVIDER_DEFAULTS[DEFAULT_CLOUD_PROVIDER],
    apiKey: "",
    mode: DEFAULT_CLOUD_ANALYSIS_MODE,
    autoReadWholeThread: true,
    autoAnalyzeWholeThread: false,
  });
  const [savedCloudSettings, setSavedCloudSettings] =
    useState<CloudSettings>(cloudSettings);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [cloudApiKeyLoading, setCloudApiKeyLoading] = useState(false);
  const [cloudApiKeyClearConfirmation, setCloudApiKeyClearConfirmation] =
    useState<CloudProvider | null>(null);
  const [cloudSettingsReady, setCloudSettingsReady] = useState(false);
  const [cloudResults, setCloudResults] = useState<Record<string, CloudAnalysisResult>>({});
  const [cloudBusyId, setCloudBusyId] = useState<string | null>(null);
  const [cloudConfirmation, setCloudConfirmation] = useState<PendingCloudConfirmation | null>(null);
  const [paidRetryConfirmation, setPaidRetryConfirmation] =
    useState<PaidRetryConfirmation | null>(null);
  const [wholeThreadCloudResult, setWholeThreadCloudResult] =
    useState<WholeThreadCloudAnalysisResult | null>(null);
  const [analysisJobs, setAnalysisJobs] = useState<Record<string, AnalysisJobView>>({});
  const [wholeThreadCloudError, setWholeThreadCloudError] =
    useState<string | null>(null);
  const [wholeThreadCloudPermissionRequired, setWholeThreadCloudPermissionRequired] =
    useState(false);
  const [wholeThreadCloudPermissionBusy, setWholeThreadCloudPermissionBusy] =
    useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const reviewRecordImportRef = useRef<HTMLInputElement>(null);
  const cloudDialogRef = useRef<HTMLElement>(null);
  const cloudDialogCancelRef = useRef<HTMLButtonElement>(null);
  const cloudDialogTriggerRef = useRef<HTMLElement | null>(null);
  const historyDeleteCancelRef = useRef<HTMLButtonElement>(null);
  const historyDeleteTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const cloudAbortRef = useRef<AbortController | null>(null);
  const analysisControllersRef = useRef(new Map<string, AbortController>());
  const analysisStartLocksRef = useRef(new Set<string>());
  const analysisJobsRef = useRef<Record<string, AnalysisJobView>>({});
  const analysisHistoryRef = useRef<AnalysisHistoryEntry[]>([]);
  const analysisHistoryLoadRevisionRef = useRef(0);
  const reviewDraftsRef = useRef(new Map<string, SnapshotReviewDraft>());
  const activeDraftSnapshotRef = useRef<string | null>(null);
  const wholeThreadCloudPermissionRequestRef = useRef(false);
  const cloudSettingsSaveAttemptRef = useRef(0);
  const cloudApiKeyLoadAttemptRef = useRef(0);
  const apiKeyDraftRef = useRef("");
  const themeInteractedRef = useRef(false);
  const appMountedRef = useRef(true);
  const lastCloudSessionRevisionRef = useRef<string | null>(null);
  const activeReviewTabRef = useRef<number | null>(null);
  const activeContextGenerationRef = useRef(0);
  const autoCaptureAttemptedTabsRef = useRef(new Set<number>());
  const captureRequestRef = useRef<{ tabId: number; requestId: string } | null>(null);
  const sessionRef = useRef(session);
  const cloudSettingsRef = useRef(cloudSettings);
  const savedCloudSettingsRef = useRef(savedCloudSettings);
  activeReviewTabRef.current = session?.tabId ?? null;
  sessionRef.current = session;
  cloudSettingsRef.current = cloudSettings;
  savedCloudSettingsRef.current = savedCloudSettings;
  analysisJobsRef.current = analysisJobs;
  analysisHistoryRef.current = analysisHistory;

  const activeAnalysisIdentity = useMemo(() => {
    if (!session || !cloudSettingsReady) return null;
    return threadCloudCacheIdentity(session, savedCloudSettings);
  }, [
    session,
    savedCloudSettings.provider,
    savedCloudSettings.endpoint,
    savedCloudSettings.model,
    savedCloudSettings.mode,
    cloudSettingsReady,
  ]);
  const activeAnalysisJob = activeAnalysisIdentity
    ? analysisJobs[activeAnalysisIdentity.analysisKey]
    : undefined;
  const activeAnalysisAttemptId = wholeThreadCloudResult
    ? activeAnalysisJob?.status === "success" &&
      activeAnalysisJob.result === wholeThreadCloudResult
      ? activeAnalysisJob.attemptId
      : null
    : null;
  const wholeThreadCloudBusy =
    activeAnalysisJob?.status === "preparing" ||
    activeAnalysisJob?.status === "running";
  const otherTaskCount = Object.values(analysisJobs).filter(
    (job) =>
      job.analysisKey !== activeAnalysisIdentity?.analysisKey &&
      (job.status === "preparing" || job.status === "running"),
  ).length;
  const otherCompletedJobs = Object.values(analysisJobs).filter(
    (job) =>
      job.analysisKey !== activeAnalysisIdentity?.analysisKey &&
      job.status === "success",
  );

  const putAnalysisJob = (job: AnalysisJobView): void => {
    analysisJobsRef.current = {
      ...analysisJobsRef.current,
      [job.analysisKey]: job,
    };
    setAnalysisJobs(analysisJobsRef.current);
  };

  function visibleAnalysisIdentityMatches(
    targetSession: ReviewSession,
    identity: ThreadCloudCacheIdentity,
  ): boolean {
    const current = sessionRef.current;
    const targetThread = canonicalTiebaThread(targetSession.threadUrl);
    const currentThread = current
      ? canonicalTiebaThread(current.threadUrl)
      : null;
    if (
      !current ||
      !targetThread ||
      !currentThread ||
      targetSession.threadId !== targetThread.threadId ||
      current.threadId !== targetThread.threadId ||
      currentThread.threadId !== targetThread.threadId ||
      currentThread.threadUrl !== targetThread.threadUrl
    ) {
      return false;
    }
    const currentIdentity = threadCloudCacheIdentity(
      current,
      savedCloudSettingsRef.current,
    );
    return (
      currentIdentity.snapshotId === identity.snapshotId &&
      currentIdentity.analysisKey === identity.analysisKey
    );
  }

  function restorePersistedHistory(
    targetSession: ReviewSession,
    identity: ThreadCloudCacheIdentity,
    entry: AnalysisHistoryEntry,
    restoredFromOlderVersion: boolean,
  ): void {
    if (!historyEntryMatchesSessionThread(entry, targetSession)) {
      if (visibleAnalysisIdentityMatches(targetSession, identity)) {
        setWholeThreadCloudResult(null);
        setWholeThreadCloudError(
          "本机历史的帖子编号或规范地址与当前帖子不一致，已拒绝恢复和自动发送。",
        );
      }
      return;
    }
    if (visibleAnalysisIdentityMatches(targetSession, identity)) {
      setWholeThreadCloudResult(entry.result);
      setWholeThreadCloudError(null);
    }
    putAnalysisJob({
      ...identity,
      attemptId: entry.attemptId,
      tabId: targetSession.tabId,
      threadId: targetSession.threadId,
      title: targetSession.title,
      status: "success",
      startedAt: entry.startedAt,
      sentAt: entry.startedAt,
      deadlineAt: null,
      error: null,
      result: entry.result,
      ...(restoredFromOlderVersion
        ? { restoredFromOlderVersion: true }
        : {}),
    });
  }

  async function persistAnalysisHistorySuccess(input: {
    targetSession: ReviewSession;
    settings: CloudSettings;
    identity: ThreadCloudCacheIdentity;
    attemptId: string;
    startedAt: string;
    completedAt: string;
    result: WholeThreadCloudAnalysisResult;
  }): Promise<AnalysisHistoryEntry> {
    const { targetSession, settings, identity, attemptId, startedAt, completedAt, result } = input;
    const entry = createAnalysisHistoryEntry({
      attemptId,
      snapshotId: identity.snapshotId,
      analysisKey: identity.analysisKey,
      threadId: targetSession.threadId,
      threadUrl: targetSession.threadUrl,
      threadTitle: targetSession.title,
      provider: settings.provider,
      model: settings.model,
      mode: settings.mode,
      analyzerVersion: identity.analyzerVersion,
      rulesVersion: identity.rulesVersion,
      transportVersion: identity.transportVersion,
      startedAt,
      completedAt,
      coverage: {
        visibleReplyCount: targetSession.coverage.visibleReplyCount,
        imageCount: targetSession.coverage.imageCount,
        unavailableReplyCount:
          targetSession.coverage.apiCoverage?.unavailableReplyCount ?? 0,
      },
      ...(result.usage ? { usage: result.usage } : {}),
      result,
      replies: targetSession.replies,
    });
    await saveAnalysisHistoryEntry(entry);
    const next = mergeAnalysisHistory(analysisHistoryRef.current, [entry]);
    analysisHistoryRef.current = next;
    if (appMountedRef.current) setAnalysisHistory(next);
    return entry;
  }

  // Local code is deliberately limited to capture, coverage checks and
  // redaction. Only a completed whole-thread model response may create risk
  // findings shown to the moderator or persisted in a review record.
  const findings = useMemo(
    () => wholeThreadCloudResult?.findings ?? [],
    [wholeThreadCloudResult],
  );
  const captureDiagnosis = useMemo(
    () => session ? buildCaptureDiagnosis(session) : null,
    [session],
  );
  const replies = useMemo(
    () => new Map((session?.replies ?? []).map((reply) => [reply.id, reply])),
    [session],
  );
  const selectedReason = selectedReasonId ? getReasonById(selectedReasonId) : undefined;
  const filteredReasons = useMemo(() => {
    const query = reasonQuery.trim().toLocaleLowerCase("zh-CN");
    return REASON_RULES.filter((rule) => {
      if (!query && reasonCategory !== "all" && rule.categoryId !== reasonCategory) {
        return false;
      }
      return !query || [rule.id, rule.categoryTitle, rule.text].some(
        (field) => field.toLocaleLowerCase("zh-CN").includes(query),
      );
    });
  }, [reasonCategory, reasonQuery]);
  const visibleReasonGroups = useMemo(() => {
    const visibleReasons = filteredReasons.slice(0, reasonVisibleCount);
    return REASON_CATEGORIES.flatMap((category) => {
      const reasons = visibleReasons.filter(
        (reason) => reason.categoryId === category.id,
      );
      if (reasons.length === 0) return [];
      return [{
        category,
        reasons,
        totalCount: REASON_RULES.filter(
          (reason) => reason.categoryId === category.id,
        ).length,
        matchedCount: filteredReasons.filter(
          (reason) => reason.categoryId === category.id,
        ).length,
      }];
    });
  }, [filteredReasons, reasonVisibleCount]);
  const matchedReasonCategoryCount = new Set(
    filteredReasons.map((reason) => reason.categoryId),
  ).size;

  useEffect(() => {
    setReasonVisibleCount(20);
  }, [reasonCategory, reasonQuery]);

  useEffect(() => {
    if (!cloudConfirmation && !paidRetryConfirmation) return;
    const dialog = cloudDialogRef.current;
    const previouslyFocused = cloudDialogTriggerRef.current;
    const focusCancel = () => cloudDialogCancelRef.current?.focus();
    const frame = requestAnimationFrame(focusCancel);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setCloudConfirmation(null);
        setPaidRetryConfirmation(null);
        queueMicrotask(() => previouslyFocused?.focus());
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => !element.hidden);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [cloudConfirmation, paidRetryConfirmation]);

  useEffect(() => {
    if (!historyDeleteAttemptId) return;
    const deleteAttemptId = historyDeleteAttemptId;
    const focusCancel = () => historyDeleteCancelRef.current?.focus();
    const restoreTriggerFocus = () =>
      historyDeleteTriggerRefs.current.get(deleteAttemptId)?.focus();
    focusCancel();
    queueMicrotask(focusCancel);
    const frame = requestAnimationFrame(focusCancel);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setHistoryDeleteAttemptId(null);
      queueMicrotask(restoreTriggerFocus);
      requestAnimationFrame(restoreTriggerFocus);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [historyDeleteAttemptId]);

  useLayoutEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [view]);

  useEffect(() => {
    if (!wholeThreadCloudBusy && !busy) return;
    setClockNow(Date.now());
    const timer = window.setInterval(() => setClockNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [wholeThreadCloudBusy, busy]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 5_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (initialTheme) return;
    let disposed = false;
    void loadThemeMode()
      .then((storedTheme) => {
        if (!disposed && !themeInteractedRef.current) {
          setThemeMode(storedTheme);
        }
      })
      .catch(() => {
        // Keep the deterministic light default when preference storage is unavailable.
      });
    return () => {
      disposed = true;
    };
  }, [initialTheme]);

  useEffect(() => {
    appMountedRef.current = true;
    const params = new URLSearchParams(window.location.search);
    if (params.has("demo")) {
      const scenario = params.get("demo") as DemoReviewScenarioId | null;
      const fixture = scenario ? DEMO_REVIEW_FIXTURES[scenario] : undefined;
      setSession(fixture?.session ?? DEMO_SESSION);
      if (fixture) {
        setWholeThreadCloudResult(fixture.result);
        const identity = threadCloudCacheIdentity(
          fixture.session,
          cloudSettingsRef.current,
        );
        const completedAt = fixture.session.updatedAt;
        const startedAt = new Date(
          Math.max(0, Date.parse(completedAt) - 90_000),
        ).toISOString();
        const demoHistory = createAnalysisHistoryEntry({
          attemptId: `demo-${fixture.id}`,
          snapshotId: identity.snapshotId,
          analysisKey: identity.analysisKey,
          threadId: fixture.session.threadId,
          threadUrl: fixture.session.threadUrl,
          threadTitle: fixture.session.title,
          provider: cloudSettingsRef.current.provider,
          model: cloudSettingsRef.current.model,
          mode: cloudSettingsRef.current.mode,
          analyzerVersion: identity.analyzerVersion,
          rulesVersion: identity.rulesVersion,
          transportVersion: identity.transportVersion,
          startedAt,
          completedAt,
          coverage: {
            visibleReplyCount: fixture.session.coverage.visibleReplyCount,
            imageCount: fixture.session.coverage.imageCount,
            unavailableReplyCount:
              fixture.session.coverage.apiCoverage?.unavailableReplyCount ?? 0,
          },
          result: fixture.result,
          replies: fixture.session.replies,
        });
        analysisHistoryRef.current = [demoHistory];
        setAnalysisHistory([demoHistory]);
      }
      if (params.get("view") === "history") setView("history");
      setAnalysisHistoryReady(true);
      setAnalysisHistoryLoadError(null);
      setRecordsReady(true);
      setRecordsLoadError(null);
      setCloudSettingsReady(true);
      return;
    }
    if (typeof chrome === "undefined" || !chrome.runtime?.id) {
      setAnalysisHistoryReady(true);
      setRecordsReady(true);
      return;
    }
    const maybeAutoCapture = async (): Promise<void> => {
      const tabId = await getActiveTabId();
      if (
        tabId === null ||
        autoCaptureAttemptedTabsRef.current.has(tabId)
      ) {
        return;
      }
      autoCaptureAttemptedTabsRef.current.add(tabId);
      await capturePage(tabId);
    };
    const refreshActiveSession = async (
      allowAutoCapture = false,
    ): Promise<void> => {
      const generation = ++activeContextGenerationRef.current;
      try {
        const activeSession = await sendExtensionMessage<ReviewSession | null>({
          type: "GET_ACTIVE_SESSION",
        });
        if (generation !== activeContextGenerationRef.current) return;
        setSession(activeSession);
        if (!activeSession && allowAutoCapture) {
          const settings = await loadCloudSettings();
          if (generation !== activeContextGenerationRef.current) return;
          if (settings.autoReadWholeThread) await maybeAutoCapture();
        }
      } catch {
        if (generation === activeContextGenerationRef.current) {
          setSession(null);
        }
      }
    };

    const initialContextGeneration = ++activeContextGenerationRef.current;
    const historyLoadRevision = ++analysisHistoryLoadRevisionRef.current;
    void loadAnalysisHistory()
      .then((entries) => {
        if (
          !appMountedRef.current ||
          historyLoadRevision !== analysisHistoryLoadRevisionRef.current
        ) return;
        analysisHistoryRef.current = entries;
        setAnalysisHistory(entries);
        setAnalysisHistoryLoadError(null);
        setAnalysisHistoryReady(true);
      })
      .catch((caught: unknown) => {
        if (
          !appMountedRef.current ||
          historyLoadRevision !== analysisHistoryLoadRevisionRef.current
        ) return;
        setAnalysisHistoryLoadError(
          caught instanceof Error
            ? caught.message
            : "无法读取本机 AI 分析历史。",
        );
        setAnalysisHistoryReady(true);
      });
    void loadStoredRecords()
      .then((loadedRecords) => {
        if (!appMountedRef.current) return;
        setRecords(loadedRecords);
        setRecordsLoadError(null);
        setRecordsReady(true);
      })
      .catch((caught: unknown) => {
        if (!appMountedRef.current) return;
        const message =
          caught instanceof Error
            ? caught.message
            : "无法读取本机人工决定。";
        setRecordsLoadError(message);
        setRecordsReady(true);
        setError(message);
      });
    void Promise.all([
      sendExtensionMessage<ReviewSession | null>({ type: "GET_ACTIVE_SESSION" }).catch(() => null),
      loadCloudSettings(),
      loadMonthlyCloudUsage(),
      sendExtensionMessage<string | null>({ type: "GET_CLOUD_PERMISSION_STATUS" }).catch(() => null),
    ]).then(([loadedSession, loadedCloud, loadedUsage, cleanupStatus]) => {
      const contextIsCurrent =
        initialContextGeneration === activeContextGenerationRef.current;
      if (contextIsCurrent) setSession(loadedSession);
      setCloudSettings(loadedCloud);
      setSavedCloudSettings(loadedCloud);
      setMonthlyUsage(loadedUsage);
      setCloudSettingsReady(true);
      if (cleanupStatus) setError(cleanupStatus);
      if (contextIsCurrent && !loadedSession && loadedCloud.autoReadWholeThread) {
        void maybeAutoCapture();
      }
    }).catch((caught: unknown) => {
      if (!appMountedRef.current) return;
      setCloudSettingsReady(true);
      setError(
        caught instanceof Error
          ? caught.message
          : "无法安全读取本机设置；AI 请求保持关闭。",
      );
    });

    const listener = (message: unknown) => {
      if (isCaptureProgressMessage(message)) {
        const activeRequest = captureRequestRef.current;
        if (
          activeRequest?.tabId === message.tabId &&
          activeRequest.requestId === message.requestId
        ) {
          setCaptureProgress(message);
        }
        return;
      }
      if (isSessionUpdatedMessage(message)) {
        void getActiveTabId().then((activeId) => {
          if (activeId === message.session.tabId) {
            activeContextGenerationRef.current += 1;
            setSession(message.session);
            // A completed same-thread reload resumes with a fresh document
            // instance. Do not leave the transient loading warning attached
            // to that newly validated session.
            setError(null);
          }
        });
        return;
      }
      if (isSessionClearedMessage(message)) {
        if (activeReviewTabRef.current !== message.tabId) return;
        // Hide a session already known to belong to this tab immediately. The
        // asynchronous active-tab lookup below is still used for notices and
        // cross-tab validation, but must not leave stale actions clickable.
        activeContextGenerationRef.current += 1;
        setSession((current) =>
          current?.tabId === message.tabId ? null : current,
        );
        void getActiveTabId().then((activeId) => {
          if (activeId !== message.tabId) return;
          cloudAbortRef.current?.abort();
          setCloudConfirmation(null);
          setSession(null);
          autoCaptureAttemptedTabsRef.current.delete(message.tabId);
          if (message.reason === "navigation") {
            setError("页面已离开原帖子，旧审阅会话已停止使用");
          }
        });
        return;
      }
      if (isSessionSuspendedMessage(message)) {
        if (activeReviewTabRef.current !== message.tabId) return;
        activeContextGenerationRef.current += 1;
        setSession((current) =>
          current?.tabId === message.tabId ? null : current,
        );
        void getActiveTabId().then((activeId) => {
          if (activeId !== message.tabId) return;
          cloudAbortRef.current?.abort();
          setCloudConfirmation(null);
          setSession(null);
          setError("暂时无法核对当前页面地址；审阅数据仍保留，请重新点击扩展图标");
        });
      }
    };
    const tabListener = () => {
      cloudAbortRef.current?.abort();
      setCloudConfirmation(null);
      setSession(null);
      void refreshActiveSession(true);
    };
    const tabUpdatedListener = (
      tabId: number,
      changeInfo: { status?: string },
      tab: chrome.tabs.Tab,
    ) => {
      if (changeInfo.status === "loading") {
        autoCaptureAttemptedTabsRef.current.delete(tabId);
        if (activeReviewTabRef.current === tabId) {
        }
        return;
      }
      if (changeInfo.status === "complete" && tab.active) {
        void refreshActiveSession(true);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    chrome.tabs.onActivated.addListener(tabListener);
    chrome.tabs.onUpdated.addListener(tabUpdatedListener);
    return () => {
      appMountedRef.current = false;
      cloudAbortRef.current?.abort();
      for (const [analysisKey, controller] of analysisControllersRef.current) {
        const job = analysisJobsRef.current[analysisKey];
        controller.abort();
        if (!job) continue;
        const sent = job.sentAt !== null;
        const completedAt = new Date().toISOString();
        void saveThreadCloudCache({
          ...job,
          status: sent ? "unknown_after_disconnect" : "cancelled_before_send",
          result: undefined,
          error: {
            category: sent ? "disconnect" : "aborted",
            code: sent ? "sidepanel_closed_after_send" : "sidepanel_closed_before_send",
          },
          updatedAt: completedAt,
          completedAt,
        } as ThreadCloudCacheEntry).catch(() => undefined);
      }
      analysisControllersRef.current.clear();
      chrome.runtime.onMessage.removeListener(listener);
      chrome.tabs.onActivated.removeListener(tabListener);
      chrome.tabs.onUpdated.removeListener(tabUpdatedListener);
    };
  }, []);

  useEffect(() => {
    const revision = session
      ? `${session.tabId}:${session.threadId ?? session.threadUrl}:${session.updatedAt}`
      : null;
    if (lastCloudSessionRevisionRef.current === revision) return;
    lastCloudSessionRevisionRef.current = revision;
    const previousDraftKey = activeDraftSnapshotRef.current;
    if (previousDraftKey) {
      reviewDraftsRef.current.set(previousDraftKey, {
        selectedFindingId,
        selectedReasonId,
        decision,
        expandedFindingIds: [...expandedFindingIds],
      });
    }
    const nextDraftKey = session ? createSnapshotId(session) : null;
    activeDraftSnapshotRef.current = nextDraftKey;
    const restoredDraft = nextDraftKey
      ? reviewDraftsRef.current.get(nextDraftKey)
      : undefined;
    // Review controls belong to one immutable snapshot. Changing the visible
    // tab clears only the visible draft; paid jobs continue under their
    // original SnapshotId and may finish into that snapshot's cache.
    cloudAbortRef.current?.abort();
    setSelectedFindingId(restoredDraft?.selectedFindingId ?? null);
    setSelectedReasonId(restoredDraft?.selectedReasonId ?? null);
    setDecision(restoredDraft?.decision ?? "undecided");
    setExpandedFindingIds(new Set(restoredDraft?.expandedFindingIds ?? []));
    setJumpingReplyId(null);
    setCloudResults({});
    setCloudConfirmation(null);
    const demoId = new URLSearchParams(window.location.search).get("demo") as
      | DemoReviewScenarioId
      | null;
    const demoFixture = demoId ? DEMO_REVIEW_FIXTURES[demoId] : undefined;
    setWholeThreadCloudResult(
      demoFixture && demoFixture.session.threadId === session?.threadId
        ? demoFixture.result
        : null,
    );
    setWholeThreadCloudError(null);
    setWholeThreadCloudPermissionRequired(false);
  }, [session?.tabId, session?.threadId, session?.threadUrl, session?.updatedAt]);

  useEffect(() => {
    const key = activeDraftSnapshotRef.current;
    if (!key) return;
    reviewDraftsRef.current.set(key, {
      selectedFindingId,
      selectedReasonId,
      decision,
      expandedFindingIds: [...expandedFindingIds],
    });
  }, [selectedFindingId, selectedReasonId, decision, expandedFindingIds]);

  useEffect(() => {
    if (!session || !activeAnalysisIdentity) return;
    if (!sessionHasCanonicalThreadIdentity(session)) {
      setWholeThreadCloudResult(null);
      setWholeThreadCloudError(
        "当前快照的帖子编号与规范地址不一致，已拒绝恢复历史或任务缓存。",
      );
      return;
    }
    if (typeof chrome === "undefined" || !chrome.storage?.local) return;
    const expectedSnapshotId = activeAnalysisIdentity.snapshotId;
    const expectedAnalysisKey = activeAnalysisIdentity.analysisKey;
    const expectedThread = canonicalTiebaThread(session.threadUrl);
    let disposed = false;
    const inMemory = analysisJobsRef.current[activeAnalysisIdentity.analysisKey];
    if (inMemory) {
      setWholeThreadCloudResult(inMemory.result);
      setWholeThreadCloudError(inMemory.error);
      return;
    }
    void loadThreadCloudCache(activeAnalysisIdentity)
      .then(async (cached) => {
        if (disposed || sessionRef.current === null) return;
        if (!cached) {
          const legacySuccess = await loadLegacyThreadCloudSuccess(
            sessionRef.current,
            savedCloudSettings,
          );
          if (legacySuccess) {
            if (
              !disposed &&
              visibleAnalysisIdentityMatches(
                sessionRef.current,
                activeAnalysisIdentity,
              )
            ) {
              setWholeThreadCloudResult(legacySuccess.result);
              setWholeThreadCloudError(null);
            }
            return;
          }
          cached = await migrateLegacyThreadCloudPendingToUnknown(
            sessionRef.current,
            savedCloudSettings,
            `legacy-${Date.now()}`,
          );
        }
        const currentSession = sessionRef.current;
        const currentThread = currentSession
          ? canonicalTiebaThread(currentSession.threadUrl)
          : null;
        if (
          !currentSession ||
          !expectedThread ||
          !currentThread ||
          currentSession.threadId !== expectedThread.threadId ||
          currentThread.threadId !== expectedThread.threadId ||
          currentThread.threadUrl !== expectedThread.threadUrl
        ) return;
        const currentIdentity = threadCloudCacheIdentity(
          currentSession,
          savedCloudSettingsRef.current,
        );
        if (
          currentIdentity.snapshotId !== expectedSnapshotId ||
          currentIdentity.analysisKey !== expectedAnalysisKey
        ) return;
        if (!cached) {
          const matchingHistory = analysisHistoryRef.current.filter((entry) =>
            historyEntryMatchesSessionThread(entry, currentSession),
          );
          const exactDurable = findLatestByAnalysisKey(
            matchingHistory,
            activeAnalysisIdentity.analysisKey,
          );
          const hasLiveOtherVersion = Object.values(
            analysisJobsRef.current,
          ).some(
            (job) =>
              job.snapshotId === activeAnalysisIdentity.snapshotId &&
              job.analysisKey !== activeAnalysisIdentity.analysisKey &&
              ["preparing", "running", "success"].includes(job.status),
          );
          const durable =
            exactDurable ??
            (hasLiveOtherVersion
              ? undefined
              : findLatestBySnapshotId(
                  matchingHistory,
                  activeAnalysisIdentity.snapshotId,
                ));
          if (!durable) {
            const receipt = await loadThreadCloudBillingReceipt(
              activeAnalysisIdentity.snapshotId,
            );
            if (disposed) return;
            if (billingReceiptBlocksNewRequest(receipt)) {
              setWholeThreadCloudResult(null);
              setWholeThreadCloudError(billingReceiptBlockMessage(receipt));
              return;
            }
            const snapshotMarker =
              await loadLatestThreadCloudCacheForSnapshot(
                activeAnalysisIdentity.snapshotId,
              );
            const markerSession = sessionRef.current;
            if (
              disposed ||
              !snapshotMarker ||
              !markerSession ||
              !sessionHasCanonicalThreadIdentity(markerSession)
            ) return;
            const markerMessage =
              snapshotMarker.error?.code === "history_deleted"
                ? "这份本机 AI 报告已删除；防重复计费标记仍保留，不会自动重新分析。"
                : snapshotMarker.status === "success"
                  ? "同一内容快照存在旧版成功缓存，但它没有可核对的帖子身份，因此不会展示或绑定到当前帖子，也不会自动再次付费。"
                  : "同一内容快照已有可能计费的请求记录；无法核对帖子身份，不会自动重发。";
            setWholeThreadCloudResult(null);
            setWholeThreadCloudError(markerMessage);
            return;
          }
          restorePersistedHistory(
            currentSession,
            activeAnalysisIdentity,
            durable,
            durable.analysisKey !== activeAnalysisIdentity.analysisKey,
          );
          return;
        }
        if (cached.status === "success") {
          setWholeThreadCloudResult(cached.result);
          setWholeThreadCloudError(null);
          putAnalysisJob({
            ...activeAnalysisIdentity,
            attemptId: cached.attemptId,
            tabId: currentSession.tabId,
            threadId: currentSession.threadId,
            title: currentSession.title,
            status: "success",
            startedAt: cached.startedAt,
            sentAt: cached.sentAt,
            deadlineAt: cached.deadlineAt,
            error: null,
            result: cached.result,
          });
          void persistAnalysisHistorySuccess({
            targetSession: currentSession,
            settings: savedCloudSettings,
            identity: activeAnalysisIdentity,
            attemptId: cached.attemptId,
            startedAt: cached.startedAt,
            completedAt: cached.completedAt,
            result: cached.result,
          })
            .then(() =>
              clearThreadCloudCache(cached.analysisKey).catch(() => undefined),
            )
            .catch((caught: unknown) => {
              showNotice(
                `分析结果已恢复，但长期历史未保存：${analysisHistoryPersistenceError(caught)}`,
                "warning",
              );
            });
        } else {
          const restoredStatus: AnalysisJobStatus =
            cached.status === "preparing"
              ? "unknown_after_disconnect"
              : cached.status === "running"
                ? "unknown_after_disconnect"
                : cached.status;
          const sent = cached.sentAt !== null;
          const restoredError =
            cached.status === "preparing"
              ? "上一次任务在准备阶段中断，或另一上下文可能仍在准备。无法确认普通重试仍安全，因此不会自动重发。"
              : sent
                ? "上一次请求已经发出，但没有可确认的成功结果。为避免重复计费，不会自动重发。"
                : "上一次任务在发送正文前停止，可以手动重新开始。";
          setWholeThreadCloudResult(null);
          setWholeThreadCloudError(restoredError);
          putAnalysisJob({
            ...activeAnalysisIdentity,
            attemptId: cached.attemptId,
            tabId: currentSession.tabId,
            threadId: currentSession.threadId,
            title: currentSession.title,
            status: restoredStatus,
            startedAt: cached.startedAt,
            sentAt: cached.sentAt,
            deadlineAt: cached.deadlineAt,
            error: restoredError,
            result: null,
          });
        }
      })
      .catch(() => {
        if (!disposed) {
          setWholeThreadCloudError("无法核对此快照的分析缓存，已停止自动发送以避免重复计费。");
        }
      });
    return () => {
      disposed = true;
    };
  }, [
    activeAnalysisIdentity?.analysisKey,
    analysisHistory.length,
    analysisHistoryReady,
  ]);

  useEffect(() => {
    if (
      !session ||
      !cloudSettingsReady ||
      !analysisHistoryReady ||
      analysisHistoryLoadError !== null ||
      !savedCloudSettings.autoAnalyzeWholeThread ||
      !savedCloudSettings.endpoint ||
      !savedCloudSettings.model ||
      !savedCloudSettings.apiKey
    ) {
      return;
    }
    if (
      session.coverage.captureMode !== "api" ||
      !session.coverage.apiCoverage?.readableTextComplete
    ) {
      return;
    }
    void runWholeThreadCloudAnalysisForSession(session);
  }, [
    session?.tabId,
    session?.threadId,
    session?.updatedAt,
    analysisHistoryReady,
    analysisHistoryLoadError,
    savedCloudSettings.endpoint,
    savedCloudSettings.model,
    savedCloudSettings.apiKey,
    savedCloudSettings.mode,
    savedCloudSettings.autoAnalyzeWholeThread,
    cloudSettingsReady,
  ]);

  async function assertSessionIsActive(
    expected: ReviewSession,
    requireSameRevision = false,
  ): Promise<ReviewSession> {
    const active = await sendExtensionMessage<ReviewSession | null>({
      type: "GET_ACTIVE_SESSION",
    });
    const sameThread =
      active &&
      active.tabId === expected.tabId &&
      (active.threadId && expected.threadId
        ? active.threadId === expected.threadId
        : new URL(active.threadUrl).pathname ===
          new URL(expected.threadUrl).pathname);
    if (!sameThread) {
      setSession(null);
      throw new Error("当前页面已经离开原帖子，请重新读取后再操作");
    }
    if (requireSameRevision && active.updatedAt !== expected.updatedAt) {
      setSession(active);
      throw new Error("帖子内容已更新，请重新检查并确认本次操作");
    }
    return active;
  }

  async function runWholeThreadCloudAnalysisForSession(
    targetSession: ReviewSession,
    intent: WholeThreadAnalysisIntent = { kind: "initial" },
  ): Promise<void> {
    if (
      targetSession.coverage.captureMode !== "api" ||
      !targetSession.coverage.apiCoverage?.readableTextComplete
    ) {
      setWholeThreadCloudError(
        "当前整帖接口读取仍有缺口，已禁止把部分内容作为整帖发送。",
      );
      return;
    }
    if (
      !targetSession.threadId ||
      !sessionHasCanonicalThreadIdentity(targetSession)
    ) {
      setWholeThreadCloudError("当前快照缺少匹配的稳定帖子编号与规范地址，请重新读取整帖。");
      return;
    }
    if (
      intent.kind === "initial" &&
      (!analysisHistoryReady || analysisHistoryLoadError)
    ) {
      setWholeThreadCloudError(
        analysisHistoryLoadError
          ? "无法核对本机 AI 分析历史，已停止发送以避免重复计费。请先在“历史”页重新读取。"
          : "正在核对本机 AI 分析历史；完成前不会发送付费请求。",
      );
      return;
    }
    const settings = { ...savedCloudSettings };
    if (!settings.endpoint || !settings.model || !settings.apiKey) {
      setView("settings");
      setWholeThreadCloudError("请先保存 AI 服务商、模型和该服务商的 API 密钥。");
      return;
    }
    const identity = threadCloudCacheIdentity(targetSession, settings);
    if (
      analysisControllersRef.current.has(identity.analysisKey) ||
      analysisStartLocksRef.current.has(identity.analysisKey)
    ) return;
    analysisStartLocksRef.current.add(identity.analysisKey);
    try {
    if (intent.kind === "retry_before_send") {
      let retryCache: ThreadCloudCacheEntry | null;
      let retryReceipt: ThreadCloudBillingReceipt | null;
      try {
        [retryCache, retryReceipt] = await Promise.all([
          loadThreadCloudCache(identity),
          loadThreadCloudBillingReceipt(identity.snapshotId),
        ]);
      } catch {
        if (visibleAnalysisIdentityMatches(targetSession, identity)) {
          setWholeThreadCloudError(
            "无法核对未发送任务的精确缓存与计费回执；为避免覆盖另一项请求，本次没有发送。",
          );
        }
        return;
      }
      const exactRetryCache = Boolean(
        retryCache &&
          retryCache.analysisKey === identity.analysisKey &&
          retryCache.attemptId === intent.attemptId &&
          (retryCache.status === "failed_before_send" ||
            retryCache.status === "cancelled_before_send") &&
          retryCache.sentAt === null,
      );
      const exactRetryReceipt = Boolean(
        retryReceipt &&
          retryReceipt.analysisKey === identity.analysisKey &&
          retryReceipt.attemptId === intent.attemptId &&
          retryReceipt.status === "failed_before_send" &&
          retryReceipt.sentAt === null,
      );
      if (!exactRetryCache || !exactRetryReceipt) {
        if (visibleAnalysisIdentityMatches(targetSession, identity)) {
          setWholeThreadCloudResult(null);
          setWholeThreadCloudError(
            billingReceiptBlocksNewRequest(retryReceipt)
              ? billingReceiptBlockMessage(retryReceipt)
              : "未发送任务的缓存或计费回执已经变化，无法确认它仍属于本次重试；本次不会创建或发送新请求。",
          );
        }
        return;
      }
    } else if (intent.kind === "initial") {
      let cached: ThreadCloudCacheEntry | null;
      try {
        cached = await loadThreadCloudCache(identity);
        if (!cached) {
          const legacySuccess = await loadLegacyThreadCloudSuccess(
            targetSession,
            settings,
          );
          if (legacySuccess) {
            if (visibleAnalysisIdentityMatches(targetSession, identity)) {
              setWholeThreadCloudResult(legacySuccess.result);
              setWholeThreadCloudError(null);
            }
            return;
          }
          cached = await migrateLegacyThreadCloudPendingToUnknown(
            targetSession,
            settings,
            `legacy-${Date.now()}`,
          );
        }
      } catch {
        setWholeThreadCloudError(
          "无法核对此快照是否已经调用过模型，已停止发送以避免重复计费。",
        );
        return;
      }
      if (cached?.status === "success") {
        if (visibleAnalysisIdentityMatches(targetSession, identity)) {
          setWholeThreadCloudResult(cached.result);
          setWholeThreadCloudError(null);
        }
        putAnalysisJob({
          ...identity,
          attemptId: cached.attemptId,
          tabId: targetSession.tabId,
          threadId: targetSession.threadId,
          title: targetSession.title,
          status: "success",
          startedAt: cached.startedAt,
          sentAt: cached.sentAt,
          deadlineAt: cached.deadlineAt,
          error: null,
          result: cached.result,
        });
        void persistAnalysisHistorySuccess({
          targetSession,
          settings,
          identity,
          attemptId: cached.attemptId,
          startedAt: cached.startedAt,
          completedAt: cached.completedAt,
          result: cached.result,
        })
          .then(() =>
            clearThreadCloudCache(cached.analysisKey).catch(() => undefined),
          )
          .catch((caught: unknown) => {
            showNotice(
              `分析结果已恢复，但长期历史未保存：${analysisHistoryPersistenceError(caught)}`,
              "warning",
            );
          });
        return;
      }
      if (cached) {
        const sent = cached.sentAt !== null;
        if (visibleAnalysisIdentityMatches(targetSession, identity)) {
          setWholeThreadCloudResult(null);
          setWholeThreadCloudError(
            cached.status === "preparing"
              ? "上一次任务在准备阶段中断，或另一上下文可能仍在准备。无法确认普通重试仍安全，因此不会自动重发。"
              : sent
                ? "这个快照已有一次可能计费的请求记录。为避免重复收费，不会自动重发；请先核对后再明确重试。"
                : "这个快照上一次在发送前停止，可由你手动重新开始。",
          );
        }
        return;
      }
      const matchingHistory = analysisHistoryRef.current.filter((entry) =>
        historyEntryMatchesSessionThread(entry, targetSession),
      );
      const durable = findLatestByAnalysisKey(
        matchingHistory,
        identity.analysisKey,
      );
      if (durable) {
        restorePersistedHistory(targetSession, identity, durable, false);
        return;
      }
      const hasLiveOtherVersion = Object.values(
        analysisJobsRef.current,
      ).some(
        (job) =>
          job.snapshotId === identity.snapshotId &&
          job.analysisKey !== identity.analysisKey &&
          ["preparing", "running", "success"].includes(job.status),
      );
      const olderVersion = hasLiveOtherVersion
        ? undefined
        : findLatestBySnapshotId(matchingHistory, identity.snapshotId);
      if (olderVersion) {
        restorePersistedHistory(targetSession, identity, olderVersion, true);
        return;
      }
      let billingReceipt: ThreadCloudBillingReceipt | null;
      try {
        billingReceipt = await loadThreadCloudBillingReceipt(
          identity.snapshotId,
        );
      } catch {
        setWholeThreadCloudError(
          "无法核对此快照的防重复计费回执，已停止发送。请先检查扩展存储。",
        );
        return;
      }
      if (billingReceiptBlocksNewRequest(billingReceipt)) {
        if (visibleAnalysisIdentityMatches(targetSession, identity)) {
          setWholeThreadCloudResult(null);
          setWholeThreadCloudError(billingReceiptBlockMessage(billingReceipt));
        }
        return;
      }
      let snapshotMarker: ThreadCloudCacheEntry | null;
      try {
        snapshotMarker = await loadLatestThreadCloudCacheForSnapshot(
          identity.snapshotId,
        );
      } catch {
        setWholeThreadCloudError(
          "无法核对同一快照的跨版本任务标记，已停止发送以避免重复计费。",
        );
        return;
      }
      if (snapshotMarker) {
        if (visibleAnalysisIdentityMatches(targetSession, identity)) {
          setWholeThreadCloudResult(null);
          setWholeThreadCloudError(
            snapshotMarker.error?.code === "history_deleted"
              ? "这份本机 AI 报告已删除；防重复计费标记仍保留。重新分析必须由你明确确认再次付费。"
              : snapshotMarker.status === "success"
                ? "同一内容快照存在旧版成功缓存，但它没有可核对的帖子身份，因此不会展示或绑定到当前帖子。重新分析必须由你明确确认再次付费。"
                : "同一内容快照已有可能计费的请求记录；无法核对帖子身份，不会自动重发。",
          );
        }
        return;
      }
    }
    if (analysisControllersRef.current.size >= 2) {
      setWholeThreadCloudError(
        "已有两项付费分析正在运行。本帖不会排队；请等其中一项完成后再手动开始。",
      );
      return;
    }
    const attemptId =
      typeof crypto?.randomUUID === "function"
        ? crypto.randomUUID()
        : `analysis-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const startedAt = new Date().toISOString();
    const baseJob: AnalysisJobView = {
      ...identity,
      attemptId,
      tabId: targetSession.tabId,
      threadId: targetSession.threadId,
      title: targetSession.title,
      status: "preparing",
      startedAt,
      sentAt: null,
      deadlineAt: null,
      error: null,
      result: null,
    };
    const preparingEntry: ThreadCloudPreparingCacheEntry = {
      ...identity,
      status: "preparing",
      attemptId,
      startedAt,
      updatedAt: startedAt,
      sentAt: null,
      deadlineAt: null,
      error: null,
    };
    try {
      const occupiedReceipt = await claimThreadCloudAnalysisStart(
        preparingEntry,
        { force: intent.kind === "paid_retry" },
      );
      if (occupiedReceipt) {
        if (visibleAnalysisIdentityMatches(targetSession, identity)) {
          setWholeThreadCloudResult(null);
          setWholeThreadCloudError(
            billingReceiptBlockMessage(occupiedReceipt),
          );
        }
        return;
      }
    } catch {
      if (visibleAnalysisIdentityMatches(targetSession, identity)) {
        setWholeThreadCloudError(
          "无法安全写入或核对防重复计费回执；为避免重复收费，本次没有创建或发送请求。",
        );
      }
      return;
    }

    const controller = new AbortController();
    analysisControllersRef.current.set(identity.analysisKey, controller);
    putAnalysisJob(baseJob);
    if (visibleAnalysisIdentityMatches(targetSession, identity)) {
      setWholeThreadCloudResult(null);
      setWholeThreadCloudError(null);
      setWholeThreadCloudPermissionRequired(false);
    }

    let runningJob: AnalysisJobView | null = null;
    let sentAtForJob: string | null = null;
    let deadlineAtForJob: string | null = null;
    const visibleSnapshotMatches = (): boolean =>
      visibleAnalysisIdentityMatches(targetSession, identity);
    try {
      const result = await runManagedWholeThreadCloudAnalysis(
        targetSession.title,
        targetSession.replies,
        {
          provider: settings.provider,
          endpoint: settings.endpoint,
          model: settings.model,
          apiKey: settings.apiKey,
          mode: settings.mode,
          signal: controller.signal,
          beforeStart: async () => {
            await sendExtensionMessage({
              type: "VALIDATE_REVIEW_SNAPSHOT",
              tabId: targetSession.tabId,
              threadId: targetSession.threadId!,
              sessionUpdatedAt: targetSession.updatedAt,
            });
          },
          beforeSend: async () => {
            await sendExtensionMessage({
              type: "VALIDATE_REVIEW_SNAPSHOT",
              tabId: targetSession.tabId,
              threadId: targetSession.threadId!,
              sessionUpdatedAt: targetSession.updatedAt,
            });
            const sentAt = new Date().toISOString();
            const deadlineAt = new Date(
              Date.parse(sentAt) + WHOLE_THREAD_ANALYSIS_TIMEOUT_MS[settings.mode],
            ).toISOString();
            sentAtForJob = sentAt;
            deadlineAtForJob = deadlineAt;
            runningJob = {
              ...baseJob,
              status: "running",
              sentAt,
              deadlineAt,
            };
            await saveThreadCloudCache({
              ...identity,
              status: "running",
              attemptId,
              startedAt,
              updatedAt: sentAt,
              sentAt,
              deadlineAt,
              error: null,
            });
            putAnalysisJob(runningJob);
          },
        },
      );
      if (controller.signal.aborted) return;
      const completedAt = new Date().toISOString();
      let cacheSaved = true;
      try {
        await saveThreadCloudCache(
          {
            ...identity,
            status: "success",
            attemptId,
            startedAt,
            updatedAt: completedAt,
            sentAt: sentAtForJob ?? completedAt,
            deadlineAt:
              deadlineAtForJob ??
              new Date(
                Date.parse(completedAt) + WHOLE_THREAD_ANALYSIS_TIMEOUT_MS[settings.mode],
              ).toISOString(),
            completedAt,
            error: null,
            result,
            ...(result.usage ? { usage: result.usage } : {}),
          },
          targetSession.replies.map((reply) => reply.authorName ?? ""),
        );
      } catch {
        cacheSaved = false;
      }
      let historySaved = true;
      let historySaveError: string | null = null;
      try {
        await persistAnalysisHistorySuccess({
          targetSession,
          settings,
          identity,
          attemptId,
          startedAt,
          completedAt,
          result,
        });
      } catch (caught: unknown) {
        historySaved = false;
        historySaveError = analysisHistoryPersistenceError(caught);
      }
      let cacheCleanupFailed = false;
      if (historySaved && cacheSaved) {
        try {
          await clearThreadCloudCache(identity.analysisKey);
        } catch {
          cacheCleanupFailed = true;
        }
      }
      putAnalysisJob({
        ...(runningJob ?? baseJob),
        status: "success",
        result,
        error: null,
      });
      if (result.usage) {
        const usageEntry: CloudUsageLedgerEntry = {
          attemptId,
          calledAt: completedAt,
          provider: settings.provider,
          model: settings.model,
          usage: result.usage,
        };
        void recordCloudUsage(usageEntry)
          .then(() => setMonthlyUsage((current) => [
            usageEntry,
            ...current.filter((entry) => entry.attemptId !== attemptId),
          ]))
          .catch(() => showNotice("分析已完成，但本月 token 用量记录未能保存。", "warning"));
      }
      if (visibleSnapshotMatches()) {
        setWholeThreadCloudResult(result);
        setWholeThreadCloudError(null);
        setWholeThreadCloudPermissionRequired(false);
        if (!historySaved && !cacheSaved) {
          showNotice(
            `AI 初筛已完成，但长期历史未保存：${historySaveError ?? "原因未知。"} 临时缓存也未能保存；关闭侧栏后结果可能丢失。`,
            "warning",
          );
        } else if (!historySaved) {
          showNotice(
            `AI 初筛已完成并保留在本机任务缓存，但长期历史未保存：${historySaveError ?? "原因未知。"}`,
            "warning",
          );
        } else if (cacheCleanupFailed) {
          showNotice(
            "AI 初筛已写入历史，但旧的临时结果缓存未能清理；不会再次调用模型。",
            "warning",
          );
        } else {
          showNotice(
            `AI 初筛完成并已保存到历史：审阅 ${result.analyzedReplyCount} 条文字回复，发现 ${result.findings.length} 条待复核线索。`,
          );
        }
      } else {
        showNotice(
          historySaved
            ? `“${targetSession.title}”的 AI 初筛已完成并保存到历史。`
            : `“${targetSession.title}”的 AI 初筛已完成，但长期历史未保存：${historySaveError ?? "原因未知。"}`,
          historySaved ? "success" : "warning",
        );
      }
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "整帖云端分析失败";
      const permissionRequired =
        isPersistentCloudPermissionRequired(caught);
      const sentAt = sentAtForJob;
      const disconnected = !appMountedRef.current;
      const status: AnalysisJobStatus = disconnected && sentAt
        ? "unknown_after_disconnect"
        : controller.signal.aborted
          ? sentAt
            ? "cancelled_after_send"
            : "cancelled_before_send"
        : sentAt
          ? "failed_after_send"
          : "failed_before_send";
      const category = permissionRequired
        ? "permission"
        : disconnected
          ? "disconnect"
        : controller.signal.aborted
          ? "aborted"
          : caught instanceof DOMException && caught.name === "TimeoutError"
            ? "timeout"
            : "provider";
      const completedAt = new Date().toISOString();
      try {
        await saveThreadCloudCache({
          ...identity,
          status,
          attemptId,
          startedAt,
          updatedAt: completedAt,
          sentAt,
          deadlineAt: deadlineAtForJob,
          completedAt,
          error: { category, code: permissionRequired ? "permission_required" : status },
        });
      } catch {
        // The in-memory job still prevents another automatic call in this panel.
      }
      putAnalysisJob({
        ...(runningJob ?? baseJob),
        status,
        error: message,
        result: null,
      });
      if (visibleSnapshotMatches()) {
        setWholeThreadCloudPermissionRequired(permissionRequired);
        setWholeThreadCloudError(
          sentAt
            ? `${message}（请求已经发出，重试可能再次计费）`
            : `${message}（正文尚未发送）`,
        );
      }
    } finally {
      analysisControllersRef.current.delete(identity.analysisKey);
    }
    } finally {
      analysisStartLocksRef.current.delete(identity.analysisKey);
    }
  }

  async function rerunWholeThreadCloudAnalysis(): Promise<void> {
    if (!session || wholeThreadCloudBusy) return;
    if (
      !savedCloudSettings.endpoint ||
      !savedCloudSettings.model ||
      !savedCloudSettings.apiKey
    ) {
      setView("settings");
      setError("请先保存 AI 服务商、模型和该服务商的 API 密钥");
      return;
    }
    if (
      !activeAnalysisJob ||
      (activeAnalysisJob.status !== "failed_before_send" &&
        activeAnalysisJob.status !== "cancelled_before_send")
    ) {
      setWholeThreadCloudError(
        "无法确认需要重试的是哪一次未发送任务；本次不会创建或发送新请求。",
      );
      return;
    }
    await runWholeThreadCloudAnalysisForSession(session, {
      kind: "retry_before_send",
      attemptId: activeAnalysisJob.attemptId,
    });
  }

  function authorizePersistentCloudAndAnalyze(): void {
    if (
      !session ||
      wholeThreadCloudBusy ||
      wholeThreadCloudPermissionRequestRef.current
    ) {
      return;
    }
    if (
      !savedCloudSettings.endpoint ||
      !savedCloudSettings.model ||
      !savedCloudSettings.apiKey
    ) {
      setView("settings");
      setError("请先保存 AI 服务商、模型和该服务商的 API 密钥");
      return;
    }

    // Capture immutable ownership before opening Chrome's permission prompt.
    // Switching the active tab only changes what the side panel displays; it
    // does not retarget or cancel the confirmed job.
    const targetSession = session;
    const requestedSettings = { ...savedCloudSettings };
    const retryJob = activeAnalysisJob;
    if (
      !retryJob ||
      (retryJob.status !== "failed_before_send" &&
        retryJob.status !== "cancelled_before_send")
    ) {
      setWholeThreadCloudError(
        "无法确认授权后需要续跑的是哪一次未发送任务；本次不会创建或发送新请求。",
      );
      return;
    }
    let permissionRequest: Promise<boolean>;
    try {
      permissionRequest = requestPersistentCloudPermission(
        requestedSettings.endpoint,
      );
    } catch (caught) {
      setWholeThreadCloudError(
        caught instanceof Error ? caught.message : "无法请求 AI 端点权限",
      );
      return;
    }

    wholeThreadCloudPermissionRequestRef.current = true;
    setWholeThreadCloudPermissionBusy(true);
    setError(null);
    void (async () => {
      try {
        const granted = await permissionRequest;
        if (!granted) {
          setWholeThreadCloudPermissionRequired(true);
          setWholeThreadCloudError(
            `你没有授予 ${cloudProviderLabels[requestedSettings.provider]} 网络权限；帖子正文尚未发送，原失败记录仍保留。`,
          );
          return;
        }
        setWholeThreadCloudPermissionRequired(false);
        setWholeThreadCloudError(null);
        await runWholeThreadCloudAnalysisForSession(targetSession, {
          kind: "retry_before_send",
          attemptId: retryJob.attemptId,
        });
      } catch (caught) {
        setWholeThreadCloudPermissionRequired(
          isPersistentCloudPermissionRequired(caught),
        );
        setWholeThreadCloudError(
          caught instanceof Error ? caught.message : "AI 端点授权失败",
        );
      } finally {
        wholeThreadCloudPermissionRequestRef.current = false;
        if (appMountedRef.current) {
          setWholeThreadCloudPermissionBusy(false);
        }
      }
    })();
  }

  function updateCloudSettingsDraft(
    next: typeof cloudSettings,
  ): void {
    cloudSettingsRef.current = next;
    setCloudSettings(next);
  }

  function updateApiKeyDraft(value: string): void {
    apiKeyDraftRef.current = value;
    setApiKeyDraft(value);
    setCloudApiKeyClearConfirmation(null);
  }

  function saveCurrentCloudSettings(): void {
    const draftAtStart = apiKeyDraftRef.current;
    const replacementApiKey = draftAtStart.trim();
    const sourceApiKey = cloudSettings.apiKey;
    const snapshot = {
      ...cloudSettings,
      apiKey: replacementApiKey || sourceApiKey,
    };
    const attempt = cloudSettingsSaveAttemptRef.current + 1;
    cloudSettingsSaveAttemptRef.current = attempt;
    const snapshotIsCurrent = (): boolean => {
      const current = cloudSettingsRef.current;
      return (
        current.provider === snapshot.provider &&
        current.endpoint === snapshot.endpoint &&
        current.model === snapshot.model &&
        current.apiKey === sourceApiKey &&
        apiKeyDraftRef.current === draftAtStart &&
        current.mode === snapshot.mode &&
        current.autoReadWholeThread === snapshot.autoReadWholeThread &&
        current.autoAnalyzeWholeThread === snapshot.autoAnalyzeWholeThread
      );
    };

    void saveCloudSettings(snapshot)
      .then(() => {
        if (attempt !== cloudSettingsSaveAttemptRef.current) return;
        if (!snapshotIsCurrent()) {
          setError("AI 设置在保存期间又发生了变化；原先保存的设置仍有效，请重新保存新设置。");
          return;
        }
        setCloudSettingsReady(true);
        cloudSettingsRef.current = snapshot;
        setCloudSettings(snapshot);
        setSavedCloudSettings(snapshot);
        apiKeyDraftRef.current = "";
        setApiKeyDraft("");
        showNotice(
          snapshot.autoAnalyzeWholeThread
            ? "设置已保存；以后每个新的完整快照会自动创建一次可能计费的模型请求。"
            : "设置已保存；免费读取保持自动，AI 初筛需由你手动开始。",
        );
      })
      .catch((caught: unknown) => {
        if (attempt !== cloudSettingsSaveAttemptRef.current) return;
        setError(
          caught instanceof Error ? caught.message : "云端设置保存失败",
        );
      });
  }

  function selectCloudProvider(provider: CloudProvider): void {
    if (provider === cloudSettings.provider) return;
    const attempt = cloudApiKeyLoadAttemptRef.current + 1;
    cloudApiKeyLoadAttemptRef.current = attempt;
    apiKeyDraftRef.current = "";
    setApiKeyDraft("");
    setCloudApiKeyClearConfirmation(null);
    setCloudApiKeyLoading(true);
    updateCloudSettingsDraft({
      ...cloudSettings,
      provider,
      ...CLOUD_PROVIDER_DEFAULTS[provider],
      apiKey: "",
      mode: provider === "deepseek" ? "deep" : "fast",
    });
    setError(null);
    void loadCloudApiKey(provider)
      .then((apiKey) => {
        if (
          attempt !== cloudApiKeyLoadAttemptRef.current ||
          cloudSettingsRef.current.provider !== provider
        ) return;
        updateCloudSettingsDraft({
          ...cloudSettingsRef.current,
          apiKey,
        });
        showNotice(
          apiKey
            ? `已读取该 Chrome 配置文件中保存的 ${cloudProviderLabels[provider]} 密钥；保存设置后启用。`
            : `尚未保存 ${cloudProviderLabels[provider]} 密钥；请输入后保存。`,
        );
      })
      .catch((caught: unknown) => {
        if (attempt !== cloudApiKeyLoadAttemptRef.current) return;
        setError(
          caught instanceof Error ? caught.message : "无法读取已保存的 API 密钥",
        );
      })
      .finally(() => {
        if (attempt === cloudApiKeyLoadAttemptRef.current) {
          setCloudApiKeyLoading(false);
        }
      });
  }

  async function confirmClearCloudApiKey(): Promise<void> {
    const provider = cloudApiKeyClearConfirmation;
    if (!provider || cloudApiKeyLoading) return;
    setCloudApiKeyLoading(true);
    try {
      await clearCloudApiKey(provider);
      if (cloudSettingsRef.current.provider === provider) {
        const next = { ...cloudSettingsRef.current, apiKey: "" };
        cloudSettingsRef.current = next;
        setCloudSettings(next);
      }
      if (savedCloudSettings.provider === provider) {
        setSavedCloudSettings((current) => ({ ...current, apiKey: "" }));
      }
      apiKeyDraftRef.current = "";
      setApiKeyDraft("");
      setCloudApiKeyClearConfirmation(null);
      showNotice(
        `${cloudProviderLabels[provider]} 密钥已从此 Chrome 配置文件清除；已发送任务不受影响。`,
        "warning",
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "清除 API 密钥失败");
    } finally {
      setCloudApiKeyLoading(false);
    }
  }

  async function capturePage(requestedTabId?: number) {
    setBusy(true);
    setError(null);
    let requestIdentity: { tabId: number; requestId: string } | null = null;
    try {
      const tabId = requestedTabId ?? session?.tabId ?? (await getActiveTabId());
      if (tabId === null) throw new Error("找不到可读取的活动标签页");
      const requestId =
        typeof crypto?.randomUUID === "function"
          ? crypto.randomUUID()
          : `capture-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      requestIdentity = { tabId, requestId };
      captureRequestRef.current = requestIdentity;
      setCaptureStartedAt(Date.now());
      setCaptureProgress({
        type: "CAPTURE_PROGRESS",
        tabId,
        requestId,
        phase: "validation",
        completed: 0,
        total: 1,
        status: "running",
      });
      const next = await sendExtensionMessage<ReviewSession>({
        type: "CAPTURE_WHOLE_THREAD",
        tabId,
        requestId,
      });
      const stillLatest = captureRequestRef.current?.requestId === requestId;
      const activeTabId = await getActiveTabId();
      if (!stillLatest || activeTabId !== tabId) {
        const diagnosis = buildCaptureDiagnosis(next);
        showNotice(
          diagnosis.blocking
            ? `“${next.title}”读取仍有缺口；切回该帖子查看具体原因。`
            : `“${next.title}”已读取完成；切回该帖子即可查看。`,
          diagnosis.blocking || !next.coverage.isComplete
            ? "warning"
            : "success",
        );
        return;
      }
      activeContextGenerationRef.current += 1;
      setSession(next);
      showNotice(
        next.coverage.captureMode === "api"
          ? next.coverage.apiCoverage?.readableTextComplete
            ? `接口可见文字已读完：主层 ${next.coverage.mainReplyCount} 条（含主帖）＋楼中楼 ${next.coverage.nestedReplyCount} 条＝共 ${next.coverage.visibleReplyCount} 条`
            : `已读取 ${next.coverage.visibleReplyCount} 条证据，但接口分页或数量校验仍有缺口`
          : next.coverage.captureMode === "dynamic"
          ? `已累计 ${next.coverage.visibleReplyCount} 条可见回复`
          : `已读取第 ${next.coverage.analyzedPageNumbers.at(-1) ?? 1} 页`,
        buildCaptureDiagnosis(next).blocking || !next.coverage.isComplete
          ? "warning"
          : "success",
      );
    } catch (caught) {
      if (
        !requestIdentity ||
        captureRequestRef.current?.requestId === requestIdentity.requestId
      ) {
        setError(caught instanceof Error ? caught.message : "读取页面失败");
      }
    } finally {
      if (
        !requestIdentity ||
        captureRequestRef.current?.requestId === requestIdentity.requestId
      ) {
        setBusy(false);
        captureRequestRef.current = null;
      }
    }
  }

  async function cancelCapture(): Promise<void> {
    const active = captureRequestRef.current;
    if (!active) return;
    try {
      await sendExtensionMessage({
        type: "CANCEL_CAPTURE",
        tabId: active.tabId,
        requestId: active.requestId,
      });
      setCaptureProgress((current) => current ? { ...current, status: "cancelled" } : null);
      showNotice("本次读取已取消；不会在稍后自动继续。", "warning");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法取消本次读取");
    }
  }

  async function jumpToReply(replyId: string) {
    const reply = replies.get(replyId);
    if (!reply) return;
    if (!session) return;
    setError(null);
    setNotice(null);
    setJumpingReplyId(replyId);
    try {
      await assertSessionIsActive(session);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "当前帖子会话已失效");
      setJumpingReplyId(null);
      return;
    }
    const currentPage = Number(
      new URL(session.threadUrl).searchParams.get("pn") ?? "1",
    );
    if (
      session.coverage.captureMode !== "api" &&
      currentPage !== reply.sourcePage
    ) {
      showNotice(
        `这条证据位于第 ${reply.sourcePage} 页。为避免刷新页面，未自动换页；请在贴吧中打开该页后再点击定位。`,
        "warning",
      );
      setJumpingReplyId(null);
      return;
    }
    try {
      await sendExtensionMessage({
        type: "JUMP_TO_REPLY",
        replyId,
      });
    } catch (caught) {
      if (
        caught instanceof Error &&
        "code" in caught &&
        caught.code === "EVIDENCE_NOT_LOADED"
      ) {
        showNotice(caught.message, "warning");
      } else {
        setError(caught instanceof Error ? caught.message : "无法定位原回复");
      }
    } finally {
      setJumpingReplyId(null);
    }
  }

  async function copySelectedReason() {
    if (!selectedReason) return;
    try {
      await copyText(selectedReason.text);
      showNotice("规范原文已复制");
    } catch {
      setError("复制失败，请选中规范原文后手动复制");
    }
  }

  async function saveReview() {
    if (!session) return;
    if (decision === "undecided") {
      setError("请先明确选择继续观察、确认保留或记录为建议删除。");
      return;
    }
    const finding = findings.find((item) => item.id === selectedFindingId);
    if (findings.length > 0 && !finding) {
      setError("请先明确选择一条待复核线索作为当前记录对象。");
      return;
    }
    if (decision === "delete" && !selectedReasonId) {
      setError("记录为建议删除时，必须由你明确确认一条完整规范。");
      return;
    }
    try {
      if (typeof chrome !== "undefined" && chrome.runtime?.id) {
        await assertSessionIsActive(session);
      }
      const record = createReviewRecord({
        threadId: session.threadId,
        threadUrl: session.threadUrl,
        replyIds: finding?.replyIds ?? [],
        decision,
        primaryReasonId: decision === "delete" ? selectedReasonId : null,
        internalTags: finding ? [finding.type, finding.severity] : [],
        analysisAttemptId: activeAnalysisAttemptId,
        snapshotId: activeAnalysisAttemptId
          ? activeAnalysisIdentity?.snapshotId ?? createSnapshotId(session)
          : null,
        findingId: activeAnalysisAttemptId ? finding?.id ?? null : null,
        analyzerVersions: {
          local: "disabled",
          cloud: wholeThreadCloudResult ? CLOUD_ANALYZER_VERSION : null,
          rules: REASON_VERSION,
        },
      });
      const persistedRecords = await saveStoredRecords([record]);
      setRecords(persistedRecords);
      setRecordsLoadError(null);
      setRecordsReady(true);
      showNotice(
        activeAnalysisAttemptId
          ? "人工决定已关联并保存到 AI 分析历史"
          : "人工决定已作为旧版独立记录保存到本机",
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存审核记录失败");
    }
  }

  function prepareCloud(finding: Finding) {
    if (!session) return;
    if (cloudBusyId) return;
    const settings = savedCloudSettings;
    if (!settings.endpoint || !settings.model || !settings.apiKey) {
      setView("settings");
      setError("请先保存 AI 服务商、模型和该服务商的 API 密钥");
      return;
    }
    try {
      cloudDialogTriggerRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      const preview = buildCloudPreflight(
        finding,
        session.replies,
        settings.endpoint,
      );
      setCloudConfirmation({
        ...preview,
        findingId: finding.id,
        tabId: session.tabId,
        threadId: session.threadId,
        sessionUpdatedAt: session.updatedAt,
        endpoint: settings.endpoint,
        model: settings.model,
        mode: settings.mode,
        provider: settings.provider,
      });
      setSelectedFindingId(finding.id);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法完成云端脱敏预检");
    }
  }

  async function confirmCloud() {
    const confirmation = cloudConfirmation;
    const activeSession = session;
    if (!confirmation || !activeSession || cloudBusyId) return;
    const finding = findings.find((item) => item.id === confirmation.findingId);
    if (
      !finding ||
      activeSession.tabId !== confirmation.tabId ||
      activeSession.threadId !== confirmation.threadId ||
      activeSession.updatedAt !== confirmation.sessionUpdatedAt ||
      savedCloudSettings.endpoint !== confirmation.endpoint ||
      savedCloudSettings.model !== confirmation.model ||
      savedCloudSettings.mode !== confirmation.mode ||
      savedCloudSettings.provider !== confirmation.provider
    ) {
      setCloudConfirmation(null);
      setError("帖子或云端设置已变更，请重新进行脱敏预检");
      return;
    }
    const controller = new AbortController();
    cloudAbortRef.current?.abort();
    cloudAbortRef.current = controller;
    setCloudBusyId(finding.id);
    setCloudConfirmation(null);
    setError(null);
    try {
      // Invoked directly from the explicit confirmation click so the optional
      // permission request retains its required user gesture.
      const analysis = runManagedCloudAnalysis(
        finding,
        activeSession.replies,
        {
          provider: confirmation.provider,
          endpoint: confirmation.endpoint,
          model: confirmation.model,
          apiKey: savedCloudSettings.apiKey,
          mode: confirmation.mode,
          signal: controller.signal,
          beforeStart: async () => {
            // This is the last awaited check before the broker receives the
            // exact finding/replies snapshot that the moderator previewed.
            await assertSessionIsActive(activeSession, true);
          },
        },
      );
      const result = await analysis;
      setCloudResults((current) => ({ ...current, [finding.id]: result }));
      setSelectedFindingId(finding.id);
      setSelectedReasonId(null);
      setDecision("undecided");
      showNotice("深度分析完成；请仍以原文和上下文为准");
    } catch (caught) {
      setError(
        controller.signal.aborted
          ? "页面或审阅会话已切换，云端分析已取消"
          : caught instanceof Error
            ? caught.message
            : "云端分析失败",
      );
    } finally {
      if (cloudAbortRef.current === controller) cloudAbortRef.current = null;
      setCloudBusyId(null);
    }
  }

  function downloadJson(serialized: string, filename: string): void {
    const blob = new Blob([serialized], {
      type: "application/json",
    });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(href);
  }

  function exportHistory() {
    downloadJson(
      serializeAnalysisHistoryExport(analysisHistory),
      `假面骑士吧-AI分析历史-${new Date().toISOString().slice(0, 10)}.json`,
    );
  }

  function exportReviewRecords() {
    downloadJson(
      serializeReviewRecords(records),
      `假面骑士吧-人工决定-${new Date().toISOString().slice(0, 10)}.json`,
    );
  }

  async function reloadAnalysisHistory(): Promise<void> {
    const loadRevision = ++analysisHistoryLoadRevisionRef.current;
    setAnalysisHistoryReady(false);
    setAnalysisHistoryLoadError(null);
    try {
      const loaded = await loadAnalysisHistory();
      if (loadRevision !== analysisHistoryLoadRevisionRef.current) return;
      analysisHistoryRef.current = loaded;
      setAnalysisHistory(loaded);
    } catch (caught) {
      if (loadRevision !== analysisHistoryLoadRevisionRef.current) return;
      setAnalysisHistoryLoadError(
        caught instanceof Error ? caught.message : "无法读取本机 AI 分析历史。",
      );
    } finally {
      if (loadRevision === analysisHistoryLoadRevisionRef.current) {
        setAnalysisHistoryReady(true);
      }
    }
  }

  async function importHistory(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      if (file.size > MAX_LOCAL_IMPORT_BYTES) {
        throw new Error("AI 分析历史文件超过 8 MiB，已停止导入。");
      }
      const imported = parseAnalysisHistoryExport(await file.text());
      const next = await replaceAnalysisHistory(imported);
      ++analysisHistoryLoadRevisionRef.current;
      analysisHistoryRef.current = next;
      setAnalysisHistory(next);
      setAnalysisHistoryLoadError(null);
      setAnalysisHistoryReady(true);
      showNotice(
        `已合并 ${imported.length} 次 AI 分析；同一任务编号以较新的完成记录为准。`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "AI 分析历史导入失败");
    }
  }

  async function importReviewRecords(
    event: ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      if (file.size > MAX_LOCAL_IMPORT_BYTES) {
        throw new Error("人工决定文件超过 8 MiB，已停止导入。");
      }
      const imported = parseReviewRecords(await file.text());
      const persistedRecords = await saveStoredRecords(imported);
      setRecords(persistedRecords);
      setRecordsLoadError(null);
      setRecordsReady(true);
      showNotice(`已合并 ${imported.length} 条人工决定。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "人工决定导入失败");
    }
  }

  async function deleteHistory(entry: AnalysisHistoryEntry): Promise<void> {
    try {
      const isDemoEntry = entry.attemptId.startsWith("demo-");
      if (!isDemoEntry) {
        const deletedAt = new Date().toISOString();
        const cacheIdentity: ThreadCloudCacheIdentity = {
          schemaVersion: THREAD_CLOUD_CACHE_SCHEMA_VERSION,
          snapshotId: entry.snapshotId,
          analysisKey: entry.analysisKey,
          analyzerVersion: CLOUD_ANALYZER_VERSION,
          rulesVersion: REASON_VERSION,
          transportVersion: THREAD_CLOUD_TRANSPORT_VERSION,
        };
        const deadlineAt = new Date(
          Date.parse(entry.startedAt) +
            WHOLE_THREAD_ANALYSIS_TIMEOUT_MS[entry.mode],
        ).toISOString();
        await clearThreadCloudCache(entry.analysisKey);
        await saveThreadCloudCache({
          ...cacheIdentity,
          status: "unknown_after_disconnect",
          attemptId: entry.attemptId,
          startedAt: entry.startedAt,
          updatedAt: deletedAt,
          sentAt: entry.startedAt,
          deadlineAt,
          completedAt: deletedAt,
          error: { category: "storage", code: "history_deleted" },
        });
        try {
          await deleteAnalysisHistoryEntry(entry.attemptId);
        } catch (caught) {
          // The report still exists in history, so restore the cache result as
          // well; a failed delete must not silently turn a known success into
          // an unknown request.
          await saveThreadCloudCache({
            ...cacheIdentity,
            status: "success",
            attemptId: entry.attemptId,
            startedAt: entry.startedAt,
            updatedAt: deletedAt,
            sentAt: entry.startedAt,
            deadlineAt,
            completedAt: entry.completedAt,
            error: null,
            result: entry.result,
            ...(entry.usage ? { usage: entry.usage } : {}),
          }).catch(() => undefined);
          throw caught;
        }
      }
      const next = analysisHistoryRef.current.filter(
        (candidate) => candidate.attemptId !== entry.attemptId,
      );
      analysisHistoryRef.current = next;
      setAnalysisHistory(next);
      const nextJobs = Object.fromEntries(
        Object.entries(analysisJobsRef.current).map(([analysisKey, job]) =>
          job.status === "success" && job.attemptId === entry.attemptId
            ? [
                analysisKey,
                {
                  ...job,
                  status: "unknown_after_disconnect" as const,
                  error:
                    "这份本机 AI 报告已删除；防重复计费标记仍保留，不会自动重新分析。",
                  result: null,
                  restoredFromOlderVersion: false,
                },
              ]
            : [analysisKey, job],
        ),
      );
      analysisJobsRef.current = nextJobs;
      setAnalysisJobs(nextJobs);
      if (activeAnalysisJob?.attemptId === entry.attemptId) {
        setWholeThreadCloudResult(null);
        setWholeThreadCloudError(
          "这份本机 AI 报告已删除；防重复计费标记仍保留，不会自动重新分析。",
        );
      }
      setHistoryDeleteAttemptId(null);
      historyDeleteTriggerRefs.current.delete(entry.attemptId);
      showNotice("本机 AI 报告已删除；关联的人工决定和防重复计费标记仍保留。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法删除本机 AI 报告");
    }
  }

  function toggleTheme(): void {
    const nextTheme = themeMode === "light" ? "dark" : "light";
    themeInteractedRef.current = true;
    setThemeMode(nextTheme);
    void saveThemeMode(nextTheme).catch(() => {
      setError("外观偏好未能保存；本次主题切换仍然有效");
    });
  }

  const v3Report =
    wholeThreadCloudResult?.protocolVersion === 3
      ? wholeThreadCloudResult.report
      : null;
  const legacyReport =
    wholeThreadCloudResult && wholeThreadCloudResult.protocolVersion !== 3
      ? wholeThreadCloudResult.report
      : null;
  const humanCheckNotes = v3Report
    ? v3Report.notes.filter((note) => note.kind === "needs_human_check")
    : [];
  const pendingHumanCount = v3Report
    ? humanCheckNotes.length
    : (wholeThreadCloudResult?.uncertainties.length ?? 0);
  const activeElapsed = activeAnalysisJob
    ? elapsedLabel(clockNow - Date.parse(activeAnalysisJob.startedAt))
    : null;
  const capturePhaseLabels: Record<CaptureProgressMessage["phase"], string> = {
    validation: "正在核对帖子",
    sync: "正在建立只读会话",
    main: "正在读取主回复",
    nested: "正在读取楼中楼",
    coverage: "正在核对读取范围",
  };
  const monthlyTokenTotals = monthlyUsage.reduce(
    (total, entry) => ({
      input: total.input + entry.usage.inputTokens,
      output: total.output + entry.usage.outputTokens,
      all: total.all + entry.usage.totalTokens,
    }),
    { input: 0, output: 0, all: 0 },
  );
  const historyByAttemptId = new Map(
    analysisHistory.map((entry) => [entry.attemptId, entry]),
  );
  const unlinkedReviewRecords = records.filter((record) => {
    const entry = record.analysisAttemptId
      ? historyByAttemptId.get(record.analysisAttemptId)
      : undefined;
    return !entry || !reviewRecordMatchesHistoryEntry(record, entry);
  });
  const currentProviderLabel = cloudProviderLabels[cloudSettings.provider];
  const currentProviderHasSavedApiKey = Boolean(cloudSettings.apiKey);

  function openPaidRetryConfirmation(
    reason: PaidRetryConfirmation["reason"],
  ): void {
    if (!session) return;
    cloudDialogTriggerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setPaidRetryConfirmation({ session, reason });
  }

  function stopActiveAnalysis(): void {
    if (!activeAnalysisIdentity) return;
    analysisControllersRef.current.get(activeAnalysisIdentity.analysisKey)?.abort();
  }

  function renderReasonRows(reasonList: typeof REASON_RULES) {
    return (
      <ol className="reason-rules">
        {reasonList.map((reason) => {
          const selected = selectedReasonId === reason.id;
          return (
            <li key={reason.id} className={`reason-row ${selected ? "selected" : ""}`}>
              <button
                type="button"
                className="reason-select"
                aria-pressed={selected}
                aria-label={`选择第 ${reason.item} 条规范：${reason.text}`}
                onClick={() => setSelectedReasonId(selected ? null : reason.id)}
              >
                <small className="reason-number">第 {reason.item} 条</small>
                <span className="reason-text">{reason.text}</span>
              </button>
              {selected && (
                <div className="reason-row-actions">
                  <button
                    type="button"
                    className="reason-copy"
                    aria-label={`复制规范原文：${reason.text}`}
                    onClick={() => {
                      void copyText(reason.text)
                        .then(() => showNotice("规范原文已复制"))
                        .catch(() => setError("复制失败，请选中规范原文后手动复制"));
                    }}
                  >
                    <Icon name="copy" />复制规范原文
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    );
  }

  return (
    <div className="app-shell" data-theme={themeMode}>
      <header className="app-header">
        <div className="brand-mark"><Icon name="shield" /></div>
        <div className="brand-copy">
          <span>假面骑士吧</span>
          <h1>长帖审阅助手</h1>
        </div>
        <div className="header-actions">
          <span className="local-pill"><i />云端 AI 初筛 · 发送前本地脱敏</span>
          <button
            type="button"
            className="theme-toggle"
            aria-pressed={themeMode === "dark"}
            aria-label={themeMode === "dark" ? "切换到普通模式" : "切换到夜间模式"}
            title={themeMode === "dark" ? "切换到普通模式" : "切换到夜间模式"}
            onClick={toggleTheme}
          >
            <Icon name={themeMode === "dark" ? "sun" : "moon"} />
          </button>
        </div>
      </header>

      <nav className="tabs" aria-label="功能导航">
        {([
          ["review", "风险"],
          ["reasons", "理由库"],
          ["history", "历史"],
          ["settings", "设置"],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            className={view === id ? "active" : ""}
            aria-current={view === id ? "page" : undefined}
            onClick={() => setView(id)}
          >
            {label}
          </button>
        ))}
      </nav>

      {(error || notice) && (
        <div className={`toast ${error ? "error" : noticeTone}`} role={error ? "alert" : "status"}>
          <span>{error ?? notice}</span>
          <button aria-label="关闭提示" onClick={() => { setError(null); setNotice(null); }}>×</button>
        </div>
      )}

      <main>
        {!session && view !== "reasons" && view !== "history" && view !== "settings" ? (
          <section className="empty-state">
            <div className="empty-visual"><Icon name="scan" /><span>只读取当前打开的帖子</span></div>
            <span className="eyebrow">开始一次人工审阅</span>
            <h2>先打开需要检查的贴吧长帖</h2>
            <p>点击下方按钮后，扩展才会通过固定的贴吧只读端点读取整帖楼层和楼中楼。它不会后台巡检，也不会执行删除或封禁。</p>
            <button className="primary-button" onClick={() => void capturePage()} disabled={busy}><Icon name="scan" />{busy ? "正在读取整帖…" : "读取整帖"}</button>
            {busy && (
              <button className="secondary-button" type="button" onClick={() => void cancelCapture()}>取消读取</button>
            )}
            {busy && captureProgress && (
              <div className="capture-progress" role="status" aria-live="polite">
                <strong>{capturePhaseLabels[captureProgress.phase]}</strong>
                <span>{captureProgress.completed} / {captureProgress.total || "待确认"}</span>
                <small>已等待 {elapsedLabel(clockNow - (captureStartedAt ?? clockNow))}；可以切换标签页。</small>
              </div>
            )}
          </section>
        ) : null}

        {session && view === "review" && (
          <div
            className="view-stack"
            key={`review:${session.tabId}:${session.threadId ?? session.threadUrl}`}
          >
            <section className="thread-heading">
              <div><span className="eyebrow">正在审阅</span><h2>{session.title}</h2></div>
              <button className="icon-button" title="重新读取整帖" onClick={() => void capturePage()} disabled={busy}><Icon name="scan" /></button>
            </section>
            <CaptureDiagnostics
              key={`${session.threadId ?? session.threadUrl}:${session.updatedAt}`}
              session={session}
            />
            <section
              className={`whole-thread-cloud-card ${
                wholeThreadCloudBusy || wholeThreadCloudPermissionBusy
                  ? "busy"
                  : wholeThreadCloudResult
                    ? "complete"
                    : wholeThreadCloudError
                      ? "error"
                      : ""
              }`}
              aria-busy={wholeThreadCloudBusy || wholeThreadCloudPermissionBusy}
            >
              <div className="section-heading">
                <div>
                  <span className="eyebrow">AI 初筛</span>
                  <h2>
                    {wholeThreadCloudPermissionBusy
                      ? `正在请求 ${cloudProviderLabels[savedCloudSettings.provider]} 权限`
                      : wholeThreadCloudBusy
                      ? activeAnalysisJob?.status === "preparing"
                        ? "发送前准备"
                        : `已发送，正在等待 ${savedCloudSettings.model}`
                      : wholeThreadCloudResult
                        ? "AI 初筛结果"
                        : captureDiagnosis?.blocking
                          ? "读取尚未完成"
                        : wholeThreadCloudPermissionRequired
                          ? `需要授权 ${cloudProviderLabels[savedCloudSettings.provider]} 网络权限`
                          : wholeThreadCloudError
                            ? "本次初筛未完成"
                            : "可以开始 AI 初筛"}
                  </h2>
                </div>
                <Icon name="cloud" />
              </div>
              {otherTaskCount > 0 && (
                <p className="cross-task-note" role="status">
                  另有 {otherTaskCount} 个帖子的分析正在运行；本帖不会接收它们的结果。
                </p>
              )}
              {otherCompletedJobs.length > 0 && (
                <div className="cross-task-note completed" role="status">
                  <strong>{otherCompletedJobs.length} 个其他帖子已完成 AI 初筛</strong>
                  <span>切回对应帖子查看；结果不会挂到当前帖子。</span>
                </div>
              )}
              {wholeThreadCloudPermissionBusy ? (
                <p>Chrome 正在等待你的站点权限选择；在允许前不会发送任何帖子正文。</p>
              ) : wholeThreadCloudBusy ? (
                <div className="analysis-progress" role="status" aria-live="polite">
                  <strong>
                    {activeAnalysisJob?.status === "preparing"
                      ? "正在完成脱敏、大小与快照校验；尚未发送正文。"
                      : "请求已经发出，结果会保存到这个帖子快照。"}
                  </strong>
                  <p>
                    已等待 {activeElapsed ?? "0 秒"} · 最长约
                    {savedCloudSettings.mode === "deep" ? " 10 分钟" : " 3 分钟"}
                  </p>
                  <small>可以切换标签页，但请保持侧栏开启。切换不会取消或转移本任务。</small>
                  <button className="secondary-button" type="button" onClick={stopActiveAnalysis}>
                    {activeAnalysisJob?.status === "preparing"
                      ? "取消（尚未发送）"
                      : "停止等待（请求可能仍计费）"}
                  </button>
                </div>
              ) : wholeThreadCloudResult && !captureDiagnosis?.blocking ? (
                <>
                  {activeAnalysisJob?.restoredFromOlderVersion && (
                    <div className="cross-task-note completed" role="status">
                      <strong>正在显示同一快照的旧版 AI 初筛结果</strong>
                      <span>
                        为避免自动重复计费，当前版本不会自行重跑。如需新版结果，请在下方“低频操作”中明确选择重新分析。
                      </span>
                    </div>
                  )}
                  <section className="review-overview">
                    <div className="review-overview-metrics" aria-label="AI 初筛总览">
                      <div><strong>{findings.length}</strong><span>待复核线索</span></div>
                      <div><strong>{pendingHumanCount}</strong><span>待人工确认</span></div>
                      <div><strong>{session.coverage.visibleReplyCount}</strong><span>已读文字</span></div>
                      <div><strong>{wholeThreadCloudResult.omittedImageCount}</strong><span>图片缺口</span></div>
                    </div>
                    <CloudNarrative
                      value={wholeThreadCloudResult.summary}
                      replies={session.replies}
                      className="cloud-overview"
                      references={
                        wholeThreadCloudResult.narrativeReferences?.summary
                      }
                      replyMap={replies}
                      onJump={jumpToReply}
                    />
                  </section>
                  {findings[0] && !selectedFindingId && (
                    <section className="review-first-action">
                      <div>
                        <small>最高优先级线索</small>
                        <strong>{riskLabels[findings[0].type]} · {severityLabels[findings[0].severity]}</strong>
                      </div>
                      <button
                        type="button"
                        className="primary-button"
                        onClick={() => {
                          setSelectedFindingId(findings[0]!.id);
                          setSelectedReasonId(null);
                          setDecision("undecided");
                        }}
                      >
                        开始复核
                      </button>
                    </section>
                  )}
                  {findings.length > 0 ? (
                    <section className="cloud-actionable-findings">
                      <header className="cloud-report-group-heading">
                        <div>
                          <small>AI 只提供线索，不作处罚决定</small>
                          <h3>待复核线索</h3>
                        </div>
                        <span>{findings.length} 条</span>
                      </header>
                      <div className="cloud-finding-list">
                        {findings.map((finding, index) => (
                          <WholeThreadFindingItem
                            key={finding.id}
                            finding={finding}
                            index={index}
                            replies={replies}
                            references={
                              wholeThreadCloudResult.narrativeReferences
                                ?.findings[finding.id]
                            }
                            selected={selectedFindingId === finding.id}
                            expanded={expandedFindingIds.has(finding.id)}
                            jumpingReplyId={jumpingReplyId}
                            onSelect={() => {
                              setSelectedFindingId(finding.id);
                              setSelectedReasonId(null);
                              setDecision("undecided");
                            }}
                            onToggle={() => setExpandedFindingIds((current) => {
                              const next = new Set(current);
                              if (next.has(finding.id)) next.delete(finding.id);
                              else next.add(finding.id);
                              return next;
                            })}
                            onJump={jumpToReply}
                          />
                        ))}
                      </div>
                    </section>
                  ) : (
                    <section className="review-clean-state">
                      <strong>未发现达到当前门槛的待复核线索</strong>
                      <p>这不等于整帖绝对安全；请结合下方待确认项、图片缺口和读取范围判断。</p>
                    </section>
                  )}

                  {(selectedFindingId || findings.length === 0) && (
                    <section className="decision-card" aria-labelledby="decision-title">
                      <span className="eyebrow">形成处理记录</span>
                      <h3 id="decision-title">当前记录对象</h3>
                      <p className="decision-target">
                        {selectedFindingId
                          ? `待复核线索 ${findings.findIndex((item) => item.id === selectedFindingId) + 1}`
                          : "整帖（当前没有待复核线索）"}
                      </p>
                      <div className="decision-options" role="radiogroup" aria-label="处理决定">
                        {(["watch", "keep", "delete"] as const).map((value) => (
                          <button
                            type="button"
                            role="radio"
                            aria-checked={decision === value}
                            key={value}
                            className={decision === value ? "selected" : ""}
                            onClick={() => {
                              setDecision(value);
                              if (value !== "delete") setSelectedReasonId(null);
                            }}
                            disabled={findings.length === 0 && value === "delete"}
                          >
                            {value === "watch" ? "继续观察" : value === "keep" ? "确认保留" : "记录为建议删除"}
                          </button>
                        ))}
                      </div>
                      {decision === "delete" && (
                        <fieldset className="reason-confirmation">
                          <legend>由你确认可能涉及的规范</legend>
                          <p>AI 推荐只作参考，不会自动成为已确认理由。</p>
                          {findings
                            .find((item) => item.id === selectedFindingId)
                            ?.reasonCandidates.map((candidate) => {
                              const reason = getReasonById(candidate.reasonId);
                              if (!reason) return null;
                              return (
                                <label key={reason.id}>
                                  <input
                                    type="radio"
                                    name="confirmed-reason"
                                    checked={selectedReasonId === reason.id}
                                    onChange={() => setSelectedReasonId(reason.id)}
                                  />
                                  <span>{reason.text}</span>
                                </label>
                              );
                            })}
                          <button type="button" className="text-button" onClick={() => setView("reasons")}>打开完整理由库</button>
                        </fieldset>
                      )}
                      {selectedReason && (
                        <div className="selected-reason">
                          <small>已确认规范 · {selectedReason.categoryTitle}</small>
                          <p>{selectedReason.text}</p>
                          <button type="button" onClick={copySelectedReason}><Icon name="copy" />复制规范原文</button>
                        </div>
                      )}
                      <button
                        className="primary-button"
                        onClick={saveReview}
                        disabled={decision === "undecided" || (decision === "delete" && !selectedReasonId)}
                      >
                        保存本地审核记录
                      </button>
                    </section>
                  )}

                  {(humanCheckNotes.length > 0 || (wholeThreadCloudResult.protocolVersion !== 3 && wholeThreadCloudResult.uncertainties.length > 0)) && (
                    <div className="cloud-overall-cautions">
                      <strong>待人工确认</strong>
                      <ul>
                        {wholeThreadCloudResult.protocolVersion === 3
                          ? humanCheckNotes.map((item, index) => (
                              <li key={`${index}:${item.title}`}>
                                <strong>{item.title}</strong>
                                <p>{item.summary}</p>
                                <NarrativeReferenceLinks
                                  replyIds={item.replyIds}
                                  replies={replies}
                                  onJump={jumpToReply}
                                  layout="stacked"
                                  showExcerpt
                                  jumpingReplyId={jumpingReplyId}
                                />
                              </li>
                            ))
                          : wholeThreadCloudResult.uncertainties.map((item, index) => (
                              <li key={`${index}:${item}`}>
                                {cloudNarrativeLines(item, session.replies).map((line, lineIndex) => (
                                  <p key={`${lineIndex}:${line}`}>{line}</p>
                                ))}
                                <NarrativeReferenceLinks
                                  replyIds={wholeThreadCloudResult.narrativeReferences?.uncertainties[index]?.replyIds}
                                  replies={replies}
                                  onJump={jumpToReply}
                                  layout="stacked"
                                  showExcerpt
                                  jumpingReplyId={jumpingReplyId}
                                />
                              </li>
                            ))}
                      </ul>
                    </div>
                  )}

                  {v3Report && (
                    <WholeThreadV3Details report={v3Report} replies={replies} onJump={jumpToReply} />
                  )}
                  {legacyReport && (
                    <details className="analysis-details legacy-report-details">
                      <summary>旧版详细报告</summary>
                      <div className="analysis-details-body">
                        <WholeThreadLongReport
                          report={legacyReport}
                          replies={session.replies}
                          references={wholeThreadCloudResult.narrativeReferences?.report}
                          replyMap={replies}
                          onJump={jumpToReply}
                          placement="before-findings"
                        />
                        <WholeThreadLongReport
                          report={legacyReport}
                          replies={session.replies}
                          references={wholeThreadCloudResult.narrativeReferences?.report}
                          replyMap={replies}
                          onJump={jumpToReply}
                          placement="after-findings"
                        />
                      </div>
                    </details>
                  )}

                  <details className="low-frequency-actions">
                    <summary>低频操作</summary>
                    <div>
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => openPaidRetryConfirmation("reanalyze_success")}
                      >
                        重新分析这个快照
                      </button>
                      <small>这会创建一次新的模型请求，并可能再次计费。</small>
                    </div>
                  </details>
                </>
              ) : wholeThreadCloudError && !captureDiagnosis?.blocking ? (
                <div className="analysis-error-state">
                  <p>{wholeThreadCloudError}</p>
                  {wholeThreadCloudPermissionRequired ? (
                    <button className="primary-button" type="button" onClick={authorizePersistentCloudAndAnalyze}>
                      授权并开始
                    </button>
                  ) : activeAnalysisJob?.status === "failed_before_send" || activeAnalysisJob?.status === "cancelled_before_send" ? (
                    <button className="primary-button" type="button" onClick={() => void rerunWholeThreadCloudAnalysis()}>
                      重新开始（上次未发送）
                    </button>
                  ) : (
                    <button className="secondary-button" type="button" onClick={() => openPaidRetryConfirmation("retry_after_send")}>
                      核对后再次付费分析
                    </button>
                  )}
                </div>
              ) : captureDiagnosis?.blocking ? (
                <div className={`analysis-ready-state capture-blocked ${captureDiagnosis.limitReached ? "limit" : ""} ${captureDiagnosis.structureUncertain ? "danger" : ""}`}>
                  <p>{captureDiagnosis.title}。具体数字和失败原因已在上方展开；残缺快照不会作为整帖外发。</p>
                  {captureDiagnosis.limitReached && (
                    <small>重复读取通常不会突破安全上限，请先按当前可见内容分段人工复核。</small>
                  )}
                  <button
                    className={captureDiagnosis.limitReached ? "secondary-button" : "primary-button"}
                    type="button"
                    onClick={() => void capturePage()}
                    disabled={busy}
                  >
                    {captureDiagnosis.retryLabel}
                  </button>
                </div>
              ) : !savedCloudSettings.endpoint ||
                !savedCloudSettings.model ||
                !savedCloudSettings.apiKey ? (
                <div className="analysis-ready-state">
                  <p>尚未配置可用的 AI 服务商、模型与该服务商的 API 密钥。</p>
                  <button className="primary-button" type="button" onClick={() => setView("settings")}>前往设置</button>
                </div>
              ) : (
                <div className="analysis-ready-state">
                  <p>已获得接口可见文字快照。点击后将进行本地脱敏，并创建一次可能计费的模型请求。</p>
                  {aiTextScopeNote(session) && (
                    <small className="analysis-scope-note">{aiTextScopeNote(session)}</small>
                  )}
                  <button className="primary-button" type="button" onClick={() => void runWholeThreadCloudAnalysisForSession(session)}>
                    开始 AI 初筛
                  </button>
                  <small>默认不会自动付费；可在设置中显式开启。</small>
                </div>
              )}
            </section>
            {!captureDiagnosis?.blocking && (
              <details className="coverage-details nonblocking-coverage-details">
                <summary>读取范围详情</summary>
                <CoverageCard session={session} />
              </details>
            )}
            {busy && captureProgress && (
              <section className="capture-progress" role="status" aria-live="polite">
                <strong>{capturePhaseLabels[captureProgress.phase]}</strong>
                <span>{captureProgress.completed} / {captureProgress.total || "待确认"}</span>
                <small>已等待 {elapsedLabel(clockNow - (captureStartedAt ?? clockNow))}；切换标签页不会取消这次读取。</small>
                <button className="secondary-button" type="button" onClick={() => void cancelCapture()}>取消读取</button>
              </section>
            )}
          </div>
        )}

        {view === "reasons" && (
          <div className="view-stack reasons-view">
            <section className="section-heading"><div><span className="eyebrow">规范原文</span><h2>16 类 · 112 条删帖理由</h2></div><span className="version-pill">{REASON_VERSION}</span></section>
            <div className="reason-filters">
              <label>
                <span className="visually-hidden">搜索规范理由</span>
                <input
                  type="search"
                  value={reasonQuery}
                  onChange={(event) => setReasonQuery(event.target.value)}
                  placeholder="搜索规范原文或分类"
                />
              </label>
            </div>
            <p className="reason-result-count" aria-live="polite">
              {reasonQuery.trim()
                ? `找到 ${filteredReasons.length} 条规范，来自 ${matchedReasonCategoryCount} 个分类`
                : `${REASON_CATEGORIES.find((category) => category.id === reasonCategory)?.title ?? "当前分类"} · ${filteredReasons.length} 条规范`}
            </p>
            {!reasonQuery.trim() && (
              <div className="reason-categories" aria-label="规范分类">
                {REASON_CATEGORIES.map((category) => {
                  const count = REASON_RULES.filter(
                    (reason) => reason.categoryId === category.id,
                  ).length;
                  const active = reasonCategory === category.id;
                  const triggerId = `reason-category-trigger-${category.id}`;
                  const panelId = `reason-category-panel-${category.id}`;
                  return (
                    <section className="reason-category-block" key={category.id}>
                      <button
                        type="button"
                        id={triggerId}
                        className={`reason-category-trigger ${active ? "active" : ""}`}
                        aria-expanded={active}
                        aria-controls={panelId}
                        onClick={() => setReasonCategory(category.id)}
                      >
                        <span className="reason-category-index">{category.index}</span>
                        <span className="reason-category-title">{category.title}</span>
                        <small>{count} 条</small>
                      </button>
                      <div
                        className="reason-category-panel"
                        id={panelId}
                        role="region"
                        aria-labelledby={triggerId}
                        hidden={!active}
                      >
                        {active && renderReasonRows(filteredReasons)}
                      </div>
                    </section>
                  );
                })}
              </div>
            )}
            {reasonQuery.trim() && (
              <div className="reason-list" aria-label="规范搜索结果">
                {visibleReasonGroups.map((group) => (
                  <section
                    className="reason-category-group"
                    key={group.category.id}
                    aria-labelledby={`reason-group-${group.category.id}`}
                  >
                    <header id={`reason-group-${group.category.id}`}>
                      <div>
                        <small>第 {group.category.index} 类</small>
                        <strong>{group.category.title}</strong>
                      </div>
                      <span>匹配 {group.matchedCount} / 共 {group.totalCount} 条</span>
                    </header>
                    {renderReasonRows(group.reasons)}
                  </section>
                ))}
                {filteredReasons.length === 0 && (
                  <div className="quiet-state"><p>没有找到匹配的规范，请换一个关键词。</p></div>
                )}
              </div>
            )}
            {filteredReasons.length > reasonVisibleCount && (
              <button
                type="button"
                className="secondary-button reason-load-more"
                onClick={() => setReasonVisibleCount((count) => count + 20)}
              >
                再显示 {Math.min(20, filteredReasons.length - reasonVisibleCount)} 条
              </button>
            )}
          </div>
        )}

        {view === "history" && (
          <div className="view-stack history-page">
            <section className="header-actions">
              <div>
                <span className="eyebrow">本机持久保存</span>
                <h2>AI 分析历史</h2>
                <p>
                  {!analysisHistoryReady
                    ? "正在核对 AI 分析历史"
                    : analysisHistoryLoadError
                      ? "AI 分析历史数量未知"
                      : `已保存 ${analysisHistory.length} 次完整分析`}
                  ；
                  {!recordsReady
                    ? "正在核对人工决定"
                    : recordsLoadError
                      ? "人工决定数量未知"
                      : `已保存 ${records.length} 条人工决定`}
                  。扩展更新、重新加载或重启 Chrome 后仍可恢复。
                </p>
              </div>
              <div className="record-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={exportHistory}
                  disabled={!analysisHistoryReady || analysisHistory.length === 0}
                >
                  <Icon name="download" />导出历史
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => importRef.current?.click()}
                  disabled={!analysisHistoryReady}
                >
                  导入历史
                </button>
                <input
                  ref={importRef}
                  hidden
                  type="file"
                  accept="application/json,.json"
                  onChange={importHistory}
                />
              </div>
            </section>

            <p className="privacy-note">
              历史保存在当前 Chrome 配置文件，包含帖子标题和 AI 生成的摘要、线索与报告；不单独保存 API 密钥、服务端点、原始回复正文、用户名或证据摘录。模型生成的文字可能概括或复述讨论内容。卸载扩展、切换 Chrome 配置文件或清除扩展数据会删除本机历史。
            </p>

            {!analysisHistoryReady ? (
              <section className="quiet-state" role="status" aria-live="polite">
                <h3>正在读取本机 AI 分析历史…</h3>
                <p>读取完成前不会把暂时的空列表显示成“没有历史”。</p>
              </section>
            ) : analysisHistoryLoadError ? (
              <section className="analysis-error-state" role="alert">
                <h3>无法确认本机 AI 分析历史</h3>
                <p>{analysisHistoryLoadError}</p>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void reloadAnalysisHistory()}
                >
                  重新读取历史
                </button>
              </section>
            ) : analysisHistory.length === 0 ? (
              <section className="quiet-state">
                <h3>还没有 AI 分析历史</h3>
                <p>完成一次整帖 AI 初筛后，结果会自动出现在这里，不再只留下一个原帖链接。</p>
                {session && (
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => setView("review")}
                  >
                    返回当前帖子
                  </button>
                )}
              </section>
            ) : (
              <div className="history-list" aria-label="AI 分析历史列表">
                {analysisHistory.map((entry) => {
                  const humanCheckCount =
                    entry.result.protocolVersion === 3
                      ? entry.result.report.notes.filter(
                          (note) => note.kind === "needs_human_check",
                        ).length
                      : entry.result.uncertainties.length;
                  const linkedDecisions = records.filter(
                    (record) => reviewRecordMatchesHistoryEntry(record, entry),
                  );
                  const replyRefs = new Map(
                    entry.replyRefs.map((reply) => [reply.id, reply]),
                  );
                  const tokenUsage = entry.usage ?? entry.result.usage;
                  const completedLabel = new Date(
                    entry.completedAt,
                  ).toLocaleString("zh-CN");
                  const accessibleEntryLabel = `${entry.threadTitle || `帖子 ${entry.threadId}`}，${completedLabel}`;
                  const needsHumanCheckNotes =
                    entry.result.protocolVersion === 3
                      ? entry.result.report.notes.filter(
                          (note) => note.kind === "needs_human_check",
                        )
                      : [];
                  const heatedButAllowedNotes =
                    entry.result.protocolVersion === 3
                      ? entry.result.report.notes.filter(
                          (note) => note.kind === "heated_but_allowed",
                        )
                      : [];
                  return (
                    <details className="history-entry" key={entry.attemptId}>
                      <summary className="history-entry-summary">
                        <span className="history-entry-title">
                          {entry.threadTitle || `帖子 ${entry.threadId}`}
                        </span>
                        <span className="history-entry-meta">
                          <time dateTime={entry.completedAt}>
                            {completedLabel}
                          </time>
                          <span>帖子 {entry.threadId}</span>
                          <span>{cloudProviderLabels[entry.provider]} · {entry.model}</span>
                        </span>
                        <span className="history-entry-badges">
                          <span>{entry.result.findings.length} 条待复核</span>
                          <span>{humanCheckCount} 条待人工确认</span>
                          <span>
                            {!recordsReady
                              ? "人工决定核对中"
                              : recordsLoadError
                                ? "人工决定数量未知"
                                : `${linkedDecisions.length} 条人工决定`}
                          </span>
                        </span>
                        <span className="history-entry-metrics">
                          <span><strong>{entry.result.analyzedReplyCount}</strong> 条已分析文字</span>
                          <span><strong>{entry.coverage.imageCount}</strong> 张图片未分析</span>
                          <span><strong>{tokenUsage?.totalTokens ?? "—"}</strong> token</span>
                        </span>
                      </summary>

                      <div className="history-entry-body">
                        <section className="history-summary">
                          <h3>AI 初筛总览</h3>
                          <p>{entry.result.summary}</p>
                          <small>
                            {entry.mode === "deep" ? "深度模式" : "快速模式"} · 分析器 {entry.analyzerVersion} · 规则库 {entry.rulesVersion}
                          </small>
                        </section>

                        <section aria-labelledby={`history-findings-${entry.attemptId}`}>
                          <h3 id={`history-findings-${entry.attemptId}`}>待复核线索</h3>
                          {entry.result.findings.length === 0 ? (
                            <p>本次 AI 初筛没有保留达到门槛的线索；这不等于帖子绝对安全。</p>
                          ) : (
                            <ol className="history-findings">
                              {entry.result.findings.map((finding) => {
                                const candidate = finding.reasonCandidates[0];
                                const reason = candidate
                                  ? getReasonById(candidate.reasonId)
                                  : undefined;
                                const locations = [
                                  ...new Set(
                                    finding.replyIds.flatMap((replyId) => {
                                      const reply = replyRefs.get(replyId);
                                      return reply ? [historyReplyLabel(reply)] : [];
                                    }),
                                  ),
                                ];
                                return (
                                  <li className="history-finding" key={finding.id}>
                                    <h4>{riskLabels[finding.type]} · {severityLabels[finding.severity]}</h4>
                                    <p>{finding.summary}</p>
                                    <p>
                                      模型把握 {candidate ? `${Math.round(candidate.confidence * 100)}%` : "未提供"}
                                      {locations.length > 0 ? ` · 涉及 ${locations.join("、")}` : ""}
                                    </p>
                                    {reason && (
                                      <p><strong>可能涉及规范：</strong>{reason.text}</p>
                                    )}
                                    {candidate?.rationale && <p>{candidate.rationale}</p>}
                                  </li>
                                );
                              })}
                            </ol>
                          )}
                        </section>

                        {entry.result.protocolVersion === 3 ? (
                          <details className="history-report">
                            <summary>查看分析详情</summary>
                            <p>{entry.result.report.overview}</p>
                            {entry.result.report.stages.length > 0 && (
                              <section>
                                <h4>讨论阶段</h4>
                                <ul>{entry.result.report.stages.map((item, index) => <li key={`${item.title}-${index}`}><strong>{item.title}</strong>：{item.summary}</li>)}</ul>
                              </section>
                            )}
                            {entry.result.report.interactions.length > 0 && (
                              <section>
                                <h4>关键互动</h4>
                                <ul>{entry.result.report.interactions.map((item, index) => <li key={`${item.title}-${index}`}><strong>{item.title}</strong>：{item.summary}</li>)}</ul>
                              </section>
                            )}
                            {needsHumanCheckNotes.length > 0 && (
                              <section>
                                <h4>待人工确认</h4>
                                <ul>{needsHumanCheckNotes.map((item, index) => <li key={`${item.kind}-${item.title}-${index}`}><strong>{item.title}</strong>：{item.summary}</li>)}</ul>
                              </section>
                            )}
                            {heatedButAllowedNotes.length > 0 && (
                              <section>
                                <h4>激烈但允许的讨论</h4>
                                <ul>{heatedButAllowedNotes.map((item, index) => <li key={`${item.kind}-${item.title}-${index}`}><strong>{item.title}</strong>：{item.summary}</li>)}</ul>
                              </section>
                            )}
                          </details>
                        ) : (
                          <details className="history-report">
                            <summary>查看旧版详细报告</summary>
                            <p>{entry.result.report?.discussionOverview ?? "旧版结果没有附带详细报告。"}</p>
                            {entry.result.report
                              ? ([
                                  ["讨论阶段", entry.result.report.discussionMap],
                                  ["关键互动", entry.result.report.participantDynamics],
                                  ["边界与待确认", entry.result.report.borderlineCases],
                                  ["激烈但允许的讨论", entry.result.report.normalHeatedDiscussion],
                                  ["读取范围说明", entry.result.report.coverageNotes],
                                  ["建议复核顺序", entry.result.report.reviewPriorities],
                                ] as const).map(([title, items]) =>
                                  items.length > 0 ? (
                                    <section key={title}>
                                      <h4>{title}</h4>
                                      <ul>{items.map((item, index) => <li key={`${title}-${index}`}>{item}</li>)}</ul>
                                    </section>
                                  ) : null,
                                )
                              : null}
                          </details>
                        )}

                        <section className="history-decisions">
                          <h3>人工决定</h3>
                          {!recordsReady ? (
                            <p role="status">正在核对本机人工决定；完成前不会把暂时的空列表当作没有决定。</p>
                          ) : recordsLoadError ? (
                            <p>无法确认本机人工决定；当前数量未知，不会显示为零。</p>
                          ) : linkedDecisions.length === 0 ? (
                            <p>这次分析尚未保存人工决定。打开同一快照后，可在“风险”页继续复核。</p>
                          ) : (
                            <ul>
                              {linkedDecisions.map((record) => (
                                <li key={record.id}>
                                  <strong>{decisionLabel(record.decision)}</strong> · {new Date(record.reviewedAt).toLocaleString("zh-CN")}
                                  {record.primaryReasonId ? ` · ${getReasonById(record.primaryReasonId)?.text ?? "旧版规范"}` : ""}
                                </li>
                              ))}
                            </ul>
                          )}
                        </section>

                        <div className="history-actions">
                          <a
                            className="primary-button"
                            href={entry.threadUrl}
                            target="_blank"
                            rel="noreferrer"
                            aria-label={`打开原帖：${accessibleEntryLabel}`}
                          >
                            打开原帖
                          </a>
                          {historyDeleteAttemptId === entry.attemptId ? (
                            <div className="history-delete-confirm" role="group" aria-label="确认删除本机 AI 报告">
                              <p>只删除这份本机 AI 报告，不会删除贴吧内容、关联人工决定或防重复计费标记。</p>
                              <button
                                ref={historyDeleteCancelRef}
                                type="button"
                                className="secondary-button"
                                aria-label={`取消删除：${accessibleEntryLabel}`}
                                onClick={() => {
                                  setHistoryDeleteAttemptId(null);
                                  const restoreTriggerFocus = () =>
                                    historyDeleteTriggerRefs.current
                                      .get(entry.attemptId)
                                      ?.focus();
                                  queueMicrotask(restoreTriggerFocus);
                                  requestAnimationFrame(restoreTriggerFocus);
                                }}
                              >
                                取消
                              </button>
                              <button
                                type="button"
                                className="danger-button"
                                aria-label={`确认删除本机 AI 报告：${accessibleEntryLabel}`}
                                onClick={() => void deleteHistory(entry)}
                              >
                                确认删除
                              </button>
                            </div>
                          ) : (
                            <button
                              ref={(node) => {
                                if (node) {
                                  historyDeleteTriggerRefs.current.set(
                                    entry.attemptId,
                                    node,
                                  );
                                } else {
                                  historyDeleteTriggerRefs.current.delete(
                                    entry.attemptId,
                                  );
                                }
                              }}
                              type="button"
                              className="secondary-button"
                              aria-label={`删除本机 AI 报告：${accessibleEntryLabel}`}
                              onClick={(event) => {
                                historyDeleteTriggerRefs.current.set(
                                  entry.attemptId,
                                  event.currentTarget,
                                );
                                setHistoryDeleteAttemptId(entry.attemptId);
                              }}
                            >
                              删除本机报告
                            </button>
                          )}
                        </div>
                      </div>
                    </details>
                  );
                })}
              </div>
            )}

            {analysisHistoryReady &&
              !analysisHistoryLoadError &&
              unlinkedReviewRecords.length > 0 && (
              <details className="legacy-records">
                <summary>未关联报告的人工决定（{unlinkedReviewRecords.length}）</summary>
                <div className="records-list">
                  {unlinkedReviewRecords.map((record) => (
                    <article key={record.id} className="record-row">
                      <div>
                        <span className={`decision-dot ${record.decision}`} />
                        <strong>{decisionLabel(record.decision)}</strong>
                        <time>{new Date(record.reviewedAt).toLocaleString("zh-CN")}</time>
                      </div>
                      <p>{record.primaryReasonId ? getReasonById(record.primaryReasonId)?.text ?? "旧版规范" : "未选择公开理由"}</p>
                      <a href={record.threadUrl} target="_blank" rel="noreferrer">打开原帖</a>
                    </article>
                  ))}
                </div>
              </details>
            )}

            <details className="low-frequency-actions">
              <summary>人工决定的导入与导出</summary>
              <div>
                <p>
                  这里使用独立的人工决定格式，不会与 AI 分析历史文件混用。
                </p>
                <div className="record-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={records.length === 0}
                    onClick={exportReviewRecords}
                  >
                    <Icon name="download" />导出人工决定
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => reviewRecordImportRef.current?.click()}
                  >
                    导入人工决定
                  </button>
                  <input
                    ref={reviewRecordImportRef}
                    hidden
                    type="file"
                    accept="application/json,.json"
                    onChange={importReviewRecords}
                  />
                </div>
              </div>
            </details>
          </div>
        )}

        {view === "settings" && (
          <div className="view-stack settings-view">
            <section className="section-heading"><div><span className="eyebrow">常用设置</span><h2>读取与 AI 初筛</h2></div><Icon name="cloud" /></section>
            <div className="settings-card settings-common">
              <p>整帖读取是不调用 AI 的贴吧只读网络请求，结果暂存在当前浏览器；AI 初筛会把本地脱敏后的文字发送给所选服务商，并可能产生费用。</p>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={cloudSettings.autoReadWholeThread}
                  onChange={(event) =>
                    updateCloudSettingsDraft({
                      ...cloudSettings,
                      autoReadWholeThread: event.target.checked,
                    })
                  }
                />
                <span><b>自动读取完整帖子</b><small>切到新的贴吧帖子时，自动调用固定的贴吧只读接口，不调用模型。</small></span>
              </label>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={cloudSettings.autoAnalyzeWholeThread}
                  onChange={(event) =>
                    updateCloudSettingsDraft({
                      ...cloudSettings,
                      autoAnalyzeWholeThread: event.target.checked,
                    })
                  }
                />
                <span><b>完整读取后自动创建 AI 请求</b><small>每个新的完整快照都会自动把本地脱敏文字发送给当前服务商，并产生一次可能计费的模型请求。默认关闭，必须由你明确开启。</small></span>
              </label>
            </div>
            <details className="settings-card advanced-settings">
              <summary>高级连接信息</summary>
              <div>
                <label>
                  AI 服务商
                  <select value={cloudSettings.provider} onChange={(event) => selectCloudProvider(event.target.value as CloudProvider)} disabled={cloudApiKeyLoading}>
                    <option value="alibaba">{cloudProviderLabels.alibaba}</option>
                    <option value="deepseek">{cloudProviderLabels.deepseek}</option>
                  </select>
                </label>
                <label>
                  OpenAI-compatible 端点
                  <input value={cloudSettings.endpoint} readOnly aria-readonly="true" title="整帖分析只连接扩展清单中的固定服务商域名" />
                </label>
                <label>模型名称<input value={cloudSettings.model} onChange={(event) => updateCloudSettingsDraft({ ...cloudSettings, model: event.target.value })} placeholder="模型 ID" /></label>
                <label>
                  分析模式
                  <select value={cloudSettings.mode} onChange={(event) => updateCloudSettingsDraft({ ...cloudSettings, mode: event.target.value as CloudAnalysisMode })}>
                    <option value="fast">{cloudModeLabels.fast}</option>
                    <option value="deep">{cloudModeLabels.deep}</option>
                  </select>
                </label>
                <div className="api-key-setting">
                  <label htmlFor="cloud-api-key">{currentProviderLabel} API 密钥</label>
                  <input
                    id="cloud-api-key"
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    value={apiKeyDraft}
                    onChange={(event) => updateApiKeyDraft(event.target.value)}
                    placeholder={currentProviderHasSavedApiKey ? "已保存；输入新值可替换" : "请输入该服务商的 API 密钥"}
                  />
                  <small className="api-key-status" role="status">
                    {cloudApiKeyLoading
                      ? "正在核对本机保存状态…"
                      : currentProviderHasSavedApiKey
                        ? "已按服务商保存在此 Chrome 配置文件；输入框留空不会更改。"
                        : "尚未保存；密钥不会同步或进入审核记录与导出文件。"}
                  </small>
                  {currentProviderHasSavedApiKey && (
                    cloudApiKeyClearConfirmation === cloudSettings.provider ? (
                      <div className="api-key-clear-confirm" role="group" aria-label={`确认清除 ${currentProviderLabel} 密钥`}>
                        <span>仅影响以后发起的任务，已发送任务不会中止。</span>
                        <button type="button" className="secondary-button" onClick={() => setCloudApiKeyClearConfirmation(null)} disabled={cloudApiKeyLoading}>取消</button>
                        <button type="button" className="danger-button" onClick={() => void confirmClearCloudApiKey()} disabled={cloudApiKeyLoading}>确认清除</button>
                      </div>
                    ) : (
                      <button type="button" className="secondary-button api-key-clear" onClick={() => setCloudApiKeyClearConfirmation(cloudSettings.provider)} disabled={cloudApiKeyLoading}>
                        清除已保存的 {currentProviderLabel} 密钥
                      </button>
                    )
                  )}
                </div>
              </div>
            </details>
            <button className="primary-button settings-save" onClick={saveCurrentCloudSettings} disabled={cloudApiKeyLoading}>保存设置（只影响未来任务）</button>
            <section className="settings-card usage-summary" aria-labelledby="usage-title">
              <small>本月本机记录</small>
              <h3 id="usage-title">{monthlyUsage.length} 次有用量回执的调用</h3>
              <dl>
                <div><dt>输入 token</dt><dd>{monthlyTokenTotals.input.toLocaleString("zh-CN")}</dd></div>
                <div><dt>输出 token</dt><dd>{monthlyTokenTotals.output.toLocaleString("zh-CN")}</dd></div>
                <div><dt>合计 token</dt><dd>{monthlyTokenTotals.all.toLocaleString("zh-CN")}</dd></div>
              </dl>
              <p>这里只统计服务商实际返回 token 用量的成功请求；人民币金额请以服务商后台账单为准。</p>
            </section>
            <div className="boundary-card"><Icon name="shield" /><div><strong>硬性边界</strong><p>固定权限仅覆盖百度贴吧、已配置的百炼工作区和 api.deepseek.com；不读取或导出 Cookie。API 密钥按服务商持久保存在此 Chrome 配置文件，重启、扩展更新和重新加载后仍保留，但不会同步或导出；卸载扩展或更换 Chrome 配置文件后会消失。扩展不调用发帖、删帖、封禁或吧务操作端点。</p></div></div>
          </div>
        )}
      </main>

      {paidRetryConfirmation && (
        <div className="cloud-confirm-backdrop" role="presentation">
          <section
            className="cloud-confirm-dialog paid-retry-dialog"
            ref={cloudDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="paid-retry-title"
            tabIndex={-1}
          >
            <span className="eyebrow">再次付费确认</span>
            <h2 id="paid-retry-title">
              {paidRetryConfirmation.reason === "reanalyze_success"
                ? "重新分析同一个快照？"
                : "结果未知或发送后失败，仍要重试？"}
            </h2>
            <p>
              新操作会创建另一项模型请求，并可能产生第二次费用。系统不会把旧请求排队或自动重发；人民币账单仍以服务商后台为准。
            </p>
            <dl>
              <div><dt>帖子</dt><dd>{paidRetryConfirmation.session.title}</dd></div>
              <div><dt>服务商</dt><dd>{cloudProviderLabels[savedCloudSettings.provider]}</dd></div>
              <div><dt>模型</dt><dd>{savedCloudSettings.model}</dd></div>
              <div><dt>模式</dt><dd>{cloudModeLabels[savedCloudSettings.mode]}</dd></div>
            </dl>
            <div className="cloud-confirm-actions">
              <button
                className="secondary-button"
                ref={cloudDialogCancelRef}
                type="button"
                onClick={() => {
                  setPaidRetryConfirmation(null);
                  queueMicrotask(() => cloudDialogTriggerRef.current?.focus());
                }}
              >
                取消
              </button>
              <button
                className="primary-button"
                type="button"
                onClick={() => {
                  const target = paidRetryConfirmation.session;
                  setPaidRetryConfirmation(null);
                  void runWholeThreadCloudAnalysisForSession(target, {
                    kind: "paid_retry",
                  });
                }}
              >
                确认并创建新请求
              </button>
            </div>
          </section>
        </div>
      )}

      {cloudConfirmation && (
        <div className="cloud-confirm-backdrop" role="presentation">
          <section
            className="cloud-confirm-dialog"
            ref={cloudDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="cloud-confirm-title"
            tabIndex={-1}
          >
            <span className="eyebrow">发送前人工确认</span>
            <h2 id="cloud-confirm-title">确认深度分析范围</h2>
            <p>尚未请求网络权限，也未发送任何正文。</p>
            <dl>
              <div><dt>服务商</dt><dd>{cloudProviderLabels[cloudConfirmation.provider]}</dd></div>
              <div><dt>服务商域名</dt><dd>{cloudConfirmation.hostname}</dd></div>
              <div><dt>分析模式</dt><dd>{cloudModeLabels[cloudConfirmation.mode]}</dd></div>
              <div><dt>文字回复</dt><dd>{cloudConfirmation.replyCount} 条（其中 {cloudConfirmation.selectedReplyCount} 条为选中证据）</dd></div>
              <div><dt>用户名</dt><dd>已替换为 U1/U2 等匿名别名</dd></div>
              <div><dt>敏感字段</dt><dd>手机号、电话、证件、邮箱、QQ/微信格式未检出遗留</dd></div>
              <div><dt>图片</dt><dd>不发送{cloudConfirmation.omittedImageCount > 0 ? `（已排除 ${cloudConfirmation.omittedImageCount} 张）` : ""}</dd></div>
            </dl>
            <p className="cloud-confirm-warning">确认后将仅为 <b>{cloudConfirmation.hostname}</b> 临时申请权限；请求结束、取消或关闭侧栏时由后台撤销。</p>
            <div className="cloud-confirm-actions">
              <button
                className="secondary-button"
                ref={cloudDialogCancelRef}
                onClick={() => {
                  setCloudConfirmation(null);
                  queueMicrotask(() => cloudDialogTriggerRef.current?.focus());
                }}
              >
                取消
              </button>
              <button className="primary-button" onClick={() => void confirmCloud()}>确认并发送脱敏文字</button>
            </div>
          </section>
        </div>
      )}

      <footer><span>所有线索都必须回看原文</span><span>规则库 {REASON_VERSION}</span></footer>
    </div>
  );
}
