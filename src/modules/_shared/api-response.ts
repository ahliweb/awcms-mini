export type ApiMeta = {
  correlationId?: string;
  requestId?: string;
};

export type ApiSuccess<TData> = {
  success: true;
  data: TData;
  meta: ApiMeta;
};

export type ApiError = {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  meta: ApiMeta;
};

type JsonResponseInit = {
  status?: number;
};

export function jsonResponse<TBody>(
  body: TBody,
  init: JsonResponseInit = {}
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}

export function ok<TData>(data: TData, meta: ApiMeta = {}): Response {
  return jsonResponse<ApiSuccess<TData>>(
    {
      success: true,
      data,
      meta
    },
    { status: 200 }
  );
}

export function fail(
  status: number,
  code: string,
  message: string,
  meta: ApiMeta = {},
  details?: unknown
): Response {
  return jsonResponse<ApiError>(
    {
      success: false,
      error: {
        code,
        message,
        ...(details === undefined ? {} : { details })
      },
      meta
    },
    { status }
  );
}
