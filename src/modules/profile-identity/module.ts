import { defineModule } from "../_shared/module-contract";

export const profileIdentityModule = defineModule({
  key: "profile_identity",
  name: "Profile Identity",
  version: "0.1.0",
  status: "experimental",
  description:
    "Canonical profile, sensitive identifier masking/dedup, contact channels, addresses, cross-module entity links, and merge requests.",
  dependencies: ["tenant_admin"]
});
