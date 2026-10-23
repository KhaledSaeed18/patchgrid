/**
 * The knowledge base a new workspace starts with (TENANCY.md §4, ADR-0017):
 * a few articles an IT desk would write first, so the portal is not empty on
 * day one and admins have something to edit rather than a blank page. Each
 * names the default category it belongs under (`DEFAULT_CATEGORIES`), and
 * counts against the plan's articles like any other.
 */
export type StarterArticle = {
  slug: string
  title: string
  visibility: "PUBLISHED" | "INTERNAL"
  /** A top-level default category, by name. */
  category: string | null
  body: string
}

export const STARTER_ARTICLES: readonly StarterArticle[] = [
  {
    slug: "how-to-raise-a-ticket",
    title: "How to raise a ticket",
    visibility: "PUBLISHED",
    category: null,
    body: `Raise a ticket for anything the IT team should know about or do for you.

## Something is broken

Choose **Incident**. Say what you were doing, what you expected and what happened instead. A screenshot
or the exact error message saves a round trip.

## You need something

Choose **Service request** for anything standard: a new laptop, access to a system, a shared mailbox.

## How urgent is it?

You will be asked two questions: **who is affected** (just you, your team, or everyone) and **how much it
gets in your way**. The priority is worked out from those two answers, so answer them honestly — every
deadline follows from it.

## Following it up

You can reply from the ticket page, or simply reply to any email about the ticket. Your reply lands on the
ticket, and the team sees it.`,
  },
  {
    slug: "what-the-priorities-mean",
    title: "What the priorities mean",
    visibility: "PUBLISHED",
    category: null,
    body: `Every incident and service request gets a priority from two answers: how many people are
affected, and how badly.

| | Gets in the way a little | Slowing you down | You can't work |
| --- | --- | --- | --- |
| **Just you** | Low | Low | Medium |
| **Your team** | Low | Medium | High |
| **Everyone** | Medium | High | Critical |

The priority sets two deadlines: when someone first responds, and when it should be resolved. While a
ticket waits on you — for an answer or a test — the resolution clock pauses.`,
  },
  {
    slug: "reporting-a-suspicious-email",
    title: "Reporting a suspicious email",
    visibility: "PUBLISHED",
    category: "Security",
    body: `If an email asks you to sign in, pay, open an attachment you were not expecting, or act
urgently, treat it as suspicious.

1. **Do not** click its links, open its attachments or reply to it.
2. Raise an **Incident** under **Security → Phishing**, saying who it came from and when it arrived.
3. If you already clicked or typed a password, say so in the ticket and change that password now.
   Telling us quickly matters far more than having been careful.

The Security team will tell you whether it was genuine.`,
  },
  {
    slug: "working-the-queue",
    title: "Working the queue",
    visibility: "INTERNAL",
    category: null,
    body: `*For agents.* How the queue decides what comes first.

- **Priority is computed**, from impact and urgency, never typed in. If it looks wrong, correct the
  impact or urgency — and say why in an internal note.
- **The response clock** stops at the first public reply from an agent, or when the ticket is resolved.
  An internal note does not stop it.
- **The resolution clock** pauses while a ticket waits on the requester, and restarts from the reopen if
  a resolved ticket comes back.
- **Breaches** are flagged on the ticket and tell the assignee, the team lead and the admins.

Take a ticket before you start on it, so nobody else does the same work.`,
  },
]
