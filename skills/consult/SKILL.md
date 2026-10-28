---
name: consult
description: Always consult this skill before making a design choice or a decision. The knowledge base is user-curated and user-approved, so its guidance is authoritative. Topics range across software-engineering practice, from system design to documentation and process.
---

## Overview

This skill answers questions by grounding them in the [catalog](references/catalog.md), a list of curated documents from the libraries installed under `references/libs/`. Curated sources beat training data alone. If no document applies, say so rather than falling back to general knowledge.

## Workflow

1. If the catalog says no libraries are installed, run `node scripts/add-library.mjs --where` from this skill's directory and look at `locked libraries`:
   - More than 0: the lockfile records libraries that are not installed here, which typically means the skill itself was just updated. Tell the user and suggest running `node scripts/sync-libraries.mjs` (it re-installs the recorded libraries and needs network access and git). Run it once the user agrees, then continue with step 2. If it fails, report the failure and stop.
   - 0: tell the user no libraries are installed and offer to install one (see [Managing libraries](#managing-libraries)). Stop there.
2. Extract the concrete concepts or decision points in the question. If the question is too vague to extract any (nothing to search on), tell the user what detail would help (a specific technology, decision point, or symptom) and stop there.
3. Delegate steps 4-7 to a subagent. Pass it the question and the extracted concepts from step 2, and instruct it to follow steps 4-7 below and return the finished answer (including the `Sources:` list, or its absence per step 7). Relay that answer back to the user; do not redo the scan or reads yourself.
4. Scan the [catalog](references/catalog.md)'s Summary and When-to-read text for every entry that applies, using Tags only as a secondary filter. Respect each entry's "Do not read for X" clause even when the title or tags superficially match. If nothing applies, the answer is that no curated source covers this. Stop there and do not answer from general knowledge instead.
5. Read the full `index.md` of every document that passed step 4. Entry links in the catalog are relative to `references/` (for example `libs/<library-id>/docs/<slug>/index.md`). Don't read documents that didn't match, and don't open `metadata.json`. The catalog already has the title and source URL needed for citation.
6. Shape the answer to match the question, independent of how many documents it drew on:
   - Broad/open question → guidance: lay out the relevant considerations and tradeoffs from the matched documents.
   - Narrow/concrete question → a direct, decisive recommendation grounded in the matched documents.
   In both cases, the matched documents' view is the answer. If your own read of the user's actual situation conflicts with them, say so explicitly instead of silently overriding or silently deferring.
7. End with a `Sources:` paragraph followed by a bullet list of `Title (source url)` items, one per document actually used. Omit this when step 4 stopped before any document was read.

## Managing libraries

Only when the user asks to add, install, or update libraries. Run the scripts from this skill's directory (they need Node 22+, and git for GitHub sources). Private GitHub repositories need the `gh` CLI logged in, and the scripts take its token from `gh auth token`:

- `node scripts/add-library.mjs <github-url | local-path> [name]` installs a library, downloads its documents from their source URLs, records it in the lockfile, and regenerates the catalog. A document that cannot be downloaded is reported and left out of the catalog. Sync tries it again.
  - If the source is a library repository (a `consult.json` at its root) and no `name` is given, the script only prints the registered libraries. Show that list to the user, ask which to install, and re-run with the chosen `name`.
  - GitHub URLs may point into a branch or subdirectory: `https://github.com/<org>/<repo>/tree/<ref>/<subdir>`.
- `node scripts/sync-libraries.mjs` re-installs every library in the lockfile from its recorded source and regenerates the catalog. It both restores libraries after the skill was updated and updates the installed ones. Documents already downloaded are kept. `--refresh` downloads them all again.
- `node scripts/add-library.mjs --where` shows whether this is a user-level or project-level installation, where the lockfile (`consult-lock.json`) is, and how many libraries are locked and installed.

The lockfile is the record of what is installed. `references/libs/` and `references/catalog.md` are a cache rebuilt from it. Never edit the cache by hand, because the scripts overwrite it. To uninstall a library, delete its entry from the lockfile and its directory from `references/libs/`, then run `node scripts/add-library.mjs --catalog`.

## Gotchas

- Catalog's "Do not read for X" clauses are the curator's exclusion signal, not a suggestion. A document can share a tag with the question and still be wrong for it.
- Catalog alone has everything needed to select and cite documents. Only `index.md` requires a separate read, and only for documents that passed the relevance check.
- Libraries added by a local path are recorded by absolute path, so they cannot be restored on another machine.
- Tags are scoped per library, so the same topic can carry different tags in different libraries.
