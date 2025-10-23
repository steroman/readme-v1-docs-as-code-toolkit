// scripts/hierarchy-manager/main.mjs - FINAL VERSION FOR GIT HOOKS

/**
 * Main Hierarchy Manager Entry Point (Split Version)
 * Orchestrates local index loading, validation, user interaction, 
 * file operations (Category/Doc Management), and Git commit.
 */
import 'dotenv/config';
import fs from 'fs-extra';
import path from 'path';
import inquirer from 'inquirer';
import gitFactory from 'simple-git';
import matter from 'gray-matter'; 
// import readline from 'readline';

import { 
    DOCS_ROOT, 
    STRUCTURE_MANIFEST,
    log, 
    warn, 
    err, 
    DRY_RUN, 
    NO_COMMIT,
    readDoc,
    API_KEY_PRESENT
} from './utils.mjs'; 
import { 
    loadCategories, 
    loadDocsIndex, 
    requireUniqueSlugs, 
    validateStructure, 
    rebuildManifest 
} from './index-manager.mjs'; 
import { 
    createCategoryFlow, 
    editCategoryFlow 
} from './category-manager.mjs'; 
import { 
    bulkMoveFlow 
} from './doc-manager.mjs'; 

// ---------------------------
// Utility: Interactive Pause Function
// ---------------------------
async function pressEnterToContinue(isError = false) {
  // Don't try to prompt in non-interactive environments (like Git hooks)
  if (!process.stdin.isTTY) return;
  
  const message = isError 
    ? 'Press ENTER to return to the menu...' 
    : 'Press ENTER to continue...';
  
  await inquirer.prompt([
    {
      name: 'continue',
      type: 'input',
      message,
      // This filter prevents the user's keystroke from showing up in the console
      filter: () => '', 
    },
  ]);
}


// ---------------------------
// Git Front Matter Comparison Logic
// ---------------------------

/**
 * Checks if any staged Markdown file has structural changes (in its front matter) 
 * compared to the version currently in HEAD.
 * @returns {Promise<boolean>} True if a structural change is detected.
 */
async function hasStructuralChanges() {
    const git = gitFactory({ baseDir: process.cwd() });
    // Define the front matter fields relevant to hierarchy/structure.
    const STRUCTURAL_KEYS = ['slug', 'title', 'parent', 'order', 'hidden', 'category'];
    
    let stagedFilesOutput;
    try {
        stagedFilesOutput = await git.diff(['--name-only', '--cached']);
    } catch {
        warn('⚠️ Could not run git diff --cached. Assuming no structural changes.');
        return false;
    }
    
    const stagedDocFiles = stagedFilesOutput
        .split('\n')
        .map(p => p.trim())
        .filter(p => p && (p.endsWith('.md') || p.endsWith('.mdx')) && p.startsWith('docs/'));
        
    let structuralChangeDetected = false;

    for (const filePathRelative of stagedDocFiles) {
        const absPath = path.resolve(process.cwd(), filePathRelative);
        
        // A. Handle file deletions (always a structural change)
        if (!fs.existsSync(absPath)) {
            log(`[STRUCT-CHECK] File deleted: ${filePathRelative}. FORCING rebuild.`);
            return true; 
        }

        // B. Handle file additions (always a structural change)
        let headContent;
        try {
            headContent = await git.show(['HEAD:' + filePathRelative]);
        } catch (e) {
            if (e.message.includes('not found') || e.message.includes('exists in the index')) {
                log(`[STRUCT-CHECK] New file detected: ${filePathRelative}. FORCING rebuild.`);
                return true; 
            }
        }

        // C. Compare Front Matter (only for modified files)
        if (headContent) {
            const currentFM = (await readDoc(absPath)).fm;
            const headFM = matter(headContent).data;

            for (const key of STRUCTURAL_KEYS) {
                // Normalize values for comparison (case and null/undefined handling)
                const currentVal = String(currentFM[key] || '').toLowerCase().trim();
                const headVal = String(headFM[key] || '').toLowerCase().trim();

                if (currentVal !== headVal) {
                    log(`[STRUCT-CHECK] Change detected in ${filePathRelative}: ${key} changed from "${headVal}" to "${currentVal}".`);
                    return true;
                }
            }
        }
    }

    return structuralChangeDetected;
}

// ---------------------------
// New CLI Action for Pre-Commit Hook
// ---------------------------

/**
 * Handles the 'structural-check' CLI command used by the pre-commit hook.
 * Checks for front matter changes and conditionally rebuilds/stages the manifest.
 */
async function cliStructuralCheck() {
    log('Running conditional structural manifest check...');
    
    // 1. Check if structural changes exist in MD files
    const structuralChangeRequired = await hasStructuralChanges();
    const git = gitFactory({ baseDir: process.cwd() });
    const manifestRelativePath = path.relative(process.cwd(), STRUCTURE_MANIFEST);

    if (structuralChangeRequired) {
        log('⚠️ Structural change detected in Markdown files. Rebuilding full manifest...');
        
        const freshCategories = await loadCategories();
        const freshDocsIndex = await loadDocsIndex();
        await validateStructure(freshCategories, freshDocsIndex); 
        await rebuildManifest(freshDocsIndex, freshCategories); 

        await git.add(manifestRelativePath);
        
        log('✅ Manifest rebuilt and staged.');
    } else {
        log('✅ No structural changes detected in Markdown files. Checking manifest status...');

        // Check if the manifest itself is staged for commit
        const status = await git.status();
        const isManifestStaged = status.staged.includes(manifestRelativePath);

        if (isManifestStaged) {
            log('ℹ️ Manifest file is already staged. Preserving it for the commit.');
        } else {
            // Original logic: unstage it only if it wasn't intentionally staged
            if (await fs.pathExists(STRUCTURE_MANIFEST)) {
                 try {
                    await git.reset(['HEAD', manifestRelativePath]);
                    log('ℹ️ Manifest was not staged and no structural changes were found. Unstaged manifest to prevent accidental commit.');
                 } catch (e) {
                     // Ignore if not staged
                 }
            }
        }
    }
}


// ---------------------------
// Non-Interactive CLI Logic
// ---------------------------

// Function to handle the hook's final 'validate' step.
async function cliValidateOnly() {
    try {
        log(`Running non-interactive CLI: validate...`);
        const categories = await loadCategories();
        const docsIndex = await loadDocsIndex();
        requireUniqueSlugs(docsIndex);
        
        await validateStructure(categories, docsIndex);
        
        log('✅ Structure valid.');
        
        process.exit(0); 
    } catch (e) {
        err('❌ Operation Failed:', e?.message || e);
        process.exit(1); 
    }
}

// ---------------------------
// Git commit wrapper
// ---------------------------

async function commitChanges(message) {
  if (DRY_RUN || NO_COMMIT) return false;
  try {
    const git = gitFactory({ baseDir: process.cwd() });
    // Stage the entire docs folder (including structure manifest)
    await git.add(path.relative(process.cwd(), DOCS_ROOT));
    await git.commit(message);
    return true;
  } catch (e) {
    warn('⚠️  Git commit failed:', e?.message || e);
    return false;
  }
}


// ---------------------------
// Main interactive entry
// ---------------------------

async function main() {
  // Determine if a non-interactive CLI action was requested
  const cliAction = process.argv.find(arg => ['validate', 'manifest', 'structural-check'].includes(arg));
  
  // 1. Handle all non-interactive CLI actions first
  if (cliAction === 'structural-check') {
     try {
         await cliStructuralCheck();
         process.exit(0);
     } catch (e) {
         err('❌ Structural check failed:', e?.message || e);
         process.exit(1);
     }
  } else if (cliAction === 'validate') {
      await cliValidateOnly();
  } else if (cliAction === 'manifest') {
      try {
          log(`Running non-interactive CLI: manifest...`);
          const categories = await loadCategories();
          const docsIndex = await loadDocsIndex();
          requireUniqueSlugs(docsIndex);
          await rebuildManifest(docsIndex, categories);
          log('✅ Manifest rebuilt.');
          process.exit(0); 
      } catch (e) {
          err('❌ Operation Failed:', e?.message || e);
          process.exit(1);
      }
  }
  // --- START Interactive Mode ---
  log(`🧭 Hierarchy manager (modular version)`);
  if (DRY_RUN) log('   Dry-run: ON (no file writes, no commit) 🚫');
  if (NO_COMMIT) log('   Auto-commit: OFF 💾');

  await fs.ensureDir(DOCS_ROOT);

  if (process.stdin.isTTY) {
      process.stdin.setEncoding('utf8');
      process.stdin.resume();
  }

  while (true) {
    let categories, docsIndex;

    try {
        categories = await loadCategories();
        docsIndex = await loadDocsIndex();
        requireUniqueSlugs(docsIndex);
    } catch (e) {
        err('❌ Initialization Failed:', e?.message || e);
        process.exit(1); 
    }

    const isCliMove =
      process.argv.includes('move') ||
      process.argv.includes('--from') ||
      process.argv.includes('--to');

    let action = 'menu';
    
    if (isCliMove) {
        action = 'moveDocs';
    } else {
      // Build the menu choices dynamically based on API key presence
      const menuChoices = [
        new inquirer.Separator(),
      ];
      // Silently add the option only if the key exists.
      if (API_KEY_PRESENT) {
        menuChoices.push({ name: 'Create a category (API + Local files) 🌐', value: 'createCategory' });
      }
      
      menuChoices.push(
        { name: 'Edit a category title (Local file only)', value: 'editCategory' },
        { name: 'Move docs (bulk: multi-source → one destination) 🔄', value: 'moveDocs' },
        new inquirer.Separator(),
        { name: 'Validate structure only', value: 'validate' },
        { name: 'Rebuild manifest only', value: 'manifest' },
        new inquirer.Separator(),
        { name: 'Exit', value: 'exit' }
      );
      // --- END MODIFICATION ---

      const ans = await inquirer.prompt([
        {
          name: 'action',
          type: 'list',
          message: 'What do you want to do?',
          choices: menuChoices, // Use the dynamic choices
        },
      ]);
      action = ans.action;
    }

    let commitMsg = '';
    
    try {
        if (action === 'exit') { log('Bye! 👋'); break; }

        if (action === 'validate') {
          log('Running full validation...');
          await validateStructure(categories, docsIndex);
          log('✅ Structure valid.');
          await pressEnterToContinue(); 
          continue; 
        }

        if (action === 'manifest') {
          log('Rebuilding manifest...');
          await rebuildManifest(docsIndex, categories);
          log('✅ Manifest rebuilt.');
          await pressEnterToContinue(); 
          continue; 
        }
        
        // --- Execute Doc/Category Actions ---
        if (action === 'createCategory') {
          await createCategoryFlow(categories);
          commitMsg = 'docs: create category via API';
        } else if (action === 'editCategory') {
          await editCategoryFlow(categories);
          commitMsg = 'docs: edit category title';
        } else if (action === 'moveDocs') {
          log('Running full validation before move...');
          await validateStructure(categories, docsIndex); 
          const { moved, promoted } = await bulkMoveFlow(categories, docsIndex);
          commitMsg = `docs: move ${moved.length} doc(s)${promoted.length ? `; promoted ${promoted.length}` : ''}`;
        }


        // --- Post-Operation Sync (Always runs after interactive or CLI actions) ---
        log('\n--- Post-Operation Sync ---');
        
        // Reload indexes after local file changes
        categories = await loadCategories();
        docsIndex = await loadDocsIndex();
        
        // Final validation on the resultant structure
        log('Running final validation...');
        await validateStructure(categories, docsIndex);
        log('✅ Final structure valid.');

        // Rebuild manifest (Always run to capture ordering/new docs)
        await rebuildManifest(docsIndex, categories);
        log('✅ Manifest rebuilt to reflect final structure.');

        // Auto-commit all changes
        const committed = await commitChanges(commitMsg);
        if (committed) log('✅ Changes committed to Git.');
        else log(DRY_RUN || NO_COMMIT ? 'ℹ️  Commit skipped.' : '⚠️  Commit may have failed.');

        log('✅ Done. Remember to push and sync with ReadMe.');
        
        await pressEnterToContinue(); 
        
    } catch (e)
    {
      err('❌ Operation Failed:', e?.message || e);
      await pressEnterToContinue(true); 
      continue; 
    }
  }
}

// Execute
main().catch((e) => {
  err('❌ FATAL Script Error:', e?.message || e);
  process.exit(1);
});