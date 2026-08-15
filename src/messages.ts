import type { ParserVariant, ThreadCapture } from "./types";
import type { ReviewSession } from "./lib/session";
import type {
  TiebaReadRequest,
  TiebaNestedPageProjection,
  TiebaNestedParseContext,
} from "./lib/tiebaApi";
import type { TiebaTransportResponse } from "./lib/tiebaTransport";

/**
 * The background constructs this from the active review session. It contains
 * only stable ids/selectors needed for navigation; reply text and usernames
 * never need to cross the jump-message boundary.
 */
export interface EvidenceLocator {
  replyId: string;
  siteReplyId: string | null;
  /** Public floor metadata used only to accelerate an in-page virtual-list scan. */
  floor: number | null;
  anchor: string;
  parentReplyId: string | null;
  parentSiteReplyId: string | null;
  parentAnchor: string | null;
  isNested: boolean;
  parserVariant: ParserVariant;
}

export type SidePanelRequest =
  | { type: "CAPTURE_WHOLE_THREAD" }
  | { type: "CAPTURE_ACTIVE_PAGE" }
  | { type: "GET_ACTIVE_SESSION" }
  | { type: "GET_CLOUD_PERMISSION_STATUS" }
  | { type: "CLEAR_ACTIVE_SESSION" }
  | { type: "JUMP_TO_REPLY"; replyId: string };

export type ContentRequest =
  | { type: "PARSE_TIEBA_PAGE" }
  | { type: "GET_PAGE_URL" }
  | {
      type: "START_DYNAMIC_CAPTURE";
      threadId: string;
      documentInstanceId: string;
      allowMissingContainer: boolean;
    }
  | {
      type: "PARSE_TIEBA_NESTED_HTML";
      html: string;
      context: TiebaNestedParseContext;
    }
  | {
      type: "FETCH_TIEBA_READ_API";
      request: TiebaReadRequest;
    }
  | {
      type: "JUMP_TO_REPLY";
      locator: EvidenceLocator;
      /** Expected Tieba thread identity; content must reject another thread. */
      expectedThreadId: string;
      /** True only while resuming a background-created official PID route. */
      waitForOfficialRoute: boolean;
    };

/** Body-free hint emitted after an explicitly reviewed SPA changes. */
export interface DynamicContentChangedMessage {
  type: "TIEBA_DYNAMIC_CONTENT_CHANGED";
  threadId: string;
  url: string;
  documentInstanceId: string;
  /** Random replay token; it is not derived from reply text or usernames. */
  signature: string;
}

/** Body-free warning that the reviewed SPA changed URL without a reload. */
export interface PageIdentityChangedMessage {
  type: "TIEBA_PAGE_IDENTITY_CHANGED";
  previousThreadId: string;
  currentUrl: string;
  documentInstanceId: string;
}

/** Messages accepted by the background from the side panel. */
export type ExtensionRequest = SidePanelRequest;

export type ExtensionErrorCode =
  | "TIEBA_PERMISSION_MISSING"
  | "RESTRICTED_PAGE"
  | "SCRIPT_INJECTION_FAILED"
  | "PAGE_NOT_READY"
  | "PAGE_LAYOUT_UNSUPPORTED"
  | "PAGE_PARSE_FAILED"
  | "TIEBA_READ_API_FAILED"
  | "TIEBA_READ_API_RESPONSE_INVALID"
  | "TIEBA_READ_API_RATE_LIMITED"
  | "CAPTURE_CANCELLED"
  | "EVIDENCE_NOT_LOADED"
  | "INVALID_TIEBA_PAGE"
  | "SESSION_STALE"
  | "CLOUD_PERMISSION_CLEANUP_FAILED"
  | "UNKNOWN";

export type ExtensionResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: ExtensionErrorCode };

export interface SessionUpdatedMessage {
  type: "SESSION_UPDATED";
  session: ReviewSession;
}

export interface SessionClearedMessage {
  type: "SESSION_CLEARED";
  tabId: number;
  reason: "navigation" | "manual";
}

export interface SessionSuspendedMessage {
  type: "SESSION_SUSPENDED";
  tabId: number;
  reason: "url_unavailable";
}

export type CaptureResponse = ExtensionResponse<ReviewSession>;
export type SessionResponse = ExtensionResponse<ReviewSession | null>;
export type ParseResponse = ExtensionResponse<ThreadCapture>;
export type NestedParseResponse = ExtensionResponse<TiebaNestedPageProjection>;
export type TiebaReadResponse = ExtensionResponse<TiebaTransportResponse>;

export function isSessionUpdatedMessage(
  value: unknown,
): value is SessionUpdatedMessage {
  return Boolean(
    value &&
      typeof value === "object" &&
      "type" in value &&
      value.type === "SESSION_UPDATED" &&
      "session" in value,
  );
}

export function isSessionClearedMessage(
  value: unknown,
): value is SessionClearedMessage {
  return Boolean(
    value &&
      typeof value === "object" &&
      "type" in value &&
      value.type === "SESSION_CLEARED" &&
      "tabId" in value &&
      typeof value.tabId === "number",
  );
}

export function isSessionSuspendedMessage(
  value: unknown,
): value is SessionSuspendedMessage {
  return Boolean(
    value &&
      typeof value === "object" &&
      "type" in value &&
      value.type === "SESSION_SUSPENDED" &&
      "tabId" in value &&
      typeof value.tabId === "number",
  );
}
