import { OG_SIZE, OG_TYPE, ogImage } from "@/lib/og"

export const alt = "Patchgrid — the help desk that works out what matters first"
export const size = OG_SIZE
export const contentType = OG_TYPE

export default function Image() {
  return ogImage({ eyebrow: "IT service management", title: "The help desk that works out what matters first." })
}
