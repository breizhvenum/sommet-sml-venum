# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the
`**Status:**` strings used in this project's tickets, and says what each one means here.

| Label in mattpocock/skills | Status in our tickets | Meaning here                                                     |
| -------------------------- | --------------------- | ---------------------------------------------------------------- |
| `needs-triage`             | `needs-triage`        | Written down but not checked yet: it may already be fixed        |
| `needs-info`               | `needs-info`          | Waiting for the maintainer to decide or answer                   |
| `ready-for-agent`          | `ready-for-agent`     | Fully described; a coding assistant can do it alone              |
| `ready-for-human`          | `ready-for-human`     | Needs the maintainer: a watch plugged in, a phone, a Mac, a look |
| `wontfix`                  | `wontfix`             | Decided against                                                  |

One more status exists only here: `done` (see `issue-tracker.md`, "Closing a ticket").

Before moving a `needs-triage` ticket forward, search the code for the fix (`git log -S`, grep),
not only the commit messages: old tasks in this project have turned out to be fixed already.
