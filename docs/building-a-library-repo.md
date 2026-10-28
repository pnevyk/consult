# Building your own library repository

A library repository is a GitHub repository or a local directory that the skill can install libraries from.
You can start from this repository as a template, or create the files below.

Building one takes up to four steps:

1. Create a library.
2. Lay out the repository for one library or for several.
3. Optionally, add the fetch tooling that adds documents from a URL.
4. Publish the repository.

## 1. Create a library

A library is a directory with a manifest and one directory per document:

```
my-library/
├── library.json
└── docs/
    └── my-first-document/
        ├── metadata.json
        └── index.md          # optional, the document as markdown
```

### `library.json`

The manifest names and describes the library.

```json
{
  "name": "my-library",
  "title": "My library",
  "description": "What this library covers, in one sentence.",
  "author": "Your Name"
}
```

- `name`: required.
  Lowercase letters, digits, and hyphens, starting with a letter or digit.
  The library is installed with the ID `<github-org>.<name>`, or `local.<name>` from a local path.
  If two repositories of the same organization use the same name, installing one replaces the other.
- `title` and `description`: required.
  The catalog shows them as the heading of the library's section.
- `author`: optional display name.
  The scripts do not use it.

### `metadata.json`

Each document's metadata describes the document.
The skill reads these fields in the catalog to decide whether to open the document.

```json
{
  "title": "Article title",
  "summary": "1-2 sentences naming the specific concepts, frameworks or techniques covered.",
  "when-to-read": "Two sentences: the kind of question that should trigger reading it, then a \"Do not read for X\" clause naming the most easily confused adjacent topic and where to look instead.",
  "source-url": "https://example.com/original-article",
  "accessed-at": "2026-01-31",
  "tags": ["tag-one", "tag-two"]
}
```

- `title`, `summary`, `when-to-read`, `source-url`, and `accessed-at`: required.
  The catalog skips a document with a missing or empty required field.
- `tags`: optional.

### Document text

A document directory needs only `metadata.json`.
On install, the skill downloads the HTML page at `source-url`.
It extracts the main content as markdown and saves it as `index.md`.
Exceptions:

- **medium.com.** The skill reads the article from the author's RSS feed, which holds only the latest posts.
  Older articles cannot be downloaded.
- **Pages that cannot be downloaded.** The download fails for pages that block bots, disallow access in `robots.txt`, or need JavaScript to show their text.
  It also fails when less than 500 characters of text come back.
  The skill reports such a document and leaves it out of the catalog.
  The next install or sync tries the download again.
- **Text you ship yourself.** If the directory already has an `index.md`, the skill uses it and downloads nothing.

To check what the skill extracts from a page, run `node .agents/skills/consult/scripts/extract.mjs <url>`.

## 2. Lay out the repository

A repository holds one library, or several libraries listed in a central manifest.

### One library

Put the library at the repository root.
Or keep it in a subdirectory, and point the install URL at it with `https://github.com/<org>/<repo>/tree/<ref>/<subdir>`.

### Several libraries

Put a central manifest, `consult.json`, at the repository root:

```json
{
  "libraries": [
    { "name": "my-library", "root": "libraries/my-library", "tags": ["tag-one", "tag-two"] }
  ]
}
```

- `root`: the library directory, relative to the repository root.
  It must be inside the repository.
  The `name` in its `library.json` must equal the entry's `name`.
- `tags`: the closed set of document tags for the library.
  Only the fetch tooling (step 3) uses it, and requires it.
  The skill ignores it when installing.

Installing from the repository URL without a library name lists the registered libraries.
With a name, it installs that library.
If the repository root also has a `library.json`, the skill installs that library and ignores `consult.json`.

## 3. Add the fetch tooling (optional)

The fetch tooling adds documents to a library from a URL.
It needs `consult.json` from [Several libraries](#several-libraries), with `tags` for each library.
Copy these files from this repository, keeping their paths:

- `scripts/add-document.mjs`
- `skills/consult/scripts/extract.mjs` (the script imports it)
- `.env.example`
- `.github/workflows/add-document.yml`

In the workflow, replace the `library` input's `options` with your library names.
The workflow commits only changes under `libraries/`.
If your library roots are elsewhere, change the `git add -A libraries` line.
Then follow [Add a document](../CONTRIBUTING.md#add-a-document) in the contributing guide.

## 4. Publish the repository

Push the repository to GitHub.
Users install and update your libraries as described in [Manage libraries](../README.md#manage-libraries), with your repository URL.
