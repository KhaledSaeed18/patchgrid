import { Button, FallbackLink, MailLayout } from "./layout"

export type ExportReadyParams = {
  orgName: string
  /** A presigned link to the zip; it lapses with the export. */
  downloadUrl: string
  /** When the link lapses, said in words by the sender. */
  expiresOn: string
  sizeLabel: string
}

export function exportReadySubject(p: ExportReadyParams): string {
  return `Your export of ${p.orgName} is ready`
}

/**
 * To the owner who asked (ADR-0028, ADR-0044). The link is the export: it
 * works for 24 hours, then the archive is deleted. It is also in Settings
 * for as long as it lasts.
 */
export function ExportReady(p: ExportReadyParams) {
  return (
    <MailLayout preview={exportReadySubject(p)}>
      <p>
        <strong>{exportReadySubject(p)}.</strong>
      </p>
      <p>
        It is a zip of {p.sizeLabel}: every ticket, comment, asset, article, member and audit entry as newline-delimited JSON, and every
        attached file. The link works until {p.expiresOn}; after that the archive is deleted.
      </p>
      <Button href={p.downloadUrl}>Download the export</Button>
      <FallbackLink href={p.downloadUrl} />
    </MailLayout>
  )
}
