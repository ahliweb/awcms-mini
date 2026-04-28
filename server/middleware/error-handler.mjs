/**
 * Global error handler for Hono.
 * Normalises unhandled errors into a consistent JSON error response.
 * Avoids leaking internal error details in production.
 */

const isDev = process.env.NODE_ENV !== "production";

/**
 * @param {object} [_options]
 * @returns {import('hono').ErrorHandler}
 */
export function middlewareErrorHandler(_options = {}) {
  return (error, c) => {
    const requestId = c.get("requestId") ?? null;

    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      requestId,
      event: "unhandled_error",
      message: error?.message ?? String(error),
      ...(isDev ? { stack: error?.stack } : {}),
    }));

    const status = typeof error?.status === "number" && error.status >= 400 && error.status < 600
      ? error.status
      : 500;

    return c.json(
      {
        error: {
          code: error?.code ?? "INTERNAL_ERROR",
          message: isDev ? (error?.message ?? "Internal server error.") : "Internal server error.",
          requestId,
        },
      },
      status,
    );
  };
}
