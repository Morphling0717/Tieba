export interface ClipboardEnvironment {
  navigator: {
    clipboard?: Pick<Clipboard, "writeText">;
  };
  document: Document;
}

/** Copies from extension side panels, including Tabbit builds that reject the modern API. */
export async function copyText(
  value: string,
  environment: ClipboardEnvironment = {
    navigator: globalThis.navigator,
    document: globalThis.document,
  },
): Promise<void> {
  try {
    if (!environment.navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
    await environment.navigator.clipboard.writeText(value);
    return;
  } catch (modernError) {
    const textarea = environment.document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    environment.document.body.append(textarea);
    textarea.focus();
    textarea.select();
    let copied = false;
    try {
      copied = environment.document.execCommand("copy");
    } finally {
      textarea.remove();
    }
    if (!copied) throw modernError;
  }
}
