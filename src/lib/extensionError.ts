import type { ExtensionErrorCode } from "../messages";

export class ExtensionOperationError extends Error {
  constructor(
    message: string,
    public readonly code: ExtensionErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ExtensionOperationError";
  }
}

function originalMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "";
}

export function normalizeExtensionError(
  error: unknown,
  fallbackCode: ExtensionErrorCode = "UNKNOWN",
): ExtensionOperationError {
  if (error instanceof ExtensionOperationError) return error;
  const message = originalMessage(error);

  if (
    /chrome:\/\/|edge:\/\/|tabbit:\/\/|extensions gallery|web store|restricted page/iu.test(
      message,
    )
  ) {
    return new ExtensionOperationError(
      "当前页面属于浏览器受限页面，扩展无法读取；请回到百度贴吧帖子后再试。",
      "RESTRICTED_PAGE",
      { cause: error },
    );
  }

  if (
    /cannot access contents|must request permission|missing host permission|not allowed to access|host permission/iu.test(
      message,
    )
  ) {
    return new ExtensionOperationError(
      "未获得百度贴吧页面读取权限。请在扩展管理页重新加载当前版本，并允许访问 tieba.baidu.com。",
      "TIEBA_PERMISSION_MISSING",
      { cause: error },
    );
  }

  if (fallbackCode === "SCRIPT_INJECTION_FAILED") {
    return new ExtensionOperationError(
      "无法把审阅脚本注入当前页面，请刷新贴吧帖子后重试。",
      fallbackCode,
      { cause: error },
    );
  }

  if (fallbackCode === "TIEBA_READ_API_RATE_LIMITED") {
    return new ExtensionOperationError(
      "贴吧暂时限制了只读请求，请稍后手动重试；扩展不会自动重发。",
      fallbackCode,
      { cause: error },
    );
  }

  if (fallbackCode === "TIEBA_READ_API_RESPONSE_INVALID") {
    return new ExtensionOperationError(
      "贴吧只读接口的返回结构已变化，已停止整帖读取以避免漏判。",
      fallbackCode,
      { cause: error },
    );
  }

  if (fallbackCode === "CAPTURE_CANCELLED") {
    return new ExtensionOperationError(
      "页面已切换或开始重新加载，本次整帖读取已取消。",
      fallbackCode,
      { cause: error },
    );
  }

  return new ExtensionOperationError(
    message || "扩展操作失败",
    fallbackCode,
    { cause: error },
  );
}
