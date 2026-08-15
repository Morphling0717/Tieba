import type { CloudProvider, ReviewRecord } from "../types";
import {
  mergeReviewRecords,
  validateReviewRecord,
} from "../lib/records";
import {
  DEFAULT_CLOUD_ANALYSIS_MODE,
  normalizeCloudAnalysisMode,
  type CloudAnalysisMode,
} from "../lib/cloud";
import {
  CLOUD_PROVIDER_DEFAULTS,
  DEFAULT_CLOUD_PROVIDER,
  normalizeCloudProvider,
  persistableCloudEndpoint,
} from "../lib/cloudPermission";

const RECORDS_KEY = "kr_tieba_review_records_v1";

export async function loadStoredRecords(): Promise<ReviewRecord[]> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return [];
  const result = await chrome.storage.local.get(RECORDS_KEY);
  const stored = result[RECORDS_KEY];
  if (!Array.isArray(stored)) return [];

  const valid: ReviewRecord[] = [];
  for (const candidate of stored) {
    try {
      valid.push(validateReviewRecord(candidate));
    } catch {
      // 0.1.2 accepted arbitrary text in otherwise legitimate string fields.
      // Invalid legacy/imported entries are discarded instead of exposing or
      // re-exporting usernames, reply bodies, or unsafe links.
    }
  }
  const normalized = mergeReviewRecords([], valid);
  if (normalized.length !== stored.length || JSON.stringify(normalized) !== JSON.stringify(stored)) {
    await chrome.storage.local.set({ [RECORDS_KEY]: normalized });
  }
  return normalized;
}

export async function saveStoredRecords(records: ReviewRecord[]): Promise<void> {
  await chrome.storage.local.set({
    [RECORDS_KEY]: mergeReviewRecords([], records),
  });
}

export interface CloudSettings {
  provider: CloudProvider;
  endpoint: string;
  model: string;
  apiKey: string;
  mode: CloudAnalysisMode;
  autoAnalyzeWholeThread: boolean;
}

export async function loadCloudSettings(): Promise<CloudSettings> {
  if (typeof chrome === "undefined" || !chrome.storage) {
    return {
      provider: DEFAULT_CLOUD_PROVIDER,
      ...CLOUD_PROVIDER_DEFAULTS[DEFAULT_CLOUD_PROVIDER],
      apiKey: "",
      mode: DEFAULT_CLOUD_ANALYSIS_MODE,
      autoAnalyzeWholeThread: true,
    };
  }
  const [local, session] = await Promise.all([
    chrome.storage.local.get("kr_cloud_settings_v1"),
    chrome.storage.session.get("kr_cloud_api_key_v1"),
  ]);
  const settings = local.kr_cloud_settings_v1 as
    | {
        provider?: unknown;
        endpoint?: string;
        model?: string;
        mode?: unknown;
        autoAnalyzeWholeThread?: unknown;
    }
    | undefined;
  const provider = normalizeCloudProvider(
    settings?.provider,
    settings?.endpoint,
  );
  const defaults = CLOUD_PROVIDER_DEFAULTS[provider];
  const mode = normalizeCloudAnalysisMode(settings?.mode);
  let endpoint = settings
    ? settings.endpoint ?? defaults.endpoint
    : defaults.endpoint;
  try {
    endpoint = persistableCloudEndpoint(endpoint);
  } catch {
    endpoint = "";
    await chrome.storage.local.set({
      kr_cloud_settings_v1: {
        provider,
        endpoint: "",
        model: settings?.model ?? defaults.model,
        mode,
        autoAnalyzeWholeThread:
          settings?.autoAnalyzeWholeThread !== false,
      },
    });
  }
  return {
    provider,
    endpoint,
    model: settings?.model ?? defaults.model,
    apiKey: (session.kr_cloud_api_key_v1 as string | undefined) ?? "",
    mode,
    autoAnalyzeWholeThread: settings?.autoAnalyzeWholeThread !== false,
  };
}

export async function saveCloudSettings(
  settings: Omit<CloudSettings, "mode" | "autoAnalyzeWholeThread"> & {
    mode?: CloudAnalysisMode;
    autoAnalyzeWholeThread?: boolean;
  },
): Promise<void> {
  const endpoint = persistableCloudEndpoint(settings.endpoint);
  const provider = normalizeCloudProvider(settings.provider, endpoint);
  await Promise.all([
    chrome.storage.local.set({
      kr_cloud_settings_v1: {
        provider,
        endpoint,
        model: settings.model,
        mode: normalizeCloudAnalysisMode(settings.mode),
        autoAnalyzeWholeThread: settings.autoAnalyzeWholeThread !== false,
      },
    }),
    chrome.storage.session.set({ kr_cloud_api_key_v1: settings.apiKey }),
  ]);
}
