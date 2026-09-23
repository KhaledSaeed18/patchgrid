import { JetBrains_Mono, Open_Sans, Source_Serif_4 } from "next/font/google"

import { cn } from "cn"

// One definition for every Next.js app. Each sets the CSS variable that
// globals.css maps into Tailwind's font-sans / font-serif / font-mono.
const fontSans = Open_Sans({ subsets: ["latin"], variable: "--font-sans" })
const fontSerif = Source_Serif_4({
  subsets: ["latin"],
  variable: "--font-serif",
})
const fontMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" })

export const fontVariables = cn(
  fontSans.variable,
  fontSerif.variable,
  fontMono.variable
)
