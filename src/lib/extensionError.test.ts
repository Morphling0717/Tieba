import { describe, expect, it } from "vitest";

import {
  ExtensionOperationError,
  normalizeExtensionError,
} from "./extensionError";

describe("normalizeExtensionError", () => {
  it("translates a missing host permission error", () => {
    const result = normalizeExtensionError(
      new Error(
        "Cannot access contents of the page. Extension manifest must request permission to access the respective host.",
      ),
      "SCRIPT_INJECTION_FAILED",
    );

    expect(result.code).toBe("TIEBA_PERMISSION_MISSING");
    expect(result.message).toContain("tieba.baidu.com");
  });

  it("distinguishes browser-internal restricted pages", () => {
    const result = normalizeExtensionError(
      new Error("Cannot access a chrome:// URL"),
      "SCRIPT_INJECTION_FAILED",
    );

    expect(result.code).toBe("RESTRICTED_PAGE");
  });

  it("preserves explicit operation errors", () => {
    const original = new ExtensionOperationError(
      "页面解析失败",
      "PAGE_PARSE_FAILED",
    );
    expect(normalizeExtensionError(original)).toBe(original);
  });
});
