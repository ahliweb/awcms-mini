import { describe, expect, test } from "bun:test";

import {
  isSocialPublishingDeploymentActive,
  isSocialPublishingEnabled,
  resolveSocialPublishingProfile
} from "../../src/modules/social-publishing/domain/social-publishing-config";

describe("social-publishing-config (Issue #643)", () => {
  test("defaults to disabled/inactive when both env vars are unset", () => {
    expect(isSocialPublishingEnabled({})).toBe(false);
    expect(resolveSocialPublishingProfile({})).toBe("disabled");
    expect(isSocialPublishingDeploymentActive({})).toBe(false);
  });

  test("enabled=true but profile unset/wrong is still inactive (fail-closed)", () => {
    expect(
      isSocialPublishingDeploymentActive({ SOCIAL_PUBLISHING_ENABLED: "true" })
    ).toBe(false);
    expect(
      isSocialPublishingDeploymentActive({
        SOCIAL_PUBLISHING_ENABLED: "true",
        SOCIAL_PUBLISHING_PROFILE: "disabled"
      })
    ).toBe(false);
    expect(
      isSocialPublishingDeploymentActive({
        SOCIAL_PUBLISHING_ENABLED: "true",
        SOCIAL_PUBLISHING_PROFILE: "bogus"
      })
    ).toBe(false);
  });

  test("active only when both ENABLED=true and PROFILE=full_online", () => {
    expect(
      isSocialPublishingDeploymentActive({
        SOCIAL_PUBLISHING_ENABLED: "true",
        SOCIAL_PUBLISHING_PROFILE: "full_online"
      })
    ).toBe(true);
  });

  test("profile set without enabled=true never activates", () => {
    expect(
      isSocialPublishingDeploymentActive({
        SOCIAL_PUBLISHING_PROFILE: "full_online"
      })
    ).toBe(false);
  });
});
