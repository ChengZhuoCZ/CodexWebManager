(() => {
  // The desktop bundle waits on best-effort experiment/telemetry
  // initialization. A private Tailnet browser cannot reach those endpoints in
  // every environment, so terminate only the exact non-provider POST routes
  // locally instead of waiting on network failure. Model, account, and App
  // Server requests are unaffected.
  const upstreamFetch =
    typeof globalThis.fetch === "function"
      ? globalThis.fetch.bind(globalThis)
      : null;
  if (upstreamFetch === null) {
    return;
  }

  const localBody = (url) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (
      parsed.protocol === "https:" &&
      parsed.hostname === "ab.chatgpt.com" &&
      parsed.pathname === "/v1/initialize"
    ) {
      return {
        dynamic_configs: {},
        feature_gates: {},
        has_updates: true,
        layer_configs: {},
        param_stores: {},
        time: 1,
      };
    }
    if (
      parsed.protocol === "https:" &&
      ((parsed.hostname === "ab.chatgpt.com" &&
        parsed.pathname === "/v1/rgstr") ||
        (parsed.hostname === "chatgpt.com" &&
          parsed.pathname === "/ces/v1/rgstr"))
    ) {
      return {};
    }
    return null;
  };

  globalThis.fetch = (input, init) => {
    const method = String(
      init?.method ??
        (typeof input === "object" && input !== null ? input.method : "GET"),
    ).toUpperCase();
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input?.url;
    const body = method === "POST" ? localBody(url) : null;
    if (body !== null) {
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
          },
        }),
      );
    }
    return upstreamFetch(input, init);
  };
})();
