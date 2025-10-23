// scripts/hierarchy-manager/index-manager.mjs

import fs from 'fs-extra';
import path from 'path';
import fg from 'fast-glob';
import yaml from 'js-yaml';
import matter from 'gray-matter'; 

import { 
    DOCS_ROOT, 
    STRUCTURE_MANIFEST, 
    MAX_DOC_DEPTH, 
    log, 
    warn, 
    DRY_RUN 
} from './utils.mjs'; 

// ... (loadCategories, loadDocsIndex, and other functions are unchanged) ...

export async function loadCategories() {
  const ymls = await fg('**/_category.yml', { cwd: DOCS_ROOT, onlyFiles: true });
  const list = [];

  for (const rel of ymls) {
    const abs = path.join(DOCS_ROOT, rel);
    const dir = path.dirname(abs);
    const obj = yaml.load(await fs.readFile(abs, 'utf8')) || {};
    
    if (!obj?.slug || !obj?.title) {
        warn(`⚠️ Skipping invalid _category.yml at ${path.relative(DOCS_ROOT, rel)}: missing slug or title.`);
        continue;
    }

    const folderName = path.basename(dir);
    if (folderName.toLowerCase() !== String(obj.slug).toLowerCase()) {
      warn(
        `⚠️  Folder "${folderName}" does not match slug "${obj.slug}" in _category.yml. ` +
        `This is fine (title-based export), but consider renaming for consistency.`
      );
    }

    list.push({
      slug: String(obj.slug),
      title: String(obj.title),
      folderAbs: dir,
      ymlAbs: abs,
    });
  }

  const bySlug = new Map();
  list.forEach((c) => {
    const key = c.slug.toLowerCase();
    if (!bySlug.has(key)) bySlug.set(key, c);
  });

  return { list: [...list], bySlug };
}

export async function loadDocsIndex() {
  const files = await fg(['**/*.md', '**/*.mdx'], {
    cwd: DOCS_ROOT,
    onlyFiles: true,
    ignore: ['**/_category.yml', '**/.readme-structure.json'],
  });

  const bySlug = new Map();
  const byPath = new Map();
  const duplicates = new Map();
  
  for (const rel of files) {
    const abs = path.join(DOCS_ROOT, rel);
    
    const src = await fs.readFile(abs, 'utf8');
    const { data: fm } = matter(src);
    
    const slug = (fm.slug || '').trim();
    if (!slug) continue;

    const info = {
      slug,
      title: fm.title ?? '',
      category: fm.category ?? '',
      parent: fm.parent ?? null,
      order: typeof fm.order === 'number' ? fm.order : undefined,
      hidden: typeof fm.hidden === 'boolean' ? fm.hidden : undefined,
      abs,
      rel,
    };
    byPath.set(abs, info);
    
    if (bySlug.has(slug)) {
      if (!duplicates.has(slug)) duplicates.set(slug, [bySlug.get(slug).rel]);
      duplicates.get(slug).push(rel);
    } else {
      bySlug.set(slug, info);
    }
  }

  return { bySlug, byPath, duplicates };
}

export function requireUniqueSlugs(docsIndex) {
  const duplicates = docsIndex.duplicates;
  if (duplicates.size) {
    warn('⚠️  Duplicate slugs detected. Resolve before proceeding:');
    for (const [slug, paths] of duplicates.entries()) {
      warn(`   • ${slug}`);
      for (const p of paths) warn(`     - ${p}`);
    }
    throw new Error('Duplicate slugs found');
  }
}

function buildAncestryMap(docsBySlug) {
  const get = (s) => docsBySlug.get(s);
  const parentOf = (s) => (get(s)?.parent ? get(s).parent : null);

  function depthOf(slug) {
    let d = 1;
    let cur = slug;
    while (true) {
      const p = parentOf(cur);
      if (!p) break;
      d += 1;
      cur = p;
      if (d > MAX_DOC_DEPTH + 1) break; 
    }
    return d;
  }

  return { parentOf, depthOf };
}

export function computeExpectedPath(doc, docsIndex, categories) {
    const categoryRecord = categories.bySlug.get(doc.category.toLowerCase());
    if (!categoryRecord) return null;

    const { parentOf } = buildAncestryMap(docsIndex.bySlug);
    const folderChain = [];
    let cursor = doc.parent; 

    while(cursor) {
        folderChain.unshift(cursor);
        cursor = parentOf(cursor); 
    }
    
    return path.join(
        categoryRecord.folderAbs, 
        ...folderChain, 
        `${doc.slug}.md`
    );
}

export function validateSameCategoryParent(doc, parentDoc) {
  if (!parentDoc) return null; 
  if (doc.category !== parentDoc.category) {
    return `Parent category mismatch: Doc "${doc.slug}" (Category: ${doc.category}) must belong to the same category as parent "${parentDoc.slug}" (Category: ${parentDoc.category}).`;
  }
  return null;
}

function validatePhysicalLocation(docsIndex, categories, errors) {
    const docs = docsIndex.bySlug.values();

    for (const doc of docs) {
        const categoryRecord = categories.bySlug.get(doc.category.toLowerCase());
        if (!categoryRecord) continue; 

        const expectedPath = computeExpectedPath(doc, docsIndex, categories);

        if (!expectedPath) continue; 

        const actualPath = doc.abs;

        if (path.resolve(actualPath).toLowerCase() !== path.resolve(expectedPath).toLowerCase()) {
            errors.push(
                `PHYSICAL MISMATCH for "${doc.slug}" in category "${doc.category}": ` +
                `Actual: ${path.relative(DOCS_ROOT, actualPath)} | ` +
                `Expected: ${path.relative(DOCS_ROOT, expectedPath)}`
            );
        }
    }
}

async function validateManifestConsistency(docsIndex, categories, errors) {
  if (!await fs.pathExists(STRUCTURE_MANIFEST)) {
    errors.push(`MANIFEST MISSING: The '.readme-structure.json' file does not exist. Please run 'Rebuild manifest'.`);
    return;
  }

  const manifestDocMap = new Map();
  const manifestCategorySlugs = new Set();
  try {
    const manifest = JSON.parse(await fs.readFile(STRUCTURE_MANIFEST, 'utf8'));
    
    const flatten = (docs, categorySlug) => {
      docs.forEach(doc => {
        manifestDocMap.set(doc.slug, { category: categorySlug, parent: doc.parent || null });
        if (doc.children) flatten(doc.children, categorySlug);
      });
    };

    manifest.categories.forEach(cat => {
        manifestCategorySlugs.add(cat.slug);
        flatten(cat.docs, cat.slug);
    });

  } catch (e) {
    errors.push(`MANIFEST INVALID: Could not parse '.readme-structure.json'. It may be corrupt.`);
    return;
  }
  
  const fileSystemCategorySlugs = new Set([...categories.bySlug.keys()].map(k => k.toLowerCase()));

  for (const slug of manifestCategorySlugs) {
    if (!fileSystemCategorySlugs.has(slug.toLowerCase())) {
        errors.push(`MANIFEST MISMATCH: Category "${slug}" exists in the manifest but its folder is MISSING from the disk. Please run 'Rebuild manifest'.`);
    }
  }
  for (const slug of fileSystemCategorySlugs) {
      if (!manifestCategorySlugs.has(slug)) {
          errors.push(`MANIFEST MISMATCH: Category "${slug}" exists on disk but is MISSING from the manifest. Please run 'Rebuild manifest'.`);
      }
  }


  for (const doc of docsIndex.bySlug.values()) {
    const manifestDoc = manifestDocMap.get(doc.slug);
    if (!manifestDoc) {
      errors.push(`MANIFEST MISMATCH for "${doc.slug}": Doc exists on disk but is MISSING from the manifest. Please run 'Rebuild manifest'.`);
      continue;
    }
    if (doc.category !== manifestDoc.category) {
      errors.push(`MANIFEST MISMATCH for "${doc.slug}": Front matter has category "${doc.category}", but manifest has "${manifestDoc.category}". Please run 'Rebuild manifest'.`);
    }
    if (doc.parent !== manifestDoc.parent) {
      errors.push(`MANIFEST MISMATCH for "${doc.slug}": Front matter has parent "${doc.parent || 'null'}", but manifest has "${manifestDoc.parent || 'null'}". Please run 'Rebuild manifest'.`);
    }
  }

  for (const manifestSlug of manifestDocMap.keys()) {
    if (!docsIndex.bySlug.has(manifestSlug)) {
      errors.push(`MANIFEST MISMATCH for "${manifestSlug}": Doc is listed in the manifest but the file is MISSING from the disk. Please run 'Rebuild manifest'.`);
    }
  }
}

export async function validateStructure(categories, docsIndex, options = {}) {
  const { skipManifestCheck = false } = options;
  const errors = [];
  const docs = docsIndex.bySlug;
  const { parentOf, depthOf } = buildAncestryMap(docs);

  requireUniqueSlugs(docsIndex);

  for (const d of docs.values()) {
    if (d.parent && !docs.has(d.parent)) {
        errors.push(`Missing Parent: Doc "${d.slug}" references parent "${d.parent}", but no doc with that slug exists.`);
    }

    const parentDoc = d.parent ? docs.get(d.parent) : null;
    const parentMismatchError = validateSameCategoryParent(d, parentDoc);
    if (parentMismatchError) {
      errors.push(parentMismatchError);
    }
    
    const depth = depthOf(d.slug);
    if (depth > MAX_DOC_DEPTH) {
      errors.push(`Max Depth Exceeded: Doc "${d.slug}" exceeds max depth (Level ${depth} > max ${MAX_DOC_DEPTH}).`);
    }

    let cur = d.parent;
    const seen = new Set([d.slug]);
    while (cur) {
      if (seen.has(cur)) {
        errors.push(`Circular Dependency: Cycle detected involving "${d.slug}" and parent "${cur}".`);
        break;
      }
      seen.add(cur);
      cur = parentOf(cur);
    }

    if (!categories.bySlug.has(d.category.toLowerCase())) {
        errors.push(`Missing Category: Doc "${d.slug}" references category "${d.category}", which has no local _category.yml.`);
    }
  }

  validatePhysicalLocation(docsIndex, categories, errors);

  if (!skipManifestCheck) {
    await validateManifestConsistency(docsIndex, categories, errors);
  }

  if (errors.length > 0) {
    const errorString = "\n" + errors.map((e, i) => `   ${i + 1}. ${e}`).join('\n');
    throw new Error(`Structure Validation Failed:\n${errorString}\n\nFIX ALL ERRORS. For manifest mismatches, running 'Rebuild manifest' is recommended.`);
  }
}

function buildNestedForManifestWithParent(tree, currentParentSlug = null) {
  return (tree || []).map(node => {
    const item = {
      slug: node.slug,
      title: node.title,
      order: typeof node.order === 'number' ? node.order : 9999,
      parent: currentParentSlug, 
      children: buildNestedForManifestWithParent(node.children || [], node.slug),
    };
    return item;
  });
}

export async function rebuildManifest(docsIndex, categories) {
  await validateStructure(categories, docsIndex, { skipManifestCheck: true }); 

  const docs = [...docsIndex.bySlug.values()];
  const cats = categories.list;

  // **MODIFICATION START**
  // Sort the categories array alphabetically by slug to ensure a consistent order.
  cats.sort((a, b) => a.slug.localeCompare(b.slug));
  // **MODIFICATION END**

  const nodeMap = new Map(
    docs.map((d) => [
      d.slug,
      {
        slug: d.slug,
        title: d.title || d.slug,
        order: typeof d.order === 'number' ? d.order : 9999,
        parent: d.parent ?? null, 
        children: [],
      },
    ])
  );

  for (const d of docs) {
    if (d.parent && nodeMap.has(d.parent)) {
      nodeMap.get(d.parent).children.push(nodeMap.get(d.slug));
    }
  }

  const byCategory = new Map();
  for (const cat of cats) byCategory.set(cat.slug, []);
  for (const d of docs) {
    if (!categories.bySlug.has(d.category.toLowerCase())) continue; 

    if (!byCategory.has(d.category)) byCategory.set(d.category, []);
    if (!d.parent) byCategory.get(d.category).push(nodeMap.get(d.slug));
  }

  const sortTree = (arr) => {
    arr.sort((a, b) => (a.order - b.order) || a.slug.localeCompare(b.slug));
    arr.forEach((n) => sortTree(n.children));
  };
  for (const arr of byCategory.values()) sortTree(arr);

  const manifest = {
    categories: cats.map((c) => ({
      slug: c.slug,
      title: c.title,
      docs: buildNestedForManifestWithParent(byCategory.get(c.slug) || [], null),
    })),
  };

  if (DRY_RUN) {
    log(`🪴 [DRY-RUN] Would write manifest: ${path.relative(process.cwd(), STRUCTURE_MANIFEST)}`);
  } else {
    await fs.ensureDir(path.dirname(STRUCTURE_MANIFEST));
    await fs.writeFile(STRUCTURE_MANIFEST, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  }

  return { manifestWritten: !DRY_RUN };
}