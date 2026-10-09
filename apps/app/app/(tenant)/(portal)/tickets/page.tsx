import { Placeholder } from "@/components/placeholder"

export default function PortalTicketsPage() {
  return (
    <Placeholder surface="portal" milestone="M2">
      My tickets, and the form that raises one. Note what is <em>not</em> on
      that form: a priority field. Priority is computed from impact × urgency,
      and a client that sends one gets a 400 (`docs/DOMAIN.md` §3).
    </Placeholder>
  )
}
