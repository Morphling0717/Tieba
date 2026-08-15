import { describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

describe("copyText", () => {
  it("uses the modern clipboard API when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const execCommand = vi.fn();
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });

    await copyText("规范原文", {
      navigator: { clipboard: { writeText } },
      document,
    });

    expect(writeText).toHaveBeenCalledWith("规范原文");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("falls back to a temporary textarea when Tabbit rejects writeText", async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException("denied"));
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });

    await copyText("规范原文", {
      navigator: { clipboard: { writeText } },
      document,
    });

    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
  });
});
