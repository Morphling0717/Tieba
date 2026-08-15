import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PERSISTENT_CLOUD_PERMISSION_ORIGINS } from "./lib/cloudPermission";

interface ExtensionManifest {
  version: string;
  permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
  commands?: Record<
    string,
    { suggested_key?: { default?: string; mac?: string } }
  >;
}

const manifest = JSON.parse(
  readFileSync(resolve(process.cwd(), "public/manifest.json"), "utf8"),
) as ExtensionManifest;

describe("extension manifest permission contract", () => {
  it("ships version 0.3.1 with only the required extension permissions", () => {
    expect(manifest.version).toBe("0.3.1");
    expect(manifest.permissions?.slice().sort()).toEqual(
      ["scripting", "sidePanel", "storage"].sort(),
    );
    expect(manifest.permissions).not.toContain("activeTab");
    expect(manifest.permissions).not.toContain("tabs");
  });

  it("requires only desktop Tieba and the existing Tabbit-compatible Alibaba endpoint", () => {
    expect(manifest.host_permissions).toEqual([
      "https://tieba.baidu.com/*",
      PERSISTENT_CLOUD_PERMISSION_ORIGINS[0],
    ]);
  });

  it("makes the exact DeepSeek host an explicit persistent user grant", () => {
    expect(manifest.optional_host_permissions).toEqual([
      PERSISTENT_CLOUD_PERMISSION_ORIGINS[1],
      "http://localhost/*",
      "http://127.0.0.1/*",
    ]);
    expect(manifest.optional_host_permissions).not.toContain("https://*/*");
  });

  it("provides a keyboard action that opens the same side panel", () => {
    expect(manifest.commands?._execute_action?.suggested_key).toEqual({
      default: "Alt+Shift+Y",
      mac: "Command+Shift+Y",
    });
  });
});
