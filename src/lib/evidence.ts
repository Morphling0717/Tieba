function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/gu, (character) =>
    `\\${character.codePointAt(0)?.toString(16) ?? "0"} `,
  );
}

/** Resolve a captured reply again after the live Tieba DOM has changed. */
export function findEvidenceElement(
  document: Document,
  anchor: string,
  replyId: string,
  siteReplyId: string | null = null,
  allowGenericDataId = true,
): Element | null {
  for (const stableId of [replyId, siteReplyId]) {
    if (!stableId) continue;
    const escaped = cssEscape(stableId);
    const stableTarget =
      document.querySelector(`[data-kr-review-reply-id="${escaped}"]`) ??
      document.querySelector(`[data-pid="${escaped}"]`) ??
      document.querySelector(`[data-spid="${escaped}"]`) ??
      document.querySelector(`.pb-comment-item[data-id="${escaped}"]`) ??
      document.querySelector(`#post_content_${escaped}`) ??
      document.getElementById(stableId);
    if (stableTarget) return stableTarget;
  }

  if (anchor) {
    try {
      const anchored = document.querySelector(anchor);
      if (anchored) return anchored;
    } catch {
      // Continue to the final legacy data-id fallback.
    }
  }
  // A few legacy layouts expose only data-id. Keep this broad fallback after
  // the captured selector so SPA cannot jump to an unrelated element that
  // happens to reuse a post id.
  if (allowGenericDataId) {
    for (const stableId of [replyId, siteReplyId]) {
      if (!stableId) continue;
      const target = document.querySelector(
        `[data-id="${cssEscape(stableId)}"]`,
      );
      if (target) return target;
    }
  }
  return null;
}

/** Find a currently mounted virtual-list placeholder for an official post id. */
export function findVirtualEvidencePlaceholder(
  document: Document,
  siteReplyId: string | null,
): Element | null {
  if (!siteReplyId) return null;
  const escaped = cssEscape(siteReplyId);
  return (
    document.querySelector(`.virtual-list-item[data-key="${escaped}"]`) ??
    document.querySelector(`.virtual-list-item[data-id="${escaped}"]`)
  );
}

/**
 * Locate the virtual row nearest a public floor number. Tieba's ascending
 * reply list normally uses a zero-based index that excludes the thread card,
 * but a few deployments offset it by one. This helper is only a scroll hint:
 * callers must still resolve the requested official PID before succeeding.
 */
export function findVirtualFloorPlaceholder(
  document: Document,
  floor: number | null,
): Element | null {
  if (floor === null || !Number.isSafeInteger(floor) || floor < 2) return null;
  const likelyIndexes = [floor - 2, floor - 1, floor];
  for (const index of likelyIndexes) {
    const target = document.querySelector(
      `.virtual-list-item[data-index="${index}"]`,
    );
    if (target) return target;
  }
  return null;
}

export interface VirtualIndexRange {
  min: number;
  max: number;
  count: number;
}

/** Read only public virtual-row indices currently mounted by Tieba. */
export function mountedVirtualIndexRange(
  document: Document,
): VirtualIndexRange | null {
  const indexes = Array.from(
    document.querySelectorAll(".virtual-list-item[data-index]"),
    (element) => Number(element.getAttribute("data-index")),
  ).filter((value) => Number.isSafeInteger(value) && value >= 0);
  if (indexes.length === 0) return null;
  return {
    min: Math.min(...indexes),
    max: Math.max(...indexes),
    count: indexes.length,
  };
}

function normalizedControlText(value: string | null): string {
  return (value ?? "")
    .replace(/[\u200b-\u200d\ufeff]/gu, "")
    .replace(/[\t\r\n\u00a0 ]+/gu, " ")
    .trim();
}

function controlIsDisabledOrHidden(element: Element): boolean {
  if (element.closest("[hidden], [inert], [aria-hidden='true']")) return true;
  if (element.getAttribute("aria-disabled") === "true") return true;
  return "disabled" in element && Boolean(element.disabled);
}

function hasDangerousControlMetadata(element: Element): boolean {
  const metadata = [
    element.textContent,
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
    element.getAttribute("class"),
  ]
    .filter(Boolean)
    .join(" ");
  return /\b(?:delete|remove|ban|report|manage|moderate|block|publish)\b|删除|移除|封禁|禁言|拉黑|举报|管理|发布|发帖/iu.test(
    metadata,
  );
}

function hasSafeNonNavigatingHref(element: Element): boolean {
  if (element.tagName !== "A") return true;
  const href = element.getAttribute("href")?.trim() ?? "";
  return href === "" || href === "#";
}

function semanticClickable(element: Element): HTMLElement | null {
  const clickable = element.closest<HTMLElement>(
    "button, [role='button'], [role='tab'], a, .sub-tab-item, [class*='sort-item'], [class*='order-item'], [class*='more'], [class*='expand'], [class*='unfold']",
  );
  if (!clickable || controlIsDisabledOrHidden(clickable)) return null;
  if (
    hasDangerousControlMetadata(element) ||
    hasDangerousControlMetadata(clickable)
  ) {
    return null;
  }
  if (!hasSafeNonNavigatingHref(clickable)) return null;
  return clickable;
}

/**
 * Resolve only an unambiguous in-page "ascending" sort control. Restricting
 * the search to Tieba's reply header/tab regions prevents a reply whose body
 * happens to contain the word “正序” from ever being clicked.
 */
export function findTiebaAscendingSortControl(
  document: Document,
): HTMLElement | null {
  const scopes = document.querySelectorAll(
    ".pc-pb-comments .pc-pb-reply-top, .pc-pb-comments .pc-pb-comments-header, .pc-pb-comments [class*='reply-top'], .pc-pb-comments [class*='reply-header'], .pc-pb-comments [class*='reply-sort'], .pc-pb-comments [class*='comment-sort'], .pc-pb-comments [role='tablist']",
  );
  for (const scope of scopes) {
    if (
      scope.closest(
        ".pb-comment-item, .pb-lzl-item, .l_post, .lzl_single_post",
      )
    ) {
      continue;
    }
    const candidates = [scope, ...scope.querySelectorAll("*")];
    for (const candidate of candidates) {
      if (normalizedControlText(candidate.textContent) !== "正序") continue;
      const clickable = semanticClickable(candidate);
      if (clickable && scope.contains(clickable)) return clickable;
    }
  }
  return null;
}

export function isSelectedSortControl(element: Element): boolean {
  if (
    element.getAttribute("aria-selected") === "true" ||
    element.getAttribute("aria-current") === "true"
  ) {
    return true;
  }
  return Array.from(element.classList).some((name) =>
    /(?:^|[-_])(active|current|selected)(?:$|[-_])/iu.test(name),
  );
}

export type ReadExpansionScope = "nested" | "thread";

function isAllowedExpansionText(text: string, scope: ReadExpansionScope): boolean {
  if (!text || text.length > 40) return false;
  if (/删除|封禁|禁言|拉黑|举报|管理|发布|发帖|收起/iu.test(text)) {
    return false;
  }
  if (scope === "thread") {
    return /^(?:展开更多|查看更多|加载更多)(?:回复|评论)?$/u.test(text);
  }
  return (
    /^(?:展开|查看|加载)(?:更多|全部)?(?:\s*\d+\s*条)?(?:楼中楼)?(?:回复|评论)$/u.test(text) ||
    /^(?:展开更多|查看更多|加载更多|查看全部)$/u.test(text)
  );
}

/**
 * Return only read-only expansion controls from an explicit allowlist. This
 * deliberately never matches plain “回复”, moderation actions, or links that
 * navigate away from the current document.
 */
export function findSafeReadExpansionControls(
  root: ParentNode,
  scope: ReadExpansionScope,
): HTMLElement[] {
  const selector =
    scope === "nested"
      ? ".show-more-lzl, .lzl_more, .j_lzl_more, .j_lzl_m_w, .lzl_link_unfold, [class*='lzl_more'], [class*='lzl-more'], [class*='load-more'], [class*='show-more'], [class*='load_more'], [class*='show_more'], [class*='more-comment'], [class*='more-reply'], [class*='expand'], [class*='unfold']"
      : ".load-more, .show-more, [class*='load-more'], [class*='show-more'], [class*='load_more'], [class*='show_more'], [class*='more-comment'], [class*='more-reply'], [class*='expand'], [class*='unfold']";
  const result: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  const nestedWrappers =
    scope === "nested"
      ? Array.from(
          root.querySelectorAll(
            ".lzl-wrapper, .lzl_container, .j_lzl_container, [class*='lzl-wrapper']",
          ),
        )
      : [];
  for (const candidate of root.querySelectorAll(selector)) {
    if (
      nestedWrappers.length > 0 &&
      !nestedWrappers.some((wrapper) => wrapper.contains(candidate))
    ) {
      continue;
    }
    if (
      candidate.closest(
        "aside, form, [contenteditable]:not([contenteditable='false']), [class*='recommend'], [class*='advert'], [class*='manage'], [class*='moderation'], [data-ad]",
      )
    ) {
      continue;
    }
    if (
      scope === "thread" &&
      candidate.closest(
        ".pb-comment-item, .pb-lzl-item, .l_post, .lzl_single_post",
      )
    ) {
      continue;
    }
    const text = normalizedControlText(candidate.textContent);
    if (!isAllowedExpansionText(text, scope)) continue;
    const clickable = semanticClickable(candidate);
    if (!clickable || seen.has(clickable)) continue;
    if (root instanceof Element && !root.contains(clickable)) continue;
    seen.add(clickable);
    result.push(clickable);
  }
  return result;
}

/** Read the reply count shown by Tieba without looking at any reply body. */
export function declaredReplyCountFromDocument(
  document: Document,
): number | null {
  for (const element of document.querySelectorAll(
    ".pc-pb-reply-top, [class*='reply-top'], [class*='reply-header']",
  )) {
    const text = normalizedControlText(element.textContent);
    const match = text.match(/(?:全部)?回复[^\d]{0,6}(\d{1,7})/u);
    if (!match) continue;
    const count = Number(match[1]);
    if (Number.isSafeInteger(count)) return count;
  }
  return null;
}

/**
 * Build a bounded scan order. A public floor/count estimate is tried first,
 * followed by a coarse whole-list sweep so missing/deleted floors cannot make
 * the locator trust the estimate as evidence.
 */
export function evidenceScanFractions(
  floor: number | null,
  declaredReplyCount: number | null,
  uniformSteps = 12,
): number[] {
  const result: number[] = [];
  const append = (value: number) => {
    const bounded = Math.max(0, Math.min(1, value));
    if (!result.some((existing) => Math.abs(existing - bounded) < 0.001)) {
      result.push(bounded);
    }
  };

  if (
    floor !== null &&
    declaredReplyCount !== null &&
    Number.isSafeInteger(floor) &&
    Number.isSafeInteger(declaredReplyCount) &&
    floor >= 2 &&
    declaredReplyCount > 1
  ) {
    const estimate = (floor - 2) / Math.max(1, declaredReplyCount - 1);
    append(estimate);
    append(estimate - 0.025);
    append(estimate + 0.025);
  }

  const steps = Math.max(2, Math.min(40, Math.floor(uniformSteps)));
  for (let index = 0; index <= steps; index += 1) {
    append(index / steps);
  }
  return result;
}

/** Choose the stable SPA subtree whose virtual-list mutations matter. */
export function findDynamicThreadContainer(document: Document): Element | null {
  const explicit = document.querySelector(
    ".thread-container, .pc-pb-comments, .pc-pb-reply-list",
  );
  if (explicit) return explicit;

  const reply = document.querySelector(".pb-comment-item[data-id]");
  return (
    reply?.closest(".virtual-list, .pb-comment-list, [class*='thread-container']") ??
    document.querySelector(".pc-pb-reply-top")?.parentElement ??
    reply?.parentElement ??
    null
  );
}

function normalizedEvidenceText(value: string | null): string {
  return (value ?? "")
    .replace(/[\u200b-\u200d\ufeff]/gu, "")
    .replace(/[\t\r\n\u00a0 ]+/gu, " ")
    .trim();
}

export interface RuntimeNestedReplyIdState {
  byElement: WeakMap<Element, string>;
  /** Contains page text only in content-script memory and is never persisted. */
  byFingerprintOccurrence: Map<string, string>;
}

/**
 * Gives currently mounted SPA nested replies opaque per-document ids. An
 * occurrence ordinal prevents identical sibling replies from collapsing into
 * one finding while keeping remounted replies stable whenever the rendered
 * ordering is still knowable.
 */
export function assignRuntimeNestedReplyIds(
  document: Document,
  state: RuntimeNestedReplyIdState,
  createOpaqueId: () => string,
): void {
  const occurrences = new Map<string, number>();
  for (const element of document.querySelectorAll(
    ".lzl-wrapper > .pb-lzl-item",
  )) {
    const parentId =
      element.closest(".pb-comment-item[data-id]")?.getAttribute("data-id") ??
      "";
    const author = normalizedEvidenceText(
      element.querySelector(".head-name, .user-name, [class*='user-name']")
        ?.textContent ?? null,
    );
    const time = normalizedEvidenceText(
      element.querySelector(".comment-desc-left, time, [class*='time']")
        ?.textContent ?? null,
    );
    const content = normalizedEvidenceText(
      element.querySelector(".pb-rich-text")?.textContent ?? element.textContent,
    );
    const baseFingerprint = `${parentId}\u001f${author}\u001f${time}\u001f${content}`;
    const occurrence = occurrences.get(baseFingerprint) ?? 0;
    occurrences.set(baseFingerprint, occurrence + 1);
    const fingerprintOccurrence = `${baseFingerprint}\u001f${occurrence}`;

    const existing = element.getAttribute("data-kr-review-reply-id");
    if (existing) {
      state.byElement.set(element, existing);
      if (!state.byFingerprintOccurrence.has(fingerprintOccurrence)) {
        state.byFingerprintOccurrence.set(fingerprintOccurrence, existing);
      }
      continue;
    }

    let opaqueId = state.byElement.get(element);
    if (!opaqueId) {
      opaqueId = state.byFingerprintOccurrence.get(fingerprintOccurrence);
    }
    if (!opaqueId) {
      opaqueId = createOpaqueId();
      state.byFingerprintOccurrence.set(fingerprintOccurrence, opaqueId);
    }
    state.byElement.set(element, opaqueId);
    element.setAttribute("data-kr-review-reply-id", opaqueId);
  }
}

/**
 * Computes an in-memory structural signature used only inside the isolated
 * content script. Callers must not persist or transmit the returned value.
 */
export function dynamicEvidenceSignature(root: Element): string {
  const items = Array.from(
    root.querySelectorAll(
      ".image-text, .score-thread, .recruit-thread, .pb-comment-item[data-id], .lzl-wrapper > .pb-lzl-item, .show-more-lzl",
    ),
  );
  const source = items
    .map((item) => {
      const id =
        item.getAttribute("data-id") ??
        item.getAttribute("data-kr-review-reply-id") ??
        "";
      const images = Array.from(item.querySelectorAll("img"))
        .map((image) => image.getAttribute("src") ?? "")
        .join("\u001e");
      return `${item.tagName}\u001f${id}\u001f${normalizedEvidenceText(item.textContent)}\u001f${images}`;
    })
    .join("\u001d");

  // FNV-1a 64-bit. This is only a local change detector; the background gets
  // a separate random replay token rather than this content-derived value.
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= BigInt(source.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `${items.length}:${hash.toString(16).padStart(16, "0")}`;
}
