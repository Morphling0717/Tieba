import {
  analyzeWholeThreadWithCloud,
  CloudAnalysisError,
  deepAnalyzeFinding,
  type CloudAnalysisConfig,
  type CloudAnalysisResult,
  type WholeThreadCloudAnalysisResult,
} from "./lib/cloud";
import {
  endpointPermissionPattern,
  isPersistentCloudPermissionOrigin,
} from "./lib/cloudPermission";
import type { CapturedReply, Finding } from "./types";

export const CLOUD_ANALYSIS_PORT_NAME = "kr-cloud-analysis-v1";
const LEASES_STORAGE_KEY = "kr_cloud_permission_leases_v1";
const LATE_GRANT_GUARDS_STORAGE_KEY =
  "kr_cloud_permission_late_grant_guards_v1";
const CLEANUP_ERRORS_STORAGE_KEY = "kr_cloud_permission_cleanup_errors_v1";
const LATE_GRANT_GUARD_MS = 5 * 60 * 1_000;

interface PersistedPermissionMarker {
  requestId: string;
  origin: string;
  guardUntil: string;
}

export type CloudBrokerRequest =
  | {
      type: "CLOUD_PERMISSION_PREPARE";
      requestId: string;
      endpoint: string;
    }
  | {
      type: "CLOUD_ANALYSIS_START";
      requestId: string;
      endpoint: string;
      model: string;
      apiKey: string;
      mode?: CloudAnalysisConfig["mode"];
      finding: Finding;
      replies: CapturedReply[];
    }
  | {
      type: "CLOUD_WHOLE_THREAD_ANALYSIS_START";
      requestId: string;
      endpoint: string;
      model: string;
      apiKey: string;
      mode?: CloudAnalysisConfig["mode"];
      threadTitle: string;
      replies: CapturedReply[];
    }
  | { type: "CLOUD_ANALYSIS_CANCEL"; requestId: string };

export type CloudBrokerResponse =
  | {
      type: "CLOUD_ANALYSIS_RESULT";
      requestId: string;
      result: CloudAnalysisResult;
    }
  | {
      type: "CLOUD_WHOLE_THREAD_ANALYSIS_RESULT";
      requestId: string;
      result: WholeThreadCloudAnalysisResult;
    }
  | {
      type: "CLOUD_ANALYSIS_ERROR";
      requestId: string;
      error: string;
      code:
        | CloudAnalysisError["code"]
        | "permission_missing"
        | "permission_cleanup"
        | "invalid_request";
    };

type CloudBrokerErrorCode = Extract<
  CloudBrokerResponse,
  { type: "CLOUD_ANALYSIS_ERROR" }
>["code"];

interface BrokerPort {
  name: string;
  postMessage(message: CloudBrokerResponse): void;
  onMessage: {
    addListener(listener: (message: CloudBrokerRequest) => void): void;
  };
  onDisconnect: { addListener(listener: () => void): void };
}

interface BrokerChromeApi {
  runtime: {
    onConnect: {
      addListener(listener: (port: BrokerPort) => void): void;
    };
  };
  permissions: {
    contains(permissions: { origins: string[] }): Promise<boolean>;
    remove(permissions: { origins: string[] }): Promise<boolean>;
    onAdded?: {
      addListener(
        listener: (permissions: { origins?: string[] }) => void,
      ): void;
    };
  };
  storage: {
    get(keys: string | string[]): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
  };
}

interface BrokerDependencies {
  analyze?: typeof deepAnalyzeFinding;
  analyzeWholeThread?: typeof analyzeWholeThreadWithCloud;
  now?: () => Date;
}

interface ActiveLease extends PersistedPermissionMarker {
  /** Request-only value; never copied into durable lease storage. */
  endpoint: string;
  port: BrokerPort;
  controller: AbortController | null;
  disconnected: boolean;
  started: boolean;
  /** False for exact host permissions declared persistently in the manifest. */
  revocable: boolean;
  cleanupPromise: Promise<string | null> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safePermissionOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 512) return null;
  try {
    const base = value.endsWith("/*") ? value.slice(0, -1) : value;
    const normalized = endpointPermissionPattern(base);
    return normalized === value &&
      !isPersistentCloudPermissionOrigin(normalized)
      ? normalized
      : null;
  } catch {
    return null;
  }
}

function grantedPermissionOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 512) return null;
  try {
    const origin = endpointPermissionPattern(
      value.endsWith("/*") ? value.slice(0, -1) : value,
    );
    return isPersistentCloudPermissionOrigin(origin) ? null : origin;
  } catch {
    return null;
  }
}

function safeRequestId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9-]{1,128}$/u.test(value)
    ? value
    : null;
}

function safeGuardUntil(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function permissionMarkerFrom(
  value: unknown,
  fallbackGuardUntil: string,
): PersistedPermissionMarker | null {
  if (!isRecord(value)) return null;
  const requestId = safeRequestId(value.requestId);
  const origin = safePermissionOrigin(value.origin);
  const guardUntil = safeGuardUntil(value.guardUntil) ?? fallbackGuardUntil;
  return requestId && origin ? { requestId, origin, guardUntil } : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function persistedMarkerOf(
  lease: PersistedPermissionMarker,
): PersistedPermissionMarker {
  return {
    requestId: lease.requestId,
    origin: lease.origin,
    guardUntil: lease.guardUntil,
  };
}

/**
 * Owns each optional provider permission from the moment the foreground page
 * announces its request until the background request has stopped and the
 * permission has actually been removed.
 */
export function installCloudAnalysisBroker(
  api: BrokerChromeApi,
  dependencies: BrokerDependencies = {},
): { getCleanupStatus(): Promise<string | null> } {
  const analyze = dependencies.analyze ?? deepAnalyzeFinding;
  const analyzeWholeThread =
    dependencies.analyzeWholeThread ?? analyzeWholeThreadWithCloud;
  const now = dependencies.now ?? (() => new Date());
  const persistedLeases = new Map<string, PersistedPermissionMarker>();
  const lateGrantGuards = new Map<string, PersistedPermissionMarker>();
  const cleanupErrors = new Map<string, string>();
  const activeLeases = new Map<string, ActiveLease>();
  let storageQueue = Promise.resolve();

  const newGuardUntil = (): string =>
    new Date(now().getTime() + LATE_GRANT_GUARD_MS).toISOString();

  const pruneExpiredGuards = (): boolean => {
    const currentTime = now().getTime();
    let changed = false;
    for (const guard of lateGrantGuards.values()) {
      if (Date.parse(guard.guardUntil) > currentTime) continue;
      lateGrantGuards.delete(guard.requestId);
      changed = true;
    }
    return changed;
  };

  const persistState = (): Promise<void> => {
    storageQueue = storageQueue.then(async () => {
      await api.storage.set({
        [LEASES_STORAGE_KEY]: [...persistedLeases.values()],
        [LATE_GRANT_GUARDS_STORAGE_KEY]: [...lateGrantGuards.values()],
        [CLEANUP_ERRORS_STORAGE_KEY]: Object.fromEntries(cleanupErrors),
      });
    });
    return storageQueue;
  };

  const revokeOrigin = async (
    marker: PersistedPermissionMarker,
  ): Promise<{ wasGranted: boolean; error: string | null }> => {
    if (isPersistentCloudPermissionOrigin(marker.origin)) {
      cleanupErrors.delete(marker.origin);
      return { wasGranted: false, error: null };
    }
    try {
      const stillGranted = await api.permissions.contains({
        origins: [marker.origin],
      });
      if (!stillGranted) {
        cleanupErrors.delete(marker.origin);
        return { wasGranted: false, error: null };
      }
      await api.permissions.remove({ origins: [marker.origin] });
      const remainsGranted = await api.permissions.contains({
        origins: [marker.origin],
      });
      if (remainsGranted) {
        return {
          wasGranted: true,
          error: `云端域名权限未能撤销（${marker.origin}），请在扩展管理页检查站点权限。`,
        };
      }
      cleanupErrors.delete(marker.origin);
      return { wasGranted: true, error: null };
    } catch (error) {
      return {
        wasGranted: true,
        error: `撤销云端域名权限失败（${marker.origin}）：${errorMessage(error)}`,
      };
    }
  };

  const recovery = (async () => {
    const stored = await api.storage.get([
      LEASES_STORAGE_KEY,
      LATE_GRANT_GUARDS_STORAGE_KEY,
      CLEANUP_ERRORS_STORAGE_KEY,
    ]);
    const fallbackGuardUntil = newGuardUntil();
    const leases = Array.isArray(stored[LEASES_STORAGE_KEY])
      ? stored[LEASES_STORAGE_KEY].flatMap((value) => {
          const marker = permissionMarkerFrom(value, fallbackGuardUntil);
          return marker ? [marker] : [];
        })
      : [];
    const guards = Array.isArray(stored[LATE_GRANT_GUARDS_STORAGE_KEY])
      ? stored[LATE_GRANT_GUARDS_STORAGE_KEY].flatMap((value) => {
          const marker = permissionMarkerFrom(value, fallbackGuardUntil);
          return marker ? [marker] : [];
        })
      : [];
    const errors = stored[CLEANUP_ERRORS_STORAGE_KEY];
    if (errors && typeof errors === "object") {
      for (const [origin, message] of Object.entries(errors)) {
        const safeOrigin = safePermissionOrigin(origin);
        if (safeOrigin && typeof message === "string") {
          cleanupErrors.set(safeOrigin, message);
        }
      }
    }
    for (const lease of leases) {
      // Strip legacy 0.1.2 endpoint fields before any recovery write. Only the
      // permission origin is required to revoke an orphaned grant.
      persistedLeases.set(lease.requestId, persistedMarkerOf(lease));
    }
    for (const guard of guards) {
      lateGrantGuards.set(guard.requestId, persistedMarkerOf(guard));
    }
    pruneExpiredGuards();

    // A service-worker restart means no request that owned a saved lease is
    // still running. Revoke all such stale permissions before accepting work.
    for (const lease of leases) {
      const outcome = await revokeOrigin(lease);
      if (outcome.error) {
        cleanupErrors.set(lease.origin, outcome.error);
      } else {
        persistedLeases.delete(lease.requestId);
      }
    }

    // A late grant may have arrived while the previous worker was stopped.
    // Keep an absent, unexpired guard: permissions.onAdded may still fire later.
    for (const guard of [...lateGrantGuards.values()]) {
      const outcome = await revokeOrigin(guard);
      if (outcome.error) {
        cleanupErrors.set(guard.origin, outcome.error);
      } else if (outcome.wasGranted) {
        lateGrantGuards.delete(guard.requestId);
      }
    }
    await persistState();
  })();

  const cleanupLease = async (lease: ActiveLease): Promise<string | null> => {
    if (lease.cleanupPromise) return lease.cleanupPromise;
    lease.controller?.abort();
    lease.cleanupPromise = (async () => {
      await recovery;
      const anotherStartedLease =
        lease.revocable &&
        [...activeLeases.values()].some(
          (other) =>
            other.requestId !== lease.requestId &&
            other.origin === lease.origin &&
            other.started &&
            other.cleanupPromise === null,
        );
      const outcome = !lease.revocable || anotherStartedLease
        ? { wasGranted: false, error: null }
        : await revokeOrigin(lease);
      const cleanupError = outcome.error;
      if (cleanupError) {
        cleanupErrors.set(lease.origin, cleanupError);
        if (lease.started && lease.revocable) {
          // Keep active work as a durable retry marker for the next worker start.
          persistedLeases.set(lease.requestId, persistedMarkerOf(lease));
        }
        console.error(cleanupError);
      } else if (lease.started && lease.revocable) {
        persistedLeases.delete(lease.requestId);
      }
      // PREPARE wrote this guard before the prompt. An unstarted disconnect or
      // CANCEL deliberately retains it until onAdded observes the final grant,
      // or until its short deadline is lazily pruned.
      if (lease.started && lease.revocable) {
        lateGrantGuards.delete(lease.requestId);
      }
      activeLeases.delete(lease.requestId);
      await persistState();
      return cleanupError;
    })();
    return lease.cleanupPromise;
  };

  api.permissions.onAdded?.addListener((permissions) => {
    void recovery.then(async () => {
      const addedOrigins = new Set(
        (permissions.origins ?? []).flatMap((value) => {
          const origin = grantedPermissionOrigin(value);
          return origin ? [origin] : [];
        }),
      );
      let changed = pruneExpiredGuards();

      for (const origin of addedOrigins) {
        const matchingGuards = [...lateGrantGuards.values()].filter(
          (guard) => guard.origin === origin,
        );
        if (matchingGuards.length === 0) continue;
        const hasLivePendingRequest = [...activeLeases.values()].some(
          (lease) =>
            lease.origin === origin &&
            !lease.started &&
            !lease.disconnected &&
            lease.cleanupPromise === null,
        );
        if (hasLivePendingRequest) continue;
        const hasStartedWork = [...activeLeases.values()].some(
          (lease) =>
            lease.origin === origin &&
            lease.started &&
            lease.cleanupPromise === null,
        );
        if (hasStartedWork) continue;

        const outcome = await revokeOrigin(matchingGuards[0]!);
        if (outcome.error) {
          cleanupErrors.set(origin, outcome.error);
        } else {
          // onAdded proves the pending request reached its final grant. If a
          // foreground fallback won the race, contains=false is still final and
          // this guard can safely disappear.
          for (const guard of matchingGuards) {
            lateGrantGuards.delete(guard.requestId);
          }
          changed = true;
        }
      }

      if (changed || addedOrigins.size > 0) await persistState();
    });
  });

  const postError = (
    lease: ActiveLease,
    error: string,
    code: CloudBrokerErrorCode,
  ): void => {
    if (lease.disconnected) return;
    lease.port.postMessage({
      type: "CLOUD_ANALYSIS_ERROR",
      requestId: lease.requestId,
      error,
      code,
    });
  };

  api.runtime.onConnect.addListener((port) => {
    if (port.name !== CLOUD_ANALYSIS_PORT_NAME) return;
    const clientRequestIds = new Set<string>();
    let disconnected = false;
    let preparation = Promise.resolve();

    const prepare = async (
      message: Extract<CloudBrokerRequest, { type: "CLOUD_PERMISSION_PREPARE" }>,
    ): Promise<void> => {
      await recovery;
      let origin: string;
      try {
        origin = endpointPermissionPattern(message.endpoint);
      } catch (error) {
        if (!disconnected) {
          port.postMessage({
            type: "CLOUD_ANALYSIS_ERROR",
            requestId: message.requestId,
            error: errorMessage(error),
            code: "invalid_request",
          });
        }
        return;
      }
      const lease: ActiveLease = {
        requestId: message.requestId,
        endpoint: message.endpoint,
        origin,
        guardUntil: newGuardUntil(),
        port,
        controller: null,
        disconnected,
        started: false,
        revocable: !isPersistentCloudPermissionOrigin(origin),
        cleanupPromise: null,
      };
      activeLeases.set(message.requestId, lease);
      if (lease.revocable) {
        lateGrantGuards.set(message.requestId, persistedMarkerOf(lease));
      }
      clientRequestIds.add(message.requestId);
      pruneExpiredGuards();
      await persistState();
      if (disconnected) {
        lease.disconnected = true;
        await cleanupLease(lease);
      }
    };

    const start = async (
      message:
        | Extract<CloudBrokerRequest, { type: "CLOUD_ANALYSIS_START" }>
        | Extract<
            CloudBrokerRequest,
            { type: "CLOUD_WHOLE_THREAD_ANALYSIS_START" }
          >,
    ): Promise<void> => {
      await preparation;
      const lease = activeLeases.get(message.requestId);
      if (!lease || lease.endpoint !== message.endpoint || disconnected) return;
      let granted = false;
      try {
        granted = await api.permissions.contains({
          origins: [lease.origin],
        });
      } catch {
        const cleanupError = await cleanupLease(lease);
        postError(
          lease,
          cleanupError ?? "无法核对该 AI 端点的网络权限",
          cleanupError ? "permission_cleanup" : "permission_missing",
        );
        return;
      }
      if (!granted) {
        const cleanupError = await cleanupLease(lease);
        postError(
          lease,
          cleanupError ?? "未授予该 AI 端点的网络权限",
          cleanupError ? "permission_cleanup" : "permission_missing",
        );
        return;
      }
      if (disconnected || lease.disconnected || lease.cleanupPromise) {
        await cleanupLease(lease);
        return;
      }
      // The permission is now known to be granted and this request owns active
      // work. Replace the pre-prompt late-grant guard with the restart-safe
      // active cleanup marker before any body can leave the browser.
      lease.started = true;
      if (lease.revocable) {
        lateGrantGuards.delete(lease.requestId);
        persistedLeases.set(lease.requestId, persistedMarkerOf(lease));
      }
      await persistState();
      if (disconnected || lease.disconnected || lease.cleanupPromise) {
        await cleanupLease(lease);
        return;
      }
      lease.controller = new AbortController();
      void (async () => {
        let result:
          | CloudAnalysisResult
          | WholeThreadCloudAnalysisResult
          | null = null;
        let analysisError: unknown;
        try {
          const config = {
            endpoint: message.endpoint,
            model: message.model,
            apiKey: message.apiKey,
            mode: message.mode,
            signal: lease.controller!.signal,
          } satisfies CloudAnalysisConfig;
          result =
            message.type === "CLOUD_ANALYSIS_START"
              ? await analyze(message.finding, message.replies, config)
              : await analyzeWholeThread(
                  message.threadTitle,
                  message.replies,
                  config,
                );
        } catch (error) {
          analysisError = error;
        }

        const cleanupError = await cleanupLease(lease);
        if (cleanupError) {
          postError(lease, cleanupError, "permission_cleanup");
          return;
        }
        if (analysisError) {
          postError(
            lease,
            errorMessage(analysisError),
            analysisError instanceof CloudAnalysisError
              ? analysisError.code
              : "network",
          );
          return;
        }
        if (!lease.disconnected && result) {
          if (message.type === "CLOUD_ANALYSIS_START") {
            port.postMessage({
              type: "CLOUD_ANALYSIS_RESULT",
              requestId: lease.requestId,
              result: result as CloudAnalysisResult,
            });
          } else {
            port.postMessage({
              type: "CLOUD_WHOLE_THREAD_ANALYSIS_RESULT",
              requestId: lease.requestId,
              result: result as WholeThreadCloudAnalysisResult,
            });
          }
        }
      })();
    };

    port.onMessage.addListener((message) => {
      if (message.type === "CLOUD_PERMISSION_PREPARE") {
        preparation = preparation.then(() => prepare(message));
        return;
      }
      if (message.type === "CLOUD_ANALYSIS_START") {
        void start(message);
        return;
      }
      if (message.type === "CLOUD_WHOLE_THREAD_ANALYSIS_START") {
        void start(message);
        return;
      }
      if (message.type === "CLOUD_ANALYSIS_CANCEL") {
        void preparation.then(async () => {
          const lease = activeLeases.get(message.requestId);
          if (lease) await cleanupLease(lease);
        });
      }
    });

    port.onDisconnect.addListener(() => {
      disconnected = true;
      for (const requestId of clientRequestIds) {
        const lease = activeLeases.get(requestId);
        if (!lease) continue;
        lease.disconnected = true;
        lease.controller?.abort();
        void cleanupLease(lease);
      }
      // Covers a disconnect that happens before PREPARE has finished storing.
      void preparation.then(() => {
        for (const requestId of clientRequestIds) {
          const lease = activeLeases.get(requestId);
          if (!lease) continue;
          lease.disconnected = true;
          void cleanupLease(lease);
        }
      });
    });
  });

  return {
    async getCleanupStatus(): Promise<string | null> {
      await recovery;
      // A previous remove(false) remains actionable. Retry it when the panel
      // next asks for status, while never touching an origin with live work.
      let changed = pruneExpiredGuards();
      let stateMayHaveChanged = changed;
      for (const lease of [...persistedLeases.values()]) {
        if (activeLeases.has(lease.requestId)) continue;
        const outcome = await revokeOrigin(lease);
        stateMayHaveChanged = true;
        if (outcome.error) {
          cleanupErrors.set(lease.origin, outcome.error);
        } else {
          persistedLeases.delete(lease.requestId);
          changed = true;
        }
      }

      // An unexpired guard is a permission request whose foreground context may
      // have vanished before the prompt resolved. Polling cleanup status is a
      // second recovery path in addition to permissions.onAdded.
      const checkedOrigins = new Set<string>();
      for (const guard of [...lateGrantGuards.values()]) {
        if (checkedOrigins.has(guard.origin)) continue;
        checkedOrigins.add(guard.origin);
        const hasLiveOwner = [...activeLeases.values()].some(
          (lease) =>
            lease.origin === guard.origin &&
            !lease.disconnected &&
            lease.cleanupPromise === null,
        );
        if (hasLiveOwner) continue;
        const outcome = await revokeOrigin(guard);
        stateMayHaveChanged = true;
        if (outcome.error) {
          cleanupErrors.set(guard.origin, outcome.error);
        } else if (outcome.wasGranted) {
          for (const candidate of [...lateGrantGuards.values()]) {
            if (candidate.origin === guard.origin) {
              lateGrantGuards.delete(candidate.requestId);
            }
          }
          changed = true;
        }
      }
      if (changed || stateMayHaveChanged) await persistState();
      return [...cleanupErrors.values()][0] ?? null;
    },
  };
}
