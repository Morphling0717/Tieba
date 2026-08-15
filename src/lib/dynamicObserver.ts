export interface MutationDebouncer {
  schedule(): void;
  cancel(): void;
}

export interface MutationDebouncerOptions {
  delayMs: number;
  readSignature: () => string;
  emit: () => void;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Debounces mutation bursts and suppresses notifications with no DOM change. */
export function createMutationDebouncer(
  options: MutationDebouncerOptions,
): MutationDebouncer {
  const setTimer =
    options.setTimer ??
    ((callback: () => void, delayMs: number) =>
      globalThis.setTimeout(callback, delayMs));
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown) => globalThis.clearTimeout(handle as number));
  let timer: unknown = null;
  let lastSignature = options.readSignature();

  return {
    schedule() {
      if (timer !== null) clearTimer(timer);
      timer = setTimer(() => {
        timer = null;
        const nextSignature = options.readSignature();
        if (nextSignature === lastSignature) return;
        lastSignature = nextSignature;
        options.emit();
      }, options.delayMs);
    },
    cancel() {
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
