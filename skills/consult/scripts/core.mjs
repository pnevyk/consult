// Building blocks shared by the CLIs (add-library, sync-libraries): source
// resolution, library installation, document download, the lockfile, and catalog generation.
// Node >= 22, no dependencies, git needed only for GitHub sources (gh optional, for private repos).
//
// references/libs/ is a cache. The source of truth for "what is installed" is consult-lock.json,
// which lives OUTSIDE the skill directory because tools that update the skill replace that
// directory wholesale. sync-libraries.mjs rebuilds the cache from the lockfile (and, because it
// re-fetches every source, also updates the libraries).
//
// A library holds a metadata.json per document and, usually, no text: the text of a document is
// downloaded from its `source-url` (see extract.mjs) into references/libs/ when the library is
// installed, and kept there, so every article is downloaded once per installation. A document
// directory that already ships an index.md is used as is.

import { execFileSync } from "node:child_process";
import {
    copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
    realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { fetchMarkdown } from "./extract.mjs";

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REFERENCES_DIR = join(SKILL_ROOT, "references");
const LIBS_DIR = join(REFERENCES_DIR, "libs");
const CATALOG_PATH = join(REFERENCES_DIR, "catalog.md");

const LOCK_FILE = "consult-lock.json";
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const ORG_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const GITHUB_RE =
    /^https:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.+?))?)?\/?$/;

const LIBRARY_FIELDS = ["name", "title", "description"];
const DOWNLOAD_CONCURRENCY = 6;
const DOC_FIELDS = ["title", "summary", "when-to-read", "source-url", "accessed-at"];

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const isDir = (path) => existsSync(path) && statSync(path).isDirectory();
const isUrl = (source) => /^https?:\/\//.test(source);
const isInside = (parent, child) => child === parent || child.startsWith(parent + sep);

function requireFields(object, fields, where) {
    for (const field of fields) {
        if (typeof object[field] !== "string" || !object[field].trim()) {
            throw new Error(`${where}: missing or empty required field '${field}'`);
        }
    }
}

// --- manifests -----------------------------------------------------------

function readLibraryManifest(dir) {
    const path = join(dir, "library.json");
    const manifest = readJson(path);
    requireFields(manifest, LIBRARY_FIELDS, path);
    if (!SLUG_RE.test(manifest.name)) {
        throw new Error(`${path}: 'name' must match ${SLUG_RE}`);
    }
    return manifest;
}

function readCentralManifest(dir) {
    const path = join(dir, "consult.json");
    const manifest = readJson(path);
    if (!Array.isArray(manifest.libraries)) {
        throw new Error(`${path}: 'libraries' must be an array`);
    }
    for (const entry of manifest.libraries) {
        requireFields(entry, ["name", "root"], `${path} library entry`);
    }
    return manifest;
}

/** Registered libraries of a central manifest directory, with title/description when readable. */
function listCentral(dir) {
    return readCentralManifest(dir).libraries.map((entry) => {
        const libraryDir = resolve(dir, entry.root);
        const manifest = existsSync(join(libraryDir, "library.json")) ? readLibraryManifest(libraryDir) : {};
        return { name: entry.name, root: entry.root, title: manifest.title, description: manifest.description };
    });
}

// --- sources -------------------------------------------------------------

/** GitHub token from the gh CLI, or undefined when gh is missing or not logged in. */
function ghToken() {
    try {
        const token = execFileSync("gh", ["auth", "token", "--hostname", "github.com"], {
            stdio: ["ignore", "pipe", "ignore"],
        }).toString().trim();
        return token || undefined;
    } catch {
        return undefined;
    }
}

/** Resolves a source to a directory on disk. Returns { dir, author, cleanup }. */
function materialize(source) {
    if (!isUrl(source)) {
        const dir = resolve(source);
        if (!isDir(dir)) throw new Error(`not a directory: ${dir}`);
        return { dir, author: "local", cleanup: () => {} };
    }

    const match = GITHUB_RE.exec(source);
    if (!match) throw new Error(`unsupported URL (expected a github.com repository URL): ${source}`);
    const [, org, repo, ref, subdir = ""] = match;
    if (!ORG_RE.test(org)) throw new Error(`invalid GitHub organization: ${org}`);

    const checkout = mkdtempSync(join(tmpdir(), "consult-lib-"));
    const cleanup = () => rmSync(checkout, { recursive: true, force: true });
    // The gh token (if any) in the URL lets private repositories be cloned.
    const token = ghToken();
    const auth = token ? `x-access-token:${token}@` : "";
    const args = [
        "clone", "--depth", "1", ...(ref ? ["--branch", ref] : []),
        `https://${auth}github.com/${org}/${repo}.git`, checkout,
    ];
    try {
        execFileSync("git", args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
        cleanup();
        const message = error.stderr?.toString().trim() || error.message;
        throw new Error(`git clone failed for ${source}: ${token ? message.replaceAll(token, "***") : message}`);
    }
    const dir = resolve(checkout, subdir);
    if (!isInside(checkout, dir)) {
        cleanup();
        throw new Error(`path escapes the repository: ${subdir}`);
    }
    return { dir, author: org, cleanup };
}

// --- installation level and lockfile --------------------------------------

function userConfigDir() {
    if (process.env.CONSULT_HOME) return resolve(process.env.CONSULT_HOME);
    if (process.platform === "win32") {
        return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "consult");
    }
    return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "consult");
}

/**
 * Where this copy of the skill is installed, and so where its lockfile lives.
 *
 * The skill sits in `<base>/skills/consult`. `<base>` is usually an agent directory such as
 * `.claude` or `.agents`; the installation root is then its parent, otherwise `<base>` itself.
 *   - root is the home directory (`~/.claude/skills`, `~/.agents/skills`, ...), or `<base>` is
 *     under the config home (`~/.config/<agent>/skills`) -> user level: the lockfile goes to
 *     $CONSULT_HOME, else the system config directory (`~/.config/consult`).
 *   - anything else (`<project>/.claude/skills`, `<project>/skills`) -> project level: the
 *     lockfile goes to the project root.
 * Returns { level: "user" | "project", lockPath }.
 */
export function installation() {
    const skillsDir = dirname(SKILL_ROOT);
    if (basename(skillsDir) !== "skills") {
        if (process.env.CONSULT_HOME) return { level: "user", lockPath: join(userConfigDir(), LOCK_FILE) };
        throw new Error(
            `cannot tell where the skill is installed (${SKILL_ROOT} is not inside a 'skills' directory); ` +
            "set CONSULT_HOME to choose a lockfile directory",
        );
    }
    const base = dirname(skillsDir);
    const root = basename(base).startsWith(".") ? dirname(base) : base;
    const home = realpathSync(homedir());
    const configHome = resolve(process.env.XDG_CONFIG_HOME ?? join(home, ".config"));
    if (root === home || isInside(configHome, base)) {
        return { level: "user", lockPath: join(userConfigDir(), LOCK_FILE) };
    }
    return { level: "project", lockPath: join(root, LOCK_FILE) };
}

/** Locked libraries: [{ id, source, name }] sorted by id; empty when there is no lockfile. */
export function readLock() {
    const { lockPath } = installation();
    if (!existsSync(lockPath)) return [];
    const { libraries } = readJson(lockPath);
    if (!Array.isArray(libraries)) throw new Error(`${lockPath}: 'libraries' must be an array`);
    return libraries;
}

function writeLock(libraries) {
    const { lockPath } = installation();
    const sorted = [...libraries].sort((a, b) => a.id.localeCompare(b.id));
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ libraries: sorted }, null, 2) + "\n");
}

/** Adds or replaces the lock entry for `entry.id`, or for `replacesId` when the ID changed. */
function recordInLock(entry, replacesId = entry.id) {
    writeLock([...readLock().filter((item) => item.id !== replacesId && item.id !== entry.id), entry]);
}

// --- installed libraries -------------------------------------------------

/** IDs (`<author>.<name>`) of the libraries present in references/libs, sorted. */
export function installedLibraryIds() {
    if (!isDir(LIBS_DIR)) return [];
    return readdirSync(LIBS_DIR).filter((id) => isDir(join(LIBS_DIR, id))).sort();
}

export function removeLibrary(id) {
    rmSync(join(LIBS_DIR, id), { recursive: true, force: true });
}

const documentDirs = (libraryDir) => {
    const docsDir = join(libraryDir, "docs");
    return (isDir(docsDir) ? readdirSync(docsDir).sort() : []).map((slug) => join(docsDir, slug));
};

/** Runs `task` over `items`, at most `limit` at a time. */
async function mapPool(items, limit, task) {
    let next = 0;
    const worker = async () => {
        while (next < items.length) await task(items[next++]);
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Keeps the text already downloaded into `previous` for documents whose source URL did not change. */
function keepDownloads(previous, staging) {
    for (const dir of documentDirs(staging)) {
        const old = join(previous, "docs", basename(dir));
        if (existsSync(join(dir, "index.md")) || !existsSync(join(old, "index.md"))) continue;
        try {
            if (readJson(join(old, "metadata.json"))["source-url"] === readJson(join(dir, "metadata.json"))["source-url"]) {
                copyFileSync(join(old, "index.md"), join(dir, "index.md"));
            }
        } catch {
            // unreadable metadata: the document is downloaded again (and reported, if that fails)
        }
    }
}

/** Downloads the text of every document of `libraryDir` that has none. Returns [{ slug, error }] of failures. */
async function downloadDocuments(libraryDir) {
    const missing = documentDirs(libraryDir).filter(
        (dir) => existsSync(join(dir, "metadata.json")) && !existsSync(join(dir, "index.md")),
    );
    const failures = [];
    await mapPool(missing, DOWNLOAD_CONCURRENCY, async (dir) => {
        try {
            const url = readJson(join(dir, "metadata.json"))["source-url"];
            if (typeof url !== "string") throw new Error("missing 'source-url' in metadata.json");
            writeFileSync(join(dir, "index.md"), await fetchMarkdown(url));
        } catch (error) {
            failures.push({ slug: basename(dir), error: error.message });
        }
    });
    return failures.sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Installs a library into references/libs, replacing any previous install of the same ID, and
 * downloads the text of its documents (`refresh` downloads all of it again instead of keeping
 * what is there). Returns { id, source, name, failures }, or { available } when the source is a
 * central manifest and no name was given. Everything is validated, and the new copy built beside
 * the old one, before the previous install is replaced. Does not touch the lockfile. A document
 * that cannot be downloaded is reported in `failures` and left out of the catalog; a later
 * install or sync tries it again.
 */
export async function installLibrary(source, name, { refresh = false } = {}) {
    const { dir, author, cleanup } = materialize(source);
    try {
        let libraryDir = dir;
        if (existsSync(join(dir, "library.json"))) {
            if (name) throw new Error("[name] only applies to sources with a consult.json central manifest");
        } else if (existsSync(join(dir, "consult.json"))) {
            if (!name) return { available: listCentral(dir) };
            const entry = readCentralManifest(dir).libraries.find((item) => item.name === name);
            if (!entry) throw new Error(`no library named '${name}' in ${source}`);
            libraryDir = resolve(dir, entry.root);
            if (!isInside(dir, libraryDir)) {
                throw new Error(`library root escapes the repository: ${entry.root}`);
            }
            if (!existsSync(join(libraryDir, "library.json"))) {
                throw new Error(`${entry.root}: no library.json found`);
            }
        } else {
            throw new Error(`neither library.json nor consult.json found in ${dir}`);
        }

        const manifest = readLibraryManifest(libraryDir);
        if (name && manifest.name !== name) {
            throw new Error(`library.json name '${manifest.name}' does not match central manifest name '${name}'`);
        }

        const id = `${author}.${manifest.name}`;
        const target = join(LIBS_DIR, id);
        const staging = `${target}.tmp`;
        mkdirSync(LIBS_DIR, { recursive: true });
        rmSync(staging, { recursive: true, force: true });
        try {
            cpSync(libraryDir, staging, {
                recursive: true,
                filter: (path) => basename(path) !== ".git" && basename(path) !== "node_modules",
            });
            if (!refresh) keepDownloads(target, staging);
            rmSync(target, { recursive: true, force: true });
            renameSync(staging, target);
        } finally {
            rmSync(staging, { recursive: true, force: true });
        }
        const failures = await downloadDocuments(target);
        return { id, source: isUrl(source) ? source : resolve(source), name: name ?? null, failures };
    } finally {
        cleanup();
    }
}

/** installLibrary + a lockfile entry, so the library survives updates of the skill. */
export async function addLibrary(source, name) {
    const result = await installLibrary(source, name);
    if (result.id) recordInLock({ id: result.id, source: result.source, name: result.name });
    return result;
}

/**
 * Re-installs every locked library from its recorded source, which both restores libraries
 * missing from references/libs (after the skill itself was updated) and updates the present
 * ones. Downloaded document text is kept unless `refresh` is set. Continues past failures.
 * Returns [{ id, newId?, failures?, error? }]; a library renamed upstream is moved to its new
 * ID in both the cache and the lockfile.
 */
export async function syncLibraries({ refresh = false } = {}) {
    const results = [];
    for (const entry of readLock()) {
        try {
            const installed = await installLibrary(entry.source, entry.name ?? undefined, { refresh });
            const renamed = installed.id !== entry.id;
            if (renamed) removeLibrary(entry.id);
            recordInLock({ id: installed.id, source: entry.source, name: entry.name }, entry.id);
            results.push({ id: entry.id, failures: installed.failures, ...(renamed && { newId: installed.id }) });
        } catch (error) {
            results.push({ id: entry.id, error: error.message });
        }
    }
    return results;
}

// --- catalog -------------------------------------------------------------

function renderEntry(libraryId, slug, doc) {
    const tags = Array.isArray(doc.tags) ? doc.tags.join(", ") : "";
    return [
        `### [${doc.title}](libs/${libraryId}/docs/${slug}/index.md)`,
        `**Summary:** ${doc.summary}`,
        `**When to read:** ${doc["when-to-read"]}`,
        `**Tags:** ${tags}`,
        `**Source:** ${doc["source-url"]} (accessed ${doc["accessed-at"]})`,
    ].join("\n\n") + "\n";
}

function readDocuments(libraryDir) {
    const documents = [];
    for (const dir of documentDirs(libraryDir)) {
        const metadataPath = join(dir, "metadata.json");
        // no index.md: the download failed, so there is nothing to read behind the catalog entry
        if (!existsSync(metadataPath) || !existsSync(join(dir, "index.md"))) continue;
        try {
            const doc = readJson(metadataPath);
            requireFields(doc, DOC_FIELDS, metadataPath);
            documents.push({ slug: basename(dir), doc });
        } catch (error) {
            console.error(`warning: skipping document: ${error.message}`);
        }
    }
    return documents.sort((a, b) => a.doc.title.toLowerCase().localeCompare(b.doc.title.toLowerCase()));
}

/** Rebuilds references/catalog.md from every installed library; git state is irrelevant. */
export function generateCatalog() {
    const sections = [];
    for (const id of installedLibraryIds()) {
        const libraryDir = join(LIBS_DIR, id);
        let manifest;
        try {
            manifest = readLibraryManifest(libraryDir);
        } catch (error) {
            console.error(`warning: skipping library ${id}: ${error.message}`);
            continue;
        }
        const documents = readDocuments(libraryDir);
        const body = documents.map(({ slug, doc }) => renderEntry(id, slug, doc)).join("\n---\n\n");
        sections.push(
            `## Library: ${manifest.title} (\`${id}\`)\n\n${manifest.description}\n\n` +
            (documents.length ? body : "_No documents._\n"),
        );
    }

    const catalog = "# Catalog\n\n" + (sections.length ? sections.join("\n") : "_No libraries installed._\n");
    mkdirSync(REFERENCES_DIR, { recursive: true });
    writeFileSync(CATALOG_PATH, catalog);
    return CATALOG_PATH;
}
