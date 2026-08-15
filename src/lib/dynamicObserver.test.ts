import { describe, expect, it, vi } from "vitest";

import { createMutationDebouncer } from "./dynamicObserver";

describe("createMutationDebouncer", () => {
  it("coalesces a mutation burst at 750ms and suppresses an unchanged signature", () => {
    let signature = "initial";
    let nextHandle = 0;
    const scheduled = new Map<number, () => void>();
    const delays: number[] = [];
    const emit = vi.fn();
    const debouncer = createMutationDebouncer({
      delayMs: 750,
      readSignature: () => signature,
      emit,
      setTimer(callback, delayMs) {
        const handle = ++nextHandle;
        scheduled.set(handle, callback);
        delays.push(delayMs);
        return handle;
      },
      clearTimer(handle) {
        scheduled.delete(handle as number);
      },
    });

    signature = "changed";
    debouncer.schedule();
    debouncer.schedule();
    debouncer.schedule();
    expect(scheduled.size).toBe(1);
    expect(delays).toEqual([750, 750, 750]);
    [...scheduled.values()][0]!();
    scheduled.clear();
    expect(emit).toHaveBeenCalledTimes(1);

    debouncer.schedule();
    [...scheduled.values()][0]!();
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
