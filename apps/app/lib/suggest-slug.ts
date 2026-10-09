import { SLUG_MAX_LENGTH } from "@patchgrid/contracts"

/** "Acme Corp, Ltd." → "acme-corp-ltd" — a suggestion the person can edit. */
export function suggestSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/, "")
}
