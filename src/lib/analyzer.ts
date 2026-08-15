import { REASON_RULES } from "../data/reasons";
import type { CapturedReply, Finding } from "../types";

export const ANALYZER_VERSION = "1.0.0";

export interface AnalyzeOptions {
  /** Minimum score (0-100) required for each risk type. */
  thresholds?: Partial<Record<LocalRiskType, number>>;
}

type LocalRiskType =
  | "personal_attack"
  | "provocation"
  | "harassment"
  | "spam";

type ScoreMap = Record<LocalRiskType, number>;
type SignalMap = Record<LocalRiskType, string[]>;

interface ReplyAnalysis {
  reply: CapturedReply;
  index: number;
  authorKey: string;
  targetAuthors: Set<string>;
  scores: ScoreMap;
  signals: SignalMap;
}

interface PatternSignal {
  pattern: RegExp;
  label: string;
  score: number;
}

const DEFAULT_THRESHOLDS: Record<LocalRiskType, number> = {
  personal_attack: 20,
  provocation: 20,
  harassment: 25,
  spam: 40,
};

const RISK_LABELS: Record<LocalRiskType, string> = {
  personal_attack: "人身攻击",
  provocation: "挑衅引战",
  harassment: "挂人骚扰",
  spam: "刷屏",
};

const PERSONAL_ATTACK_PATTERNS: PatternSignal[] = [
  { pattern: /傻[\s._-]*[逼屄比]|煞笔|脑残|智障|弱智/iu, label: "高风险辱骂词", score: 28 },
  { pattern: /死妈|司马|没妈|全家(?:死|火葬)/iu, label: "针对亲属的恶毒辱骂", score: 36 },
  { pattern: /废物|垃圾|畜生|狗东西|贱人|蟊贼/iu, label: "贬损人格表达", score: 24 },
  { pattern: /你有病|滚(?:出|回)?|闭嘴|脑子呢|带脑子/iu, label: "贬损或驱赶表达", score: 15 },
];

const PROVOCATION_PATTERNS: PatternSignal[] = [
  { pattern: /急了|破防|气不气|红温|跳脚/iu, label: "刺激对方情绪的表达", score: 20 },
  { pattern: /小丑|孝死|典中典|赢麻|乐子|绷不住/iu, label: "嘲弄或拱火表达", score: 16 },
  { pattern: /不会真有人|就这|(?:来|敢)对线|不服来|(?:又|还)在洗/iu, label: "挑衅式句型", score: 20 },
  { pattern: /钓鱼|引战|拱火|带节奏/iu, label: "引战或钓鱼表达", score: 22 },
];

const HARASSMENT_PATTERNS: PatternSignal[] = [
  { pattern: /开盒|人肉|盒武器|查你户籍/iu, label: "人肉或开盒威胁", score: 42 },
  { pattern: /挂人|曝光他|公开他|挂出来/iu, label: "挂人或公开他人信息", score: 30 },
  { pattern: /骚扰|私信轰炸|追着骂|大家去找他/iu, label: "召集或持续骚扰", score: 30 },
  { pattern: /真实姓名|住址|家庭住址|学校|工作单位|手机号/iu, label: "涉及可识别个人信息", score: 22 },
];

const REASON_KEYWORDS: Record<LocalRiskType, string[]> = {
  personal_attack: ["人身攻击", "辱骂", "侮辱", "恶意攻击", "不友善"],
  provocation: ["挑衅", "引战", "钓鱼", "拱火", "引起争端"],
  harassment: ["挂人", "骚扰", "人肉", "开盒", "个人信息", "隐私"],
  spam: ["刷屏", "重复", "灌水", "无意义回复"],
};

const PREFERRED_REASON_IDS: Record<LocalRiskType, string[]> = {
  personal_attack: ["R03.01", "R03.04", "R03.05"],
  provocation: ["R04.01", "R04.02", "R04.08"],
  harassment: ["R04.07", "R05.01", "R01.04"],
  spam: ["R06.05", "R06.07"],
};

function emptyScores(): ScoreMap {
  return { personal_attack: 0, provocation: 0, harassment: 0, spam: 0 };
}

function emptySignals(): SignalMap {
  return { personal_attack: [], provocation: [], harassment: [], spam: [] };
}

function addSignal(
  analysis: ReplyAnalysis,
  type: LocalRiskType,
  score: number,
  label: string,
): void {
  analysis.scores[type] = Math.min(100, analysis.scores[type] + score);
  if (!analysis.signals[type].includes(label)) analysis.signals[type].push(label);
}

function applyPatterns(
  analysis: ReplyAnalysis,
  type: LocalRiskType,
  patterns: readonly PatternSignal[],
): void {
  for (const signal of patterns) {
    if (signal.pattern.test(analysis.reply.content)) {
      addSignal(analysis, type, signal.score, signal.label);
    }
  }
}

function normalizeForDuplicate(content: string): string {
  return content
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/(?:回复|回覆)\s*(?:@[^\s:：]+|\d+楼)?\s*[:：]?/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .slice(0, 500);
}

function parseReplyTime(value: string | null): number | null {
  if (!value) return null;
  const normalized = value
    .trim()
    .replace(/[\u5e74/.]/gu, "-")
    .replace(/月/gu, "-")
    .replace(/日/gu, "")
    .replace(/\s+/gu, " ");
  const timestamp = Date.parse(normalized);
  if (Number.isFinite(timestamp)) return timestamp;

  const timeOnly = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/u.exec(normalized);
  if (!timeOnly) return null;
  const hour = Number(timeOnly[1]);
  const minute = Number(timeOnly[2]);
  const second = Number(timeOnly[3] ?? 0);
  return (hour * 60 * 60 + minute * 60 + second) * 1_000;
}

function timestampFor(reply: CapturedReply): number | null {
  return Number.isFinite(reply.timestamp) ? reply.timestamp : parseReplyTime(reply.time);
}

function excerpt(content: string): string {
  const compact = content.replace(/\s+/gu, " ").trim();
  return compact.length > 160 ? `${compact.slice(0, 157)}…` : compact;
}

function pairKey(left: string, right: string): string {
  return [left, right].sort().join("\u0000");
}

function hash(value: string): string {
  let current = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    current ^= value.charCodeAt(index);
    current = Math.imul(current, 16_777_619);
  }
  return (current >>> 0).toString(36);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function resolveTargets(
  reply: CapturedReply,
  byId: ReadonlyMap<string, CapturedReply>,
  knownNames: readonly string[],
): Set<string> {
  const targets = new Set<string>();
  const parent = reply.parentReplyId ? byId.get(reply.parentReplyId) : undefined;
  if (parent?.authorName?.trim()) targets.add(parent.authorName.trim());

  for (const name of knownNames) {
    if (name === reply.authorName?.trim()) continue;
    const escapedName = escapeRegExp(name);
    const namesTarget =
      reply.content.includes(`@${name}`) ||
      new RegExp(
        `(?:回复|回覆)\\s*@?${escapedName}(?=\\s*[:：,，]|\\s|$)`,
        "u",
      ).test(reply.content);
    if (namesTarget) {
      targets.add(name);
    }
  }
  return targets;
}

function scoreDirectSignals(analysis: ReplyAnalysis): void {
  applyPatterns(analysis, "personal_attack", PERSONAL_ATTACK_PATTERNS);
  applyPatterns(analysis, "provocation", PROVOCATION_PATTERNS);
  applyPatterns(analysis, "harassment", HARASSMENT_PATTERNS);

  const hasExplicitReply =
    analysis.reply.parentReplyId !== null ||
    /(?:回复|回覆)\s*(?:第?\s*\d+\s*楼|@?[\w\u3400-\u9fff-]{1,30})|@[\w\u3400-\u9fff-]{1,30}/u.test(
      analysis.reply.content,
    );
  if (hasExplicitReply) {
    for (const type of ["personal_attack", "provocation", "harassment"] as const) {
      if (analysis.scores[type] > 0) {
        addSignal(analysis, type, 7, "存在明确回复或 @ 对象");
      }
    }
  }
}

function scoreDuplicateText(analyses: readonly ReplyAnalysis[]): void {
  const groups = new Map<string, ReplyAnalysis[]>();
  for (const analysis of analyses) {
    const normalized = normalizeForDuplicate(analysis.reply.content);
    if (!normalized) continue;
    const key = `${analysis.authorKey}\u0000${normalized}`;
    const group = groups.get(key) ?? [];
    group.push(analysis);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    if (group.length < 3) continue;
    const score = Math.min(90, 48 + (group.length - 3) * 8);
    for (const analysis of group) {
      addSignal(
        analysis,
        "spam",
        score,
        `同一作者重复发布相同或近似文本（${group.length}次）`,
      );
    }
  }
}

function scoreConversationDynamics(analyses: readonly ReplyAnalysis[]): void {
  const pairMessages = new Map<string, ReplyAnalysis[]>();
  const mentionMessages = new Map<string, ReplyAnalysis[]>();

  for (const analysis of analyses) {
    for (const target of analysis.targetAuthors) {
      if (target === analysis.authorKey) continue;
      const key = pairKey(analysis.authorKey, target);
      const pair = pairMessages.get(key) ?? [];
      pair.push(analysis);
      pairMessages.set(key, pair);

      const mentionKey = `${analysis.authorKey}\u0000${target}`;
      const mentions = mentionMessages.get(mentionKey) ?? [];
      mentions.push(analysis);
      mentionMessages.set(mentionKey, mentions);
    }
  }

  for (const pair of pairMessages.values()) {
    const authors = new Set(pair.map((item) => item.authorKey));
    if (authors.size === 2 && pair.length >= 4) {
      for (const analysis of pair) {
        addSignal(analysis, "provocation", 10, `双方连续互回（${pair.length}条）`);
      }
    }

    const timed = pair
      .map((analysis) => ({ analysis, timestamp: timestampFor(analysis.reply) }))
      .filter((entry): entry is { analysis: ReplyAnalysis; timestamp: number } => entry.timestamp !== null)
      .sort((left, right) => left.timestamp - right.timestamp);

    for (let start = 0; start < timed.length; start += 1) {
      const window = timed.slice(start).filter(
        (entry) => entry.timestamp - timed[start]!.timestamp <= 10 * 60 * 1_000,
      );
      const lexicalRisk = window.reduce(
        (total, entry) =>
          total +
          entry.analysis.scores.personal_attack +
          entry.analysis.scores.provocation +
          entry.analysis.scores.harassment,
        0,
      );
      if (window.length < 3 || lexicalRisk < 35) continue;
      for (const entry of window) {
        addSignal(entry.analysis, "provocation", 9, `10分钟内密集互回（${window.length}条）`);
      }
      break;
    }
  }

  for (const mentions of mentionMessages.values()) {
    if (mentions.length < 3) continue;
    for (const analysis of mentions) {
      addSignal(analysis, "harassment", 27, `反复 @ 同一对象（${mentions.length}次）`);
    }
  }

  // Fast posting is only a supporting spam signal; it cannot trigger a
  // finding on its own without repetition or another meaningful indicator.
  const byAuthor = new Map<string, ReplyAnalysis[]>();
  for (const analysis of analyses) {
    const group = byAuthor.get(analysis.authorKey) ?? [];
    group.push(analysis);
    byAuthor.set(analysis.authorKey, group);
  }
  for (const group of byAuthor.values()) {
    const timed = group
      .map((analysis) => ({ analysis, timestamp: timestampFor(analysis.reply) }))
      .filter((entry): entry is { analysis: ReplyAnalysis; timestamp: number } => entry.timestamp !== null)
      .sort((left, right) => left.timestamp - right.timestamp);
    for (let start = 0; start < timed.length; start += 1) {
      const window = timed.slice(start).filter(
        (entry) => entry.timestamp - timed[start]!.timestamp <= 2 * 60 * 1_000,
      );
      if (window.length < 5) continue;
      for (const entry of window) {
        addSignal(entry.analysis, "spam", 12, `2分钟内密集发布（${window.length}条）`);
      }
      break;
    }
  }
}

function reasonCandidates(type: LocalRiskType) {
  const keywords = REASON_KEYWORDS[type];
  const preferredOrder = new Map(
    PREFERRED_REASON_IDS[type].map((id, index) => [id, index]),
  );
  return REASON_RULES.map((rule) => {
    const preferredIndex = preferredOrder.get(rule.id);
    const textKeywordIndex = keywords.findIndex((keyword) => rule.text.includes(keyword));
    const categoryKeywordIndex = keywords.findIndex((keyword) => rule.categoryTitle.includes(keyword));
    const matchScore = preferredIndex !== undefined
      ? 1_000 - preferredIndex
      : textKeywordIndex >= 0
        ? 100 - textKeywordIndex
        : categoryKeywordIndex >= 0
          ? 10 - categoryKeywordIndex
          : -1;
    return { matchScore, rule };
  })
    .filter((entry) => entry.matchScore >= 0)
    .sort((left, right) => right.matchScore - left.matchScore)
    .slice(0, 3)
    .map((entry, index) => ({
      reasonId: entry.rule.id,
      confidence: Math.max(0.55, 0.94 - index * 0.12),
      rationale: `规范原文与“${RISK_LABELS[type]}”信号直接匹配`,
    }));
}

function uncertaintyFor(group: readonly ReplyAnalysis[], type: LocalRiskType): string[] {
  const uncertainties = ["文本规则无法单独判断引用、反讽或熟人玩笑"];
  if (group.some((item) => item.reply.time === null && item.reply.timestamp === null)) {
    uncertainties.push("部分回复缺少时间，短时升温判断可能不完整");
  }
  if (group.some((item) => item.reply.imageCount > 0)) {
    uncertainties.push("图片内容未识别");
  }
  if (
    group.some(
      (item) =>
        item.reply.parentReplyId !== null && item.targetAuthors.size === 0,
    )
  ) {
    uncertainties.push("部分被回复内容未抓取，上下文可能不完整");
  }
  if (reasonCandidates(type).length === 0) {
    uncertainties.push("未在当前规则库中找到可靠的直接理由");
  }
  return uncertainties;
}

/**
 * Runs deterministic, local-only heuristics. Scores rank review priority and
 * are not an automatic moderation decision.
 */
export function analyzeReplies(
  replies: readonly CapturedReply[],
  options: AnalyzeOptions = {},
): Finding[] {
  if (replies.length === 0) return [];

  const byId = new Map(replies.map((reply) => [reply.id, reply]));
  const knownNames = [
    ...new Set(
      replies
        .map((reply) => reply.authorName?.trim())
        .filter((name): name is string => Boolean(name)),
    ),
  ].sort((left, right) => right.length - left.length);
  const analyses: ReplyAnalysis[] = replies.map((reply, index) => ({
    reply,
    index,
    authorKey: reply.authorName?.trim() || `[未知用户:${reply.id}]`,
    targetAuthors: resolveTargets(reply, byId, knownNames),
    scores: emptyScores(),
    signals: emptySignals(),
  }));

  for (const analysis of analyses) scoreDirectSignals(analysis);
  scoreDuplicateText(analyses);
  scoreConversationDynamics(analyses);

  const thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  const groups = new Map<string, { type: LocalRiskType; items: ReplyAnalysis[] }>();
  for (const analysis of analyses) {
    for (const type of Object.keys(DEFAULT_THRESHOLDS) as LocalRiskType[]) {
      if (analysis.scores[type] < thresholds[type]) continue;
      const participants = [analysis.authorKey, ...analysis.targetAuthors];
      const cluster = participants.length > 1
        ? participants.sort().slice(0, 2).join("\u0000")
        : analysis.authorKey;
      const key = `${type}\u0001${cluster}`;
      const existing = groups.get(key) ?? { type, items: [] };
      existing.items.push(analysis);
      groups.set(key, existing);
    }
  }

  const findings = [...groups.values()].map(({ type, items }) => {
    const uniqueItems = [...new Map(items.map((item) => [item.reply.id, item])).values()]
      .sort((left, right) => left.index - right.index);
    const participants = [
      ...new Set(
        uniqueItems.flatMap((item) => [item.authorKey, ...item.targetAuthors]),
      ),
    ].filter((name) => !name.startsWith("[未知用户:"));
    const sortedScores = uniqueItems
      .map((item) => item.scores[type])
      .sort((left, right) => right - left);
    const topAverage =
      sortedScores.slice(0, 3).reduce((total, score) => total + score, 0) /
      Math.min(3, sortedScores.length);
    const score = Math.min(100, Math.round(topAverage + Math.min(12, (uniqueItems.length - 1) * 3)));
    const replyIds = uniqueItems.map((item) => item.reply.id);

    const severity = score >= 85
      ? "critical"
      : score >= 65
        ? "high"
        : score >= 40
          ? "medium"
          : "low";
    const summaryParticipants = participants.length > 0
      ? participants.slice(0, 3).join("、")
      : "未知用户";

    return {
      id: `F-${type}-${hash(replyIds.join("|") + type)}`,
      type,
      severity,
      replyIds,
      score,
      summary: `${summaryParticipants}的${uniqueItems.length}条回复命中${RISK_LABELS[type]}信号，请回到原楼对照上下文复核。`,
      evidence: uniqueItems
        .slice()
        .sort((left, right) => right.scores[type] - left.scores[type])
        .slice(0, 8)
        .map((item) => ({
          replyId: item.reply.id,
          excerpt: excerpt(item.reply.content),
          signals: item.signals[type],
          score: item.scores[type],
        })),
      reasonCandidates: reasonCandidates(type),
      uncertainties: uncertaintyFor(uniqueItems, type),
      participantNames: participants,
    } satisfies Finding;
  });

  return findings.sort((left, right) => right.score - left.score);
}

/** Compatibility alias for callers that describe this operation as local analysis. */
export const analyzeLocal = analyzeReplies;
