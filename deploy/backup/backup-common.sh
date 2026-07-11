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
  if [[ ! -s "$value" ]]; then
    echo "$(basename "$0"): ${var_name}=${value} is empty — refusing to run." >&2
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
  local data="${1//+/ }"
  printf '%b' "${data//%/\\x}"
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
# Residual risk (documented, not silently accepted): the HMAC key's bytes
# are read into a shell variable and passed to `openssl dgst -hmac`, so they
# appear briefly in that one child process's argv (visible via
# /proc/<pid>/cmdline to the same user/root only, for the duration of that
# single call). This is a materially smaller exposure than the issue this
# ticket fixes (a full DATABASE_URL sitting in `pg_dump`/`pg_restore`/`psql`
# argv for the whole dump/restore duration, plus shell history/cron logs) —
# openssl's HMAC-via-CLI has no file-based key option (unlike `-pass file:`
# for `enc`), and hand-rolling HMAC's key-padding/XOR construction in bash to
# avoid it would add untested bespoke crypto code, which is a worse trade.
# ---------------------------------------------------------------------------

sha256_file() {
  sha256sum "$1" | awk '{print $1}'
}

hmac_sha256_string() {
  local key_file="$1"
  local message="$2"
  local key
  key="$(cat "$key_file")"
  printf '%s' "$message" | openssl dgst -sha256 -hmac "$key" -r | awk '{print $1}'
}
