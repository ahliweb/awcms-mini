---
"awcms-mini": patch
---

Gate the observability metrics documentation table against drift.

`docs/awcms-mini/observability-metrics.md` §"Cardinality and privacy review"
describes itself as an acceptance criterion: every metric the codebase emits is
supposed to be listed there with its label set and cardinality bound, so that
adding a metric forces a deliberate privacy decision. Nothing verified it, and
it had drifted to 19 of 48 declared metrics — entire families (domain events,
business scope, SoD, workflow, profile identity, organization structure, and the
new control-plane metrics) had no entry at all.

A hand-maintained table that nothing checks is a guarantee on paper only, which
is worse than no guarantee because reviewers cite it. The table is regenerated
from `METRIC_DEFINITIONS`, and `tests/unit/observability-metrics-doc-coverage.test.ts`
now enforces coverage in both directions: a declared metric with no row fails,
and a row naming a metric that no longer exists fails.

The gate deliberately checks coverage only, not prose quality — the
cardinality and privacy reasoning stays human-written. The point is that a new
metric cannot silently skip having that reasoning recorded.

Documentation and skill files are also brought back in sync with what shipped in
#932 and #930; those changes carry no runtime effect.
