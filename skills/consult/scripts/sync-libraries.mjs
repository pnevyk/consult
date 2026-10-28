#!/usr/bin/env node
// Re-install every library in the lockfile from its recorded source, then regenerate
// references/catalog.md. This restores libraries after the skill itself was updated (its
// directory is replaced, wiping references/libs) and updates the ones that are present.
// Documents already downloaded are kept; --refresh downloads them all again.
//
// Usage: node sync-libraries.mjs [--refresh]

import { generateCatalog, installedLibraryIds, readLock, syncLibraries } from "./core.mjs";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--refresh")) {
    console.error("usage: sync-libraries.mjs [--refresh]");
    process.exit(2);
}

try {
    const locked = new Set(readLock().map((entry) => entry.id));
    for (const id of installedLibraryIds().filter((id) => !locked.has(id))) {
        console.error(`warning: ${id} is not in the lockfile and cannot be synced`);
    }

    let failed = 0;
    for (const { id, newId, failures, error } of await syncLibraries({ refresh: args.includes("--refresh") })) {
        if (error) {
            failed += 1;
            console.error(`failed ${id}: ${error}`);
            continue;
        }
        for (const failure of failures) console.error(`warning: ${id}: ${failure.slug} not downloaded: ${failure.error}`);
        console.log(`synced ${id}${newId ? ` -> ${newId}` : ""}${failures.length ? ` (${failures.length} documents not downloaded)` : ""}`);
    }

    console.log(generateCatalog());
    process.exit(failed ? 1 : 0);
} catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(1);
}
