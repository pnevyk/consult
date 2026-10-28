#!/usr/bin/env node
// Add a document to a library of this repository, or update it when its source URL is already
// there. Downloads the page with the skill's extractor, asks Claude (haiku) for the metadata,
// and writes `<library root>/docs/<slug>/metadata.json`. The text itself is not stored: the skill
// downloads it from `source-url` when a library is installed.
//
// The library and its allowed document tags come from the central manifest `consult.json` at
// the repository root. Needs ANTHROPIC_API_KEY (environment or .env). Prints the document
// directory.
//
// Usage: node scripts/add-document.mjs <url> <library>

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { fetchMarkdown } from "../skills/consult/scripts/extract.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODEL = "claude-haiku-5-5";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

function metadataTool(tags) {
    return {
        name: "record_article_metadata",
        description: "Record extracted metadata for the article.",
        input_schema: {
            type: "object",
            properties: {
                title: { type: "string", description: "Clean article title." },
                summary: {
                    type: "string",
                    description:
                        "1-2 sentence table-of-contents-style summary naming the article's specific, " +
                        "named concepts, frameworks, or techniques (e.g. 'Conway's Law', 'FCIS', " +
                        "'Diataxis', '90/90 rule') rather than generic category words already covered " +
                        "by tags. Omit a word if it duplicates a tag, unless it is the article's " +
                        "central named concept.",
                },
                when_to_read: {
                    type: "string",
                    description:
                        "Exactly two sentences. First: the general kind of task or question that " +
                        "should trigger reading this article, phrased broadly enough that an agent " +
                        "doesn't skip it just because a query uses different words. Second: a " +
                        "'Do not read for X' clause naming the most easily-confused adjacent topic, " +
                        "and which other article or tag to consult instead, so similar articles can " +
                        "be told apart.",
                },
                tags: {
                    type: "array",
                    items: { type: "string", enum: tags },
                    minItems: 1,
                    maxItems: 4,
                    description: "1-4 tags from the closed set that best categorize the article. Never invent a tag outside this set.",
                },
            },
            required: ["title", "summary", "when_to_read", "tags"],
        },
    };
}

/** Returns { docsDir, tags } for a library of the central manifest. */
function loadLibrary(name) {
    const { libraries } = readJson(join(ROOT, "consult.json"));
    const entry = libraries.find((item) => item.name === name);
    if (!entry) throw new Error(`unknown library '${name}' (known: ${libraries.map((item) => item.name).join(", ")})`);
    if (!entry.tags?.length) throw new Error(`library '${name}' has no tags in consult.json`);
    return { docsDir: join(ROOT, entry.root, "docs"), tags: entry.tags };
}

async function extractMetadata(markdown, tags) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
    const tool = metadataTool(tags);
    const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
            "x-api-key": process.env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        body: JSON.stringify({
            model: MODEL,
            max_tokens: 1024,
            tools: [tool],
            tool_choice: { type: "tool", name: tool.name },
            messages: [{
                role: "user",
                content:
                    "Extract metadata for this article, for a curated knowledge base " +
                    "consulted by an engineer looking for guidance.\n\n" + markdown.slice(0, 20000),
            }],
        }),
    });
    if (!response.ok) throw new Error(`Anthropic API ${response.status}: ${await response.text()}`);
    const block = (await response.json()).content.find((item) => item.type === "tool_use");
    if (!block) throw new Error("model did not return the expected tool call");
    return block.input;
}

const slugify = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "article";

/** Existing directory with the same source URL (update), else a free slug. */
function resolveDocumentDir(docsDir, slug, sourceUrl) {
    const existing = existsSync(docsDir) ? readdirSync(docsDir) : [];
    for (const name of existing) {
        const path = join(docsDir, name, "metadata.json");
        if (existsSync(path) && readJson(path)["source-url"] === sourceUrl) return join(docsDir, name);
    }
    let candidate = slug;
    for (let suffix = 2; existing.includes(candidate); suffix++) candidate = `${slug}-${suffix}`;
    return join(docsDir, candidate);
}

async function main(argv) {
    if (argv.length !== 2) {
        console.error("usage: add-document.mjs <url> <library>");
        process.exit(1);
    }
    const [url, library] = argv;
    if (existsSync(join(ROOT, ".env"))) process.loadEnvFile(join(ROOT, ".env"));
    const { docsDir, tags } = loadLibrary(library);

    const metadata = await extractMetadata(await fetchMarkdown(url), tags);
    const documentTags = metadata.tags.filter((tag) => tags.includes(tag));
    if (!documentTags.length) throw new Error(`model chose no tag from the library's tags: ${metadata.tags}`);

    const dir = resolveDocumentDir(docsDir, slugify(metadata.title), url);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "metadata.json"), JSON.stringify({
        title: metadata.title,
        summary: metadata.summary,
        "when-to-read": metadata.when_to_read,
        "source-url": url,
        "accessed-at": new Date().toISOString().slice(0, 10),
        tags: documentTags,
    }, null, 2) + "\n");
    console.log(dir);
}

try {
    await main(process.argv.slice(2));
} catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(1);
}
