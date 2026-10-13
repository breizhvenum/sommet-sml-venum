# Issue tracker: local files, kept private

The task list for this project is a set of markdown files under `.scratch/`. GitHub Issues are
not used: the repository is public and the task list is not.

`.scratch` is a link to a private folder outside this repository (its own local git repository,
never pushed anywhere). It is git-ignored here. If the link is missing, ask the maintainer where
the tracker is; do not create a new one inside the repository.

## Conventions

- One topic per directory: `.scratch/<topic>/`
- One ticket per file: `.scratch/<topic>/issues/<NN>-<slug>.md`, numbered from `01` inside its topic
- A ticket is named by topic and number, for example `watch-protocol/01`
- Near the top of each ticket: a `**Status:**` line (see `triage-labels.md`) and a `**Category:**`
  line (`bug` or `enhancement`)
- A spec, when a topic has one, is `.scratch/<topic>/spec.md`
- Notes and history go at the bottom under `## Comments`, newest last, each starting with the date

## Closing a ticket

Set `**Status:** done`, and add a comment line with the date, the commit, and how it was checked
(which watch, which screen, which test). A ticket that changes what is written to a watch is not
`done` until it was checked on a real watch.

## Listing tickets

`.scratch/list.sh` prints every open ticket grouped by status. `.scratch/list.sh all` includes
the finished ones.

## After every change

Commit inside the tracker folder (`git -C .scratch add -A && git -C .scratch commit -m "..."`), so
the history shows when each ticket was opened and closed.

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<topic>/issues/` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The maintainer will normally give the topic and number.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/<effort>/map.md` (the Notes / Decisions-so-far / Fog body).
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<effort>/issues/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.
