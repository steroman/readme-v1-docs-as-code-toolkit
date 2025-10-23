// scripts/hierarchy-manager/doc-manager.mjs

import fs from 'fs-extra';
import path from 'path';
import inquirer from 'inquirer';
import { 
    readDoc, 
    writeDoc, 
    log, 
    warn, 
    DRY_RUN,
    DOCS_ROOT,
    MAX_DOC_DEPTH
} from './utils.mjs'; 
import { 
    validateSameCategoryParent, 
    computeExpectedPath 
} from './index-manager.mjs'; 

// ---------------------------
// Doc Move Helpers
// ---------------------------

/**
 * Recursively collects all descendant slugs of a root slug.
 */
function collectDescendants(rootSlug, docsBySlug) { 
  const descendants = [];
  const find = (parentSlug) => {
    for (const doc of docsBySlug.values()) {
      if (doc.parent === parentSlug) {
        descendants.push(doc.slug);
        find(doc.slug);
      }
    }
  };
  find(rootSlug);
  return descendants;
} 

/**
 * Simple depth check (max depth 3 is implicitly enforced by validateStructure)
 * @param {string|null} targetParentSlug The slug of the prospective new parent.
 */
function validateMaxDepth(targetParentSlug, docsBySlug) { 
  if (!targetParentSlug) return; // Top-level is fine
  
  // NOTE: This re-builds the ancestry map, which is fine for utility functions
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
  
  // Calculate depth if we were to put a *new* doc under targetParentSlug
  const hypotheticalDepth = depthOf(targetParentSlug) + 1;
  
  if (hypotheticalDepth > MAX_DOC_DEPTH) {
      throw new Error(`Max Depth Exceeded: Moving here would result in depth ${hypotheticalDepth} > max ${MAX_DOC_DEPTH}.`);
  }
} 

/**
 * Determines if destination slug is a Category or a Doc.
 * @returns {object} { destCategory, destDoc }
 */
function assertDestinationExists(destination, categories, docsIndex) { 
  const destCategory = categories.bySlug.get(destination.toLowerCase()) || null;
  const destDoc = docsIndex.bySlug.get(destination) || null;
  
  if (destCategory && destDoc) {
      log(`⚠️ Destination slug "${destination}" is both a Category and a Doc. Treating as Category.`);
      return { destCategory, destDoc: null };
  }
  
  return { destCategory, destDoc };
} 

/**
 * Computes the final absolute path for a doc move.
 */
function targetDocPath(categoryFolderAbs, ancestrySlugs, slug) { 
    return path.join(
        categoryFolderAbs, 
        ...ancestrySlugs, 
        `${slug}.md`
    );
} 

/**
 * Calculates the new full folder chain for a document (including a moved root or its descendant).
 */
function calculateNewPathChain(docSlug, docsBySlug) {
    const get = (s) => docsBySlug.get(s);
    const parentOf = (s) => (get(s)?.parent ? get(s).parent : null);
    
    // Build the full folder chain for the doc based on its *new* parent in docsBySlug
    const chain = [];
    let cursor = parentOf(docSlug);

    while (cursor) {
        chain.unshift(cursor);
        cursor = parentOf(cursor);
        
        if (chain.length > MAX_DOC_DEPTH) { 
            throw new Error(`Path Chain Error: Detected unusually long chain for ${docSlug}. Check for cycles.`);
        }
    }
    
    return chain;
}


// ---------------------------
// BULK MOVE (multi-source → one destination)
// ---------------------------

export async function bulkMoveFlow(categories, docsIndex) {
  // 1) Source slugs (interactive unless provided via CLI)
  const cliFromArgIdx = process.argv.findIndex(a => a === '--from');
  let sourcesRaw = null;
  if (cliFromArgIdx >= 0 && process.argv[cliFromArgIdx + 1]) {
    sourcesRaw = process.argv[cliFromArgIdx + 1];
  } else {
    const ans = await inquirer.prompt([
      {
        name: 'sourceSlugs',
        type: 'input',
        message: 'Enter source doc slugs (comma or space separated):',
      },
    ]);
    sourcesRaw = ans.sourceSlugs || '';
  }
  const sourceSlugs = sourcesRaw
    .split(/[,\s]+/)
    .map(s => s.trim())
    .filter(Boolean);

  if (!sourceSlugs.length) throw new Error('No source slugs provided.');

  // 2) Destination slug (interactive unless provided via CLI)
  const cliToArgIdx = process.argv.findIndex(a => a === '--to');
  let destination = null;
  if (cliToArgIdx >= 0 && process.argv[cliToArgIdx + 1]) {
    destination = process.argv[cliToArgIdx + 1].trim();
  } else {
    const ans = await inquirer.prompt([
      { name: 'destination', type: 'input', message: 'Enter destination slug (category or doc):' },
    ]);
    destination = (ans.destination || '').trim();
  }
  if (!destination) throw new Error('No destination slug provided.');

  // 3) Detect destination type
  const { destCategory, destDoc } = assertDestinationExists(destination, categories, docsIndex);

  if (!destCategory && !destDoc) {
    throw new Error(`Destination slug "${destination}" is neither a valid Category nor a valid Doc slug.`);
  }

  // 4) Global child-handling mode
  const sourcesWithChildren = sourceSlugs
    .map(s => ({ slug: s, children: collectDescendants(s, docsIndex.bySlug) }))
    .filter(x => x.children.length > 0);

  let childMode = 'ask'; 
  if (sourcesWithChildren.length > 0) {
    const { choice } = await inquirer.prompt([
      {
        name: 'choice',
        type: 'list',
        message: `Some of the selected docs have children. How should I handle them?`,
        choices: [
          { name: 'Ask me for each doc', value: 'ask' },
          { name: 'Move all with their children', value: 'move_all' },
          { name: 'Move all without their children (promote all children)', value: 'promote_all' },
        ],
      },
    ]);
    childMode = choice;
  }

  // 5) Build a unified plan (Determine category/parent/children)
  const plans = []; 

  for (const sourceSlug of sourceSlugs) {
    const src = docsIndex.bySlug.get(sourceSlug);
    if (!src) throw new Error(`Source doc "${sourceSlug}" not found locally.`);

    let targetCategorySlug = null;
    let targetParentSlug = null;
    let targetCategoryFolderAbs = null;

    if (destCategory) {
      targetCategorySlug = destCategory.slug;        
      targetParentSlug = null;
      targetCategoryFolderAbs = destCategory.folderAbs;
    } else { // destDoc
      targetCategorySlug = destDoc.category;         
      targetParentSlug = destDoc.slug;
      const owningCat = categories.bySlug.get(targetCategorySlug.toLowerCase());
      if (!owningCat) {
        throw new Error(`Category record for "${targetCategorySlug}" not found. Check _category.yml.`);
      }
      targetCategoryFolderAbs = owningCat.folderAbs;
    }

    // Validation checks for this source → destination
    const tempDoc = { ...src, category: targetCategorySlug, parent: targetParentSlug };
    const targetParentDoc = targetParentSlug ? docsIndex.bySlug.get(targetParentSlug) : null;
    const sameCategoryError = validateSameCategoryParent(tempDoc, targetParentDoc);
    if (sameCategoryError) {
        throw new Error(sameCategoryError);
    }
    validateMaxDepth(targetParentSlug, docsIndex.bySlug); // Validates the root doc move/parenting

    // FIX: The variable 'docsBySlug' was used here instead of 'docsIndex.bySlug'
    const descendants = collectDescendants(sourceSlug, docsIndex.bySlug);
    
    // Decide child behavior
    let moveChildren = true; 
    if (descendants.length > 0) {
      if (childMode === 'move_all') moveChildren = true;
      else if (childMode === 'promote_all') moveChildren = false;
      else {
        // ask-per-doc
        const previewKids = descendants.slice(0, 5).join(', ') + (descendants.length > 5 ? ', …' : '');
        const { perDocChoice } = await inquirer.prompt([
          {
            name: 'perDocChoice',
            type: 'confirm',
            message: `Doc "${sourceSlug}" has ${descendants.length} children (${previewKids}). Move them too?`,
            default: true,
          },
        ]);
        moveChildren = perDocChoice;
      }
    }

    plans.push({
      sourceSlug,
      src,
      targetCategorySlug,
      targetParentSlug,
      targetCategoryFolderAbs,
      descendants,
      moveChildren,
    });
  }

  // 6) Expand plans to concrete file ops (moves + FM updates) and promotions
  const fileOps = []; // { slug, from, to, newCategory, setParentTo }
  const promotions = []; // { slug, fromParent, category }
  
  // Create a writable copy of docsBySlug to temporarily apply FM changes for path calculation
  const workingDocsBySlug = new Map(docsIndex.bySlug); 

  for (const plan of plans) {
    const { sourceSlug, targetCategorySlug, targetParentSlug, targetCategoryFolderAbs, moveChildren, descendants } = plan;

    // Apply frontmatter changes to the working copy (critical for correct path calculation)
    const originalRootDoc = workingDocsBySlug.get(sourceSlug);
    const rootDocCopy = { ...originalRootDoc, category: targetCategorySlug, parent: targetParentSlug ?? null };
    workingDocsBySlug.set(sourceSlug, rootDocCopy);

    // Collect all slugs that need to be moved/updated
    const slugsToMove = [sourceSlug, ...(moveChildren ? descendants : [])];

    for (const s of slugsToMove) {
        const doc = workingDocsBySlug.get(s);
        
        // The new parent is the destination parent for the root, and the original parent for descendants.
        let newParent = doc.parent; 
        if (s === sourceSlug) {
            newParent = targetParentSlug ?? null;
        } 
        
        // Update the working model for descendants too, as they inherit the root's new category
        if (s !== sourceSlug) {
            const descendantCopy = { ...doc, category: targetCategorySlug };
            workingDocsBySlug.set(s, descendantCopy);
        }
        
        // Calculate the path based on the *updated working model* (new parent/category)
        const finalChain = calculateNewPathChain(s, workingDocsBySlug);
        const toPath = targetDocPath(targetCategoryFolderAbs, finalChain, s);
        
        // Use the canonical path stored in the original index.
        const fromPath = docsIndex.bySlug.get(s).abs; 
        
        fileOps.push({
            slug: s,
            from: fromPath,
            to: toPath,
            newCategory: targetCategorySlug,
            setParentTo: newParent, // Final FM value
        });
    }

    // Promotions: reset parent/order in the working model
    if (!moveChildren && descendants.length > 0) {
      for (const childSlug of descendants) {
        const child = docsIndex.bySlug.get(childSlug);
        promotions.push({
          slug: childSlug,
          fromParent: child.parent,
          category: child.category, // they remain in same category
        });
        
        // Update workingDocsBySlug for manifest/validation
        const promoDocCopy = { ...workingDocsBySlug.get(childSlug), parent: null, order: 9999 };
        workingDocsBySlug.set(childSlug, promoDocCopy);
      }
    }
  }
  
  // NOTE: workingDocsBySlug is now the final state of the hierarchy (used for path conflict checking below).

  // 7) Check for path conflicts
  for (const op of fileOps) {
    if (await fs.pathExists(op.to)) {
      const same = path.resolve(op.to) === path.resolve(op.from);
      if (!same) {
        throw new Error(
          `Destination already has a file: ${path.relative(process.cwd(), op.to)} (slug conflict)`
        );
      }
    }
  }

  // 8) Show plan and confirm
  log('\n📦 Move plan');
  for (const op of fileOps) {
    const relFrom = path.relative(DOCS_ROOT, op.from);
    const relTo = path.relative(DOCS_ROOT, op.to);
    log(`  • ${op.slug}: ${relFrom}  →  ${relTo}`);
  }
  if (promotions.length) {
    const grouped = promotions.reduce((acc, p) => {
      acc[p.fromParent] = acc[p.fromParent] || [];
      acc[p.fromParent].push(p.slug);
      return acc;
    }, {});
    log('\n⚠️  Promotions (children not moved):');
    for (const [parent, kids] of Object.entries(grouped)) {
      log(`  • former children of "${parent}" promoted: ${kids.join(', ')}`);
    }
    log('    Their order was reset to 9999 — please review ordering manually.');
  }

  const { confirm } = await inquirer.prompt([
    { name: 'confirm', type: 'confirm', message: DRY_RUN ? 'Proceed with dry-run?' : 'Apply these changes?' },
  ]);
  if (!confirm) {
    log('Aborted.');
    return { moved: [], promoted: [] };
  }

  // 9) Apply promotions first (FM updates, files stay in place)
  const changedFiles = [];
  for (const promo of promotions) {
    const info = docsIndex.bySlug.get(promo.slug);
    const { content, fm } = await readDoc(info.abs);
    fm.parent = null;
    fm.order = 9999;
    if (!DRY_RUN) {
      await writeDoc(info.abs, content, fm);
    }
    changedFiles.push(info.abs);
    // Update the *actual* index for downstream operations (e.g., commit/manifest)
    const d = docsIndex.bySlug.get(promo.slug);
    d.parent = null;
    d.order = 9999;
  }

  // 10) Apply moves: write to new path then remove old if path changed
  for (const op of fileOps) {
    const { content, fm } = await readDoc(op.from);
    fm.category = op.newCategory;
    fm.parent = op.setParentTo;
    
    // Update the *actual* index for downstream operations (CRITICAL)
    const d = docsIndex.bySlug.get(op.slug);
    d.abs = op.to; // <--- Path changed!
    d.rel = path.relative(DOCS_ROOT, op.to);
    d.category = op.newCategory;
    d.parent = op.setParentTo;
    
    if (!DRY_RUN) {
      if (path.resolve(op.from) !== path.resolve(op.to)) {
        // Step 1: Write to the new location (creates directory if needed)
        await writeDoc(op.to, content, fm);
        // Step 2: Remove the old file and empty directories
        await fs.remove(op.from);
        // Attempt to clean up parent directories if they become empty
        try {
            const oldDir = path.dirname(op.from);
            // This will only succeed if the directory is empty
            await fs.rmdir(oldDir); 
        } catch {} 
      } else {
        // Overwrite in place if only FM changed but path is same
        await writeDoc(op.to, content, fm);
      }
    }
    changedFiles.push(op.to);
  }

  return { moved: fileOps.map(o => o.slug), promoted: promotions.map(p => p.slug) };
}