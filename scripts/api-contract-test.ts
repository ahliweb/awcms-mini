/**
 * Contract test API terhadap server berjalan (APP_URL, default localhost:4321).
 * Memverifikasi envelope standard { success, data } pada endpoint publik.
 */

const baseUrl = (process.env.APP_URL ?? "http://localhost:4321").replace(/\/$/, "");

type Case = {
  name: string;
  path: string;
  validate: (body: Record<string, unknown>) => string | undefined;
};

const cases: Case[] = [
  {
    name: "GET /api/v1/health",
    path: "/api/v1/health",
    validate: (body) => {
      if (body.success !== true) return "success harus true";
      const data = body.data as Record<string, unknown> | undefined;
      if (data?.status !== "ok") return "data.status harus 'ok'";
      if (typeof data?.timestamp !== "string") return "data.timestamp wajib string";
      return undefined;
    }
  }
];

async function main(): Promise<void> {
  let failed = 0;
  for (const testCase of cases) {
    try {
      const response = await fetch(`${baseUrl}${testCase.path}`);
      const body = (await response.json()) as Record<string, unknown>;
      const problem =
        response.status !== 200 ? `HTTP ${response.status}` : testCase.validate(body);
      if (problem) {
        console.error(`FAIL ${testCase.name}: ${problem}`);
        failed += 1;
      } else {
        console.log(`PASS ${testCase.name}`);
      }
    } catch {
      console.error(
        `FAIL ${testCase.name}: server tidak terjangkau di ${baseUrl} — jalankan 'bun run dev' atau set APP_URL`
      );
      failed += 1;
    }
  }
  if (failed > 0) process.exitCode = 1;
}

main();
