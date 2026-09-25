export function authSessionOptions(config: { hostname: string; clientId: string; mode?: string; apiHostname?: string }) {
  const local = config.hostname === "localhost" || config.hostname === "127.0.0.1";
  // Only these synthetic staging previews may persist refresh tokens in browser storage.
  const preview = config.mode === "preview-local"
    && config.clientId === "client_01M3AAH302D3TVVDJN9SBNYARF"
    && /^pr-[0-9]+-remold-i2-preview\.shakur-949\.workers\.dev$/.test(config.hostname);
  return { devMode: local || preview, apiHostname: config.apiHostname || undefined };
}
