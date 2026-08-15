import { describe, expect, it } from "vitest";

import {
  getReasonById,
  REASON_CATEGORIES,
  REASON_RULES,
  REASON_VERSION,
} from "./reasons";

const EXPECTED_COUNTS = [6, 6, 8, 8, 6, 7, 7, 9, 8, 5, 5, 7, 12, 8, 4, 6];

describe("删帖理由规则库", () => {
  it("包含 PDF 中的 16 个分类和 112 条细化理由", () => {
    expect(REASON_CATEGORIES).toHaveLength(16);
    expect(REASON_RULES).toHaveLength(112);

    REASON_CATEGORIES.forEach((category, categoryIndex) => {
      const rules = REASON_RULES.filter(
        (rule) => rule.categoryId === category.id,
      );

      expect(rules).toHaveLength(EXPECTED_COUNTS[categoryIndex]);
      expect(
        rules.every(
          (rule, ruleIndex) =>
            rule.categoryTitle === category.title && rule.item === ruleIndex + 1,
        ),
      ).toBe(true);
    });
  });

  it("每个 ID 唯一并在各分类内从 01 连续编号", () => {
    const ids = REASON_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);

    const expectedIds = REASON_CATEGORIES.flatMap((category, categoryIndex) =>
      Array.from(
        { length: EXPECTED_COUNTS[categoryIndex] },
        (_, reasonIndex) =>
          `${category.id}.${String(reasonIndex + 1).padStart(2, "0")}`,
      ),
    );

    expect(ids).toEqual(expectedIds);
  });

  it("每条理由都有规范原文和统一版本", () => {
    for (const rule of REASON_RULES) {
      expect(rule.text.trim()).not.toBe("");
      expect(rule.version).toBe(REASON_VERSION);
    }
  });

  it("可按稳定 ID 查询理由", () => {
    expect(getReasonById("R03.06")?.text).toContain("XX孝子");
    expect(getReasonById("R13.12")?.categoryTitle).toBe(
      "在播作品与完结作品质量比较",
    );
    expect(getReasonById("R16.06")?.version).toBe("2026.07");
    expect(getReasonById("R99.99")).toBeUndefined();
  });
});
