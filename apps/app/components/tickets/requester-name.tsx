import type { TicketSummary } from "@patchgrid/contracts"
import { Badge } from "@patchgrid/ui/components/badge"

/** A ticket's requester, badged when they are outside the workspace and reached by email only (ADR-0027 §4). */
export function RequesterName({ requester }: { requester: TicketSummary["requester"] }) {
  return (
    <>
      {requester.displayName}
      {requester.external && (
        <Badge variant="outline" className="ml-1.5" title="Outside the workspace: they write and hear back by email only">
          External
        </Badge>
      )}
    </>
  )
}
