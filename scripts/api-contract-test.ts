const response = await fetch("http://localhost:4321/api/v1/health").catch(
  () => null,
);

if (!response) {
  console.log("api contract test skipped: dev server is not running");
  process.exit(0);
}

if (!response.ok) {
  throw new Error(`health endpoint failed: ${response.status}`);
}

const body = await response.json();
if (body?.success !== true || body?.data?.service !== "awcms-mini") {
  throw new Error("health endpoint contract mismatch");
}

console.log("api contract ok");

export {};
