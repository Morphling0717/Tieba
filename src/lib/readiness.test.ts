import { describe, expect, it } from "vitest";

import { waitForTiebaDocumentReady } from "./readiness";

function documentFrom(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("waitForTiebaDocumentReady", () => {
  it("waits through a header-only unsupported snapshot until a reply mounts", async () => {
    const document = documentFrom(`
      <div id="app"><div class="pc-pb-reply-top">全部回复 (2)</div></div>
    `);
    let elapsed = 0;
    const inspection = await waitForTiebaDocumentReady(
      document,
      "https://tieba.baidu.com/p/123",
      {
        timeoutMs: 5_000,
        pollMs: 125,
        now: () => elapsed,
        wait: async (milliseconds) => {
          elapsed += milliseconds;
          if (elapsed === 250) {
            document.querySelector("#app")!.insertAdjacentHTML(
              "beforeend",
              `<div class="pb-comment-item" data-id="101"></div>`,
            );
          }
        },
      },
    );

    expect(inspection).toEqual({ status: "ready", parserVariant: "spa" });
    expect(elapsed).toBe(250);
  });

  it("returns the final unsupported classification at the deadline", async () => {
    const document = documentFrom(`
      <div id="app"><div class="pc-pb-reply-top">全部回复</div></div>
    `);
    let elapsed = 0;
    const inspection = await waitForTiebaDocumentReady(
      document,
      "https://tieba.baidu.com/p/123",
      {
        timeoutMs: 250,
        pollMs: 125,
        now: () => elapsed,
        wait: async (milliseconds) => {
          elapsed += milliseconds;
        },
      },
    );

    expect(inspection.status).toBe("unsupported");
    expect(elapsed).toBe(250);
  });
});
