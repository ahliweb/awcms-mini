import { createMiddleware } from "hono/factory";

function getMaxBodyBytes(options) {
  const fromOptions = Number(options?.runtimeConfig?.edgeApi?.maxBodyBytes ?? 0);
  if (Number.isFinite(fromOptions) && fromOptions > 0) {
    return fromOptions;
  }

  const fromEnv = Number.parseInt(String(process.env.EDGE_API_MAX_BODY_BYTES ?? ""), 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }

  return 16 * 1024;
}

export function middlewareBodySizeLimit(options = {}) {
  const maxBodyBytes = getMaxBodyBytes(options);

  return createMiddleware(async (c, next) => {
    const contentLengthHeader = c.req.header("content-length");
    const contentLength = Number.parseInt(String(contentLengthHeader ?? ""), 10);

    if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
      return c.json(
        {
          error: {
            code: "PAYLOAD_TOO_LARGE",
            message: "Request body exceeds configured size limit.",
            details: {
              maxBodyBytes,
            },
          },
        },
        413,
      );
    }

    await next();
  });
}
