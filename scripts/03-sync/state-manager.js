// scripts/sync/state-manager.js

const fs = require('fs-extra');
const path = require('path');
let pMap = require('p-map');
if (typeof pMap !== 'function') { pMap = pMap.default; }
const fg = require('fast-glob');
const yaml = require('js-yaml');
const config = require('./config.js');
const utils = require('./utils.js');
const apiClient = require('./api-client.js');

// FIX: This function now builds the local state from the file system first,
// ensuring that deleted files/categories are correctly identified as missing.
async function loadLocalState() {
  utils.log('1. Loading local hierarchy and content...');
  
  const localCategories = new Map();
  const localDocsBySlug = new Map();

  // Step 1: Find all category definition files (_category.yml) as the ground truth for categories.
  const categoryFiles = await fg('**/_category.yml', { cwd: config.CONFIG.DOCS_ROOT, onlyFiles: true });
  for (const relPath of categoryFiles) {
    const absPath = path.join(config.CONFIG.DOCS_ROOT, relPath);
    try {
      const obj = yaml.load(await fs.readFile(absPath, 'utf8')) || {};
      if (obj.slug && obj.title) {
        localCategories.set(obj.slug.toLowerCase(), {
          slug: obj.slug.toLowerCase(),
          title: obj.title,
          type: obj.type || 'guide',
        });
      }
    } catch (e) {
      utils.warn(`Could not parse category file: ${relPath}`);
    }
  }

  // Step 2: Find all Markdown files as the ground truth for documents.
  const localMdFiles = await utils.findMarkdownFiles(config.CONFIG.DOCS_ROOT);
  for (const absPath of localMdFiles) {
    const { fm, content } = await utils.readDoc(absPath);
    const slug = fm.slug?.toLowerCase();
    
    if (!slug) {
      utils.warn(`Skipping file with no slug: ${path.relative(process.cwd(), absPath)}.`);
      continue;
    }

    // Basic record from front matter
    localDocsBySlug.set(slug, {
      slug,
      title: fm.title || 'Untitled',
      categorySlug: fm.category?.toLowerCase(),
      parentDocSlug: fm.parent?.toLowerCase() || null,
      order: fm.order,
      hidden: !!fm.hidden,
      excerpt: fm.excerpt ?? '',
      content: content.trim(),
      absPath,
    });
  }

  // Step 3 (Optional but good): Use the manifest to enrich order/parent info if it's missing from front matter.
  // This part is less critical now, as the primary source is the file system.
  // For now, we rely purely on the file system's front matter for hierarchy.

  return { categories: localCategories, docs: localDocsBySlug };
}

async function fetchAndPaginateCategories() {
  const all = [];
  let page = 1;
  while (true) {
    const res = await apiClient.throttledApiCall('get', '/categories', { page, perPage: 100 });
    if (!res.data || res.data.length === 0) break;
    all.push(...res.data);
    if (res.data.length < 100) break;
    page += 1;
  }
  return all;
}

function flattenRemoteDocs(nestedDocs, categorySlug, parentSlug, remoteDocs) {
  if (!nestedDocs) return;
  for (const doc of nestedDocs) {
    remoteDocs.set(doc.slug.toLowerCase(), {
      id: doc._id,
      title: doc.title,
      categorySlug: categorySlug,
      parentDocSlug: parentSlug,
      order: doc.order,
      hidden: doc.hidden,
      excerpt: doc.excerpt || '',
    });
    if (doc.children) flattenRemoteDocs(doc.children, categorySlug, doc.slug, remoteDocs);
  }
}

async function fetchRemoteState() {
  utils.log('2. Fetching remote state from ReadMe...');
  const remoteCategories = new Map();
  const remoteDocs = new Map();

  const allCategoriesData = await fetchAndPaginateCategories();
  const remoteCategoryList = allCategoriesData.filter(c => c.type === 'guide');
  utils.log(`   - Found ${remoteCategoryList.length} remote guide categories.`);

  remoteCategoryList.forEach(c => {
    remoteCategories.set(c.slug.toLowerCase(), { id: c._id, slug: c.slug.toLowerCase(), title: c.title, type: c.type });
  });

  await pMap(
    remoteCategoryList,
    async (cat) => {
      try {
        const res = await apiClient.throttledApiCall('get', `/categories/${cat.slug}/docs`);
        flattenRemoteDocs(res.data, cat.slug.toLowerCase(), null, remoteDocs);
      } catch (e) {
        utils.warn(`   - Failed to fetch docs for category ${cat.slug}: ${e.message}`);
      }
    },
    { concurrency: config.CONFIG.MAX_CONCURRENT_API_CALLS }
  );

  utils.log(`   - Found ${remoteDocs.size} remote docs with details.`);
  return { categories: remoteCategories, docs: remoteDocs };
}

exports.loadLocalState = loadLocalState;
exports.fetchRemoteState = fetchRemoteState;