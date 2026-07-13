/**
 * Resolves an opaque `token_reference`-shaped string to a real credential
 * value (Issue #644). Issue #643's own foundation is explicit that this
 * resolution "is each adapter's own responsibility... e.g. read an env var
 * named after the reference, or call a real secret manager" — this repo
 * has NO real secret-manager integration today (documented residual,
 * `.claude/skills/awcms-mini-social-publishing/SKILL.md` §643), so this
 * file implements the ONE concretely-supported convention: an
 * `env:VAR_NAME` reference reads `process.env.VAR_NAME`. Any other
 * reference scheme (`secretsmanager:`, `vault:`, `kms:`, `ssm:` — all
 * accepted as REFERENCE shapes by the write-time validator,
 * `social-account-validation.ts`'s `looksLikeRawSecretToken`) is
 * recognized as a valid-shaped reference but NOT resolvable by this
 * deployment — returns `null` (fails closed) rather than throwing, exactly
 * like every other "cannot proceed" branch in this adapter (a missing
 * secret-manager integration must degrade to `needs_reauth`/`failed`, never
 * crash the dispatcher or leak partial state).
 *
 * Used for BOTH an account's `token_reference` (the Page/Instagram access
 * token) and `META_APP_SECRET_REFERENCE` (the app secret, needed for
 * `appsecret_proof`-style calls) — same resolution convention, same
 * function, kept intentionally LOCAL to this Meta module rather than
 * promoted to a shared foundation file (Issue #643's own guidance: token
 * resolution is each adapter's own responsibility — #645/#646 may
 * implement their own copy, a known, accepted, documented duplication
 * tradeoff to avoid a 3-way merge conflict in a shared file this epic's
 * parallel adapter issues would otherwise all need to touch).
 */
const ENV_REFERENCE_PATTERN = /^env:([A-Za-z_][A-Za-z0-9_]*)$/;

export type MetaResolvedCredential = {
  value: string;
};

/**
 * Never throws. Returns `null` for: a reference that isn't `env:`-shaped
 * (unsupported scheme in this deployment), an `env:` reference whose named
 * variable is unset/empty, or malformed input.
 */
export function resolveMetaTokenReference(
  tokenReference: string,
  env: NodeJS.ProcessEnv = process.env
): MetaResolvedCredential | null {
  const match = ENV_REFERENCE_PATTERN.exec(tokenReference);

  if (!match) {
    return null;
  }

  const variableName = match[1]!;
  const value = env[variableName];

  if (!value || value.trim().length === 0) {
    return null;
  }

  return { value };
}
