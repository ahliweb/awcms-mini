#!/usr/bin/env bash
#
# backup-common.sh — shared helpers for backup-postgres.sh, restore-postgres.sh,
# restore-drill.sh (Issue #691, epic #679 platform-hardening).
#
# Same Bun-only exemption as backup-postgres.sh's header: this is an OS-level
# shell library wrapping Postgres client binaries (`psql`, `pg_dump`,
# `pg_restore`), `openssl`, and coreutils — not application/runtime code, so
# AGENTS.md rule 14 does not apply and no Bun-exception sign-off is needed.
#
# Meant to be `source`d, not executed directly.

BACKUP_COMMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# Secret-from-file loading
#
# Every key this project needs (backup encryption, manifest HMAC) is read
# from a FILE path given via an env var, never from the CLI or an env var
# that itself holds the key material — a positional CLI arg is visible in
# `ps`/`/proc/<pid>/cmdline` for the lifetime of the process, and an env var
# holding the secret's *content* (rather than just a path to it) persists in
# `/proc/<pid>/environ` and can leak via core dumps, `docker inspect`, process
# supervisors that log environments, etc. A path is not a secret, so it is
# fine for this to appear in argv/logs.
#
# A minimum size (32 bytes) is enforced as defense-in-depth against an
# operator typing a short passphrase directly into the key file instead of
# generating one (`openssl rand -base64 48`, as README.md instructs) — PBKDF2
# stretching (used for the encryption key) and HMAC (used for the manifest
# key) are only as strong as the key material's actual entropy.
# ---------------------------------------------------------------------------

require_secret_file() {
  local var_name="$1"
  local value="${!var_name:-}"

  if [[ -z "$value" ]]; then
    echo "$(basename "$0"): ${var_name} is not set — refusing to run. Point it at a file containing the key (see deploy/backup/README.md)." >&2
    exit 1
  fi
  if [[ ! -f "$value" ]]; then
    echo "$(basename "$0"): ${var_name}=${value} does not exist — refusing to run." >&2
    exit 1
  fi
  local size
  size="$(stat -c%s "$value")"
  if (( size < 32 )); then
    echo "$(basename "$0"): ${var_name}=${value} is only ${size} byte(s) (minimum 32) — refusing to run. This looks like a low-entropy passphrase rather than a generated key; use e.g. \`openssl rand -base64 48 > ${value}\`." >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Key-confusion guard (PR #708 review) — nothing about the two-key design
# (confidentiality key vs. authenticity key) is enforced by the tools
# themselves unless we check for it: an operator pointing both
# BACKUP_ENCRYPTION_KEY_FILE and BACKUP_HMAC_KEY_FILE at the same file would
# silently defeat the point of having two separate keys. Compare by content
# (sha256), not by path, so two different paths that happen to contain
# identical bytes are still caught.
# ---------------------------------------------------------------------------

assert_distinct_keys() {
  local encryption_key_file="$1"
  local hmac_key_file="$2"

  if [[ "$(sha256_file "$encryption_key_file")" == "$(sha256_file "$hmac_key_file")" ]]; then
    echo "$(basename "$0"): BACKUP_ENCRYPTION_KEY_FILE and BACKUP_HMAC_KEY_FILE must not be the same key (or two files with identical content) — refusing to run. Generate two separate keys (see deploy/backup/README.md)." >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Mutual-exclusion lock (Issue #691 scope item 6) — a shared lockfile in
# BACKUP_DIR so a backup and a restore (or two backups, or two restores)
# never run concurrently against the same directory. Held via an flock'd file
# descriptor for the lifetime of the CURRENT PROCESS only — a script that
# chains two of these tools as separate subprocesses (e.g. restore-drill.sh
# calling backup-postgres.sh then restore-postgres.sh) does not deadlock,
# because each subprocess acquires and releases the lock independently
# (released automatically when that subprocess exits).
# ---------------------------------------------------------------------------

acquire_lock() {
  local lock_file="$1"
  exec 200>"$lock_file"
  if ! flock -n 200; then
    echo "$(basename "$0"): another backup/restore job holds the lock (${lock_file}) — refusing to run concurrently." >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# DATABASE_URL parsing (Issue #691 scope item 4) — decodes a
# postgres://user:pass@host:port/dbname?query URL into PGHOST/PGPORT/PGUSER/
# PGPASSWORD/PGDATABASE environment variables (and PGSSLMODE if a `sslmode`
# query param is present), so callers invoke `pg_dump`/`pg_restore`/`psql`
# with NO connection string/credential positional argument at all — libpq
# picks these up from the environment. Never echoes the URL, user, or
# password. Advanced libpq URI query parameters other than `sslmode` are not
# translated; use a `.pgpass`/connection service file if you need those.
# ---------------------------------------------------------------------------

url_decode() {
  # Percent-decoding only. Do NOT also translate `+` to space here — that is
  # an `application/x-www-form-urlencoded` (query-string) convention, not
  # valid for a URI's userinfo/host/path components per RFC 3986, where `+`
  # is a legal literal character. A password generator commonly produces
  # `+`; unconditionally decoding it to space would silently corrupt
  # PGPASSWORD (and PGUSER/PGHOST/PGDATABASE) with no obvious cause (PR #708
  # review). None of this project's query-string parsing (`sslmode` below)
  # currently needs `+`-as-space decoding either, so it is simply removed,
  # not relocated.
  printf '%b' "${1//%/\\x}"
}

parse_database_url() {
  local url="$1"
  local rest="${url#*://}"
  local query=""

  if [[ "$rest" == *\?* ]]; then
    query="${rest#*\?}"
    rest="${rest%%\?*}"
  fi

  local userinfo="" hostport_path="$rest"
  if [[ "$rest" == *@* ]]; then
    userinfo="${rest%%@*}"
    hostport_path="${rest#*@}"
  fi

  local hostport="${hostport_path%%/*}"
  local dbname_enc="${hostport_path#*/}"

  local host="${hostport%%:*}"
  local port="5432"
  if [[ "$hostport" == *:* ]]; then
    port="${hostport##*:}"
  fi

  local user_enc="" pass_enc=""
  if [[ -n "$userinfo" ]]; then
    user_enc="${userinfo%%:*}"
    if [[ "$userinfo" == *:* ]]; then
      pass_enc="${userinfo#*:}"
    fi
  fi

  export PGHOST
  export PGPORT
  export PGUSER
  export PGPASSWORD
  export PGDATABASE
  PGHOST="$(url_decode "$host")"
  PGPORT="$port"
  PGUSER="$(url_decode "$user_enc")"
  PGPASSWORD="$(url_decode "$pass_enc")"
  PGDATABASE="$(url_decode "$dbname_enc")"

  if [[ "$query" == *sslmode=* ]]; then
    local sslmode="${query#*sslmode=}"
    sslmode="${sslmode%%&*}"
    export PGSSLMODE="$sslmode"
  fi
}

# ---------------------------------------------------------------------------
# Database identifier validation (Issue #691 scope item 5) — rejects any
# --target value containing characters that could break out of the
# double-quoted identifier restore-postgres.sh embeds it in (quotes,
# semicolons, backslashes, whitespace, `$`, backticks, parens, ...), or that
# starts with a digit/hyphen (ambiguous with numeric literals/CLI flags).
# Hyphens are otherwise ALLOWED (not just letters/digits/underscore) because
# this project's own databases are conventionally named with them (e.g. the
# dev DATABASE_URL's dbname is literally "awcms-mini") — an unquoted-SQL-
# identifier-only rule would reject this project's own real recovery targets.
# Max 63 bytes — NAMEDATALEN.
# ---------------------------------------------------------------------------

validate_db_identifier() {
  local name="$1"
  [[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_-]{0,62}$ ]]
}

# ---------------------------------------------------------------------------
# Checksums (Issue #691 scope item 2) — sha256 of a file, and HMAC-SHA256 of
# an arbitrary string with the key read from a file. The HMAC construction
# mirrors the `signature = HMAC(secret, "<timestamp>.<body>")` pattern
# already documented in skill `awcms-mini-sync-hmac` (docs/awcms-mini/08,
# 10) — reused here rather than inventing a new scheme, just with the
# manifest's canonical fields standing in for "<body>".
#
# HMAC-SHA256 is computed by `hmac-sha256.ts` (Bun; already a hard project
# dependency per AGENTS.md rule 14), not `openssl dgst -hmac` — openssl's
# HMAC-via-CLI has no file-based key option (unlike `enc`'s `-pass file:`),
# so it would require the raw key bytes as a literal CLI argument, visible
# via `ps`/`/proc/<pid>/cmdline` for that call's duration (PR #708 review).
# `hmac-sha256.ts` reads the key directly from the given file path (a path
# is not a secret) and the message via stdin, so the key bytes never touch
# argv or an env var at all.
# ---------------------------------------------------------------------------

sha256_file() {
  sha256sum "$1" | awk '{print $1}'
}

hmac_sha256_string() {
  local key_file="$1"
  local message="$2"
  printf '%s' "$message" | bun "${BACKUP_COMMON_DIR}/hmac-sha256.ts" "$key_file"
}
