import { defineModule } from "../_shared/module-contract";

export const profileIdentityModule = defineModule({
  key: "profile_identity",
  name: "Profile Identity",
  version: "1.0.0",
  status: "active",
  description:
    "Canonical profile, sensitive identifier masking/dedup, contact channels, addresses, cross-module entity links, and merge requests.",
  dependencies: ["tenant_admin"]
});
