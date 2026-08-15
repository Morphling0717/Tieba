import type { CapturedReply } from "../types";

/** The deliberately small wire representation used by cloud analysis. */
export interface AnonymizedReply {
  id: string;
  floor: number | null;
  parentReplyId: string | null;
  authorAlias: string;
  time: string | null;
  content: string;
  sourcePage: number;
}

export interface AnonymizeOptions {
  /**
   * Names seen elsewhere in the thread. They are removed even when their
   * authors are not part of the selected cloud context.
   */
  knownAuthorNames?: Iterable<string | null | undefined>;
}

const EMAIL_PATTERN = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/giu;
const CHINESE_ID_PATTERN = /(?<![0-9a-z])(?:\d{17}[0-9x]|\d{15})(?![0-9a-z])/giu;
const MOBILE_PATTERN = /(?<!\d)(?:(?:\+|00)86[\s-]?)?1[3-9]\d[\s-]?\d{4}[\s-]?\d{4}(?!\d)/gu;
const LANDLINE_PATTERN = /(?<!\d)(?:\+?86[\s-]?)?0\d{2,3}[\s-]?\d{7,8}(?!\d)/gu;
const QQ_PATTERN = /(?:q\s*q|QQ|qq|\u6263\u6263|\u4f01\u9e45(?:\u53f7)?)(?:\s*(?:\u53f7|\u53f7\u7801|id))?\s*[:\uff1a]?\s*[1-9]\d{4,11}/giu;
const WECHAT_PATTERN = /(?:\u5fae\u4fe1|\u5fae\u4fe1\u53f7|v\s*x|v\u4fe1|w\s*x|wechat)(?:\s*(?:\u53f7|\u53f7\u7801|id))?\s*[:\uff1a]?\s*[a-z][-_a-z0-9]{5,19}/giu;
const UNKNOWN_MENTION_PATTERN = /@([\p{L}\p{N}_.\-·]{1,40})/gu;
const UNKNOWN_REPLY_TARGET_PATTERN =
  /((?:回复|回覆)\s*@?)([\p{L}\p{N}_.\-·]{1,40})(?=\s*[:：])/gu;
const SENSITIVE_PATTERNS = [
  EMAIL_PATTERN,
  CHINESE_ID_PATTERN,
  MOBILE_PATTERN,
  LANDLINE_PATTERN,
  QQ_PATTERN,
  WECHAT_PATTERN,
] as const;

function normalizedName(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  return trimmed ? trimmed : null;
}

/** Assigns aliases by first appearance, making the result stable for an input order. */
export function createAuthorAliasMap(
  replies: readonly CapturedReply[],
): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();
  for (const reply of replies) {
    const name = normalizedName(reply.authorName);
    if (name && !aliases.has(name)) {
      aliases.set(name, `U${aliases.size + 1}`);
    }
  }
  return aliases;
}

/** Redacts common Chinese contact/identity patterns without retaining a value. */
export function redactSensitiveText(input: string): string {
  return input
    .replace(QQ_PATTERN, "[QQ\u53f7]")
    .replace(WECHAT_PATTERN, "[\u5fae\u4fe1\u53f7]")
    .replace(EMAIL_PATTERN, "[\u90ae\u7bb1]")
    .replace(CHINESE_ID_PATTERN, "[\u8eab\u4efd\u8bc1]")
    .replace(MOBILE_PATTERN, "[\u624b\u673a\u53f7]")
    .replace(LANDLINE_PATTERN, "[\u7535\u8bdd]");
}

/** Final preflight check over the already-redacted payload text. */
export function containsUnredactedSensitiveText(input: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    const matched = pattern.test(input);
    pattern.lastIndex = 0;
    return matched;
  });
}

function redactAuthorNames(
  input: string,
  aliases: ReadonlyMap<string, string>,
  knownAuthorNames: Iterable<string | null | undefined>,
): string {
  const names = new Set<string>();
  for (const name of knownAuthorNames) {
    const normalized = normalizedName(name);
    if (normalized) names.add(normalized);
  }
  for (const name of aliases.keys()) names.add(name);

  // Contact fields must be removed before handling @mentions; otherwise the
  // `@domain` part of an email could be mistaken for an unknown username and
  // prevent the email pattern from matching as a whole.
  let withoutNames = redactSensitiveText(input).replaceAll("\u0000", "");
  const aliasMarkers = new Map<string, string>();
  let aliasMarkerIndex = 0;
  if (names.size > 0) {
    const escapedNames = [...names]
      .sort((left, right) => right.length - left.length)
      .map((name) => name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
    // Temporary NUL-delimited markers prevent generated aliases such as U1
    // from colliding with literal text that already contained "@U1".
    const authorPattern = new RegExp(escapedNames.join("|"), "gu");
    withoutNames = withoutNames.replace(
      authorPattern,
      (name) => {
        const marker = `\u0000KR_AUTHOR_${aliasMarkerIndex}\u0000`;
        aliasMarkerIndex += 1;
        aliasMarkers.set(marker, aliases.get(name) ?? "[\u7528\u6237\u540d]");
        return marker;
      },
    );
  }
  const withoutUnknownMentions = withoutNames.replace(
    UNKNOWN_MENTION_PATTERN,
    "@[\u7528\u6237\u540d]",
  );
  const withoutUnknownReplyTargets = withoutUnknownMentions.replace(
    UNKNOWN_REPLY_TARGET_PATTERN,
    (_match, prefix: string) => `${prefix}[\u7528\u6237\u540d]`,
  );
  let restoredAliases = withoutUnknownReplyTargets;
  for (const [marker, replacement] of aliasMarkers) {
    restoredAliases = restoredAliases.replaceAll(marker, replacement);
  }
  return redactSensitiveText(restoredAliases);
}

/**
 * Produces the only reply shape allowed into a cloud request. DOM selectors,
 * source URLs, image counts/data and original author names are intentionally
 * absent from the return type.
 */
export function anonymizeReplies(
  replies: readonly CapturedReply[],
  options: AnonymizeOptions = {},
): AnonymizedReply[] {
  const aliases = createAuthorAliasMap(replies);
  const knownNames = [
    ...replies.map((reply) => reply.authorName),
    ...(options.knownAuthorNames ?? []),
  ];

  return replies.map((reply) => {
    const authorName = normalizedName(reply.authorName);
    return {
      id: reply.id,
      floor: reply.floor,
      parentReplyId: reply.parentReplyId,
      authorAlias: authorName ? (aliases.get(authorName) ?? "U0") : "U0",
      time: reply.time,
      content: redactAuthorNames(reply.content, aliases, knownNames),
      sourcePage: reply.sourcePage,
    };
  });
}

/** Used as a final guard immediately before serialization. */
export function containsAnyOriginalAuthorName(
  value: unknown,
  authorNames: Iterable<string | null | undefined>,
): boolean {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const candidate of authorNames) {
    const name = normalizedName(candidate);
    if (name && serialized.includes(name)) return true;
  }
  return false;
}
