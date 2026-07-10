import { describe, expect, test } from "bun:test";

import {
  determineArea,
  isApiArea
} from "../../src/modules/visitor-analytics/domain/request-area";

describe("determineArea", () => {
  test("classifies /admin/* as admin", () => {
    expect(determineArea("/admin")).toBe("admin");
    expect(determineArea("/admin/dashboard")).toBe("admin");
  });

  test("classifies /api/v1/setup/* as setup", () => {
    expect(determineArea("/api/v1/setup/initialize")).toBe("setup");
  });

  test("classifies /api/v1/auth/* as auth", () => {
    expect(determineArea("/api/v1/auth/login")).toBe("auth");
  });

  test("classifies other /api/* paths as api", () => {
    expect(determineArea("/api/v1/blog/posts")).toBe("api");
  });

  test("classifies everything else, including /login, as public", () => {
    expect(determineArea("/news/hello-world")).toBe("public");
    expect(determineArea("/login")).toBe("public");
    expect(determineArea("/")).toBe("public");
  });
});

describe("isApiArea", () => {
  test("true for api/auth/setup", () => {
    expect(isApiArea("api")).toBe(true);
    expect(isApiArea("auth")).toBe(true);
    expect(isApiArea("setup")).toBe(true);
  });

  test("false for admin/public/unknown", () => {
    expect(isApiArea("admin")).toBe(false);
    expect(isApiArea("public")).toBe(false);
    expect(isApiArea("unknown")).toBe(false);
  });
});
