import { describe, expect, it } from "vitest";
import {
  CLOUD_PROVIDER_DEFAULTS,
  endpointPermissionPattern,
  normalizeCloudProvider,
  persistableCloudEndpoint,
} from "./cloudPermission";

describe("cloud endpoint permissions and persistence", () => {
  it("reduces a safe endpoint to one exact optional host origin", () => {
    expect(
      endpointPermissionPattern("https://provider.example/v1/chat/completions"),
    ).toBe("https://provider.example/*");
    expect(
      persistableCloudEndpoint(" https://provider.example/v1?api-version=2026-01 "),
    ).toBe("https://provider.example/v1?api-version=2026-01");
  });

  it("provides exact DeepSeek defaults and migrates legacy provider settings", () => {
    expect(CLOUD_PROVIDER_DEFAULTS.deepseek).toEqual({
      endpoint: "https://api.deepseek.com/chat/completions",
      model: "deepseek-v4-pro",
    });
    expect(
      normalizeCloudProvider(
        undefined,
        "https://api.deepseek.com/chat/completions",
      ),
    ).toBe("deepseek");
    expect(
      normalizeCloudProvider(
        undefined,
        "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      ),
    ).toBe("alibaba");
  });

  it.each([
    "https://user:secret@provider.example/v1",
    "https://provider.example/v1#api-key=secret",
    "https://provider.example/v1?api_key=secret",
    "https://provider.example/v1?key=secret",
    "https://provider.example/v1?x-api-key=secret",
    "https://provider.example/v1?subscription-key=secret",
    "https://provider.example/v1?access-token=secret",
    "https://provider.example/v1?clientSecret=secret",
    "https://provider.example/v1?authorization=Bearer-secret",
  ])("rejects credential-bearing durable endpoints: %s", (endpoint) => {
    expect(() => persistableCloudEndpoint(endpoint)).toThrow();
  });
});
