---
"awcms-mini": patch
---

chore(modules): gate the cross-module import graph against declared `dependencies`

`bun run modules:imports:check` (`scripts/validate-module-imports.ts`) fails when
a file in `src/modules/<A>` imports at runtime from `src/modules/<B>` without
`B`'s key in `A`'s descriptor `dependencies`.

**Why a second gate when `modules:dag:check` exists.** That one is fed
`listModules()` — the hand-written `dependencies` arrays — so it validates the
DECLARED graph (self-edges, duplicates, missing keys, cycles) and is structurally
incapable of noticing an import edge that exists in the code but was never
declared. Nothing compared the two, so a module could grow a runtime dependency
and every gate stayed green.

That gap has teeth because `dependencies` is semantically load-bearing (#845,
PR #855): it drives protected-module computation, deployment-profile presets, and
the reverse-dependency guard that refuses to disable a module something else
needs. An undeclared edge means the platform can disable `B` while `A` still
calls into it at runtime — surfacing only in production, in whichever tenant
happened to disable the right module.

The invariant was **already clean** when this was written (0 undeclared edges
across 241 cross-module runtime import edges, 597 files). That is the point: the
gate locks in a good state rather than arriving with a backlog.

Three deliberate design decisions:

- **Runtime imports only.** Detection uses `Bun.Transpiler.scanImports`, which
  erases `import type` before reporting. `dependencies` governs runtime
  enablement, so a type-only import — erased at build time, unable to call
  anything — must not be forced to declare one. Requiring it would push
  contributors into adding a FALSE dependency edge purely to satisfy a gate, and
  that edge would then change protected-module/preset/reverse-dep behaviour for
  real. Verified: adding a type-only cross-module import leaves the edge count
  unchanged at 241.
- **A real parse, not a regex.** Import syntax has too many shapes (multi-line
  named, side-effect, dynamic `import()`, `export … from`) for a pattern list not
  to miss some, and a gate with silent blind spots reads as "verified" while
  proving little.
- **Directory names are resolved to descriptor keys**, by importing each
  `module.ts` and reading its own `key`, because the two genuinely diverge
  (`workflow-approval/` declares key `workflow`). A `replace("-","_")` transform
  would mis-resolve that module and then either miss its violations or invent
  some.

`_shared` is checked one-directionally: imports INTO it are always fine (the
sanctioned ADR-0011/ADR-0013 capability-port path), while `_shared` importing a
concrete module is reported as its own violation — the exact inversion #859 had
to unpick.

All four failure paths are mutation-verified (undeclared import → red; `_shared`
inversion → red; removing a genuinely-used declared dependency → red with all
three offending files listed; type-only import → still green). The rules are unit
tested as a pure function over synthetic edges, because running the gate proves
the repo is clean, not that the gate can fail — and only the second makes it a
gate. Wired into `bun run check` and `ci.yml` (the parity test requires the
explicit CI step).
