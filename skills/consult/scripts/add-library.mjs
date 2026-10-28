#!/usr/bin/env node
// Install a consult library into references/libs/, download the text of its documents from their
// source URLs, record it in the lockfile, and regenerate references/catalog.md.
//
// Usage:
//     node add-library.mjs <github-url | local-path> [name]
//     node add-library.mjs --catalog        # only regenerate the catalog
//     node add-library.mjs --where          # show installation level, lockfile, library counts
//
// <source> points at a directory containing either
//     - library.json  -> a library; it is installed.
//     - consult.json  -> a central manifest; without [name] the registered libraries are
//                        listed (nothing is installed), with [name] that library is installed.
// GitHub sources: https://github.com/<org>/<repo>[.git][/tree/<ref>[/<subdir>]]

import { existsSync } from "node:fs";

import { addLibrary, generateCatalog, installation, installedLibraryIds, readLock } from "./core.mjs";

async function main(argv) {
    if (argv[0] === "--catalog" && argv.length === 1) {
        console.log(generateCatalog());
        return;
    }
    if (argv[0] === "--where" && argv.length === 1) {
        const { level, lockPath } = installation();
        console.log(
            `level: ${level}\n` +
            `lockfile: ${lockPath} (${existsSync(lockPath) ? "exists" : "missing"})\n` +
            `locked libraries: ${readLock().length}\n` +
            `installed libraries: ${installedLibraryIds().length}`,
        );
        return;
    }
    if (argv.length < 1 || argv.length > 2 || argv[0].startsWith("-")) {
        console.error(
            "usage: add-library.mjs <github-url | local-path> [name]\n" +
            "       add-library.mjs --catalog\n" +
            "       add-library.mjs --where",
        );
        process.exit(2);
    }

    const result = await addLibrary(argv[0], argv[1]);
    if (result.available) {
        console.log("Source is a central manifest. Registered libraries (re-run with a name to install one):");
        for (const library of result.available) {
            const title = library.title ? `: ${library.title}` : "";
            const description = library.description ? ` — ${library.description}` : "";
            console.log(`- ${library.name}${title}${description}`);
        }
        return;
    }
    for (const { slug, error } of result.failures) console.error(`warning: ${slug} not downloaded: ${error}`);
    console.log(`installed ${result.id}${result.failures.length ? ` (${result.failures.length} documents not downloaded; sync-libraries.mjs tries them again)` : ""}`);
    console.log(generateCatalog());
}

try {
    await main(process.argv.slice(2));
} catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(1);
}
