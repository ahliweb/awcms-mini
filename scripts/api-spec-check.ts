import { access, readFile } from "node:fs/promises";

const requiredFiles = [
  "openapi/awcms-mini-public-api.openapi.yaml",
  "asyncapi/awcms-mini-domain-events.asyncapi.yaml",
];

for (const file of requiredFiles) {
  await access(file);
  const text = await readFile(file, "utf8");
  if (!text.includes("awcms-mini")) {
    throw new Error(`${file} must identify awcms-mini`);
  }
}

console.log("api specs ok");
