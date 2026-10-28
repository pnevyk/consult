# consult

An agent skill that answers design and decision questions from curated documents and cites its sources.
It works with any agent harness that supports skills.

## Quick start

### Install the skill

```sh
npx skills add pnevyk/consult
```

The skill scripts need Node.js 22+.

### Add a library

A library is a curated set of documents on one topic.
The skill has no documents until you add at least one library:

```sh
node .agents/skills/consult/scripts/add-library.mjs https://github.com/pnevyk/consult software-design
```

Installing a library from GitHub needs git.
The install downloads the text of each document from its source URL, so it needs network access.

### Ask a question

Ask your agent a question on a topic of the installed libraries.
The skill picks the matching documents, answers from them, and lists them as sources:

```
> Should this service own its own database, or share one with the billing service?

Give the service its own database. A shared database couples both services
to one schema, so neither can change it without coordinating with the other. …

Sources:
- Article title (https://example.com/article)
```

When no document covers the question, the skill says so and does not answer from general knowledge.

## Libraries in this repository

| Name | Description |
|---|---|
| `software-design` | Architecture, system and API design, complexity and simplicity, and the tradeoffs behind design decisions. |
| `software-craft` | Day-to-day code quality: technical debt, readability, error handling, testing, logging, and commit messages. |
| `web-development` | Frontend (React, CSS, native HTML, URL state) and Node.js practices. |
| `software-documentation` | Documentation structure (Diataxis), design docs, and clear technical writing. |
| `ai-engineering` | Building AI agents and working effectively with AI-assisted development. |
| `ai-essays` | Opinion and perspective essays on AI. |
| `engineering-teams` | Code review culture, mentoring, meetings, career growth, and team dynamics. |
| `thinking` | Mental models for problem solving, strategy, troubleshooting, and learning. |

To create your own libraries, see [Building your own library repository](docs/building-a-library-repo.md).

## How it works

The skill relies on four parts:

- **Library.** A directory of document descriptions: title, summary, when to read it, tags, and source URL.
  It usually does not contain the text of the documents.
- **Document.** Its text is downloaded from the source URL when you install the library.
  The text is stored in `references/libs/` in the skill directory.
  After the install, the skill reads documents without network access.
- **Catalog.** `references/catalog.md` in the skill directory lists all installed documents.
  The skill reads it to decide which documents to open.
  Each install or sync regenerates it.
  A document whose text could not be downloaded is left out.
- **Lockfile.** `consult-lock.json` records the source of each installed library.
  It is outside the skill directory, because updating the skill replaces that directory.

## Manage libraries

Run the scripts from the project root.
If the skill is installed at user level, run them from your home directory.

### Install a library

```sh
# list the libraries a repository offers
node .agents/skills/consult/scripts/add-library.mjs https://github.com/pnevyk/consult

# install a library from a GitHub repository
node .agents/skills/consult/scripts/add-library.mjs https://github.com/pnevyk/consult software-design

# install a library from a branch or a subdirectory of a GitHub repository
node .agents/skills/consult/scripts/add-library.mjs https://github.com/<org>/<repo>/tree/<ref>/<subdir>

# install a library from a local directory
node .agents/skills/consult/scripts/add-library.mjs ~/my-library

# install a library from a local repository with a consult.json
node .agents/skills/consult/scripts/add-library.mjs ~/my-libraries my-library
```

### Update libraries

`sync-libraries.mjs` re-installs every library in the lockfile from its source, which also updates them.
It keeps the downloaded text of documents whose source URL did not change.

```sh
node .agents/skills/consult/scripts/sync-libraries.mjs

# download every document again
node .agents/skills/consult/scripts/sync-libraries.mjs --refresh
```

Updating the skill removes the installed libraries.
Run `sync-libraries.mjs` afterwards to restore them.
If you forget, the skill finds the lockfile entries without installed libraries and suggests the sync.

### Uninstall a library

1. Delete the library's entry from the lockfile (see [Where libraries are recorded](#where-libraries-are-recorded)).
2. Delete its `references/libs/<id>/` directory.
3. Run `node .agents/skills/consult/scripts/add-library.mjs --catalog` to regenerate the catalog.

## Where libraries are recorded

The lockfile location depends on where the skill is installed:

| Skill installed in | Level | System | Lockfile |
|---|---|---|---|
| `~/.agents/skills`, `~/.claude/skills`, or `~/.config/<agent>/skills` | user | Linux, macOS | `$CONSULT_HOME/consult-lock.json`, else `$XDG_CONFIG_HOME/consult/consult-lock.json`, else `~/.config/consult/consult-lock.json` |
| `~/.agents/skills`, `~/.claude/skills`, or `~/.config/<agent>/skills` | user | Windows | `%CONSULT_HOME%\consult-lock.json`, else `%APPDATA%\consult\consult-lock.json` |
| `<project>/.agents/skills`, `<project>/.claude/skills`, or `<project>/skills` | project | any | `<project>/consult-lock.json` |

To show the level, the lockfile path, and the number of locked and installed libraries, run:

```sh
node .agents/skills/consult/scripts/add-library.mjs --where
```

To share libraries with your team, commit the project-level lockfile.
Teammates then run `sync-libraries.mjs` to install the libraries it lists.
The scripts rebuild `references/libs/` and `references/catalog.md` from the lockfile, so you can git-ignore both.
The lockfile records sources, not versions, so each sync installs the current version of each library.
A library installed from a local directory is recorded by its absolute path, so it does not sync on another machine.

## Contributing

See the [Contributing guide](CONTRIBUTING.md).
