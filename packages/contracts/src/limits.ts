/**
 * Limits and sizes that more than one surface has to agree on.
 *
 * Each of these was previously a number written into prose in two or three
 * documents. A constant that exists twice is a constant that will disagree.
 */

/** Per-file attachment ceiling. The presigned PUT signs this exact length (ADR-0005). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

/**
 * MIME types accepted for upload, verified by **byte sniffing** at completion
 * rather than by the client's declared `Content-Type`.
 *
 * SVG, HTML and XHTML are absent deliberately: an SVG is a script-capable
 * document, and this product's users upload files precisely because they are
 * suspicious of them (ADR-0005).
 */
export const ALLOWED_ATTACHMENT_MIME_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/json",
  "application/zip",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]

/**
 * The subset safe to render inline. Everything else is served with
 * `Content-Disposition: attachment`, from a separate origin.
 */
export const INLINE_RENDERABLE_MIME_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]

/** How long a user may edit or delete their own comment (`RBAC.md` §6). */
export const COMMENT_EDIT_WINDOW_MINUTES = 15

/** Reopen window after `closedAt` for Incidents and Service Requests (`DOMAIN.md` §2.4). */
export const REOPEN_WINDOW_DAYS = 30

/** A `RESOLVED` ticket auto-closes after this long (`DOMAIN.md` §2.1). */
export const AUTO_CLOSE_DAYS = 7

/** Category tree depth (`DOMAIN.md` §5). */
export const MAX_CATEGORY_DEPTH = 3

/** Presigned URL lifetimes (ADR-0005). */
export const PRESIGNED_UPLOAD_TTL_SECONDS = 5 * 60
export const PRESIGNED_DOWNLOAD_TTL_SECONDS = 2 * 60

/** Slug changes are rate-limited to one per this many days, owner only. */
export const SLUG_CHANGE_COOLDOWN_DAYS = 30
/** How long the previous slug keeps redirecting. The *reservation* is permanent. */
export const SLUG_REDIRECT_DAYS = 30

/** Invitations and verification links. */
export const INVITATION_TTL_DAYS = 7
export const EMAIL_VERIFICATION_TTL_HOURS = 24

/** Maximum duration an owner may grant a support session (ADR-0020). */
export const MAX_SUPPORT_SESSION_HOURS = 72
