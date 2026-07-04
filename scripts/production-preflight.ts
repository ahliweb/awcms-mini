const checks = [
  ["APP_ENV", process.env.APP_ENV === "production"],
  ["APP_URL", Boolean(process.env.APP_URL)],
  ["DATABASE_URL", Boolean(process.env.DATABASE_URL)],
  ["AUTH_JWT_SECRET", Boolean(process.env.AUTH_JWT_SECRET)],
];

const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length > 0) {
  console.error(`production preflight failed: ${failed.join(", ")}`);
  process.exit(1);
}

console.log("production preflight ok");
