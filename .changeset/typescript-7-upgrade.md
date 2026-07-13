---
"awcms-mini": patch
---

Bump `typescript` devDependency from 6.0.3 to 7.0.2 (Dependabot). Also
fixes a real typecheck regression the upgrade surfaced:
`scripts/lib/docs-checks.mjs`'s `checkMermaid` JSDoc comment contained an
unescaped literal triple-backtick (`` ```mermaid ``) with no matching
close before the comment's `@param` tags. TypeScript 7's stricter JSDoc
parser toggles an internal "inside a fenced code block" state on any raw
run of 3+ backticks; the unmatched opener left it toggled on for the rest
of the comment, silently swallowing the following `@param` tags and
turning `file`/`lines` into implicit `any` (`TS7006`). Reworded the
comment to avoid backticks entirely rather than relying on a
backtick-count-parity escape, since parity is fragile and easy to break
again silently. No runtime behavior change.
