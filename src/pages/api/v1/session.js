import { getDatabase } from "../../../db/index.mjs";
import { handleEdgeSessionGet, handleEdgeSessionOptions, handleEdgeSessionPost } from "../../../api/edge/session.mjs";

export const prerender = false;

export async function GET(context) {
  return handleEdgeSessionGet({ request: context.request, session: context.session, db: getDatabase() });
}

export async function POST(context) {
  return handleEdgeSessionPost({ request: context.request, session: context.session, db: getDatabase() });
}

export async function OPTIONS(context) {
  return handleEdgeSessionOptions({ request: context.request });
}
