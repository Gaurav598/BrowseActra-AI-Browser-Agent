#!/usr/bin/env node

/**
 * Guard project-owned product surfaces against inherited promotional links and
 * runtime imports. Historical attribution and the imported packages/docs site
 * are deliberately outside this check; they need their own scoped retirement.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directFiles = ["README.md", "CONTRIBUTING.md"];
const directories = ["apps", "docs", "packages"];
const supportedExtensions = new Set([
  ".js",
  ".mjs",
  ".ts",
  ".tsx",
  ".html",
  ".md",
  ".mdx",
  ".json",
  ".css",
]);
const patterns = [
  ["upstream product site", /https?:\/\/(?:docs\.)?stagehand\.dev\b/i],
  ["upstream community promotion", /https?:\/\/discord\.gg\/stagehand\b/i],
  ["upstream support address", /support@browserbase\.com/i],
  ["upstream popularity badge", /trendshift\.io\/repositories\/12122/i],
  ["upstream generated encyclopedia", /deepwiki\.com\/browserbase\/stagehand/i],
  [
    "upstream brand image",
    /raw\.githubusercontent\.com\/browserbase\/stagehand\/[^\s"']+\/media\/(?:light|dark)_logo/i,
  ],
];
const runtimeImportPatterns = [
  ["inherited Stagehand package import", /\bfrom\s+["']@browserbasehq\/stagehand(?:["'/]|$)/],
  ["inherited Stagehand module import", /\bfrom\s+["']stagehand(?:["'/]|$)/],
];

async function sourceFiles(directory) {
  let entries;
  try {
    entries = await readdir(path.join(root, directory), { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (directory === "packages" && !entry.name.startsWith("browseactra-")) continue;
      files.push(...(await sourceFiles(relative)));
    } else if (entry.isFile() && supportedExtensions.has(path.extname(entry.name))) {
      files.push(relative);
    }
  }
  return files;
}

const files = [...directFiles];
for (const directory of directories) files.push(...(await sourceFiles(directory)));

const failures = [];
for (const relative of files) {
  const content = await readFile(path.join(root, relative), "utf8");
  const patternsForFile =
    relative.startsWith("apps/") || relative.startsWith("packages/browseactra-")
      ? [...patterns, ...runtimeImportPatterns]
      : patterns;
  for (const [label, expression] of patternsForFile) {
    const match = expression.exec(content);
    if (!match) continue;
    const line = content.slice(0, match.index).split("\n").length;
    failures.push(`${relative}:${line}: ${label}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`BrowseActra brand check failed:\n${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`BrowseActra brand check passed (${files.length} project-owned files).\n`);
}
