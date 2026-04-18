import { getDatabase } from "../../../db/index.mjs";
import { handleEdgeTokenOptions, handleEdgeTokenPost } from "../../../api/edge/token.mjs";

export const prerender = false;

export async function POST(context) {
  return handleEdgeTokenPost({ request: context.request, db: getDatabase() });
}

export async function OPTIONS(context) {
  return handleEdgeTokenOptions({ request: context.request });
}
