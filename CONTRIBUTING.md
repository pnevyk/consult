# Contributing

This guide covers adding documents and libraries to this repository and testing the skill locally.

## Add a document

Add a document with a local script, or with a GitHub workflow.
The library must be registered in `consult.json` with a non-empty `tags` list.

### With the local script

The script needs Node.js 22+ and an Anthropic API key.
It reads the key from the `ANTHROPIC_API_KEY` environment variable or from `.env` at the repository root.
To use `.env`, run `cp .env.example .env` and fill in the key.

```sh
node scripts/add-document.mjs <url> <library>
```

The script:

1. Downloads the page with the skill's extractor, `skills/consult/scripts/extract.mjs`.
2. Asks Claude Haiku for the title, summary, when-to-read note, and tags.
   The model picks one to four tags from the library's `tags` list.
3. Writes `libraries/<library>/docs/<slug>/metadata.json`, with today's date as `accessed-at`.
   The slug comes from the title.

If the library already has a document with the exact same URL, the script overwrites that document's metadata.

To check that the extracted text is sound, run `node skills/consult/scripts/extract.mjs <url>`.

### With the GitHub workflow

The workflow needs the `ANTHROPIC_API_KEY` repository secret.
It commits directly to the branch it runs on, which is the default branch unless you pick another.
That branch must allow pushes made with the workflow token.

Go to Actions → **Add document** → *Run workflow*, and enter the URL and the library.

## Create a library

1. Create `libraries/<name>/library.json`.
   For its fields, see [Building your own library repository](docs/building-a-library-repo.md).
2. Register the library in `consult.json` with its document tags.
   `add-document.mjs` refuses a library without tags.
3. Add its name to the `library` input `options` in `.github/workflows/add-document.yml`.

## Change a library's tags

Edit the library's `tags` list in `consult.json`.
Only `add-document.mjs` uses the list, when it tags a new or updated document.
Other documents keep their tags, including tags removed from the list.

## Test the skill locally

```sh
node skills/consult/scripts/add-library.mjs . software-design
```

The command installs the library as `local.software-design` from your working tree.
In this repository the skill is installed at project level.
Installed libraries go to `skills/consult/references/libs/`, and the lockfile goes to `consult-lock.json` at the repository root.
Both are git-ignored.
To confirm, run `node skills/consult/scripts/add-library.mjs --where`.

The install also regenerates `skills/consult/references/catalog.md`.
The committed version is the empty catalog that ships with the skill, so do not commit your changes to it.
Restore it with `git checkout skills/consult/references/catalog.md`.
