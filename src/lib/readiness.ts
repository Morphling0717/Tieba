import {
  inspectTiebaDocument,
  type TiebaDocumentInspection,
} from "./extractor";

export interface TiebaReadinessOptions {
  timeoutMs?: number;
  pollMs?: number;
  beforeInspect?: () => void;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}

/** Polls both partial/unknown CSR states because Tieba mounts headers first. */
export async function waitForTiebaDocumentReady(
  document: Document,
  url: string,
  options: TiebaReadinessOptions = {},
): Promise<TiebaDocumentInspection> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const pollMs = options.pollMs ?? 125;
  const now = options.now ?? Date.now;
  const wait =
    options.wait ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds)));
  const deadline = now() + timeoutMs;

  while (true) {
    options.beforeInspect?.();
    const inspection = inspectTiebaDocument(document, url);
    if (inspection.status === "ready" || now() >= deadline) return inspection;
    await wait(Math.min(pollMs, Math.max(0, deadline - now())));
  }
}
