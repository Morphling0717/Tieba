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
  mergeReviewRecords,
  parseReviewRecords,
  serializeReviewRecords,
} from "../lib/records";
import { copyText } from "../lib/clipboard";
import type { ReviewSession } from "../lib/session";
import {
  isSessionClearedMessage,
  isSessionSuspendedMessage,
  isSessionUpdatedMessage,
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
  clearThreadCloudCache,
  loadThreadCloudCache,
  saveThreadCloudCache,
  threadCloudCacheIdentity,
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
  loadCloudSettings,
  loadStoredRecords,
  saveCloudSettings,
  saveStoredRecords,
  type CloudSettings,
} from "./recordStore";
import { DEMO_SESSION } from "./demo";

type View = "review" | "reasons" | "records" | "settings";
type Decision = ReviewRecord["decision"];
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

function cloudNarrativeLines(
  value: string,
  replies: readonly CapturedReply[],
): string[] {
  return resolveCloudAliases(value, replies)
    .replace(/([。！？；])\s*(?=\S)/gu, "$1\n")
    .replace(/([：:])\s*(?=\d+[.)、])/gu, "$1\n")
    .replace(/\s+(?=\d+[.)、])/gu, "\n")
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean);
}

function NarrativeReferenceLinks({
  replyIds,
  replies,
  onJump,
}: {
  replyIds: readonly string[] | undefined;
  replies: Map<string, CapturedReply>;
  onJump: (replyId: string) => void;
}) {
  const referencedReplies = [...new Set(replyIds ?? [])].flatMap((replyId) => {
    const reply = replies.get(replyId);
    return reply ? [{ replyId, reply }] : [];
  });
  if (referencedReplies.length === 0) return null;

  return (
    <div className="narrative-reference-links" aria-label="这段说明引用的原帖回复">
      {referencedReplies.map(({ replyId, reply }) => (
        <button
          type="button"
          key={replyId}
          onClick={() => onJump(replyId)}
          aria-label={`定位引用：${floorLabel(reply)}，作者 ${reply.authorName?.trim() || "用户未知"}`}
        >
          <b>{floorLabel(reply)}</b>
          <span>{reply.authorName?.trim() || "用户未知"}</span>
          <Icon name="arrow" />
        </button>
      ))}
    </div>
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
  report: NonNullable<WholeThreadCloudAnalysisResult["report"]>;
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
  onSelect,
  onJump,
}: {
  finding: Finding;
  index: number;
  replies: Map<string, CapturedReply>;
  references?: WholeThreadCloudFindingNarrativeReferences;
  selected: boolean;
  onSelect: () => void;
  onJump: (replyId: string) => void;
}) {
  const orderedReplies = [...replies.values()];
  const candidate = finding.reasonCandidates[0];
  const reason = candidate ? getReasonById(candidate.reasonId) : undefined;
  return (
    <article className={`cloud-finding-item ${selected ? "selected" : ""}`}>
      <div className="cloud-finding-topline">
        <span>线索 {index + 1}</span>
        <strong>{riskLabels[finding.type]}</strong>
        <span className={`severity-badge ${finding.severity}`}>
          {severityLabels[finding.severity]}
        </span>
      </div>
      <CloudNarrative
        value={finding.summary}
        replies={orderedReplies}
        className="cloud-finding-summary"
        references={references?.summary}
        replyMap={replies}
        onJump={onJump}
      />
      <section className="cloud-finding-evidence">
        <small>涉嫌违规的回复（需人工复核）</small>
        <div className="cloud-reply-links" aria-label="涉及的原帖回复">
          {finding.replyIds.map((replyId) => {
            const reply = replies.get(replyId);
            const label = reply ? floorLabel(reply) : "无法定位的回复";
            const author = reply?.authorName?.trim() || "用户未知";
            const evidence = finding.evidence.find(
              (item) => item.replyId === replyId,
            );
            const excerpt = evidence?.excerpt ?? reply?.content.trim();
            return (
              <div className="cloud-evidence-entry" key={replyId}>
                <button
                  className="cloud-reply-link"
                  onClick={() => onJump(replyId)}
                  aria-label={`查看原文：${label}，作者 ${author}`}
                >
                  <span className="cloud-reply-content">
                    <span className="cloud-reply-meta">
                      <b>{label}</b>
                      <small>{author}</small>
                      <time>{friendlyTime(reply?.time ?? null)}</time>
                    </span>
                    {excerpt && (
                      <span className="cloud-reply-excerpt" title={excerpt}>
                        “{excerpt}”
                      </span>
                    )}
                  </span>
                  <span className="jump-hint">
                    原文 <Icon name="arrow" />
                  </span>
                </button>
                <NarrativeReferenceLinks
                  replyIds={references?.evidence[replyId]?.replyIds}
                  replies={replies}
                  onJump={onJump}
                />
              </div>
            );
          })}
        </div>
      </section>
      {(finding.contextReplyIds?.length ?? 0) > 0 && (
        <section className="cloud-finding-context">
          <small>相关上下文（非违规证据）</small>
          <div
            className="cloud-reply-links cloud-context-reply-links"
            aria-label="相关上下文（非违规证据）"
          >
            {finding.contextReplyIds?.map((replyId) => {
              const reply = replies.get(replyId);
              const label = reply ? floorLabel(reply) : "无法定位的回复";
              const author = reply?.authorName?.trim() || "用户未知";
              return (
                <button
                  className="cloud-reply-link cloud-context-reply-link"
                  key={replyId}
                  onClick={() => onJump(replyId)}
                  aria-label={`查看相关上下文：${label}，作者 ${author}`}
                >
                  <span className="cloud-reply-content">
                    <span className="cloud-reply-meta">
                      <b>{label}</b>
                      <small>{author}</small>
                      <time>{friendlyTime(reply?.time ?? null)}</time>
                    </span>
                  </span>
                  <span className="jump-hint">
                    原文 <Icon name="arrow" />
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}
      {reason && (
        <div className="cloud-finding-reason">
          <small>模型建议规范 · {reason.id}</small>
          <p>{reason.text}</p>
          {candidate?.rationale && (
            <CloudNarrative
              value={candidate.rationale}
              replies={orderedReplies}
              className="cloud-finding-rationale"
              references={references?.rationale}
              replyMap={replies}
              onJump={onJump}
            />
          )}
        </div>
      )}
      {finding.uncertainties.length > 0 && (
        <div className="cloud-finding-cautions">
          <small>这组线索仍需确认</small>
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
                />
              </li>
            ))}
          </ul>
        </div>
      )}
      <button
        className="secondary-button cloud-finding-select"
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
      >
        {selected ? "已选为记录对象" : "选为本次记录对象"}
      </button>
    </article>
  );
}

function Icon({ name }: { name: "shield" | "scan" | "copy" | "arrow" | "download" | "trash" | "cloud" }) {
  const paths = {
    shield: <path d="M12 3 5.5 5.5v5.7c0 4.2 2.8 7.8 6.5 9.8 3.7-2 6.5-5.6 6.5-9.8V5.5L12 3Z" />,
    scan: <><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M8 12h8M12 8v8"/></>,
    copy: <><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></>,
    arrow: <><path d="M5 12h14M13 6l6 6-6 6"/></>,
    download: <><path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/></>,
    trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14"/></>,
    cloud: <><path d="M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 8.5 4.5 4.5 0 0 0 7 18Z"/><path d="M12 11v5M9.5 13.5 12 11l2.5 2.5"/></>,
  };
  return <svg aria-hidden="true" className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function CoverageCard({ session }: { session: ReviewSession }) {
  const { coverage } = session;
  const dynamic = coverage.captureMode === "dynamic";
  const api = coverage.captureMode === "api";
  const apiCoverage = coverage.apiCoverage;
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
        <span className={`coverage-state ${coverage.isComplete ? "complete" : "partial"}`}>
          {stateLabel}
        </span>
      </div>
      <div className="metrics">
        {api ? (
          <div><strong>{coverage.visibleReplyCount}</strong><span>可读内容合计</span></div>
        ) : dynamic ? (
          <div><strong>{coverage.visibleReplyCount}</strong><span>已累计回复</span></div>
        ) : (
          <div><strong>{coverage.analyzedPageNumbers.length}</strong><span>已访问页</span></div>
        )}
        {api ? (
          <div><strong>{apiCoverage ? `${apiCoverage.mainPagesFetched}/${apiCoverage.mainPagesTotal}` : "—"}</strong><span>主回复分页</span></div>
        ) : dynamic ? (
          <div><strong>{coverage.declaredReplyCount ?? "—"}</strong><span>页面标注回复</span></div>
        ) : (
          <div><strong>{coverage.visibleReplyCount}</strong><span>文字回复</span></div>
        )}
        {api ? (
          <div><strong>{apiCoverage ? `${apiCoverage.nestedRepliesFetched}/${apiCoverage.nestedRepliesDeclared}` : "—"}</strong><span>楼中楼</span></div>
        ) : (
          <div><strong>{coverage.unexpandedLzlCount}</strong><span>未展开</span></div>
        )}
        {api ? (
          <div><strong>{apiCoverage?.unavailableReplyCount ?? "—"}</strong><span>不可见缺口</span></div>
        ) : (
          <div><strong>{coverage.imageCount}</strong><span>未识别图片</span></div>
        )}
      </div>
      {!coverage.isComplete && (
        <p className="coverage-note">
          {api
            ? apiCoverage?.readableTextComplete
              ? `${apiReplyBreakdown} 已读完接口当前能返回的主层和楼中楼。${apiCoverage.unavailableReplyCount > 0 ? ` 贴吧标注数量仍有 ${apiCoverage.unavailableReplyCount} 条差额，可能是已删除、审核中或不可见回复。` : ""}${coverage.imageCount > 0 ? ` 另有 ${coverage.imageCount} 张图片未识别文字。` : ""}`
              : `接口分页或数量校验未完成；失败请求 ${apiCoverage?.failedRequestCount ?? 0} 个，不能据此判断整帖安全。`
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
              ? resolveCloudAliases(finding.summary, orderedReplies)
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
                      ? resolveCloudAliases(signal, orderedReplies)
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
          <p>{cloudResult.summary}</p>
          {cloudResult.uncertainties.length > 0 && (
            <div className="cloud-result-cautions">
              <small>仍需留意</small>
              <ul>
                {cloudResult.uncertainties.map((item) => (
                  <li key={item}>{item}</li>
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

export function App() {
  const [view, setView] = useState<View>("review");
  const [session, setSession] = useState<ReviewSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const [selectedReasonId, setSelectedReasonId] = useState<string | null>(null);
  const [decision, setDecision] = useState<Decision>("watch");
  const [records, setRecords] = useState<ReviewRecord[]>([]);
  const [reasonQuery, setReasonQuery] = useState("");
  const [reasonCategory, setReasonCategory] = useState("all");
  const [cloudSettings, setCloudSettings] = useState<CloudSettings>({
    provider: DEFAULT_CLOUD_PROVIDER,
    ...CLOUD_PROVIDER_DEFAULTS[DEFAULT_CLOUD_PROVIDER],
    apiKey: "",
    mode: DEFAULT_CLOUD_ANALYSIS_MODE,
    autoAnalyzeWholeThread: true,
  });
  const [cloudSettingsReady, setCloudSettingsReady] = useState(false);
  const [cloudResults, setCloudResults] = useState<Record<string, CloudAnalysisResult>>({});
  const [cloudBusyId, setCloudBusyId] = useState<string | null>(null);
  const [cloudConfirmation, setCloudConfirmation] = useState<PendingCloudConfirmation | null>(null);
  const [wholeThreadCloudResult, setWholeThreadCloudResult] =
    useState<WholeThreadCloudAnalysisResult | null>(null);
  const [wholeThreadCloudBusy, setWholeThreadCloudBusy] = useState(false);
  const [wholeThreadCloudError, setWholeThreadCloudError] =
    useState<string | null>(null);
  const [wholeThreadCloudPermissionRequired, setWholeThreadCloudPermissionRequired] =
    useState(false);
  const [wholeThreadCloudPermissionBusy, setWholeThreadCloudPermissionBusy] =
    useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const cloudAbortRef = useRef<AbortController | null>(null);
  const wholeThreadCloudAbortRef = useRef<AbortController | null>(null);
  const wholeThreadCloudAttemptRef = useRef<string | null>(null);
  const wholeThreadCloudRunRef = useRef<{
    token: symbol;
    generation: number;
  } | null>(null);
  const wholeThreadCloudPermissionRequestRef = useRef(false);
  const wholeThreadCloudPermissionGenerationRef = useRef(0);
  const cloudSettingsSaveAttemptRef = useRef(0);
  const appMountedRef = useRef(true);
  const lastCloudSessionRevisionRef = useRef<string | null>(null);
  const activeReviewTabRef = useRef<number | null>(null);
  const autoCaptureAttemptedTabsRef = useRef(new Set<number>());
  const sessionRef = useRef(session);
  const cloudSettingsRef = useRef(cloudSettings);
  activeReviewTabRef.current = session?.tabId ?? null;
  sessionRef.current = session;
  cloudSettingsRef.current = cloudSettings;

  // Local code is deliberately limited to capture, coverage checks and
  // redaction. Only a completed whole-thread model response may create risk
  // findings shown to the moderator or persisted in a review record.
  const findings = useMemo(
    () => wholeThreadCloudResult?.findings ?? [],
    [wholeThreadCloudResult],
  );
  const replies = useMemo(
    () => new Map((session?.replies ?? []).map((reply) => [reply.id, reply])),
    [session],
  );
  const selectedReason = selectedReasonId ? getReasonById(selectedReasonId) : undefined;
  const filteredReasons = useMemo(() => {
    const query = reasonQuery.trim().toLocaleLowerCase("zh-CN");
    return REASON_RULES.filter((rule) => {
      if (reasonCategory !== "all" && rule.categoryId !== reasonCategory) return false;
      return !query || `${rule.id}${rule.categoryTitle}${rule.text}`.toLocaleLowerCase("zh-CN").includes(query);
    });
  }, [reasonCategory, reasonQuery]);

  useLayoutEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [view]);

  useEffect(() => {
    appMountedRef.current = true;
    if (typeof chrome === "undefined" || !chrome.runtime?.id) {
      if (new URLSearchParams(window.location.search).has("demo")) {
        setSession(DEMO_SESSION);
      }
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
      await capturePage();
    };
    const refreshActiveSession = async (
      allowAutoCapture = false,
    ): Promise<void> => {
      try {
        const activeSession = await sendExtensionMessage<ReviewSession | null>({
          type: "GET_ACTIVE_SESSION",
        });
        setSession(activeSession);
        if (!activeSession && allowAutoCapture) {
          const settings = await loadCloudSettings();
          if (settings.autoAnalyzeWholeThread) await maybeAutoCapture();
        }
      } catch {
        setSession(null);
      }
    };

    void Promise.all([
      sendExtensionMessage<ReviewSession | null>({ type: "GET_ACTIVE_SESSION" }).catch(() => null),
      loadStoredRecords(),
      loadCloudSettings(),
      sendExtensionMessage<string | null>({ type: "GET_CLOUD_PERMISSION_STATUS" }).catch(() => null),
    ]).then(([loadedSession, loadedRecords, loadedCloud, cleanupStatus]) => {
      setSession(loadedSession);
      setRecords(loadedRecords);
      setCloudSettings(loadedCloud);
      setCloudSettingsReady(true);
      if (cleanupStatus) setError(cleanupStatus);
      if (!loadedSession && loadedCloud.autoAnalyzeWholeThread) {
        void maybeAutoCapture();
      }
    });

    const listener = (message: unknown) => {
      if (isSessionUpdatedMessage(message)) {
        void getActiveTabId().then((activeId) => {
          if (activeId === message.session.tabId) {
            wholeThreadCloudPermissionGenerationRef.current += 1;
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
        wholeThreadCloudPermissionGenerationRef.current += 1;
        // Hide a session already known to belong to this tab immediately. The
        // asynchronous active-tab lookup below is still used for notices and
        // cross-tab validation, but must not leave stale actions clickable.
        setSession((current) =>
          current?.tabId === message.tabId ? null : current,
        );
        void getActiveTabId().then((activeId) => {
          if (activeId !== message.tabId) return;
          cloudAbortRef.current?.abort();
          wholeThreadCloudAbortRef.current?.abort();
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
        wholeThreadCloudPermissionGenerationRef.current += 1;
        setSession((current) =>
          current?.tabId === message.tabId ? null : current,
        );
        void getActiveTabId().then((activeId) => {
          if (activeId !== message.tabId) return;
          cloudAbortRef.current?.abort();
          wholeThreadCloudAbortRef.current?.abort();
          setCloudConfirmation(null);
          setSession(null);
          setError("暂时无法核对当前页面地址；审阅数据仍保留，请重新点击扩展图标");
        });
      }
    };
    const tabListener = () => {
      wholeThreadCloudPermissionGenerationRef.current += 1;
      cloudAbortRef.current?.abort();
      wholeThreadCloudAbortRef.current?.abort();
      setCloudConfirmation(null);
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
          wholeThreadCloudPermissionGenerationRef.current += 1;
          wholeThreadCloudAbortRef.current?.abort();
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
      wholeThreadCloudPermissionGenerationRef.current += 1;
      cloudAbortRef.current?.abort();
      wholeThreadCloudAbortRef.current?.abort();
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
    wholeThreadCloudPermissionGenerationRef.current += 1;
    // A new capture can materially change both the selected cluster and its
    // anonymized context. Never keep cloud output attached to an older
    // revision. The explicit revision guard also prevents React StrictMode
    // from starting the same paid request twice.
    cloudAbortRef.current?.abort();
    wholeThreadCloudAbortRef.current?.abort();
    setSelectedFindingId(null);
    setSelectedReasonId(null);
    setCloudResults({});
    setCloudConfirmation(null);
    setWholeThreadCloudResult(null);
    setWholeThreadCloudError(null);
    setWholeThreadCloudPermissionRequired(false);
    wholeThreadCloudAttemptRef.current = null;
  }, [session?.tabId, session?.threadId, session?.threadUrl, session?.updatedAt]);

  useEffect(() => {
    if (
      !session ||
      !cloudSettingsReady ||
      !cloudSettings.autoAnalyzeWholeThread ||
      !cloudSettings.endpoint ||
      !cloudSettings.model ||
      !cloudSettings.apiKey
    ) {
      return;
    }
    if (
      session.coverage.captureMode !== "api" ||
      !session.coverage.apiCoverage?.readableTextComplete
    ) {
      setWholeThreadCloudError(
        "当前不是完整的贴吧只读接口快照，已禁止自动外发，避免把残缺内容当成整帖。",
      );
      return;
    }
    void runWholeThreadCloudAnalysisForSession(session);
  }, [
    session?.tabId,
    session?.threadId,
    session?.updatedAt,
    cloudSettings.endpoint,
    cloudSettings.model,
    cloudSettings.apiKey,
    cloudSettings.mode,
    cloudSettings.autoAnalyzeWholeThread,
    cloudSettingsReady,
  ]);

  useEffect(() => {
    const selectedFinding = findings.find(
      (finding) => finding.id === selectedFindingId,
    );
    if (!selectedFinding && findings[0]) {
      setSelectedFindingId(findings[0].id);
      if (findings[0].reasonCandidates[0]) {
        setSelectedReasonId(findings[0].reasonCandidates[0].reasonId);
      }
    } else if (!findings[0]) {
      setSelectedFindingId(null);
    } else if (!selectedReasonId && selectedFinding?.reasonCandidates[0]) {
      setSelectedReasonId(selectedFinding.reasonCandidates[0].reasonId);
    }
  }, [findings, selectedFindingId, selectedReasonId]);

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
    force = false,
    permissionGeneration?: number,
  ): Promise<void> {
    const analysisGeneration =
      permissionGeneration ??
      wholeThreadCloudPermissionGenerationRef.current;
    if (
      analysisGeneration !==
      wholeThreadCloudPermissionGenerationRef.current
    ) {
      return;
    }
    const activeRun = wholeThreadCloudRunRef.current;
    if (activeRun && activeRun.generation >= analysisGeneration) return;
    const token = Symbol("whole-thread-cloud-run");
    wholeThreadCloudRunRef.current = { token, generation: analysisGeneration };
    try {
      await executeWholeThreadCloudAnalysisForSession(
        targetSession,
        force,
        analysisGeneration,
      );
    } finally {
      if (wholeThreadCloudRunRef.current?.token === token) {
        wholeThreadCloudRunRef.current = null;
      }
    }
  }

  async function executeWholeThreadCloudAnalysisForSession(
    targetSession: ReviewSession,
    force: boolean,
    analysisGeneration: number,
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
    const identity = threadCloudCacheIdentity(targetSession, cloudSettings);
    const identityKey = JSON.stringify(identity);
    // Every automatic run and explicit retry captures one immutable intent,
    // not just the permission-recovery path. Any session/tab/settings change
    // increments the shared generation and permanently invalidates this run.
    const analysisIntentIsCurrent = () =>
      analysisGeneration ===
      wholeThreadCloudPermissionGenerationRef.current;
    if (!analysisIntentIsCurrent()) return;
    if (!force && wholeThreadCloudAttemptRef.current === identityKey) return;
    wholeThreadCloudAttemptRef.current = identityKey;
    if (force) {
      if (!analysisIntentIsCurrent()) return;
      try {
        await clearThreadCloudCache(targetSession.tabId);
      } catch {
        // The moderator explicitly requested a retry. The in-memory attempt
        // guard still prevents a second request within this side-panel run.
      }
      if (!analysisIntentIsCurrent()) return;
    } else {
      let cached;
      try {
        cached = await loadThreadCloudCache(identity);
      } catch {
        if (!analysisIntentIsCurrent()) return;
        setWholeThreadCloudError(
          "无法核对本次帖子是否已经调用过模型，已停止自动发送，避免重复计费。可点击“重新分析”明确重试。",
        );
        return;
      }
      if (!analysisIntentIsCurrent()) return;
      if (wholeThreadCloudAttemptRef.current !== identityKey) return;
      if (cached?.status === "success") {
        setWholeThreadCloudResult(cached.result);
        setWholeThreadCloudError(null);
        setWholeThreadCloudPermissionRequired(false);
        return;
      }
      if (cached?.status === "pending") {
        setWholeThreadCloudResult(null);
        setWholeThreadCloudError(
          "上一次整帖请求可能仍在服务商侧处理。为避免重复计费，本次不会自动再发；确认需要重试时请点击“重新分析”。",
        );
        return;
      }
      if (cached?.status === "failed") {
        setWholeThreadCloudResult(null);
        const permissionRequired =
          isPersistentCloudPermissionRequired(cached.error);
        setWholeThreadCloudPermissionRequired(permissionRequired);
        setWholeThreadCloudError(permissionRequired
          ? cached.error
          : `${cached.error}（本次不会自动重试，可点击“重新分析”）`);
        return;
      }
    }
    if (!analysisIntentIsCurrent()) return;
    if (wholeThreadCloudAttemptRef.current !== identityKey) return;

    const controller = new AbortController();
    wholeThreadCloudAbortRef.current?.abort();
    wholeThreadCloudAbortRef.current = controller;
    setWholeThreadCloudBusy(true);
    setWholeThreadCloudResult(null);
    setWholeThreadCloudError(null);
    setWholeThreadCloudPermissionRequired(false);
    try {
      const result = await runManagedWholeThreadCloudAnalysis(
        targetSession.title,
        targetSession.replies,
        {
          endpoint: cloudSettings.endpoint,
          model: cloudSettings.model,
          apiKey: cloudSettings.apiKey,
          mode: cloudSettings.mode,
          signal: controller.signal,
          beforeStart: async () => {
            if (!analysisIntentIsCurrent()) {
              throw new DOMException(
                "帖子或 AI 设置已变更，本次分析没有发送正文",
                "AbortError",
              );
            }
            await assertSessionIsActive(targetSession, true);
            if (!analysisIntentIsCurrent()) {
              throw new DOMException(
                "帖子或 AI 设置已变更，本次分析没有发送正文",
                "AbortError",
              );
            }
            await saveThreadCloudCache({
              ...identity,
              status: "pending",
              startedAt: new Date().toISOString(),
            });
            if (!analysisIntentIsCurrent()) {
              throw new DOMException(
                "帖子或 AI 设置已变更，本次分析没有发送正文",
                "AbortError",
              );
            }
          },
        },
      );
      if (!analysisIntentIsCurrent()) return;
      await assertSessionIsActive(targetSession, true);
      if (controller.signal.aborted || !analysisIntentIsCurrent()) return;
      try {
        await saveThreadCloudCache({
          ...identity,
          status: "success",
          result,
        });
      } catch {
        if (!analysisIntentIsCurrent()) return;
        setNotice(
          "模型结果已返回，但本次会话缓存写入失败；关闭并重开侧栏前请勿重复分析。",
        );
      }
      if (!analysisIntentIsCurrent()) return;
      setWholeThreadCloudResult(result);
      setWholeThreadCloudError(null);
      setWholeThreadCloudPermissionRequired(false);
      setNotice(
        `整帖 AI 已审阅 ${result.analyzedReplyCount} 条文字回复，并对照 ${result.ruleCount} 条规范理由`,
      );
    } catch (caught) {
      if (controller.signal.aborted) return;
      if (!analysisIntentIsCurrent()) return;
      const message =
        caught instanceof Error ? caught.message : "整帖云端分析失败";
      const permissionRequired =
        isPersistentCloudPermissionRequired(caught);
      try {
        await saveThreadCloudCache({
          ...identity,
          status: "failed",
          error: message,
        });
      } catch {
        // The in-memory attempt guard still prevents an automatic retry while
        // this side-panel instance remains open.
      }
      if (!analysisIntentIsCurrent()) return;
      setWholeThreadCloudPermissionRequired(permissionRequired);
      setWholeThreadCloudError(permissionRequired
        ? message
        : `${message}（本次不会自动重试，可点击“重新分析”）`);
    } finally {
      if (wholeThreadCloudAbortRef.current === controller) {
        wholeThreadCloudAbortRef.current = null;
        setWholeThreadCloudBusy(false);
      }
    }
  }

  async function rerunWholeThreadCloudAnalysis(): Promise<void> {
    if (!session || wholeThreadCloudBusy) return;
    if (
      !cloudSettings.endpoint ||
      !cloudSettings.model ||
      !cloudSettings.apiKey
    ) {
      setView("settings");
      setError("请先保存 AI 服务商、模型和本次浏览器会话使用的 API 密钥");
      return;
    }
    await runWholeThreadCloudAnalysisForSession(session, true);
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
      !cloudSettings.endpoint ||
      !cloudSettings.model ||
      !cloudSettings.apiKey
    ) {
      setView("settings");
      setError("请先保存 AI 服务商、模型和本次浏览器会话使用的 API 密钥");
      return;
    }

    // Keep this call in the direct onClick stack. In particular, do not clear
    // the failed cache or perform an active-session await before Chrome opens
    // its site-access prompt.
    const permissionGeneration =
      wholeThreadCloudPermissionGenerationRef.current;
    const requestedSessionRevision = `${session.tabId}:${session.threadId ?? session.threadUrl}:${session.updatedAt}`;
    const requestedSettings = {
      provider: cloudSettings.provider,
      endpoint: cloudSettings.endpoint,
      model: cloudSettings.model,
      apiKey: cloudSettings.apiKey,
      mode: cloudSettings.mode,
      autoAnalyzeWholeThread: cloudSettings.autoAnalyzeWholeThread,
    };
    let permissionRequest: Promise<boolean>;
    try {
      permissionRequest = requestPersistentCloudPermission(
        cloudSettings.endpoint,
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
    const requestIsCurrent = (): boolean => {
      const currentSession = sessionRef.current;
      const currentSettings = cloudSettingsRef.current;
      const currentSessionRevision = currentSession
        ? `${currentSession.tabId}:${currentSession.threadId ?? currentSession.threadUrl}:${currentSession.updatedAt}`
        : null;
      return (
        appMountedRef.current &&
        permissionGeneration ===
          wholeThreadCloudPermissionGenerationRef.current &&
        currentSessionRevision === requestedSessionRevision &&
        currentSettings.provider === requestedSettings.provider &&
        currentSettings.endpoint === requestedSettings.endpoint &&
        currentSettings.model === requestedSettings.model &&
        currentSettings.apiKey === requestedSettings.apiKey &&
        currentSettings.mode === requestedSettings.mode &&
        currentSettings.autoAnalyzeWholeThread ===
          requestedSettings.autoAnalyzeWholeThread
      );
    };
    void (async () => {
      let permissionResolved = false;
      try {
        const granted = await permissionRequest;
        permissionResolved = true;
        if (!requestIsCurrent()) {
          if (granted && appMountedRef.current) {
            setWholeThreadCloudPermissionRequired(false);
            setWholeThreadCloudError(null);
            setError(
              `${cloudProviderLabels[requestedSettings.provider]} 权限已授予，但帖子或 AI 设置已经变化；本次没有发送正文，也没有调用模型。`,
            );
          }
          return;
        }
        if (!granted) {
          setWholeThreadCloudPermissionRequired(true);
          setWholeThreadCloudError(
            `你没有授予 ${cloudProviderLabels[requestedSettings.provider]} 网络权限；帖子正文尚未发送，原失败记录仍保留。`,
          );
          return;
        }
        // Chrome can resolve a permission prompt before its tab/navigation
        // events reach this side panel. Re-read the active review identity
        // before clearing the old failure marker, then re-check the local
        // generation in case settings changed during that read.
        await assertSessionIsActive(session, true);
        if (!requestIsCurrent()) {
          setError(
            `${cloudProviderLabels[requestedSettings.provider]} 权限已授予，但帖子或 AI 设置已经变化；本次没有发送正文，也没有调用模型。`,
          );
          return;
        }
        setWholeThreadCloudPermissionRequired(false);
        setWholeThreadCloudError(null);
        // The explicit grant makes this a deliberate paid retry. force clears
        // the old failed marker, then the normal path sends exactly one whole-
        // thread request after its final session/revision check.
        await runWholeThreadCloudAnalysisForSession(
          session,
          true,
          permissionGeneration,
        );
      } catch (caught) {
        if (!requestIsCurrent()) {
          if (permissionResolved && appMountedRef.current) {
            setError(
              caught instanceof Error
                ? caught.message
                : "帖子或 AI 设置已变更，本次没有发送正文",
            );
          }
          return;
        }
        setWholeThreadCloudPermissionRequired(
          !permissionResolved || isPersistentCloudPermissionRequired(caught),
        );
        setWholeThreadCloudError(
          !permissionResolved
            ? `Chrome 未能完成 ${cloudProviderLabels[requestedSettings.provider]} 授权；帖子正文尚未发送，原失败记录仍保留。${caught instanceof Error ? `（${caught.message}）` : ""}`
            : caught instanceof Error
              ? caught.message
              : "AI 端点授权失败",
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
    cloudAbortRef.current?.abort();
    wholeThreadCloudAbortRef.current?.abort();
    wholeThreadCloudPermissionGenerationRef.current += 1;
    wholeThreadCloudAttemptRef.current = null;
    setCloudSettingsReady(false);
    setWholeThreadCloudPermissionRequired(false);
    cloudSettingsRef.current = next;
    setCloudSettings(next);
  }

  function saveCurrentCloudSettings(): void {
    const snapshot = { ...cloudSettings };
    const generation = wholeThreadCloudPermissionGenerationRef.current;
    const attempt = cloudSettingsSaveAttemptRef.current + 1;
    cloudSettingsSaveAttemptRef.current = attempt;
    const snapshotIsCurrent = (): boolean => {
      const current = cloudSettingsRef.current;
      return (
        generation === wholeThreadCloudPermissionGenerationRef.current &&
        current.provider === snapshot.provider &&
        current.endpoint === snapshot.endpoint &&
        current.model === snapshot.model &&
        current.apiKey === snapshot.apiKey &&
        current.mode === snapshot.mode &&
        current.autoAnalyzeWholeThread === snapshot.autoAnalyzeWholeThread
      );
    };

    void saveCloudSettings(snapshot)
      .then(() => {
        if (attempt !== cloudSettingsSaveAttemptRef.current) return;
        if (!snapshotIsCurrent()) {
          setCloudSettingsReady(false);
          setError("AI 设置在保存期间又发生了变化；新设置尚未启用，请重新保存。");
          return;
        }
        setCloudSettingsReady(true);
        setNotice(
          "设置已保存；完整整帖快照将自动分析，密钥会在浏览器会话结束后清除",
        );
      })
      .catch((caught: unknown) => {
        if (attempt !== cloudSettingsSaveAttemptRef.current) return;
        setCloudSettingsReady(false);
        setError(
          caught instanceof Error ? caught.message : "云端设置保存失败",
        );
      });
  }

  function selectCloudProvider(provider: CloudProvider): void {
    updateCloudSettingsDraft({
      ...cloudSettings,
      provider,
      ...CLOUD_PROVIDER_DEFAULTS[provider],
      // Provider credentials are not interchangeable. Requiring a fresh
      // entry prevents an Alibaba key from being sent to DeepSeek or vice versa.
      apiKey: "",
      mode: provider === "deepseek" ? "deep" : "fast",
    });
    setError(null);
    setNotice("已切换服务商；请输入该服务商的 API 密钥后保存。");
  }

  async function capturePage() {
    setBusy(true);
    setError(null);
    try {
      const next = await sendExtensionMessage<ReviewSession>({ type: "CAPTURE_WHOLE_THREAD" });
      wholeThreadCloudPermissionGenerationRef.current += 1;
      setSession(next);
      setNotice(
        next.coverage.captureMode === "api"
          ? next.coverage.apiCoverage?.readableTextComplete
            ? `接口可见文字已读完：主层 ${next.coverage.mainReplyCount} 条（含主帖）＋楼中楼 ${next.coverage.nestedReplyCount} 条＝共 ${next.coverage.visibleReplyCount} 条`
            : `已读取 ${next.coverage.visibleReplyCount} 条证据，但接口分页或数量校验仍有缺口`
          : next.coverage.captureMode === "dynamic"
          ? `已累计 ${next.coverage.visibleReplyCount} 条可见回复`
          : `已读取第 ${next.coverage.analyzedPageNumbers.at(-1) ?? 1} 页`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "读取页面失败");
    } finally {
      setBusy(false);
    }
  }

  async function jumpToReply(replyId: string) {
    const reply = replies.get(replyId);
    if (!reply) return;
    if (!session) return;
    try {
      await assertSessionIsActive(session);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "当前帖子会话已失效");
      return;
    }
    const currentPage = Number(
      new URL(session.threadUrl).searchParams.get("pn") ?? "1",
    );
    if (
      session.coverage.captureMode !== "api" &&
      currentPage !== reply.sourcePage
    ) {
      // Legacy captures still depend on the page that exposed the evidence.
      await chrome.tabs.update(session.tabId, { url: reply.sourceUrl });
      setNotice("已打开证据所在页，页面载入后请再次点击该证据");
      return;
    }
    try {
      await sendExtensionMessage({
        type: "JUMP_TO_REPLY",
        replyId,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法定位原回复");
    }
  }

  async function copySelectedReason() {
    if (!selectedReason) return;
    try {
      await copyText(selectedReason.text);
      setNotice(`已复制 ${selectedReason.id} 的规范原文`);
    } catch {
      setError("复制失败，请选中规范原文后手动复制");
    }
  }

  async function saveReview() {
    if (!session) return;
    if (decision === "delete" && !selectedReasonId) {
      setError("选择删除时必须先选择一个公开理由");
      return;
    }
    try {
      if (typeof chrome !== "undefined" && chrome.runtime?.id) {
        await assertSessionIsActive(session);
      }
      const finding = findings.find((item) => item.id === selectedFindingId);
      const record = createReviewRecord({
        threadId: session.threadId,
        threadUrl: session.threadUrl,
        replyIds: finding?.replyIds ?? [],
        decision,
        primaryReasonId: decision === "delete" ? selectedReasonId : null,
        internalTags: finding ? [finding.type, finding.severity] : [],
        analyzerVersions: {
          local: "disabled",
          cloud: wholeThreadCloudResult ? CLOUD_ANALYZER_VERSION : null,
          rules: REASON_VERSION,
        },
      });
      const next = mergeReviewRecords(records, [record]);
      await saveStoredRecords(next);
      setRecords(next);
      setNotice("审核记录已保存到本机");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存审核记录失败");
    }
  }

  function prepareCloud(finding: Finding) {
    if (!session) return;
    if (cloudBusyId) return;
    if (!cloudSettings.endpoint || !cloudSettings.model || !cloudSettings.apiKey) {
      setView("settings");
      setError("请先填写云端端点、模型和本次浏览器会话使用的 API 密钥");
      return;
    }
    try {
      const preview = buildCloudPreflight(
        finding,
        session.replies,
        cloudSettings.endpoint,
      );
      setCloudConfirmation({
        ...preview,
        findingId: finding.id,
        tabId: session.tabId,
        threadId: session.threadId,
        sessionUpdatedAt: session.updatedAt,
        endpoint: cloudSettings.endpoint,
        model: cloudSettings.model,
        mode: cloudSettings.mode,
        provider: cloudSettings.provider,
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
      cloudSettings.endpoint !== confirmation.endpoint ||
      cloudSettings.model !== confirmation.model ||
      cloudSettings.mode !== confirmation.mode
      || cloudSettings.provider !== confirmation.provider
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
          endpoint: confirmation.endpoint,
          model: confirmation.model,
          apiKey: cloudSettings.apiKey,
          mode: confirmation.mode,
          signal: controller.signal,
          beforeStart: async () => {
            await saveCloudSettings(cloudSettings);
            // This is the last awaited check before the broker receives the
            // exact finding/replies snapshot that the moderator previewed.
            await assertSessionIsActive(activeSession, true);
          },
        },
      );
      const result = await analysis;
      setCloudResults((current) => ({ ...current, [finding.id]: result }));
      setSelectedFindingId(finding.id);
      if (result.reasonCandidates[0]) {
        setSelectedReasonId(result.reasonCandidates[0].reasonId);
      }
      setNotice("深度分析完成；请仍以原文和上下文为准");
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

  function exportRecords() {
    const blob = new Blob([serializeReviewRecords(records)], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = `假面骑士吧审核记录-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(href);
  }

  async function importRecords(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const imported = parseReviewRecords(await file.text());
      const next = mergeReviewRecords(records, imported);
      await saveStoredRecords(next);
      setRecords(next);
      setNotice(`已导入 ${imported.length} 条记录`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "记录导入失败");
    }
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-mark"><Icon name="shield" /></div>
        <div className="brand-copy">
          <span>假面骑士吧</span>
          <h1>长帖审阅助手</h1>
        </div>
        <span className="local-pill"><i />AI 判定 · 本地脱敏</span>
      </header>

      <nav className="tabs" aria-label="功能导航">
        {([
          ["review", "风险"],
          ["reasons", "理由库"],
          ["records", "记录"],
          ["settings", "设置"],
        ] as const).map(([id, label]) => (
          <button key={id} className={view === id ? "active" : ""} onClick={() => setView(id)}>{label}</button>
        ))}
      </nav>

      {(error || notice) && (
        <div className={`toast ${error ? "error" : "success"}`} role="status">
          <span>{error ?? notice}</span>
          <button aria-label="关闭提示" onClick={() => { setError(null); setNotice(null); }}>×</button>
        </div>
      )}

      <main>
        {!session && view !== "reasons" && view !== "records" && view !== "settings" ? (
          <section className="empty-state">
            <div className="empty-visual"><Icon name="scan" /><span>只读取当前打开的帖子</span></div>
            <span className="eyebrow">开始一次人工审阅</span>
            <h2>先打开需要检查的贴吧长帖</h2>
            <p>点击下方按钮后，扩展才会通过固定的贴吧只读端点读取整帖楼层和楼中楼。它不会后台巡检，也不会执行删除或封禁。</p>
            <button className="primary-button" onClick={capturePage} disabled={busy}><Icon name="scan" />{busy ? "正在读取整帖…" : "读取整帖"}</button>
          </section>
        ) : null}

        {session && view === "review" && (
          <div className="view-stack">
            <section className="thread-heading">
              <div><span className="eyebrow">正在审阅</span><h2>{session.title}</h2></div>
              <button className="icon-button" title="重新读取整帖" onClick={capturePage} disabled={busy}><Icon name="scan" /></button>
            </section>
            <CoverageCard session={session} />
            {(session.errors.length > 0 || session.warnings.length > 0) && (
              <section className={`capture-issues ${session.errors.length > 0 ? "has-errors" : ""}`}>
                <strong>{session.errors.length > 0 ? "本次解析不完整，不能据此判定整帖安全" : "仍有覆盖缺口"}</strong>
                <ul>
                  {[...session.errors, ...session.warnings].map((issue) => <li key={issue}>{issue}</li>)}
                </ul>
              </section>
            )}
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
            >
              <div className="section-heading">
                <div>
                  <span className="eyebrow">整帖 AI 审阅</span>
                  <h2>
                    {wholeThreadCloudPermissionBusy
                      ? `正在请求 ${cloudProviderLabels[cloudSettings.provider]} 权限`
                      : wholeThreadCloudBusy
                      ? `正在审阅 ${session.replies.length} 条回复`
                      : wholeThreadCloudResult
                        ? `已对照 ${wholeThreadCloudResult.ruleCount} 条规范`
                        : wholeThreadCloudPermissionRequired
                          ? `需要授权 ${cloudProviderLabels[cloudSettings.provider]} 网络权限`
                          : wholeThreadCloudError
                            ? "整帖 AI 审阅未完成"
                            : cloudSettings.autoAnalyzeWholeThread
                              ? "等待完整整帖快照"
                              : "自动分析已关闭"}
                  </h2>
                </div>
                <Icon name="cloud" />
              </div>
              {wholeThreadCloudPermissionBusy ? (
                <p>Chrome 正在等待你的站点权限选择；在允许前不会发送任何帖子正文。</p>
              ) : wholeThreadCloudBusy ? (
                <p>
                  已在本地替换用户名与敏感字段，正在把全部可读楼层和楼中楼交给
                  {cloudSettings.model}。不会逐条重复请求。
                </p>
              ) : wholeThreadCloudResult ? (
                <>
                  <section className="cloud-report-lead">
                    <small>审阅结论</small>
                    <h3>整帖摘要</h3>
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
                  <div className="cloud-scope">
                    <span>{wholeThreadCloudResult.analyzedReplyCount} 条回复</span>
                    <span>{wholeThreadCloudResult.findings.length} 组违规线索</span>
                    <span>
                      {wholeThreadCloudResult.omittedImageCount} 张图片未发送
                    </span>
                  </div>
                  {wholeThreadCloudResult.report && (
                    <WholeThreadLongReport
                      report={wholeThreadCloudResult.report}
                      replies={session.replies}
                      references={
                        wholeThreadCloudResult.narrativeReferences?.report
                      }
                      replyMap={replies}
                      onJump={jumpToReply}
                      placement="before-findings"
                    />
                  )}
                  {wholeThreadCloudResult.findings.length > 0 && (
                    <section className="cloud-actionable-findings">
                      <header className="cloud-report-group-heading">
                        <div>
                          <small>需要回原文复核</small>
                          <h3>高置信违规线索</h3>
                        </div>
                        <span>{wholeThreadCloudResult.findings.length} 组</span>
                      </header>
                      <div className="cloud-finding-list">
                        {wholeThreadCloudResult.findings.map((finding, index) => (
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
                            onSelect={() => {
                              setSelectedFindingId(finding.id);
                              setSelectedReasonId(
                                finding.reasonCandidates[0]?.reasonId ?? null,
                              );
                            }}
                            onJump={jumpToReply}
                          />
                        ))}
                      </div>
                    </section>
                  )}
                  {wholeThreadCloudResult.report && (
                    <WholeThreadLongReport
                      report={wholeThreadCloudResult.report}
                      replies={session.replies}
                      references={
                        wholeThreadCloudResult.narrativeReferences?.report
                      }
                      replyMap={replies}
                      onJump={jumpToReply}
                      placement="after-findings"
                    />
                  )}
                  {wholeThreadCloudResult.uncertainties.length > 0 && (
                    <div className="cloud-overall-cautions">
                      <strong>仍需人工留意</strong>
                      <ul>
                        {wholeThreadCloudResult.uncertainties.map((item, index) => (
                          <li key={`${index}:${item}`}>
                            {cloudNarrativeLines(item, session.replies).map((line, lineIndex) => (
                              <p key={`${lineIndex}:${line}`}>{line}</p>
                            ))}
                            <NarrativeReferenceLinks
                              replyIds={
                                wholeThreadCloudResult.narrativeReferences
                                  ?.uncertainties[index]?.replyIds
                              }
                              replies={replies}
                              onJump={jumpToReply}
                            />
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {(session.coverage.apiCoverage?.unavailableReplyCount ?? 0) >
                    0 && (
                    <small>
                      贴吧另标注了{" "}
                      {session.coverage.apiCoverage?.unavailableReplyCount}{" "}
                      条当前接口不可见内容；模型只审阅了接口实际可返回的全部文字。
                    </small>
                  )}
                </>
              ) : wholeThreadCloudError ? (
                <p>{wholeThreadCloudError}</p>
              ) : !cloudSettings.endpoint ||
                !cloudSettings.model ||
                !cloudSettings.apiKey ? (
                <p>请先在“设置”中选择 AI 服务商，并保存模型和本次会话的 API 密钥。</p>
              ) : (
                <p>
                  只有贴吧只读接口完成全部主楼和楼中楼分页后才会自动发送；DOM
                  降级结果不会外发。
                </p>
              )}
              {!wholeThreadCloudBusy && !wholeThreadCloudPermissionBusy &&
                (wholeThreadCloudResult || wholeThreadCloudError) && (
                  <div className="cloud-retry">
                    {wholeThreadCloudPermissionRequired ? (
                      <>
                        <button
                          className="secondary-button"
                          onClick={authorizePersistentCloudAndAnalyze}
                        >
                          授权 {cloudSettings.provider === "deepseek" ? "DeepSeek" : "阿里云百炼"} 并分析
                        </button>
                        <small>
                          仅授权 {new URL(cloudSettings.endpoint).hostname}；权限会持续保留，直到你在 Chrome 扩展设置中撤销。允许后才会发送脱敏整帖并产生费用。
                        </small>
                      </>
                    ) : (
                      <>
                        <button
                          className="secondary-button"
                          onClick={() => void rerunWholeThreadCloudAnalysis()}
                        >
                          重新分析整帖
                        </button>
                        <small>会再次调用模型，可能产生一次新的费用。</small>
                      </>
                    )}
                  </div>
                )}
            </section>
            {!wholeThreadCloudResult ? (
              <section className="model-only-state" aria-label="AI 判定状态">
                <Icon name="cloud" />
                <div>
                  <strong>尚无模型审阅结论</strong>
                  <p>本地只负责读取、覆盖校验和脱敏，不再生成风险分数、违规线索或理由推荐。请以上方整帖 AI 返回为准。</p>
                </div>
              </section>
            ) : (
              <section className="decision-card">
                <span className="eyebrow">形成处理记录</span>
                <div className="decision-options">
                  {(["watch", "keep", "delete"] as const).map((value) => (
                    <button key={value} className={decision === value ? "selected" : ""} onClick={() => setDecision(value)}>
                      {value === "watch" ? "继续观察" : value === "keep" ? "保留" : "建议删除"}
                    </button>
                  ))}
                </div>
                {selectedReason && <div className="selected-reason"><small>{selectedReason.id} · {selectedReason.categoryTitle}</small><p>{selectedReason.text}</p><button onClick={copySelectedReason}><Icon name="copy" />复制规范理由</button></div>}
                <button className="primary-button" onClick={saveReview}>保存本地审核记录</button>
              </section>
            )}
          </div>
        )}

        {view === "reasons" && (
          <div className="view-stack reasons-view">
            <section className="section-heading"><div><span className="eyebrow">规范原文</span><h2>16 类 · 112 条删帖理由</h2></div><span className="version-pill">{REASON_VERSION}</span></section>
            <div className="reason-filters">
              <input type="search" value={reasonQuery} onChange={(event) => setReasonQuery(event.target.value)} placeholder="搜索理由、分类或编号" />
              <select value={reasonCategory} onChange={(event) => setReasonCategory(event.target.value)}>
                <option value="all">全部分类</option>
                {REASON_CATEGORIES.map((category) => <option key={category.id} value={category.id}>{category.index}. {category.title}</option>)}
              </select>
            </div>
            <div className="reason-list">
              {filteredReasons.map((reason) => (
                <label key={reason.id} className={`reason-row ${selectedReasonId === reason.id ? "selected" : ""}`}>
                  <input type="radio" name="reason-library" checked={selectedReasonId === reason.id} onChange={() => setSelectedReasonId(reason.id)} />
                  <span><small>{reason.id} · {reason.categoryTitle}</small>{reason.text}</span>
                  <button type="button" title="复制理由" onClick={(event) => { event.preventDefault(); void copyText(reason.text).then(() => setNotice(`已复制 ${reason.id}`)).catch(() => setError("复制失败，请选中规范原文后手动复制")); }}><Icon name="copy" /></button>
                </label>
              ))}
            </div>
          </div>
        )}

        {view === "records" && (
          <div className="view-stack">
            <section className="section-heading"><div><span className="eyebrow">本地审核日志</span><h2>{records.length} 条最小化记录</h2></div></section>
            <div className="record-actions">
              <button className="secondary-button" onClick={exportRecords} disabled={records.length === 0}><Icon name="download" />导出 JSON</button>
              <button className="secondary-button" onClick={() => importRef.current?.click()}>导入记录</button>
              <input ref={importRef} hidden type="file" accept="application/json,.json" onChange={importRecords} />
            </div>
            <p className="privacy-note">记录不包含完整正文和用户名，可作为以后团队工作台的迁移数据。</p>
            <div className="records-list">
              {records.length === 0 ? <div className="quiet-state"><p>还没有审核记录。</p></div> : records.map((record) => (
                <article key={record.id} className="record-row">
                  <div><span className={`decision-dot ${record.decision}`} /><strong>{record.decision === "delete" ? "建议删除" : record.decision === "keep" ? "保留" : "继续观察"}</strong><time>{new Date(record.reviewedAt).toLocaleString("zh-CN")}</time></div>
                  <p>{record.primaryReasonId ? `${record.primaryReasonId} · ${getReasonById(record.primaryReasonId)?.text ?? "未知理由"}` : "未选择公开删帖理由"}</p>
                  <a href={record.threadUrl} target="_blank" rel="noreferrer">打开原帖</a>
                </article>
              ))}
            </div>
          </div>
        )}

        {view === "settings" && (
          <div className="view-stack settings-view">
            <section className="section-heading"><div><span className="eyebrow">自动能力</span><h2>整帖 AI 审阅</h2></div><Icon name="cloud" /></section>
            <div className="settings-card">
              <p>打开帖子并保持侧栏开启后，扩展会读取贴吧接口能够返回的全部主楼和楼中楼，再一次性把脱敏文字和 112 条规范理由交给模型。不会逐条重复请求，也不会发送用户名、图片、帖子链接或登录信息。</p>
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
                <span>完整读取后自动分析整帖</span>
              </label>
              <label>
                AI 服务商
                <select
                  value={cloudSettings.provider}
                  onChange={(event) =>
                    selectCloudProvider(event.target.value as CloudProvider)
                  }
                >
                  <option value="alibaba">{cloudProviderLabels.alibaba}</option>
                  <option value="deepseek">{cloudProviderLabels.deepseek}</option>
                </select>
              </label>
              <label>
                OpenAI-compatible 端点
                <input
                  value={cloudSettings.endpoint}
                  readOnly
                  aria-readonly="true"
                  title="整帖分析只连接扩展清单中的固定服务商域名"
                />
              </label>
              <label>模型名称<input value={cloudSettings.model} onChange={(event) => updateCloudSettingsDraft({ ...cloudSettings, model: event.target.value })} placeholder="模型 ID" /></label>
              <label>
                分析模式
                <select
                  value={cloudSettings.mode}
                  onChange={(event) => updateCloudSettingsDraft({
                    ...cloudSettings,
                    mode: event.target.value as CloudAnalysisMode,
                  })}
                >
                  <option value="fast">{cloudModeLabels.fast}</option>
                  <option value="deep">{cloudModeLabels.deep}</option>
                </select>
              </label>
              <label>API 密钥（仅本次浏览器会话）<input type="password" autoComplete="off" value={cloudSettings.apiKey} onChange={(event) => updateCloudSettingsDraft({ ...cloudSettings, apiKey: event.target.value })} placeholder="不会导出或同步" /></label>
              <button
                className="primary-button"
                onClick={saveCurrentCloudSettings}
              >
                保存设置
              </button>
            </div>
            <div className="boundary-card"><Icon name="shield" /><div><strong>硬性边界</strong><p>固定权限仅覆盖百度贴吧、已配置的百炼工作区和 api.deepseek.com；不读取或导出 Cookie，API 密钥仅保存在当前浏览器会话，不调用发帖、删帖、封禁或吧务操作端点。</p></div></div>
          </div>
        )}
      </main>

      {cloudConfirmation && (
        <div className="cloud-confirm-backdrop" role="presentation">
          <section
            className="cloud-confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cloud-confirm-title"
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
              <button className="secondary-button" onClick={() => setCloudConfirmation(null)}>取消</button>
              <button className="primary-button" onClick={() => void confirmCloud()} autoFocus>确认并发送脱敏文字</button>
            </div>
          </section>
        </div>
      )}

      <footer><span>所有线索都必须回看原文</span><span>规则库 {REASON_VERSION}</span></footer>
    </div>
  );
}
