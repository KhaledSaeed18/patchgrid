"use client"

import { Toaster } from "@patchgrid/ui/components/sonner"
import { TooltipProvider } from "@patchgrid/ui/components/tooltip"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useState } from "react"

import { ApiError } from "@/lib/api/errors"

import { ThemeProvider } from "./theme-provider"

/** Client-side state for the whole app: the query cache, tooltips, toasts, the theme. */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            // A 4xx is an answer, not a blip; retrying it only delays the message.
            retry: (count, error) =>
              !(error instanceof ApiError && error.status < 500) && count < 2,
          },
        },
      })
  )
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          {children}
          <Toaster position="bottom-right" />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  )
}
