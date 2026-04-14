export default function miniAuthIntegration() {
  return {
    name: "awcms-mini-auth",
    hooks: {
      "astro:config:setup": ({ addMiddleware, injectRoute }) => {
        addMiddleware({
          entrypoint: new URL("../auth/middleware-entry.mjs", import.meta.url),
          order: "pre",
        });

        injectRoute({
          pattern: "/_emdash/api/auth/login",
          entrypoint: new URL("../auth/routes/login.mjs", import.meta.url),
        });
      },
    },
  };
}
