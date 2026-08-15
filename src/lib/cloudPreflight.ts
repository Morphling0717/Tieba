import {
  buildCloudPayload,
  CloudAnalysisError,
} from "./cloud";
import {
  containsAnyOriginalAuthorName,
  containsUnredactedSensitiveText,
} from "./privacy";
import { endpointPermissionPattern } from "./cloudPermission";
import type { CapturedReply, Finding } from "../types";

export interface CloudPreflight {
  hostname: string;
  replyCount: number;
  selectedReplyCount: number;
  omittedImageCount: number;
  usernamesRedacted: true;
  sensitiveFieldsRedacted: true;
  imagesExcluded: true;
}

/** Builds and validates exactly the same reply subset used by cloud analysis. */
export function buildCloudPreflight(
  finding: Finding,
  replies: readonly CapturedReply[],
  endpoint: string,
): CloudPreflight {
  endpointPermissionPattern(endpoint);
  const hostname = new URL(endpoint).hostname;
  const payload = buildCloudPayload(finding, replies);
  const originalNames = replies
    .map((reply) => reply.authorName)
    .filter((name): name is string => Boolean(name?.trim()) && name!.trim().length >= 2);
  if (
    containsAnyOriginalAuthorName(
      payload.replies.map((reply) => reply.content),
      originalNames,
    )
  ) {
    throw new CloudAnalysisError("用户名脱敏校验失败，已取消云端请求。", "privacy_guard");
  }
  if (
    containsUnredactedSensitiveText(
      payload.replies.map((reply) => reply.content).join("\n"),
    )
  ) {
    throw new CloudAnalysisError("敏感字段脱敏校验失败，已取消云端请求。", "privacy_guard");
  }
  const includedIds = new Set(payload.replies.map((reply) => reply.id));
  const omittedImageCount = replies
    .filter((reply) => includedIds.has(reply.id))
    .reduce((total, reply) => total + reply.imageCount, 0);

  return {
    hostname,
    replyCount: payload.replies.length,
    selectedReplyCount: payload.selectedFinding.replyIds.length,
    omittedImageCount,
    usernamesRedacted: true,
    sensitiveFieldsRedacted: true,
    imagesExcluded: true,
  };
}
