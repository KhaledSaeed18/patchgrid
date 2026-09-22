/**
 * Unauthenticated entry. Served from `app.<root>` — these routes have no tenant,
 * and `proxy.ts` sends a tenant subdomain here only to bounce it to login (M1).
 */
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return children
}
