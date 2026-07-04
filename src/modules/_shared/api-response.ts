export type ApiMeta = {
  correlationId?: string;
  requestId?: string;
};

export type ApiSuccess<T> = {
  success: true;
  data: T;
  meta?: ApiMeta;
};

export type ApiErrorResponse = {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Array<{ field?: string; message: string; code?: string }>;
    correlationId?: string;
  };
};

export function ok<T>(data: T, meta?: ApiMeta): Response {
  return Response.json({ success: true, data, meta } satisfies ApiSuccess<T>);
}

export function created<T>(data: T, meta?: ApiMeta): Response {
  return Response.json({ success: true, data, meta } satisfies ApiSuccess<T>, {
    status: 201,
  });
}

export function fail(
  status: number,
  code: string,
  message: string,
  options: {
    details?: Array<{ field?: string; message: string; code?: string }>;
    correlationId?: string;
  } = {},
): Response {
  return Response.json(
    {
      success: false,
      error: {
        code,
        message,
        details: options.details,
        correlationId: options.correlationId,
      },
    } satisfies ApiErrorResponse,
    { status },
  );
}
