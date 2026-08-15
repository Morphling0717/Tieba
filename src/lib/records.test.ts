import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../types";
import type { ReviewRecord } from "../types";
import {
  createReviewRecord,
  mergeReviewRecords,
  parseReviewRecords,
  serializeReviewRecords,
  validateReviewExport,
  validateReviewRecord,
} from "./records";

function record(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: "00000000-0000-4000-8000-000000000001",
    threadId: "123",
    threadUrl: "https://tieba.baidu.com/p/123",
    replyIds: ["101"],
    decision: "delete",
    primaryReasonId: "R03.06",
    internalTags: ["personal_attack"],
    reviewedAt: "2026-07-22T04:00:00.000Z",
    analyzerVersions: {
      local: "1.0.0",
      cloud: null,
      rules: "1.0",
    },
    ...overrides,
  };
}

describe("review record validation", () => {
  it("accepts only the complete ReviewRecord shape", () => {
    expect(validateReviewRecord(record())).toEqual(record());
    const apiOnlyRecord = record({
      analyzerVersions: {
        local: "disabled",
        cloud: "2.3.0",
        rules: "1.0",
      },
    });
    expect(validateReviewRecord(apiOnlyRecord)).toEqual(apiOnlyRecord);

    const missing = { ...record() } as Record<string, unknown>;
    delete missing.threadUrl;
    expect(() => validateReviewRecord(missing)).toThrow();
    expect(() =>
      validateReviewRecord({ ...record(), schemaVersion: "2.0" }),
    ).toThrow();
    expect(() =>
      validateReviewRecord({ ...record(), threadId: "999" }),
    ).toThrow();
  });

  it("rejects unknown and sensitive reply fields at every strict boundary", () => {
    expect(() =>
      validateReviewRecord({ ...record(), content: "完整回复正文" }),
    ).toThrow();
    expect(() =>
      validateReviewRecord({ ...record(), authorName: "原始用户名" }),
    ).toThrow();
    expect(() =>
      validateReviewRecord({ ...record(), note: "可能粘贴正文的自由文本" }),
    ).toThrow();
    expect(() =>
      validateReviewRecord({
        ...record(),
        analyzerVersions: {
          ...record().analyzerVersions,
          authorName: "原始用户名",
        },
      }),
    ).toThrow();
  });

  it("rejects or strips sensitive text smuggled through allowed string fields", () => {
    expect(() =>
      validateReviewRecord({
        ...record(),
        replyIds: ["用户甲说了完整正文"],
      }),
    ).toThrow();
    expect(() =>
      validateReviewRecord({
        ...record(),
        internalTags: ["用户名-用户甲"],
      }),
    ).toThrow();
    expect(
      validateReviewRecord({
        ...record(),
        threadUrl: "https://tieba.baidu.com/p/123?note=用户甲",
      }).threadUrl,
    ).toBe("https://tieba.baidu.com/p/123");
    expect(() =>
      validateReviewRecord({
        ...record(),
        primaryReasonId: "R03.99",
      }),
    ).toThrow();
  });

  it("strictly validates the export envelope", () => {
    const bundle = {
      schemaVersion: SCHEMA_VERSION,
      exportedAt: "2026-07-22T05:00:00.000Z",
      records: [record()],
    };
    expect(validateReviewExport(bundle)).toEqual(bundle);
    expect(() => validateReviewExport({ ...bundle, username: "someone" })).toThrow();
    expect(() =>
      validateReviewExport({ ...bundle, exportedAt: "yesterday" }),
    ).toThrow();
  });
});

describe("createReviewRecord", () => {
  it("adds version, deterministic identity/time, and removes duplicate list entries", () => {
    const created = createReviewRecord(
      {
        threadId: null,
        threadUrl: "https://tieba.baidu.com/p/456",
        replyIds: ["101", "101", "102"],
        decision: "watch",
        primaryReasonId: null,
        internalTags: ["provocation", "provocation"],
        analyzerVersions: { local: "1.0.0", cloud: null, rules: "1.0" },
      },
      {
        now: () => new Date("2026-07-22T06:00:00.000Z"),
        randomUUID: () => "00000000-0000-4000-8000-000000000003",
      },
    );

    expect(created).toMatchObject({
      schemaVersion: SCHEMA_VERSION,
      id: "00000000-0000-4000-8000-000000000003",
      reviewedAt: "2026-07-22T06:00:00.000Z",
      replyIds: ["101", "102"],
      internalTags: ["provocation"],
    });
  });
});

describe("record export and merge", () => {
  it("serializes a versioned envelope and parses it back", () => {
    const serialized = serializeReviewRecords(
      [record()],
      "2026-07-22T08:00:00.000Z",
    );
    const envelope = JSON.parse(serialized) as Record<string, unknown>;

    expect(envelope.schemaVersion).toBe("1.0");
    expect(envelope.exportedAt).toBe("2026-07-22T08:00:00.000Z");
    expect(envelope.records).toEqual([record()]);
    expect(parseReviewRecords(serialized)).toEqual([record()]);
  });

  it("canonicalizes thread URLs before persistence and export", () => {
    const created = createReviewRecord(
      {
        ...record(),
        threadUrl: "https://tieba.baidu.com/p/123?fr=frs&note=用户甲",
      },
      { randomUUID: () => "unused" },
    );

    expect(created.threadUrl).toBe("https://tieba.baidu.com/p/123");
    expect(serializeReviewRecords([created])).not.toContain("用户甲");
  });

  it("rejects imported records containing sensitive extra fields", () => {
    const unsafe = JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      exportedAt: "2026-07-22T08:00:00.000Z",
      records: [{ ...record(), content: "不应导入的完整正文" }],
    });

    expect(() => parseReviewRecords(unsafe)).toThrow();
  });

  it("de-duplicates IDs, keeps the latest version, and leaves inputs unchanged", () => {
    const oldRecord = record({
      reviewedAt: "2026-07-22T01:00:00.000Z",
      decision: "watch",
      replyIds: ["101", "101"],
    });
    const newRecord = record({
      reviewedAt: "2026-07-22T03:00:00.000Z",
      decision: "keep",
      replyIds: ["101", "102", "102"],
    });
    const other = record({
      id: "00000000-0000-4000-8000-000000000002",
      reviewedAt: "2026-07-22T02:00:00.000Z",
    });

    const merged = mergeReviewRecords([oldRecord], [other, newRecord]);

    expect(merged.map((item) => item.id)).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ]);
    expect(merged[0]?.decision).toBe("keep");
    expect(merged[0]?.replyIds).toEqual(["101", "102"]);
    expect(oldRecord.replyIds).toEqual(["101", "101"]);
  });

  it("de-duplicates repeated IDs found inside an imported package", () => {
    const serialized = JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      exportedAt: "2026-07-22T08:00:00.000Z",
      records: [
        record({ reviewedAt: "2026-07-22T01:00:00.000Z", decision: "watch" }),
        record({ reviewedAt: "2026-07-22T02:00:00.000Z", decision: "keep" }),
      ],
    });

    expect(parseReviewRecords(serialized)).toEqual([
      record({ reviewedAt: "2026-07-22T02:00:00.000Z", decision: "keep" }),
    ]);
  });
});
