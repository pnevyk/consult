// Minimal article extractor: fetches a URL and turns the main content into markdown. Node >= 22,
// no dependencies. Meant for blog-style pages with reasonably clean HTML; it picks the main
// content block with a simple heuristic, not a full readability algorithm. Images are dropped.
//
// Honest User-Agent, robots.txt respected. medium.com refuses non-browser requests, so its
// articles are read from the author's RSS feed instead (which only holds the latest posts).

const USER_AGENT = "consult-skill/1.0 (+https://github.com/pnevyk/consult)";
const MIN_LENGTH = 500;

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const SKIP = new Set([
    "script", "style", "template", "svg", "iframe", "form", "button", "select",
    "nav", "footer", "head", "dialog", "canvas", "video", "audio",
]);
const BLOCK = new Set([
    "p", "div", "section", "article", "main", "header", "figure", "figcaption", "ul", "ol", "li",
    "blockquote", "pre", "table", "tr", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "details", "summary",
    "dl", "dt", "dd", "body", "html",
]);
// class/id of page furniture; only applied to block containers, so `<span class="comment">` in code is safe
const FURNITURE_RE = /(?:^|[\s_-])(comments?|share|sharing|sidebar|newsletter|subscribe|subscription|related|cookie|breadcrumbs?|toc|skip-link)(?:$|[\s_-])/i;
const IMPLIED_END = { p: ["p"], li: ["li"], dt: ["dt", "dd"], dd: ["dt", "dd"], tr: ["tr"], td: ["td", "th"], th: ["td", "th"] };
const ENTITIES = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
    lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", copy: "©", rarr: "→", larr: "←", times: "×", middot: "·",
};

// --- parsing ---------------------------------------------------------------

const TOKEN_RE = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|[^<]+|</g;
const ATTR_RE = /([^\s=/"'<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function decode(text) {
    return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (whole, dec, hex, name) => {
        if (name) return ENTITIES[name.toLowerCase()] ?? whole;
        const code = dec ? Number(dec) : parseInt(hex, 16);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    });
}

function parseAttributes(source) {
    const attrs = {};
    for (const [, name, a, b, c] of source.matchAll(ATTR_RE)) attrs[name.toLowerCase()] = decode(a ?? b ?? c ?? "");
    return attrs;
}

function parse(html) {
    const root = { tag: "#root", attrs: {}, children: [] };
    const stack = [root];
    // script and style bodies are not markup (they may contain "<!--" or tags inside strings)
    const markup = html.replace(/<(script|style)\b([^>]*)>[\s\S]*?<\/\1\s*>/gi, "<$1$2></$1>");
    for (const [token, closing, rawTag, attrSource] of markup.matchAll(TOKEN_RE)) {
        const top = stack.at(-1);
        if (rawTag === undefined) {
            if (!token.startsWith("<!--")) top.children.push({ text: token });
            continue;
        }
        const tag = rawTag.toLowerCase();
        if (closing) {
            const at = stack.map((n) => n.tag).lastIndexOf(tag);
            if (at > 0) stack.length = at;
            continue;
        }
        const ends = IMPLIED_END[tag] ?? [];
        for (let i = stack.length - 1; i > 0 && ends.length; i--) {
            if (ends.includes(stack[i].tag)) { stack.length = i; break; }
            if (BLOCK.has(stack[i].tag)) break;
        }
        const node = { tag, attrs: parseAttributes(attrSource), children: [] };
        stack.at(-1).children.push(node);
        if (VOID.has(tag)) continue; // `/>` means nothing on non-void HTML elements, and svg content is skipped anyway
        stack.push(node);
    }
    return root;
}

// --- content selection -------------------------------------------------------

const isElement = (node) => node.tag !== undefined;

function* walk(node, visibleOnly = false) {
    for (const child of node.children ?? []) {
        if (!isElement(child) || (visibleOnly && SKIP.has(child.tag))) continue;
        yield child;
        yield* walk(child, visibleOnly);
    }
}

const TEXT_BLOCKS = new Set(["p", "pre", "li", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6"]);

function textLength(node) {
    if (!isElement(node)) return node.text.trim().length;
    return SKIP.has(node.tag) ? 0 : node.children.reduce((sum, child) => sum + textLength(child), 0);
}

function linkTextLength(node) {
    if (!isElement(node)) return 0;
    return node.tag === "a" ? textLength(node) : node.children.reduce((sum, child) => sum + linkTextLength(child), 0);
}

const weights = new WeakMap();

/** Amount of running text in a subtree; list items that are mostly links (menus, tag clouds) do not count. */
function weight(node) {
    if (!isElement(node) || SKIP.has(node.tag)) return 0;
    if (!weights.has(node)) {
        let value;
        if (!TEXT_BLOCKS.has(node.tag)) {
            // bare text counts too: old pages put text straight into a div or font element, separated by <br>
            value = node.children.reduce((sum, child) => sum + (isElement(child) ? weight(child) : child.text.trim().length), 0);
        }
        else value = node.tag === "li" && linkTextLength(node) > textLength(node) / 2 ? 0 : textLength(node);
        weights.set(node, value);
    }
    return weights.get(node);
}

/** `<article>` or `<main>` when present (the biggest one), else the lowest element holding most of the page's text. */
function findContent(root) {
    const all = [...walk(root)];
    for (const tag of ["article", "main"]) {
        const found = all.filter((n) => n.tag === tag).sort((a, b) => weight(b) - weight(a));
        if (found.length && weight(found[0]) >= MIN_LENGTH) return found[0];
    }
    let node = root;
    for (;;) {
        const next = node.children.find((child) => isElement(child) && weight(child) > 0 && weight(child) >= weight(node) * 0.8);
        if (!next) return node;
        node = next;
    }
}

// --- markdown rendering ------------------------------------------------------

const squash = (text) => text.replace(/\s+/g, " ");

function rawText(node) {
    return isElement(node) ? (node.tag === "br" ? "\n" : node.children.map(rawText).join("")) : decode(node.text);
}

function absolute(href, base) {
    try {
        const url = new URL(href, base);
        return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
    } catch {
        return null;
    }
}

function fence(code, language) {
    const ticks = "`".repeat(Math.max(3, ...[...code.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    return `${ticks}${language}\n${code.replace(/\n+$/, "")}\n${ticks}`;
}

function inline(nodes, base) {
    let out = "";
    for (const node of nodes) {
        if (!isElement(node)) {
            out += squash(decode(node.text));
            continue;
        }
        if (SKIP.has(node.tag) || node.tag === "img" || node.attrs.hidden !== undefined) continue;
        const inner = inline(node.children, base);
        switch (node.tag) {
            case "br": out += "\n"; break;
            case "code": out += inner.trim() ? "`" + rawText(node).replace(/\s+/g, " ").trim() + "`" : ""; break;
            case "strong": case "b": out += inner.trim() ? `**${inner.trim()}**` : inner; break;
            case "em": case "i": out += inner.trim() ? `*${inner.trim()}*` : inner; break;
            case "a": {
                const href = node.attrs.href && !node.attrs.href.startsWith("#") ? absolute(node.attrs.href, base) : null;
                out += href && inner.trim() ? `[${inner.trim()}](${href})` : inner;
                break;
            }
            default: out += inner;
        }
    }
    return out;
}

function table(node, base) {
    const rows = [...walk(node)].filter((n) => n.tag === "tr").map((tr) =>
        tr.children.filter((c) => c.tag === "td" || c.tag === "th")
            .map((cell) => inline(cell.children, base).replace(/\|/g, "\\|").replace(/\s+/g, " ").trim()));
    if (!rows.length) return "";
    const width = Math.max(...rows.map((row) => row.length));
    const line = (row) => `| ${Array.from({ length: width }, (_, i) => row[i] ?? "").join(" | ")} |`;
    return [line(rows[0]), line(Array(width).fill("---")), ...rows.slice(1).map(line)].join("\n");
}

function list(node, base, depth) {
    const ordered = node.tag === "ol";
    const items = node.children.filter((c) => c.tag === "li");
    return items.map((item, index) => {
        const marker = ordered ? `${index + 1}.` : "-";
        const nested = item.children.filter((c) => c.tag === "ul" || c.tag === "ol");
        const body = blocks(item.children.filter((c) => !nested.includes(c)), base, depth + 1).join("\n\n");
        const pad = " ".repeat(marker.length + 1);
        const first = `${marker} ${body.replace(/\n/g, "\n" + pad)}`.trimEnd();
        return [first, ...nested.map((n) => list(n, base, depth + 1).replace(/^/gm, pad))].join("\n");
    }).join("\n");
}

const hasBlock = (node) => node.children.some((c) => isElement(c) && (BLOCK.has(c.tag) || hasBlock(c)));

/** Block-level markdown pieces of a node list; loose inline content becomes paragraphs. */
function blocks(nodes, base, depth = 0) {
    const out = [];
    let run = [];
    const flush = () => {
        const text = inline(run, base).replace(/ *\n */g, "\n").trim();
        if (text) out.push(text);
        run = [];
    };
    for (const node of nodes) {
        if (!isElement(node) || (!BLOCK.has(node.tag) && !hasBlock(node))) {
            if (!isElement(node) || (!SKIP.has(node.tag) && node.tag !== "img")) run.push(node);
            continue;
        }
        if (SKIP.has(node.tag) || node.attrs.hidden !== undefined) continue;
        if (node.tag === "div" || node.tag === "section" || node.tag === "ul" || node.tag === "ol" || node.tag === "aside") {
            if (FURNITURE_RE.test(`${node.attrs.class ?? ""} ${node.attrs.id ?? ""}`)) continue;
        }
        flush();
        const level = /^h([1-6])$/.exec(node.tag)?.[1];
        if (level) {
            const text = inline(node.children, base).replace(/\s+/g, " ").trim();
            if (text) out.push(`${"#".repeat(level)} ${text}`);
        } else if (node.tag === "p" || node.tag === "figcaption" || node.tag === "summary" || node.tag === "dt") {
            const text = inline(node.children, base).replace(/ *\n */g, "\n").trim();
            if (text) out.push(text);
        } else if (node.tag === "pre") {
            const code = [...walk(node)].find((n) => n.tag === "code");
            const language = /(?:language|lang)-([\w+#-]+)/.exec(`${node.attrs.class ?? ""} ${code?.attrs.class ?? ""}`)?.[1] ?? "";
            const text = rawText(node);
            if (text.trim()) out.push(fence(text, language));
        } else if (node.tag === "ul" || node.tag === "ol") {
            const text = list(node, base, depth);
            if (text.trim()) out.push(text);
        } else if (node.tag === "blockquote") {
            const text = blocks(node.children, base, depth).join("\n\n");
            if (text) out.push(text.replace(/^/gm, "> "));
        } else if (node.tag === "table") {
            const text = table(node, base);
            if (text) out.push(text);
        } else if (node.tag === "hr") {
            out.push("---");
        } else {
            out.push(...blocks(node.children, base, depth));
        }
    }
    flush();
    return out;
}

/** Main content of an HTML page as markdown. */
export function htmlToMarkdown(html, baseUrl) {
    const root = parse(html);
    const content = findContent(root);
    const body = blocks([content], baseUrl);
    // the title often sits outside the content block: the h1, else (unless the content opens with a
    // heading) the nearest heading before the content, which skips a site name further up
    const order = new Map([...walk(root)].map((node, index) => [node, index]));
    const inside = new Set([content, ...walk(content)]);
    const outside = [...walk(root, true)].filter((node) => /^h[1-6]$/.test(node.tag) && !inside.has(node));
    const title = outside.find((node) => node.tag === "h1")
        ?? (body[0]?.startsWith("#") ? undefined : outside.filter((node) => order.get(node) < order.get(content)).at(-1));
    return [...(title ? blocks([title], baseUrl) : []), ...body].join("\n\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// --- fetching ----------------------------------------------------------------

const robotsCache = new Map();

async function get(url) {
    try {
        return await fetch(url, {
            headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
            redirect: "follow",
            signal: AbortSignal.timeout(60_000),
        });
    } catch (error) {
        throw new Error(`cannot fetch ${url}: ${error.cause?.code ?? error.message}`);
    }
}

/** Longest-match Allow/Disallow evaluation of robots.txt rules for our user agent (or `*`). */
function robotsAllows(robots, path) {
    let applies = false;
    let specific = false;
    let groupHasRules = false;
    const chosen = { generic: [], specific: [] };
    for (const raw of robots.split(/\r?\n/)) {
        const [field, ...rest] = raw.replace(/#.*/, "").split(":");
        const value = rest.join(":").trim();
        const key = field.trim().toLowerCase();
        if (key === "user-agent") {
            if (groupHasRules) { applies = false; specific = false; groupHasRules = false; }
            const agent = value.toLowerCase();
            if (agent === "*") applies = true;
            else if (USER_AGENT.toLowerCase().startsWith(agent) && agent) { applies = true; specific = true; }
        } else if ((key === "allow" || key === "disallow") && applies) {
            groupHasRules = true;
            (specific ? chosen.specific : chosen.generic).push({ allow: key === "allow", pattern: value });
        }
    }
    const rules = chosen.specific.length ? chosen.specific : chosen.generic;
    let best = { allow: true, length: -1 };
    for (const { allow, pattern } of rules) {
        if (!pattern) continue;
        const regex = new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
        if (regex.test(path) && pattern.length > best.length) best = { allow, length: pattern.length };
    }
    return best.allow;
}

async function allowedByRobots(url) {
    const { origin, pathname, search } = new URL(url);
    if (!robotsCache.has(origin)) {
        robotsCache.set(origin, get(`${origin}/robots.txt`).then((r) => (r.ok ? r.text() : "")).catch(() => ""));
    }
    return robotsAllows(await robotsCache.get(origin), pathname + search);
}

/** Medium blocks non-browser requests; the author's RSS feed carries the full text of recent posts. */
async function fetchMediumArticle(url) {
    const { pathname } = new URL(url);
    const author = /^\/(@[^/]+)\//.exec(pathname)?.[1];
    const id = /-([0-9a-f]{10,12})\/?$/.exec(pathname)?.[1];
    if (!author || !id) throw new Error(`cannot tell the Medium author or post id from ${url}`);
    const feedUrl = `https://medium.com/feed/${author}`;
    if (!(await allowedByRobots(feedUrl))) throw new Error(`robots.txt disallows ${feedUrl}`);
    const response = await get(feedUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${feedUrl}`);
    const xml = await response.text();
    const item = xml.split("<item>").slice(1).find((chunk) => chunk.includes(id));
    if (!item) throw new Error(`post ${id} is not in the latest posts of ${author}'s feed`);
    const title = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(item)?.[1].trim();
    const content = /<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/.exec(item)?.[1];
    if (!content) throw new Error(`no content in the feed item for ${url}`);
    return `# ${decode(title ?? "")}\n\n${htmlToMarkdown(content, url)}`;
}

/** Downloads `url` and returns its main content as markdown. Throws when nothing usable comes back. */
export async function fetchMarkdown(url) {
    const { hostname, protocol } = new URL(url);
    if (protocol !== "http:" && protocol !== "https:") throw new Error(`not an http(s) URL: ${url}`);
    const markdown = hostname === "medium.com" || hostname.endsWith(".medium.com")
        ? await fetchMediumArticle(url)
        : await fetchPage(url);
    if (markdown.length < MIN_LENGTH) throw new Error(`no content extracted from ${url} (${markdown.length} characters)`);
    return markdown;
}

async function fetchPage(url) {
    if (!(await allowedByRobots(url))) throw new Error(`robots.txt disallows ${url}`);
    const response = await get(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return htmlToMarkdown(await response.text(), response.url);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        process.stdout.write(await fetchMarkdown(process.argv[2]));
    } catch (error) {
        console.error(`error: ${error.message}`);
        process.exit(1);
    }
}
