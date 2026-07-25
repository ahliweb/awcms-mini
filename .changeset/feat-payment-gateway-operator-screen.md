---
"awcms-mini": minor
---

Add the payment-gateway operator screen and gate the whole class of broken
sidebar links (Issue #878, epic #868).

`payment_gateway` shipped in #877 declaring a sidebar entry for
`/admin/payment-gateway` with no page behind it: an operator holding
`payment_gateway.intents.read` on a tenant that had enabled the module saw the
link and got a 404, and the module's entire read surface — provider health,
account bindings, intent status — was reachable only by calling the API by
hand. It was the only control-plane module with no admin screen at all.

The new screen is a read surface with three independently permission-gated
sections (`health.read`, `provider_accounts.read`, `intents.read`), looked up
per target tenant like the other control-plane panels. A caller holding only
one permission sees only that section, and a denied read, an empty result, and
a network failure each render distinctly rather than as the same blank panel.
Provider references (`provider_account_ref`, `provider_session_ref`) are masked
to their last four characters; signing secrets cannot appear at all, since they
are `env:` pointers the API never returns. Read-only by design — checkout,
cancel, refund request/approve, and outbox retry are high-risk mutations
requiring a reason and an idempotency key, several under maker/checker SoD and
step-up, so they stay on the API. English and Indonesian strings both added.

`tests/unit/module-navigation-path-resolves.test.ts` now fails if ANY module
declares a navigation path with no page behind it (verified red against the
missing page before it was written). No existing gate covered this:
`modules:compose:check` validates descriptor shape, the nav-registry tests
validate filtering, and the build does not care that a descriptor string looks
like a route.
