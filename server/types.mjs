/**
 * Shared type stubs for JSDoc usage across the server directory.
 * Not imported at runtime — used only for editor/tooling hints.
 *
 * @typedef {Object} RuntimeConfig
 * @property {string} databaseUrl
 * @property {string} databaseTransport
 * @property {number} databaseConnectTimeoutMs
 * @property {string} runtimeTarget
 * @property {string|null} siteUrl
 * @property {string|null} adminSiteUrl
 * @property {string|null} appSecret
 * @property {string|null} miniTotpEncryptionKey
 * @property {string} trustedProxyMode
 * @property {{ siteKey: string|null, secretKey: string|null, enabled: boolean, expectedHostnames: string[] }} turnstile
 * @property {{ mediaBucketBinding: string, mediaBucketName: string|null, maxUploadBytes: number, allowedContentTypes: string[] }} r2
 * @property {{ allowedOrigins: string[], maxBodyBytes: number, jwt: object }} edgeApi
 * @property {{ enabled: boolean, adminEntryPath: string }} adminHostRouting
 *
 * @typedef {Object} AppOptions
 * @property {RuntimeConfig} [runtimeConfig]
 */

export {};
