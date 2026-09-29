export function authSessionOptions(config: { hostname: string; clientId: string; mode?: string; apiHostname?: string }) {
  const local = config.hostname === "localhost" || config.hostname === "127.0.0.1";
  const staging = config.clientId === "client_01M3AAH302D3TVVDJN9SBNYARF";
  // Only these synthetic staging previews may persist refresh tokens in browser storage.
  const preview = config.mode === "preview-local" && staging
    && /^pr-[0-9]+-remold-i2-preview\.shakur-949\.workers\.dev$/.test(config.hostname);
  // Interim live site on the staging realm: staging has no first-party auth domain,
  // so the refresh token lives in browser storage until a production client exists.
  const interim = config.mode === "staging-live" && staging && config.hostname === "app.remoldcrm.com";
  return { devMode: local || preview || interim, apiHostname: config.apiHostname || undefined };
}
