import { SCHEMA_VERSION } from "../types";
import type { CapturedReply } from "../types";
import type { ReviewSession } from "../lib/session";

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
