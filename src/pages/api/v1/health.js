import { handleEdgeHealthGet, handleEdgeHealthOptions } from "../../../api/edge/health.mjs";

export const prerender = false;

export async function GET(context) {
  return handleEdgeHealthGet({ request: context.request });
}

export async function OPTIONS(context) {
  return handleEdgeHealthOptions({ request: context.request });
}
