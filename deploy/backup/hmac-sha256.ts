#!/usr/bin/env bun
//
// hmac-sha256.ts — computes HMAC-SHA256 of stdin, keyed by a file whose path
// is given as the sole CLI argument (Issue #691 follow-up / PR #708 review).
//
// Why this exists: `openssl dgst -sha256 -hmac "$key"` (the previous
// implementation) requires the key's raw bytes as a literal CLI argument,
// which is visible via `ps`/`/proc/<pid>/cmdline` for the lifetime of that
// child process — openssl's `dgst`/`mac` subcommands have no `-pass file:`-
// style option the way `enc` does. Bun is already a hard dependency of this
// project (AGENTS.md rule 14), so this tiny helper reads the key directly
// from the given file path (a path is not a secret) and the message from
// stdin, with the key bytes never touching argv or an env var at all. This
// is OS-tooling-adjacent (invoked from deploy/backup/*.sh, the same way
// those scripts invoke `pg_dump`/`openssl`), not application code, so it
// does not require the Bun-exception sign-off process.
//
// Usage: printf '%s' "$message" | bun deploy/backup/hmac-sha256.ts <key-file>
// Prints the lowercase hex HMAC-SHA256 digest to stdout (no trailing
// newline requirement — callers capture it via command substitution, which
// strips trailing newlines anyway).

import { createHmac } from "node:crypto";

const keyFile = process.argv[2];
if (!keyFile) {
  console.error("hmac-sha256.ts: usage: hmac-sha256.ts <key-file> < message");
  process.exit(1);
}

// Strip trailing newline(s) only, matching bash's `$(cat key_file)` command
// substitution semantics — the same key file works identically whether read
// by this script or (previously) by a shell `$(cat ...)`.
const keyRaw = await Bun.file(keyFile).text();
const key = keyRaw.replace(/\n+$/, "");

const message = await Bun.stdin.text();

const digest = createHmac("sha256", key).update(message).digest("hex");
process.stdout.write(digest);
