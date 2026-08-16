import { describe, expect, it } from "vitest";
import { REASON_RULES } from "../data/reasons";
import { WHOLE_THREAD_CLOUD_PROTOCOL_VERSION } from "../lib/cloud";
import {
  DEMO_REVIEW_CLEAN,
  DEMO_REVIEW_DENSE,
  DEMO_REVIEW_FIXTURES,
  DEMO_REVIEW_TYPICAL,
  DEMO_SESSION,
} from "./demo";

const fixtures = [
  DEMO_REVIEW_CLEAN,
  DEMO_REVIEW_TYPICAL,
  DEMO_REVIEW_DENSE,
];

describe("synthetic review demo fixtures", () => {
  it("keeps the original partial demo available", () => {
    expect(DEMO_SESSION.coverage.captureMode).toBe("paginated");
    expect(DEMO_SESSION.coverage.isComplete).toBe(false);
  });

  it("exports clean, typical and dense scenarios by stable ids", () => {
    expect(Object.keys(DEMO_REVIEW_FIXTURES)).toEqual([
      "review-clean",
      "review-typical",
      "review-dense",
    ]);
    expect(fixtures.map((fixture) => fixture.result.findings.length)).toEqual([
      0, 2, 10,
    ]);
  });

  it("uses complete API sessions and V3 results without requiring a model", () => {
    for (const fixture of fixtures) {
      expect(fixture.session.coverage).toMatchObject({
        captureMode: "api",
        isComplete: true,
        unstableReplyIdCount: 0,
      });
      expect(fixture.session.coverage.apiCoverage).toMatchObject({
        readableTextComplete: true,
        failedRequestCount: 0,
        unavailableReplyCount: 0,
      });
      expect(fixture.result.protocolVersion).toBe(
        WHOLE_THREAD_CLOUD_PROTOCOL_VERSION,
      );
      expect(fixture.result.analyzedReplyCount).toBe(
        fixture.session.replies.length,
      );
      expect(fixture.result.ruleCount).toBe(REASON_RULES.length);
    }
  });

  it("keeps every finding and report reference inside its synthetic session", () => {
    for (const fixture of fixtures) {
      const replyIds = new Set(fixture.session.replies.map((reply) => reply.id));
      const reasonIds = new Set(REASON_RULES.map((reason) => reason.id));
      for (const finding of fixture.result.findings) {
        expect(finding.replyIds.every((id) => replyIds.has(id))).toBe(true);
        expect(
          (finding.contextReplyIds ?? []).every((id) => replyIds.has(id)),
        ).toBe(true);
        expect(
          finding.evidence.every((evidence) => replyIds.has(evidence.replyId)),
        ).toBe(true);
        expect(
          finding.reasonCandidates.every((reason) =>
            reasonIds.has(reason.reasonId),
          ),
        ).toBe(true);
      }
      for (const item of [
        ...fixture.result.report.stages,
        ...fixture.result.report.interactions,
        ...fixture.result.report.notes,
      ]) {
        expect(item.replyIds.every((id) => replyIds.has(id))).toBe(true);
      }
    }
  });

  it("covers boundary notes, repeated authors, long names and same-parent nested replies", () => {
    expect(
      fixtures.some((fixture) =>
        fixture.result.report.notes.some(
          (note) => note.kind === "needs_human_check",
        ),
      ),
    ).toBe(true);
    expect(
      fixtures.some((fixture) =>
        fixture.result.report.notes.some(
          (note) => note.kind === "heated_but_allowed",
        ),
      ),
    ).toBe(true);

    const typicalAuthors = DEMO_REVIEW_TYPICAL.session.replies
      .map((reply) => reply.authorName ?? "")
      .filter(Boolean);
    expect(Math.max(...typicalAuthors.map((name) => name.length))).toBeGreaterThan(
      30,
    );
    expect(new Set(typicalAuthors).size).toBeLessThan(typicalAuthors.length);

    const denseNested = DEMO_REVIEW_DENSE.session.replies.filter(
      (reply) => reply.isNested,
    );
    expect(denseNested).toHaveLength(6);
    expect(new Set(denseNested.map((reply) => reply.parentReplyId))).toEqual(
      new Set(["830000000004"]),
    );

    const longestReason = REASON_RULES.reduce((longest, current) =>
      current.text.length > longest.text.length ? current : longest,
    );
    expect(
      DEMO_REVIEW_TYPICAL.result.findings.some((finding) =>
        finding.reasonCandidates.some(
          (candidate) => candidate.reasonId === longestReason.id,
        ),
      ),
    ).toBe(true);
  });
});
