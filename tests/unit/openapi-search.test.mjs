import test from "node:test";
import assert from "node:assert/strict";

import { routeOpenApi } from "../../server/routes/openapi.mjs";

async function getOpenApiDoc() {
  const app = routeOpenApi();
  const res = await app.fetch(new Request("http://localhost/openapi.json"));
  assert.equal(res.status, 200);
  return res.json();
}

test("openapi: mendokumentasikan 3 endpoint search (users/sikesra/satusehat)", async () => {
  const doc = await getOpenApiDoc();
  assert.ok(doc.paths["/api/v1/search/users"]?.get, "path search/users harus ada");
  assert.ok(doc.paths["/api/v1/search/sikesra/subjects"]?.get, "path search/sikesra harus ada");
  assert.ok(doc.paths["/api/v1/search/satusehat/patients"]?.get, "path search/satusehat harus ada");
});

test("openapi: endpoint search ber-tag 'search' + security bearerAuth + 403", async () => {
  const doc = await getOpenApiDoc();
  const op = doc.paths["/api/v1/search/users"].get;
  assert.ok(op.tags.includes("search"));
  assert.deepEqual(op.security, [{ bearerAuth: [] }]);
  assert.ok(op.responses["403"], "harus dokumentasikan 403 (permission denied)");
  assert.ok(op.responses["200"], "harus dokumentasikan 200");
});

test("openapi: endpoint search punya parameter q/page/pageSize/sort", async () => {
  const doc = await getOpenApiDoc();
  const names = doc.paths["/api/v1/search/users"].get.parameters.map((p) => p.name);
  for (const n of ["q", "page", "pageSize", "sortField", "sortDir"]) {
    assert.ok(names.includes(n), `parameter ${n} harus ada`);
  }
});

test("openapi: schema SearchEnvelope terdefinisi (items/page/total)", async () => {
  const doc = await getOpenApiDoc();
  const schema = doc.components.schemas.SearchEnvelope;
  assert.ok(schema, "SearchEnvelope harus terdefinisi");
  const dataProps = schema.properties.data.properties;
  for (const k of ["items", "page", "pageSize", "total"]) {
    assert.ok(dataProps[k], `SearchEnvelope.data.${k} harus ada`);
  }
});

test("openapi: tag 'search' terdaftar", async () => {
  const doc = await getOpenApiDoc();
  assert.ok(doc.tags.some((t) => t.name === "search"), "tag search harus terdaftar");
});
