// scripts/sync/utils.js

const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const matter = require('gray-matter');
const { readFileSync } = require('fs');

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn('⚠️ ', ...a);
const err = (...a) => console.error('❌ ', ...a);

function getFileHash(filePath) {
  try {
    const fileBuffer = readFileSync(filePath);
    const hash = crypto.createHash('sha1').update(fileBuffer).digest('hex');
    return hash;
  } catch (e) {
    return 'HASH_ERROR';
  }
}

async function readDoc(absPath) {
  const src = await fs.readFile(absPath, 'utf8');
  const parsed = matter(src);
  return { content: parsed.content || '', fm: parsed.data || {} };
}

async function findMarkdownFiles(dir) {
  let files = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return files;
    throw e;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (
      entry.name.startsWith('.') ||
      entry.name.startsWith('_category.yml') ||
      entry.name.startsWith('.readme-structure.json')
    )
      continue;
    if (entry.isDirectory()) {
      files = files.concat(await findMarkdownFiles(fullPath));
    } else if (entry.isFile() && (entry.name.endsWith('.md') || entry.name.endsWith('.mdx'))) {
      files.push(fullPath);
    }
  }
  return files;
}

module.exports = {
  log,
  warn,
  err,
  getFileHash,
  readDoc,
  findMarkdownFiles,
};