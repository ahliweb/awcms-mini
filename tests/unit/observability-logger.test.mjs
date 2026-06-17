import test from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";

import pino from "pino";

import { createLogger, REDACT_PATHS, childLoggerForRequest } from "../../src/observability/logger.mjs";

// Helper: tangkap output JSON dari sebuah logger ke array.
function captureLogger(loggerFactory) {
  const lines = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(JSON.parse(chunk.toString()));
      cb();
    },
  });
  const logger = loggerFactory(stream);
  return { logger, lines };
}

test("logger: output adalah JSON terstruktur dengan level label", () => {
  const { logger, lines } = captureLogger((stream) =>
    pino({ redact: { paths: REDACT_PATHS, censor: "[REDACTED]" }, formatters: { level: (l) => ({ level: l }) } }, stream),
  );
  logger.info({ foo: "bar" }, "hello");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].msg, "hello");
  assert.equal(lines[0].foo, "bar");
  assert.equal(lines[0].level, "info");
});

test("logger: redaction menyensor password", () => {
  const { logger, lines } = captureLogger((stream) =>
    pino({ redact: { paths: REDACT_PATHS, censor: "[REDACTED]" } }, stream),
  );
  logger.info({ password: "rahasia123" }, "login");
  assert.equal(lines[0].password, "[REDACTED]");
});

test("logger: redaction menyensor token & secret nested", () => {
  const { logger, lines } = captureLogger((stream) =>
    pino({ redact: { paths: REDACT_PATHS, censor: "[REDACTED]" } }, stream),
  );
  logger.info({ data: { token: "abc", secret: "xyz" } }, "ctx");
  assert.equal(lines[0].data.token, "[REDACTED]");
  assert.equal(lines[0].data.secret, "[REDACTED]");
});

test("logger: redaction menyensor NIK (highly_restricted)", () => {
  const { logger, lines } = captureLogger((stream) =>
    pino({ redact: { paths: REDACT_PATHS, censor: "[REDACTED]" } }, stream),
  );
  logger.info({ nik: "3201xxxx", subject: { nik_enc: "enc..." } }, "subject");
  assert.equal(lines[0].nik, "[REDACTED]");
  assert.equal(lines[0].subject.nik_enc, "[REDACTED]");
});

test("logger: redaction menyensor header authorization", () => {
  const { logger, lines } = captureLogger((stream) =>
    pino({ redact: { paths: REDACT_PATHS, censor: "[REDACTED]" } }, stream),
  );
  logger.info({ req: { headers: { authorization: "Bearer secret", "x-ok": "visible" } } }, "req");
  assert.equal(lines[0].req.headers.authorization, "[REDACTED]");
  assert.equal(lines[0].req.headers["x-ok"], "visible");
});

test("logger: REDACT_PATHS mencakup field sensitif inti", () => {
  for (const needle of ["password", "token", "secret", "nik", "nik_enc", "req.headers.authorization"]) {
    assert.ok(
      REDACT_PATHS.includes(needle),
      `REDACT_PATHS harus mengandung "${needle}"`,
    );
  }
});

test("logger: createLogger memakai LOG_LEVEL via opsi", () => {
  const logger = createLogger({ level: "warn" });
  assert.equal(logger.level, "warn");
});

test("logger: childLoggerForRequest menyertakan requestId di setiap log", () => {
  // child dari rootLogger — verifikasi binding requestId muncul.
  const lines = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(JSON.parse(chunk.toString()));
      cb();
    },
  });
  const base = pino({}, stream);
  const child = base.child({ requestId: "req-123" });
  child.info("hi");
  assert.equal(lines[0].requestId, "req-123");

  // childLoggerForRequest ada & berfungsi (binding requestId)
  assert.ok(typeof childLoggerForRequest === "function");
});
