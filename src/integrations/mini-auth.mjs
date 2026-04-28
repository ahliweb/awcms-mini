export default function miniAuthIntegration() {
  return {
    name: "awcms-mini-auth",
    hooks: {
      "astro:config:setup": ({ addMiddleware }) => {
        addMiddleware({
          entrypoint: new URL("../auth/middleware-entry.mjs", import.meta.url),
          order: "pre",
        });
      },
    },
  };
}
