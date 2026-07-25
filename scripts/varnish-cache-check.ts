/**
 * `bun run varnish:cache:check` — behavioural verification of the edge cache.
 *
 * Compiling `deploy/varnish/default.vcl` proves only that it parses. What
 * actually matters is whether the cache ISOLATES: that two tenants never share
 * an entry, that two users of one tenant never share an entry, and that a
 * response the app marked `no-store` is never stored at all. Those are
 * properties of the running cache, not of the file, so this script starts a
 * real Varnish against a stub backend and asserts them over HTTP.
 *
 * It is NOT part of `bun run check`: it needs Docker and pulls the Varnish
 * image, the same reason the Playwright E2E suite is its own step. Run it
 * whenever `default.vcl` changes — the VCL has no type checker and no compiler
 * warning for "this key is missing a dimension", so a review that only reads
 * the diff cannot catch the one bug that matters.
 *
 * Every assertion here was mutation-verified when it was written: deleting the
 * session component from `vcl_hash` makes the per-user isolation case fail with
 * user B receiving user A's cached page.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const VARNISH_IMAGE = "varnish:7.6";
const CONTAINER = "awcms-mini-varnish-cache-check";
const EDGE_PORT = 6081;
const BACKEND_PORT = 4399;

type Case = {
  name: string;
  /** `same` = the two requests must return the SAME body (a cache hit). */
  expect: "same" | "different";
  a: () => Promise<string>;
  b: () => Promise<string>;
};

function run(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "ignore" });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), "awcms-varnish-check-"));

  // The committed VCL points at the compose service name `app`, which does not
  // resolve outside the compose network. Rewriting only the backend address
  // keeps every rule under test byte-identical to what ships.
  const vcl = readFileSync("deploy/varnish/default.vcl", "utf8")
    .replace('.host = "app";', '.host = "127.0.0.1";')
    .replace('.port = "4321";', `.port = "${BACKEND_PORT}";`);
  const vclPath = join(workDir, "test.vcl");
  writeFileSync(vclPath, vcl);

  let requestCount = 0;
  const backend = Bun.serve({
    port: BACKEND_PORT,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      requestCount += 1;
      const headers = new Headers({ "Content-Type": "text/plain" });

      if (url.pathname === "/public") {
        headers.set("Cache-Control", "public, max-age=60");
      } else if (url.pathname === "/session") {
        headers.set("Cache-Control", "private, no-store");
        headers.set("X-AWCMS-Edge-Cache", "session; max-age=30");
      } else if (url.pathname === "/setcookie") {
        headers.set("Cache-Control", "private, no-store");
        headers.set("X-AWCMS-Edge-Cache", "session; max-age=30");
        headers.set("Set-Cookie", "awcms_mini_session=fixture; Path=/");
      } else {
        headers.set("Cache-Control", "private, no-store");
      }

      // A unique body per backend hit is what makes a cache hit observable:
      // identical bodies mean the edge answered, different bodies mean it did
      // not.
      return new Response(`body-${requestCount}`, { headers });
    }
  });

  await run("docker", ["rm", "-f", CONTAINER]);
  const started = await run("docker", [
    "run",
    "-d",
    "--name",
    CONTAINER,
    "--network",
    "host",
    "-v",
    `${vclPath}:/etc/varnish/default.vcl:ro`,
    VARNISH_IMAGE,
    "varnishd",
    "-F",
    "-a",
    `:${EDGE_PORT}`,
    "-f",
    "/etc/varnish/default.vcl",
    "-s",
    "malloc,64m"
  ]);

  if (started !== 0) {
    backend.stop();
    rmSync(workDir, { recursive: true, force: true });
    console.error("varnish:cache:check FAILED — could not start Varnish.");
    process.exit(1);
  }

  // Varnish forks a child; requests before it is ready fail with a 503 that
  // would read as a test failure rather than a startup race.
  await sleep(5000);

  async function get(
    host: string,
    path: string,
    cookie?: string,
    method = "GET"
  ): Promise<string> {
    const headers: Record<string, string> = { Host: host };
    if (cookie) headers.Cookie = cookie;
    const response = await fetch(`http://127.0.0.1:${EDGE_PORT}${path}`, {
      method,
      headers
    });
    return response.text();
  }

  const cases: Case[] = [
    {
      name: "public GET is cached and shared between anonymous visitors",
      expect: "same",
      a: () => get("t1.example.com", "/public"),
      b: () => get("t1.example.com", "/public")
    },
    {
      name: "a different Host never shares an entry (tenant isolation)",
      expect: "different",
      a: () => get("t1.example.com", "/public"),
      b: () => get("t2.example.com", "/public")
    },
    {
      name: "a different locale cookie never shares an entry",
      expect: "different",
      a: () => get("t1.example.com", "/public", "awcms_mini_locale=id"),
      b: () => get("t1.example.com", "/public", "awcms_mini_locale=en")
    },
    {
      name: "a session-marked GET is cached for the same session",
      expect: "same",
      a: () => get("t1.example.com", "/session", "awcms_mini_session=userA"),
      b: () => get("t1.example.com", "/session", "awcms_mini_session=userA")
    },
    {
      name: "a different session never shares an entry (per-user isolation)",
      expect: "different",
      a: () => get("t1.example.com", "/session", "awcms_mini_session=userA"),
      b: () => get("t1.example.com", "/session", "awcms_mini_session=userB")
    },
    {
      name: "a no-store response is never cached",
      expect: "different",
      a: () => get("t1.example.com", "/private"),
      b: () => get("t1.example.com", "/private")
    },
    {
      name: "a Set-Cookie response is never cached even when marked cacheable",
      expect: "different",
      a: () => get("t1.example.com", "/setcookie", "awcms_mini_session=userA"),
      b: () => get("t1.example.com", "/setcookie", "awcms_mini_session=userA")
    },
    {
      name: "the health endpoint is never cached",
      expect: "different",
      a: () => get("t1.example.com", "/api/v1/health"),
      b: () => get("t1.example.com", "/api/v1/health")
    },
    {
      name: "POST is never cached",
      expect: "different",
      a: () => get("t1.example.com", "/public", undefined, "POST"),
      b: () => get("t1.example.com", "/public", undefined, "POST")
    }
  ];

  let failures = 0;
  for (const testCase of cases) {
    const first = await testCase.a();
    const second = await testCase.b();
    const same = first === second;
    const ok = testCase.expect === "same" ? same : !same;

    if (ok) {
      console.log(`  OK    ${testCase.name}`);
    } else {
      failures += 1;
      console.error(
        `  FAIL  ${testCase.name} (expected ${testCase.expect}, got "${first}" / "${second}")`
      );
    }
  }

  // The private signalling must never reach a client: `X-AWCMS-Edge-Cache`
  // would advertise which authenticated routes are cached, and the rest
  // discloses edge topology.
  const leakResponse = await fetch(`http://127.0.0.1:${EDGE_PORT}/session`, {
    headers: { Host: "t1.example.com", Cookie: "awcms_mini_session=userA" }
  });
  for (const header of [
    "x-awcms-edge-cache",
    "x-cache-host",
    "x-cache-url",
    "x-varnish",
    "via"
  ]) {
    if (leakResponse.headers.has(header)) {
      failures += 1;
      console.error(`  FAIL  internal header leaked to the client: ${header}`);
    } else {
      console.log(`  OK    internal header stripped: ${header}`);
    }
  }

  await run("docker", ["rm", "-f", CONTAINER]);
  backend.stop();
  rmSync(workDir, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`\nvarnish:cache:check GAGAL — ${failures} temuan.`);
    process.exit(1);
  }
  console.log(
    "\nvarnish:cache:check OK — isolasi tenant, sesi, dan locale terbukti."
  );
}

await main();
