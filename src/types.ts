export const SCHEMA_VERSION = "1.0" as const;

export type ParserVariant = "legacy" | "spa" | "api";
export type CaptureMode = "paginated" | "dynamic" | "api";
export type CloudProvider = "alibaba" | "deepseek";

export interface ReasonCategory {
  id: string;
  index: number;
  title: string;
  version: string;
}

export interface ReasonRule {
  id: string;
  categoryId: string;
  categoryTitle: string;
  item: number;
  text: string;
  version: string;
}

export interface CapturedReply {
  /** Tieba post id when available; otherwise a deterministic page/floor id. */
  id: string;
  /** Official Tieba post id when the rendered DOM exposes one. */
  siteReplyId: string | null;
  floor: number | null;
  parentReplyId: string | null;
  authorName: string | null;
  time: string | null;
  timestamp: number | null;
  content: string;
  sourcePage: number;
  sourceUrl: string;
  /** CSS selector used only to return the moderator to the original evidence. */
  anchor: string;
  imageCount: number;
  isNested: boolean;
  /** Known lower bound for nested replies that are not currently expanded. */
  unexpandedNestedCount: number;
}

export interface Coverage {
  captureMode: CaptureMode;
  visibleReplyCount: number;
  mainReplyCount: number;
  nestedReplyCount: number;
  imageCount: number;
  unexpandedLzlCount: number;
  analyzedPageNumbers: number[];
  hasUnanalyzedImages: boolean;
  /** Reply count displayed by Tieba; its exact inclusion rules are site-owned. */
  declaredReplyCount: number | null;
  /** True while the SPA may still mount replies that have not been captured. */
  dynamicContentMayRemain: boolean;
  /** True only when the SPA has rendered its explicit end-of-list marker. */
  reachedReplyListEnd: boolean;
  /** Replies without an official site id; their runtime ids cannot survive reloads. */
  unstableReplyIdCount: number;
  /** Detailed progress for the explicit, read-only whole-thread API capture. */
  apiCoverage?: {
    mainPagesFetched: number;
    mainPagesTotal: number;
    /** Includes the first floor when it is readable. */
    mainRepliesFetched: number;
    nestedParentsFetched: number;
    nestedParentsTotal: number;
    nestedRepliesFetched: number;
    nestedRepliesDeclared: number;
    failedRequestCount: number;
    /** Estimated from Tieba's reply_num using its usual "excluding root" meaning. */
    unavailableReplyCount: number;
    /** All pages exposed by the read endpoints were fetched and reconciled. */
    readableTextComplete: boolean;
  };
  /** False unless the page itself proves that all pages/nested replies are present. */
  isComplete: boolean;
}

export interface ThreadCapture {
  schemaVersion: typeof SCHEMA_VERSION;
  parserVariant: ParserVariant;
  /** Per-document runtime id used to reset virtual-list accumulation after reload. */
  documentInstanceId: string | null;
  threadId: string | null;
  url: string;
  title: string;
  pageNumber: number;
  replies: CapturedReply[];
  coverage: Coverage;
  errors: string[];
  warnings: string[];
  capturedAt: string;
}

export type RiskType =
  | "personal_attack"
  | "provocation"
  | "harassment"
  | "spam"
  | "privacy"
  | "other";

export type FindingSeverity = "low" | "medium" | "high" | "critical";

export interface FindingEvidence {
  replyId: string;
  excerpt: string;
  signals: string[];
  score: number;
}

export interface ReasonCandidate {
  reasonId: string;
  confidence: number;
  rationale: string;
}

export interface Finding {
  id: string;
  type: RiskType;
  severity: FindingSeverity;
  score: number;
  summary: string;
  replyIds: string[];
  /**
   * Locally resolved replies that help explain the finding but are not
   * themselves marked as violating. Cloud whole-thread review may populate
   * this; local findings and persisted review records deliberately do not.
   */
  contextReplyIds?: string[];
  participantNames: string[];
  evidence: FindingEvidence[];
  reasonCandidates: ReasonCandidate[];
  uncertainties: string[];
}

export interface ReviewRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  threadId: string | null;
  threadUrl: string;
  replyIds: string[];
  decision: "delete" | "keep" | "watch" | "undecided";
  primaryReasonId: string | null;
  internalTags: string[];
  reviewedAt: string;
  analyzerVersions: {
    local: string;
    cloud: string | null;
    rules: string;
  };
}
