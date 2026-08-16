import { SCHEMA_VERSION } from "../types";
import type {
  CapturedReply,
  Finding,
  FindingSeverity,
  RiskType,
} from "../types";
import type { ReviewSession } from "../lib/session";
import {
  WHOLE_THREAD_CLOUD_PROTOCOL_VERSION,
  type WholeThreadCloudAnalysisResultV3,
} from "../lib/cloud";
import { REASON_RULES } from "../data/reasons";

const sourceUrl = "https://tieba.baidu.com/p/123456?pn=2";

function demoReply(
  id: string,
  floor: number,
  authorName: string,
  content: string,
  parentReplyId: string | null,
  time: string,
  isNested = false,
): CapturedReply {
  return {
    id,
    siteReplyId: isNested ? null : id,
    floor,
    parentReplyId,
    authorName,
    time,
    timestamp: Date.parse(time),
    content,
    sourcePage: 2,
    sourceUrl,
    anchor: `[data-pid="${id}"]`,
    imageCount: id === "kr-lzl-demo-document-0001-opaque" ? 1 : 0,
    isNested,
    unexpandedNestedCount: 0,
  };
}

const replies = [
  demoReply("7001", 71, "北斗巡游", "我只是觉得这一集节奏有问题，前半段信息太少。", null, "2026-07-22 12:01"),
  demoReply("7002", 72, "红色围巾", "回复 @北斗巡游：不会真有人连这个都看不懂吧，就这理解能力？", "7001", "2026-07-22 12:03"),
  demoReply("7003", 73, "北斗巡游", "你才是脑残吧，带脑子看剧很难吗？", "7002", "2026-07-22 12:05"),
  demoReply("kr-lzl-demo-document-0001-opaque", 73, "红色围巾", "急了？破防就别来对线，典中典。", "7003", "2026-07-22 12:06", true),
  demoReply("7005", 74, "北斗巡游", "@红色围巾 还在洗？你这种孝子真的没救了。", "7003", "2026-07-22 12:08"),
  demoReply("7006", 75, "路过的摄影师", "先停一下吧，讨论剧情就好，没必要互相攻击。", null, "2026-07-22 12:12"),
];

export const DEMO_SESSION: ReviewSession = {
  schemaVersion: SCHEMA_VERSION,
  sessionSchemaVersion: 3,
  tabId: 1,
  threadId: "123456",
  threadUrl: sourceUrl,
  title: "这一集的剧情处理是不是有点问题？",
  pages: {},
  replies,
  coverage: {
    captureMode: "paginated",
    visibleReplyCount: replies.length,
    mainReplyCount: 5,
    nestedReplyCount: 1,
    imageCount: 2,
    unexpandedLzlCount: 3,
    analyzedPageNumbers: [1, 2],
    hasUnanalyzedImages: true,
    declaredReplyCount: null,
    dynamicContentMayRemain: false,
    reachedReplyListEnd: false,
    unstableReplyIdCount: 1,
    isComplete: false,
  },
  errors: [],
  warnings: ["仍有 3 条楼中楼回复未展开。", "2 张图片未识别。"],
  updatedAt: "2026-07-22T04:12:00.000Z",
};

export type DemoReviewScenarioId =
  | "review-clean"
  | "review-typical"
  | "review-dense";

export interface DemoReviewFixture {
  id: DemoReviewScenarioId;
  session: ReviewSession;
  result: WholeThreadCloudAnalysisResultV3;
}

const syntheticBaseUrl = "https://tieba.baidu.com/p/81000000000";
const longestReason = REASON_RULES.reduce((longest, current) =>
  current.text.length > longest.text.length ? current : longest,
);

function syntheticReply(options: {
  id: string;
  floor: number;
  authorName: string;
  content: string;
  minute: number;
  parentReplyId?: string | null;
  imageCount?: number;
}): CapturedReply {
  const isNested = options.parentReplyId != null;
  return {
    id: options.id,
    siteReplyId: options.id,
    floor: options.floor,
    parentReplyId: options.parentReplyId ?? null,
    authorName: options.authorName,
    time: `2026-08-01 10:${String(options.minute).padStart(2, "0")}`,
    timestamp: Date.UTC(2026, 7, 1, 2, options.minute),
    content: options.content,
    sourcePage: 1,
    sourceUrl: syntheticBaseUrl,
    anchor: `[data-pid="${options.id}"]`,
    imageCount: options.imageCount ?? 0,
    isNested,
    unexpandedNestedCount: 0,
  };
}

function completeApiSession(
  tabId: number,
  threadId: string,
  title: string,
  fixtureReplies: CapturedReply[],
): ReviewSession {
  const mainReplies = fixtureReplies.filter((reply) => !reply.isNested);
  const nestedReplies = fixtureReplies.filter((reply) => reply.isNested);
  const nestedParentCount = new Set(
    nestedReplies.map((reply) => reply.parentReplyId).filter(Boolean),
  ).size;
  const imageCount = fixtureReplies.reduce(
    (total, reply) => total + reply.imageCount,
    0,
  );
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionSchemaVersion: 3,
    tabId,
    threadId,
    threadUrl: `https://tieba.baidu.com/p/${threadId}`,
    title,
    pages: {},
    replies: fixtureReplies,
    coverage: {
      captureMode: "api",
      visibleReplyCount: fixtureReplies.length,
      mainReplyCount: mainReplies.length,
      nestedReplyCount: nestedReplies.length,
      imageCount,
      unexpandedLzlCount: 0,
      analyzedPageNumbers: [1],
      hasUnanalyzedImages: imageCount > 0,
      declaredReplyCount: Math.max(0, fixtureReplies.length - 1),
      dynamicContentMayRemain: false,
      reachedReplyListEnd: true,
      unstableReplyIdCount: 0,
      isComplete: true,
      apiCoverage: {
        mainPagesFetched: 1,
        mainPagesTotal: 1,
        mainRepliesFetched: mainReplies.length,
        nestedParentsFetched: nestedParentCount,
        nestedParentsTotal: nestedParentCount,
        nestedRepliesFetched: nestedReplies.length,
        nestedRepliesDeclared: nestedReplies.length,
        failedRequestCount: 0,
        unavailableReplyCount: 0,
        readableTextComplete: true,
      },
    },
    errors: [],
    warnings: imageCount > 0 ? [`${imageCount} 张图片未进行内容识别。`] : [],
    updatedAt: `2026-08-01T02:${String(
      Math.max(...fixtureReplies.map((reply) => new Date(reply.timestamp ?? 0).getUTCMinutes()), 0),
    ).padStart(2, "0")}:00.000Z`,
  };
}

function syntheticFinding(options: {
  id: string;
  reply: CapturedReply;
  type: RiskType;
  severity: FindingSeverity;
  score: number;
  reasonId: string;
  summary: string;
  rationale: string;
  contextReplyIds?: string[];
  uncertainties?: string[];
}): Finding {
  return {
    id: options.id,
    type: options.type,
    severity: options.severity,
    score: options.score,
    summary: options.summary,
    replyIds: [options.reply.id],
    ...(options.contextReplyIds?.length
      ? { contextReplyIds: options.contextReplyIds }
      : {}),
    participantNames: options.reply.authorName ? [options.reply.authorName] : [],
    evidence: [
      {
        replyId: options.reply.id,
        excerpt: options.reply.content,
        signals: ["合成演示：这条回复包含需要人工核对的表达。"],
        score: options.score,
      },
    ],
    reasonCandidates: [
      {
        reasonId: options.reasonId,
        confidence: options.score,
        rationale: options.rationale,
      },
    ],
    uncertainties: options.uncertainties ?? [],
  };
}

function resultFixture(options: {
  summary: string;
  replies: CapturedReply[];
  findings: Finding[];
  overview: string;
  stages: WholeThreadCloudAnalysisResultV3["report"]["stages"];
  interactions: WholeThreadCloudAnalysisResultV3["report"]["interactions"];
  notes: WholeThreadCloudAnalysisResultV3["report"]["notes"];
}): WholeThreadCloudAnalysisResultV3 {
  return {
    protocolVersion: WHOLE_THREAD_CLOUD_PROTOCOL_VERSION,
    summary: options.summary,
    findings: options.findings,
    report: {
      overview: options.overview,
      stages: options.stages,
      interactions: options.interactions,
      notes: options.notes,
    },
    uncertainties: options.notes
      .filter((note) => note.kind === "needs_human_check")
      .map((note) => note.summary),
    analyzedReplyCount: options.replies.length,
    ruleCount: REASON_RULES.length,
    omittedImageCount: options.replies.reduce(
      (total, reply) => total + reply.imageCount,
      0,
    ),
  };
}

const cleanReplies = [
  syntheticReply({
    id: "810000000001",
    floor: 1,
    authorName: "合成楼主",
    content: "想讨论这一段摄影如何表现角色的犹豫，欢迎补充不同看法。",
    minute: 1,
  }),
  syntheticReply({
    id: "810000000002",
    floor: 2,
    authorName: "镜头记录员",
    content: "我更关注长镜头的停顿，它让场景显得克制。",
    minute: 3,
  }),
  syntheticReply({
    id: "810000000003",
    floor: 3,
    authorName: "配乐观察者",
    content: "我的评价相反，但理由是配乐进入得太早，并不是针对其他观众。",
    minute: 6,
  }),
  syntheticReply({
    id: "810000000004",
    floor: 4,
    authorName: "合成楼主",
    content: "这个角度很有意思，我回看后再比较两个版本。",
    minute: 8,
  }),
  syntheticReply({
    id: "810000000005",
    floor: 5,
    authorName: "设定整理员",
    content: "补充一条公开设定：这一幕发生在角色作出决定之前。",
    minute: 11,
  }),
];

export const DEMO_REVIEW_CLEAN_SESSION = completeApiSession(
  101,
  "81000000001",
  "合成演示：围绕镜头语言的正常讨论",
  cleanReplies,
);

export const DEMO_REVIEW_CLEAN_RESULT = resultFixture({
  summary: "讨论集中在摄影、配乐与角色表达，没有发现需要进入处置流程的线索。",
  replies: cleanReplies,
  findings: [],
  overview: "参与者提出不同审美判断，并能给出作品层面的理由。",
  stages: [
    {
      title: "提出观察",
      summary: "楼主邀请他人比较镜头表达，随后出现摄影与配乐两种解释。",
      replyIds: ["810000000001", "810000000002", "810000000003"],
    },
    {
      title: "补充依据",
      summary: "后续回复补充设定信息，讨论没有转向用户之间的评价。",
      replyIds: ["810000000004", "810000000005"],
    },
  ],
  interactions: [
    {
      title: "观点不同但仍围绕作品",
      summary: "两种评价存在分歧，回复均说明了具体理由。",
      replyIds: ["810000000002", "810000000003"],
    },
  ],
  notes: [
    {
      kind: "heated_but_allowed",
      title: "明确的反对不等于攻击",
      summary: "第3楼直接表达相反评价，但对象是配乐安排，未评价其他用户。",
      replyIds: ["810000000003"],
    },
  ],
});

const longDemoUser =
  "这是用于验证窄屏换行与截断行为的超长合成用户名_编号0001_继续延长";
const typicalReplies = [
  syntheticReply({
    id: "820000000001",
    floor: 1,
    authorName: "合成楼主",
    content: "这段剧情的转折是否缺少铺垫？请只讨论作品内容。",
    minute: 1,
  }),
  syntheticReply({
    id: "820000000002",
    floor: 2,
    authorName: longDemoUser,
    content: "合成演示：我认为不同意这个观点的人都没有认真看前文。",
    minute: 3,
  }),
  syntheticReply({
    id: "820000000003",
    floor: 2,
    authorName: "重复出现的合成用户",
    content: "楼中楼补充：可以反驳观点，但别推断其他人的能力。",
    minute: 4,
    parentReplyId: "820000000002",
  }),
  syntheticReply({
    id: "820000000004",
    floor: 2,
    authorName: longDemoUser,
    content: "楼中楼回应：这是用于验证边界判断的强硬措辞，不包含真实对象。",
    minute: 5,
    parentReplyId: "820000000002",
  }),
  syntheticReply({
    id: "820000000005",
    floor: 2,
    authorName: "重复出现的合成用户",
    content: "同一父楼的第三条楼中楼，用来验证分组和重复作者展示。",
    minute: 6,
    parentReplyId: "820000000002",
  }),
  syntheticReply({
    id: "820000000006",
    floor: 3,
    authorName: "设定核对者",
    content: "公开设定只确认了时间顺序，没有确认角色动机。",
    minute: 9,
  }),
  syntheticReply({
    id: "820000000007",
    floor: 4,
    authorName: "重复出现的合成用户",
    content: "合成演示：使用作品喜好给另一类观众贴上负面标签。",
    minute: 12,
    imageCount: 1,
  }),
  syntheticReply({
    id: "820000000008",
    floor: 5,
    authorName: "路过的合成用户",
    content: "我只比较镜头衔接，不参与对观众群体的评价。",
    minute: 15,
  }),
];

const typicalFindings = [
  syntheticFinding({
    id: "typical-finding-01",
    reply: typicalReplies[1]!,
    type: "personal_attack",
    severity: "medium",
    score: 0.82,
    reasonId: "R12.06",
    summary: "将剧情理解分歧转化为对其他参与者能力的评价。",
    rationale: "表达对象从作品内容转向了参与讨论的人，需要回看语境确认。",
    contextReplyIds: ["820000000001", "820000000003", "820000000004"],
    uncertainties: ["措辞没有点名具体用户，需确认是否指向整个讨论群体。"],
  }),
  syntheticFinding({
    id: "typical-finding-02",
    reply: typicalReplies[6]!,
    type: "provocation",
    severity: "high",
    score: 0.9,
    reasonId: longestReason.id,
    summary: "借作品喜好评价观众群体，可能扩大阵营对立。",
    rationale: "这条线索使用规则库中最长的规范文本，用来验证卡片换行与折叠。",
    contextReplyIds: ["820000000006", "820000000008"],
  }),
];

export const DEMO_REVIEW_TYPICAL_SESSION = completeApiSession(
  102,
  "81000000002",
  "合成演示：剧情分歧逐渐转向参与者评价",
  typicalReplies,
);

export const DEMO_REVIEW_TYPICAL_RESULT = resultFixture({
  summary: "发现2条待复核线索：一条涉及能力评价，一条涉及观众群体标签。",
  replies: typicalReplies,
  findings: typicalFindings,
  overview: "讨论从剧情铺垫转向参与者和观众群体评价，中间仍有正常的设定核对。",
  stages: [
    {
      title: "剧情铺垫分歧",
      summary: "楼主提出作品问题，参与者最初围绕剧情依据展开讨论。",
      replyIds: ["820000000001", "820000000002"],
    },
    {
      title: "楼中楼提醒边界",
      summary: "同一父楼出现三条连续回复，参与者尝试把话题拉回观点本身。",
      replyIds: ["820000000003", "820000000004", "820000000005"],
    },
    {
      title: "群体标签出现",
      summary: "后续回复把作品喜好与观众群体评价联系起来。",
      replyIds: ["820000000006", "820000000007", "820000000008"],
    },
  ],
  interactions: [
    {
      title: "同一父楼的连续回应",
      summary: "超长用户名与重复作者在同一楼中楼组内交替出现。",
      replyIds: ["820000000002", "820000000003", "820000000004", "820000000005"],
    },
  ],
  notes: [
    {
      kind: "needs_human_check",
      title: "是否指向具体用户",
      summary: "能力评价没有点名，需结合原帖回复关系判断指向范围。",
      replyIds: ["820000000002", "820000000003"],
    },
    {
      kind: "heated_but_allowed",
      title: "设定核对属于正常讨论",
      summary: "第3楼仅区分已确认信息与角色动机，没有评价参与者。",
      replyIds: ["820000000006"],
    },
  ],
});

const denseAuthors = [
  "高密度合成用户甲",
  "高密度合成用户乙",
  "重复作者_用于验证分组",
  "长名称_用于验证高密度卡片中用户名换行_0000000003",
];

const denseMainReplies = Array.from({ length: 12 }, (_, index) =>
  syntheticReply({
    id: `8300000000${String(index + 1).padStart(2, "0")}`,
    floor: index + 1,
    authorName: denseAuthors[index % denseAuthors.length]!,
    content:
      index === 0
        ? "合成楼主提出一个作品比较问题，并要求说明具体依据。"
        : index % 3 === 0
          ? `合成演示第${index + 1}条：给不同观点的观众贴上负面标签。`
          : `合成演示第${index + 1}条：讨论剧情、摄影或设定，但措辞强度不同。`,
    minute: index + 1,
    imageCount: index === 7 || index === 10 ? 1 : 0,
  }),
);

const denseNestedReplies = Array.from({ length: 6 }, (_, index) =>
  syntheticReply({
    id: `8300000001${String(index + 1).padStart(2, "0")}`,
    floor: 4,
    parentReplyId: "830000000004",
    authorName: denseAuthors[(index + 2) % denseAuthors.length]!,
    content:
      index % 2 === 0
        ? `同一父楼的合成回复${index + 1}：将争论重新指向作品证据。`
        : `同一父楼的合成回复${index + 1}：包含需要复核的挑衅式概括。`,
    minute: 20 + index,
  }),
);

const denseReplies = [...denseMainReplies, ...denseNestedReplies];
const denseFindingReplyIds = [
  "830000000002",
  "830000000004",
  "830000000005",
  "830000000007",
  "830000000008",
  "830000000010",
  "830000000012",
  "830000000102",
  "830000000104",
  "830000000106",
];
const denseFindingTypes: RiskType[] = [
  "personal_attack",
  "provocation",
  "harassment",
  "provocation",
  "other",
  "personal_attack",
  "provocation",
  "harassment",
  "provocation",
  "personal_attack",
];
const denseSeverities: FindingSeverity[] = [
  "high",
  "critical",
  "medium",
  "high",
  "low",
  "high",
  "medium",
  "high",
  "medium",
  "high",
];
const denseFindings = denseFindingReplyIds.map((replyId, index) => {
  const reply = denseReplies.find((candidate) => candidate.id === replyId)!;
  return syntheticFinding({
    id: `dense-finding-${String(index + 1).padStart(2, "0")}`,
    reply,
    type: denseFindingTypes[index]!,
    severity: denseSeverities[index]!,
    score: Math.min(0.98, 0.7 + index * 0.025),
    reasonId: index === 9 ? longestReason.id : index % 2 === 0 ? "R12.06" : "R12.03",
    summary: `第${index + 1}条合成线索用于验证高密度列表、优先级和展开状态。`,
    rationale: "回复从作品判断转向参与者或群体评价，需要人工核对原文与回复关系。",
    contextReplyIds: reply.isNested
      ? ["830000000004", "830000000101", "830000000103"]
      : ["830000000001"],
    uncertainties:
      index % 4 === 0
        ? ["需要确认这句话是概括观点，还是明确指向某位参与者。"]
        : [],
  });
});

export const DEMO_REVIEW_DENSE_SESSION = completeApiSession(
  103,
  "81000000003",
  "合成演示：高密度待复核线索与楼中楼互动",
  denseReplies,
);

export const DEMO_REVIEW_DENSE_RESULT = resultFixture({
  summary: "发现10条待复核线索；其中多条位于同一父楼，适合验证密集列表与逐项处理流程。",
  replies: denseReplies,
  findings: denseFindings,
  overview: "讨论从作品比较扩展为多组参与者评价，同时夹杂正常的剧情和设定讨论。",
  stages: [
    {
      title: "提出比较标准",
      summary: "楼主要求围绕作品依据展开比较。",
      replyIds: ["830000000001", "830000000002", "830000000003"],
    },
    {
      title: "主楼争论升温",
      summary: "多个重复作者在连续楼层中交替回应，出现群体标签。",
      replyIds: ["830000000004", "830000000005", "830000000006", "830000000007", "830000000008"],
    },
    {
      title: "同一父楼密集互动",
      summary: "六条楼中楼共享同一父楼，其中正常提醒与待复核表达交错。",
      replyIds: denseNestedReplies.map((reply) => reply.id),
    },
  ],
  interactions: [
    {
      title: "重复作者跨楼层出现",
      summary: "同一合成作者既参与主楼，也出现在楼中楼回复中。",
      replyIds: ["830000000003", "830000000007", "830000000011", "830000000101", "830000000105"],
    },
    {
      title: "同父楼六条回复",
      summary: "该互动组用于验证按父楼和作者折叠引用。",
      replyIds: ["830000000004", ...denseNestedReplies.map((reply) => reply.id)],
    },
  ],
  notes: [
    {
      kind: "needs_human_check",
      title: "概括性表达的指向",
      summary: "部分回复没有点名，需要结合父子关系确认是否针对具体用户。",
      replyIds: ["830000000005", "830000000102", "830000000104"],
    },
    {
      kind: "needs_human_check",
      title: "图片未识别",
      summary: "两张图片不进入模型判断，人工复核时仍需查看原帖。",
      replyIds: ["830000000008", "830000000011"],
    },
    {
      kind: "heated_but_allowed",
      title: "仍有作品层面的强烈批评",
      summary: "部分措辞强硬，但评价对象仍是剧情或摄影安排。",
      replyIds: ["830000000003", "830000000006", "830000000009"],
    },
  ],
});

export const DEMO_REVIEW_CLEAN: DemoReviewFixture = {
  id: "review-clean",
  session: DEMO_REVIEW_CLEAN_SESSION,
  result: DEMO_REVIEW_CLEAN_RESULT,
};

export const DEMO_REVIEW_TYPICAL: DemoReviewFixture = {
  id: "review-typical",
  session: DEMO_REVIEW_TYPICAL_SESSION,
  result: DEMO_REVIEW_TYPICAL_RESULT,
};

export const DEMO_REVIEW_DENSE: DemoReviewFixture = {
  id: "review-dense",
  session: DEMO_REVIEW_DENSE_SESSION,
  result: DEMO_REVIEW_DENSE_RESULT,
};

export const DEMO_REVIEW_FIXTURES: Readonly<
  Record<DemoReviewScenarioId, DemoReviewFixture>
> = {
  "review-clean": DEMO_REVIEW_CLEAN,
  "review-typical": DEMO_REVIEW_TYPICAL,
  "review-dense": DEMO_REVIEW_DENSE,
};
