import { WEBHOOK_EVENT_DESCRIPTIONS, WEBHOOK_EVENT_TYPES } from "@patchgrid/contracts"

/** The public event catalogue, from the same constant the app's picker reads (ADR-0050). */
export function WebhookEvents() {
  return (
    <div className="mt-6 overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th className="border-b border-border py-2 pr-4 text-left font-medium">Type</th>
            <th className="border-b border-border py-2 pr-4 text-left font-medium">Sent when</th>
          </tr>
        </thead>
        <tbody>
          {WEBHOOK_EVENT_TYPES.map((type) => (
            <tr key={type}>
              <td className="border-b border-border py-2 pr-4 align-top font-mono text-[0.85em] whitespace-nowrap">{type}</td>
              <td className="border-b border-border py-2 pr-4 align-top">{WEBHOOK_EVENT_DESCRIPTIONS[type]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
