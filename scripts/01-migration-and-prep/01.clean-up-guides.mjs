#!/usr/bin/env node
/**
 * cleanup-guides-only.mjs
 *
 * Keeps only ReadMe "guide" docs.
 * - Fetches all categories (pagination)
 * - Treats any category with reference !== true as guide
 * - Builds whitelist of guide doc slugs
 * - Deletes non-guide .md files and prunes empty folders
 * - Summary to console, detailed report to CSV
 * - Supports --dry-run and --report=<path>
 */

import fs from "fs";
import path from "path";
import axios from "axios";
import matter from "gray-matter";
import "dotenv/config";

const ROOT = "docs";
const DRY_RUN = process.argv.includes("--dry-run");
const REPORT_ARG = process.argv.find(a => a.startsWith("--report="));
const REPORT_PATH = REPORT_ARG ? REPORT_ARG.split("=")[1] : "cleanup-report.csv";

const API = process.env.README_API || "https://dash.readme.com/api/v1";
const KEY = process.env.README_API_KEY;

if (!KEY) {
  console.error("❌ Missing README_API_KEY in .env");
  process.exit(1);
}

const client = axios.create({
  baseURL: API,
  headers: {
    Accept: "application/json",
    Authorization: `Basic ${Buffer.from(`${KEY}:`).toString("base64")}`,
  },
  responseType: "json",
});

const norm = (s) =>
  (s || "")
    .normalize("NFKD")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[^\w\- ]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase();

const listDirEntries = (dir) =>
  fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : [];

const listMdFiles = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const e of listDirEntries(d)) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && p.endsWith(".md")) out.push(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
};

const rmPath = (p) => {
  if (!DRY_RUN) fs.rmSync(p, { recursive: true, force: true });
};

const isFolderEmptyOfMarkdown = (folder) => {
  const entries = listDirEntries(folder);
  for (const e of entries) {
    const full = path.join(folder, e.name);
    if (e.isDirectory() && !isFolderEmptyOfMarkdown(full)) return false;
    if (e.isFile() && e.name.endsWith(".md")) return false;
  }
  return true;
};

// --- ReadMe API helpers ---
async function getAllCategories() {
  const all = [];
  let page = 1;
  const pageSize = 20; // ReadMe default

  while (true) {
    const res = await client.get("/categories", {
      params: { page, perPage: pageSize },
    });

    const data =
      Array.isArray(res.data) ? res.data :
      Array.isArray(res.data?.data) ? res.data.data :
      [];

    if (!data.length) break;

    all.push(...data);
    console.log(`📄 Page ${page}: fetched ${data.length} categories (total ${all.length})`);

    // Stop if fewer than pageSize results (no next page)
    if (data.length < pageSize) break;

    page += 1;
  }

  console.log(`📦 Retrieved total categories: ${all.length}\n`);
  return all;
}


async function getGuideDocSlugsForCategory(slug) {
  const res = await client.get(`/categories/${slug}/docs`);
  const arr = Array.isArray(res.data) ? res.data : res.data?.data || [];
  const out = [];
  const walk = (nodes) => {
    for (const n of nodes) {
      out.push(norm(n.slug));
      if (n.children?.length) walk(n.children);
    }
  };
  walk(arr);
  return out;
}

// --- Main ---
async function main() {
  console.log(`🧹 Starting guide-only cleanup ${DRY_RUN ? "(DRY-RUN)" : ""}\n`);

  const categories = await getAllCategories();
  console.log(`📦 Retrieved ${categories.length} total categories from ReadMe.`);

  const guideCats = categories.filter((c) => c.reference !== true && c.type !== "reference");
  console.log(`📘 Guide categories detected: ${guideCats.length}`);
  console.log(
    "   →",
    guideCats
      .slice(0, 15)
      .map((c) => c.title)
      .join(", "),
    guideCats.length > 15 ? "..." : ""
  );

  // collect guide slugs
  const guideSlugs = new Set();
// Collect only actual doc slugs (no category slugs)
for (const g of guideCats) {
  const docSlugs = await getGuideDocSlugsForCategory(g.slug);
  docSlugs.forEach((s) => guideSlugs.add(s));
}
  console.log(`📑 Total guide doc slugs: ${guideSlugs.size}\n`);

  const report = [];
  const allFiles = listMdFiles(ROOT);
  let deletedFiles = 0;

  for (const filePath of allFiles) {
    let slugToCheck;
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const parsed = matter(content);
      const fmSlug = parsed.data?.slug ? norm(parsed.data.slug) : null;
      slugToCheck = fmSlug || norm(path.basename(filePath, ".md"));
    } catch {
      slugToCheck = norm(path.basename(filePath, ".md"));
    }

    const isGuide = guideSlugs.has(slugToCheck);
    if (!isGuide) {
      deletedFiles++;
      report.push([filePath, slugToCheck, "DELETE"]);
      rmPath(filePath);
    } else {
      report.push([filePath, slugToCheck, "KEEP"]);
    }
  }

  // prune empty folders
  let foldersDeleted = 0;
  const pruneEmpty = (dir) => {
    for (const e of listDirEntries(dir)) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) pruneEmpty(p);
    }
    if (dir !== ROOT && isFolderEmptyOfMarkdown(dir)) {
      rmPath(dir);
      foldersDeleted++;
      report.push([dir, "-", "DELETE_FOLDER"]);
    }
  };
  pruneEmpty(ROOT);

  // write report
  try {
    const header = "path,slug,action\n";
    const rows = report.map(([p, s, a]) => `"${p.replace(/"/g, '""')}","${s}","${a}"`);
    fs.writeFileSync(REPORT_PATH, header + rows.join("\n"), "utf8");
    console.log(`📝 Detailed report written to ${REPORT_PATH}`);
  } catch (e) {
    console.warn(`⚠️  Could not write report: ${e.message}`);
  }

  console.log("\n✅ Cleanup complete.\n");
  console.log("🧾 Summary:");
  console.log(`   • Guide categories: ${guideCats.length}`);
  console.log(`   • Guide slugs: ${guideSlugs.size}`);
  console.log(`   • Files scanned: ${allFiles.length}`);
  console.log(`   • Files deleted: ${deletedFiles}`);
  console.log(`   • Folders deleted: ${foldersDeleted}`);
  console.log(`   • Report: ${REPORT_PATH}\n`);
}

main().catch((err) => {
  console.error("❌ Cleanup failed");
  if (err.response) {
    console.error("🔗 URL:", err.config?.url);
    console.error("📡 Status:", err.response.status);
    console.error("💬 Response:", JSON.stringify(err.response.data, null, 2));
  } else {
    console.error("💥 Error:", err.message);
  }
  process.exit(1);
});
