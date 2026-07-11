import { defineModule } from "../_shared/module-contract";

export const profileIdentityModule = defineModule({
  key: "profile_identity",
  name: "Profile Identity",
  version: "1.0.0",
  status: "active",
  description:
    'Canonical profile, sensitive identifier masking/dedup, contact channels, addresses, cross-module entity links, and merge requests. `dependencies: ["tenant_admin"]` was already correct (Issue #680, epic #679) — the registry-wide 3-cycle this issue fixed came entirely from `tenant_admin` ALSO listing `profile_identity`/`identity_access` as its own dependencies (removed there), not from this module\'s own array.',
  dependencies: ["tenant_admin"]
});
