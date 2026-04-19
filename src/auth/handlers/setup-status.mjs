function parseJsonBoolean(value) {
  if (typeof value !== "string") {
    return false;
  }

  try {
    const parsed = JSON.parse(value);
    return parsed === true || parsed === "true";
  } catch {
    return false;
  }
}

export async function handleSetupStatus({ db }) {
  let setupCompleteValue = null;
  let setupStateValue = null;
  let hasUsers = false;

  try {
    const setupComplete = await db
      .selectFrom("options")
      .select("value")
      .where("name", "=", "emdash:setup_complete")
      .executeTakeFirst();
    setupCompleteValue = setupComplete?.value ?? null;

    const setupState = await db
      .selectFrom("options")
      .select("value")
      .where("name", "=", "emdash:setup_state")
      .executeTakeFirst();
    setupStateValue = setupState?.value ?? null;
  } catch {
    // Fresh environments may not have the options table yet.
  }

  try {
    const userCount = await db
      .selectFrom("users")
      .select((expressionBuilder) => expressionBuilder.fn.countAll().as("count"))
      .executeTakeFirstOrThrow();
    hasUsers = Number(userCount.count ?? 0) > 0;
  } catch {
    // Fresh environments may not have the users table yet.
  }

  const isComplete = parseJsonBoolean(setupCompleteValue);

  if (isComplete && hasUsers) {
    return Response.json(
      {
        data: {
          needsSetup: false,
        },
      },
      {
        status: 200,
        headers: {
          "Cache-Control": "private, no-store",
        },
      },
    );
  }

  let step = "start";

  if (setupStateValue) {
    try {
      const state = JSON.parse(setupStateValue);
      if (state?.step === "admin") {
        step = "admin";
      } else if (state?.step === "site" || state?.step === "site_complete") {
        step = "admin";
      }
    } catch {
      // Ignore invalid stored setup state.
    }
  }

  if (isComplete && !hasUsers) {
    step = "admin";
  }

  return Response.json(
    {
      data: {
        needsSetup: true,
        step,
        seedInfo: null,
        authMode: "passkey",
      },
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store",
      },
    },
  );
}
