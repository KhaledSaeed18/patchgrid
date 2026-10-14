import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { clientApi } from "@/lib/api/client"
import { failureMessage } from "@/lib/failure"

/**
 * Marking read, shared by the bell and the inbox. Both settle by refetching
 * every inbox query, so the badge and the list never disagree about a count.
 */
export function useMarkRead() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      clientApi(`/notifications/${id}/read`, {
        method: "POST",
        schema: null,
      }),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["notifications"] }),
    onError: (error) =>
      toast.error(failureMessage(error, "That wasn't marked as read.")),
  })
}

export function useMarkAllRead() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () =>
      clientApi("/notifications/read-all", { method: "POST", schema: null }),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["notifications"] }),
    onError: (error) =>
      toast.error(failureMessage(error, "Nothing was marked as read.")),
  })
}
