import { Placeholder } from "@/components/placeholder"

export default function WorkspacesPage() {
  return (
    <Placeholder surface="workspace picker" milestone="M1">
      Lists the workspaces this account belongs to. Choosing one mints a cookie
      pair bound to that organization and redirects to its subdomain; existing
      pairs are left alone, which is what lets two workspaces stay open at once.
    </Placeholder>
  )
}
