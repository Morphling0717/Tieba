import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(
  resolve(process.cwd(), "src/sidepanel/styles.css"),
  "utf8",
);

describe("sidepanel motion styles", () => {
  it("defines shared motion tokens and entry animations", () => {
    expect(styles).toContain("--motion-duration-fast: 190ms");
    expect(styles).toContain("--motion-duration-standard: 280ms");
    expect(styles).toContain("@keyframes surface-enter");
    expect(styles).toContain("@keyframes dialog-enter");
    expect(styles).toContain(".tabs::after");
    expect(styles).toContain("--tab-index: 3");
  });

  it("keeps transform transitions on rules that outrank legacy component styles", () => {
    const tabButtonRule = styles.match(/\.tabs button\s*\{([^}]*)\}/)?.[1];
    const toastButtonRule = styles.match(
      /\.app-shell \.toast button\s*\{([^}]*)\}/,
    )?.[1];

    expect(tabButtonRule).toContain(
      "transform var(--motion-duration-instant)",
    );
    expect(toastButtonRule).toContain(
      "transform var(--motion-duration-instant)",
    );
  });

  it("fully disables decorative motion when reduced motion is requested", () => {
    const reducedMotionStart = styles.indexOf(
      "@media (prefers-reduced-motion: reduce)",
    );
    const forcedColorsStart = styles.indexOf(
      "@media (forced-colors: active)",
      reducedMotionStart,
    );

    expect(reducedMotionStart).toBeGreaterThanOrEqual(0);
    expect(forcedColorsStart).toBeGreaterThan(reducedMotionStart);

    const reducedMotionStyles = styles.slice(
      reducedMotionStart,
      forcedColorsStart,
    );
    expect(reducedMotionStyles).toContain("animation: none !important");
    expect(reducedMotionStyles).toContain("transition: none !important");
    expect(reducedMotionStyles).toContain("scroll-behavior: auto !important");
  });
});
