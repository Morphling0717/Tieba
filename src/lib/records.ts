import { z } from "zod";
import { SCHEMA_VERSION } from "../types";
import type { ReviewRecord } from "../types";
import { getReasonById } from "../data/reasons";

export interface ReviewExport {
  schemaVersion: typeof SCHEMA_VERSION;
  exportedAt: string;
  records: ReviewRecord[];
}

export type NewReviewRecord = Omit<
  ReviewRecord,
  "schemaVersion" | "id" | "reviewedAt"
> &
  Partial<Pick<ReviewRecord, "id" | "reviewedAt">>;

export interface CreateReviewRecordOptions {
  /** Injectable for deterministic tests and callers that already own a clock. */
  now?: () => Date;
  /** Injectable for environments without `crypto.randomUUID`. */
  randomUUID?: () => string;
}

const recordIdSchema = z.string().trim().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
);
const replyIdSchema = z.string().trim().regex(
  /^(?:\d{1,30}|\d{1,30}-first-floor|(?:\d{1,30}|thread)-page-\d{1,6}-floor-\d{1,10}(?:-nested-\d{1,6})?|\d{1,30}-nested-\d{1,6}|kr-(?:lzl(?:-temp)?|comment-temp)-[A-Za-z0-9-]{16,120})$/u,
);
const safeVersion = z.string().trim().regex(
  /^\d{1,4}\.\d{1,4}(?:\.\d{1,4})?(?:-[A-Za-z0-9.-]{1,32})?$/u,
);
const internalTag = z.enum([
  "personal_attack",
  "provocation",
  "harassment",
  "spam",
  "privacy",
  "other",
  "low",
  "medium",
  "high",
  "critical",
]);
const isoDateTime = z.iso.datetime({ offset: true });

function canonicalThreadUrl(value: string): string | null {
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
    return `https://tieba.baidu.com/p/${threadId}`;
  } catch {
    return null;
  }
}

const threadUrlSchema = z.string().trim().transform((value, context) => {
  const canonical = canonicalThreadUrl(value);
  if (!canonical) {
    context.addIssue({
      code: "custom",
      message: "threadUrl 必须是桌面版百度贴吧帖子地址",
    });
    return z.NEVER;
  }
  return canonical;
});
const reasonIdSchema = z.string().trim().refine(
  (value) => Boolean(getReasonById(value)),
  "primaryReasonId 必须来自当前规范理由库",
);
const analysisAttemptIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9:_-]{1,128}$/u);
const snapshotIdSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const findingIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9:_-]{1,200}$/u);

const analyzerVersionsSchema = z.strictObject({
  // `disabled` marks API-only reviews without pretending the former local
  // heuristic analyzer contributed to the decision. Existing numeric
  // versions remain valid so schemaVersion 1.0 exports stay importable.
  local: z.union([safeVersion, z.literal("disabled")]),
  cloud: safeVersion.nullable(),
  rules: safeVersion,
});

const reviewRecordSchema = z
  .strictObject({
    schemaVersion: z.literal(SCHEMA_VERSION),
    id: recordIdSchema,
    threadId: z.string().regex(/^\d{1,30}$/u).nullable(),
    threadUrl: threadUrlSchema,
    replyIds: z.array(replyIdSchema).max(10_000),
    decision: z.enum(["delete", "keep", "watch", "undecided"]),
    primaryReasonId: reasonIdSchema.nullable(),
    internalTags: z.array(internalTag).max(16),
    reviewedAt: isoDateTime,
    analysisAttemptId: analysisAttemptIdSchema.nullable().optional(),
    snapshotId: snapshotIdSchema.nullable().optional(),
    findingId: findingIdSchema.nullable().optional(),
    analyzerVersions: analyzerVersionsSchema,
  })
  .superRefine((record, context) => {
    const urlThreadId = record.threadUrl.match(/^https:\/\/tieba\.baidu\.com\/p\/(\d+)$/u)?.[1];
    if (record.threadId !== null && record.threadId !== urlThreadId) {
      context.addIssue({
        code: "custom",
        path: ["threadId"],
        message: "threadId 与 threadUrl 不一致",
      });
    }
  });

const reviewExportSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  exportedAt: isoDateTime,
  records: z.array(reviewRecordSchema),
});

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function normalizedRecord(value: unknown): ReviewRecord {
  const record = validateReviewRecord(value);
  return {
    ...record,
    threadUrl: canonicalThreadUrl(record.threadUrl)!,
    replyIds: uniqueStrings(record.replyIds),
    internalTags: uniqueStrings(record.internalTags),
  };
}

function defaultRandomUUID(): string {
  if (!globalThis.crypto?.randomUUID) {
    throw new Error(
      "crypto.randomUUID is unavailable; pass CreateReviewRecordOptions.randomUUID",
    );
  }
  return globalThis.crypto.randomUUID();
}

/**
 * Validates the exact persisted shape. Strict schemas deliberately reject
 * fields such as `content` and `authorName`, so exports cannot silently retain
 * full reply text or usernames.
 */
export function validateReviewRecord(value: unknown): ReviewRecord {
  return reviewRecordSchema.parse(value);
}

/** Validates the exact versioned JSON export envelope and every record in it. */
export function validateReviewExport(value: unknown): ReviewExport {
  return reviewExportSchema.parse(value);
}

export function createReviewRecord(
  input: NewReviewRecord,
  options: CreateReviewRecordOptions = {},
): ReviewRecord {
  const now = options.now ?? (() => new Date());
  const randomUUID = options.randomUUID ?? defaultRandomUUID;
  return normalizedRecord({
    ...input,
    schemaVersion: SCHEMA_VERSION,
    id: input.id ?? randomUUID(),
    reviewedAt: input.reviewedAt ?? now().toISOString(),
  });
}

/**
 * Merges records without mutating either input. A later review wins when IDs
 * collide; equal timestamps use the incoming/later array entry. Results are
 * ordered newest first for direct display in the review history.
 */
export function mergeReviewRecords(
  existing: readonly ReviewRecord[],
  incoming: readonly ReviewRecord[],
): ReviewRecord[] {
  const recordsById = new Map<string, ReviewRecord>();

  for (const candidate of [...existing, ...incoming]) {
    const record = normalizedRecord(candidate);
    const current = recordsById.get(record.id);
    if (
      !current ||
      Date.parse(record.reviewedAt) >= Date.parse(current.reviewedAt)
    ) {
      recordsById.set(record.id, record);
    }
  }

  return [...recordsById.values()].sort((left, right) => {
    const byTime = Date.parse(right.reviewedAt) - Date.parse(left.reviewedAt);
    return byTime || left.id.localeCompare(right.id);
  });
}

export function serializeReviewRecords(
  records: readonly ReviewRecord[],
  exportedAt = new Date().toISOString(),
): string {
  const reviewExport = validateReviewExport({
    schemaVersion: SCHEMA_VERSION,
    exportedAt,
    records: mergeReviewRecords([], records),
  });
  return JSON.stringify(reviewExport, null, 2);
}

/** Parses, strictly validates, normalizes, and de-duplicates an export. */
export function parseReviewRecords(serialized: string): ReviewRecord[] {
  const reviewExport = validateReviewExport(JSON.parse(serialized));
  return mergeReviewRecords([], reviewExport.records);
}
