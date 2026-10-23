/**
 * HSTS, at its first stage (DNS.md §HSTS). `includeSubDomains` on a shared
 * parent is effectively irreversible within the max-age, so it ships short and
 * is raised once every tenant host is known to serve TLS; `preload` comes last.
 * The API and both frontends send it whenever they are served over HTTPS, so it
 * holds behind any proxy, whether or not the edge can add headers (ADR-0058).
 */
export const HSTS_MAX_AGE_SECONDS = 86_400

export const STRICT_TRANSPORT_SECURITY = `max-age=${String(HSTS_MAX_AGE_SECONDS)}; includeSubDomains`
