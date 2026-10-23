/**
 * Liveness for the load balancer's health check (ADR-0058): the server is up
 * and answering. It reads nothing, so a slow API never takes the frontends out
 * of rotation; the API's own readiness check covers what it depends on.
 * Outside the proxy's matcher, so a probe that arrives with the task's address
 * as its Host is not routed as a workspace.
 */
export function GET(): Response {
  return Response.json({ status: "ok" })
}
