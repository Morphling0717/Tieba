import { readFile } from "node:fs/promises";
import { analyzeReplies } from "../src/lib/analyzer";
import type { CapturedReply } from "../src/types";

type CaseLabel = "severe_conflict" | "normal_discussion";

interface CorpusReply {
  id: string;
  author: string;
  content: string;
  parentId?: string | null;
  time?: string | null;
  floor?: number | null;
}

interface CorpusCase {
  id: string;
  label: CaseLabel;
  replies: CorpusReply[];
}

interface CorpusFile {
  schemaVersion: "1.0";
  cases: CorpusCase[];
}

function assertCorpus(value: unknown): asserts value is CorpusFile {
  if (!value || typeof value !== "object") throw new Error("语料文件必须是 JSON 对象");
  const candidate = value as Partial<CorpusFile>;
  if (candidate.schemaVersion !== "1.0" || !Array.isArray(candidate.cases)) {
    throw new Error("语料文件必须包含 schemaVersion=1.0 和 cases 数组");
  }
  const ids = new Set<string>();
  for (const item of candidate.cases) {
    if (!item?.id || ids.has(item.id)) throw new Error("每个案例必须有唯一非空 id");
    ids.add(item.id);
    if (item.label !== "severe_conflict" && item.label !== "normal_discussion") {
      throw new Error(`${item.id}: label 必须是 severe_conflict 或 normal_discussion`);
    }
    if (!Array.isArray(item.replies) || item.replies.length === 0) {
      throw new Error(`${item.id}: replies 不能为空`);
    }
    for (const reply of item.replies) {
      if (!reply?.id || !reply.author || typeof reply.content !== "string") {
        throw new Error(`${item.id}: 回复必须包含 id、author、content`);
      }
    }
  }
}

function toCapturedReply(item: CorpusReply, caseId: string, index: number): CapturedReply {
  const time = item.time ?? null;
  return {
    id: item.id,
    siteReplyId: item.id,
    floor: item.floor ?? index + 1,
    parentReplyId: item.parentId ?? null,
    authorName: item.author,
    time,
    timestamp: time ? Date.parse(time) || null : null,
    content: item.content,
    sourcePage: 1,
    sourceUrl: `https://tieba.baidu.com/p/evaluation-${caseId}`,
    anchor: `[data-evaluation-id="${item.id}"]`,
    imageCount: 0,
    isNested: item.parentId != null,
    unexpandedNestedCount: 0,
  };
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}

const args = process.argv.slice(2);
const allowSmall = args.includes("--allow-small");
const path = args.find((arg) => !arg.startsWith("--"));
if (!path) throw new Error("用法：npm run evaluate -- evaluation/private/corpus.json");

const decoded: unknown = JSON.parse(await readFile(path, "utf8"));
assertCorpus(decoded);

const timings: number[] = [];
let severeTotal = 0;
let severeFound = 0;
let normalTotal = 0;
let normalFlagged = 0;
let replyTotal = 0;

for (const item of decoded.cases) {
  const replies = item.replies.map((reply, index) => toCapturedReply(reply, item.id, index));
  const started = performance.now();
  const findings = analyzeReplies(replies);
  timings.push(performance.now() - started);
  replyTotal += replies.length;
  const hasReviewableFinding = findings.some((finding) => finding.score >= 40);
  if (item.label === "severe_conflict") {
    severeTotal += 1;
    if (hasReviewableFinding) severeFound += 1;
  } else {
    normalTotal += 1;
    if (hasReviewableFinding) normalFlagged += 1;
  }
}

const benchmarkReplies = Array.from({ length: 500 }, (_, index) =>
  toCapturedReply(
    {
      id: `benchmark-${index}`,
      author: `用户${index % 40}`,
      content: `这是第${index + 1}条普通剧情讨论，包含具体观点和分析。`,
      time: `2026-07-22 12:${String(index % 60).padStart(2, "0")}`,
    },
    "benchmark",
    index,
  ),
);
const benchmarkStart = performance.now();
analyzeReplies(benchmarkReplies);
const benchmark500Ms = performance.now() - benchmarkStart;

const recall = severeTotal === 0 ? 0 : severeFound / severeTotal;
const falsePositiveRate = normalTotal === 0 ? 0 : normalFlagged / normalTotal;
const report = {
  cases: decoded.cases.length,
  replies: replyTotal,
  severeRecall: Number(recall.toFixed(4)),
  normalDiscussionFalsePositiveRate: Number(falsePositiveRate.toFixed(4)),
  p95CaseAnalysisMs: Number(percentile(timings, 0.95).toFixed(2)),
  benchmark500RepliesMs: Number(benchmark500Ms.toFixed(2)),
  thresholds: { minimumCases: 30, severeRecall: 0.8, benchmark500RepliesMs: 3000 },
};

console.log(JSON.stringify(report, null, 2));

const failures: string[] = [];
if (!allowSmall && decoded.cases.length < 30) failures.push("真实标注案例不足 30 个");
if (severeTotal === 0) failures.push("缺少 severe_conflict 案例");
if (recall < 0.8) failures.push("严重争吵召回率低于 80%");
if (benchmark500Ms > 3000) failures.push("500 条回复本地分析超过 3 秒");
if (failures.length > 0) {
  console.error(`验收未通过：${failures.join("；")}`);
  process.exitCode = 1;
}
