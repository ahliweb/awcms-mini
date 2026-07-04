const required = ["AUTH_JWT_SECRET"];
const missing = required.filter(
  (name) =>
    !process.env[name] || process.env[name] === "change-me-in-production",
);

if (missing.length > 0) {
  console.error(
    `security readiness failed: ${missing.join(", ")} must be configured`,
  );
  process.exit(1);
}

console.log("security readiness ok");
