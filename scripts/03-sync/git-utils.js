// scripts/sync/git-utils.js

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const config = require('./config.js');
const utils = require('./utils.js');

function getChangedFilePaths() {
  utils.log(`\n🔍 Checking Git for files changed relative to '${config.CONFIG.TARGET_GIT_BRANCH}'...`);
  try {
    // Get all changed files
    const output = execSync(`git diff --name-only ${config.CONFIG.TARGET_GIT_BRANCH}...HEAD`, {
      encoding: 'utf8',
    });

    // Get only deleted files
    const deletedOutput = execSync(`git diff --name-only --diff-filter=D ${config.CONFIG.TARGET_GIT_BRANCH}...HEAD`, {
      encoding: 'utf8',
    });

    const changedPaths = new Set();
    const deletedPaths = new Set();
    const currentWorkingDir = process.cwd();

    // Get absolute paths from config for accurate comparison
    const docsAbsPath = config.CONFIG.DOCS_ROOT;
    const assetsAbsPath = config.CONFIG.ASSETS_DIR; // <-- Required for deleted assets
    const manifestAbsPath = config.CONFIG.STRUCTURE_MANIFEST;

    // --- Process CHANGED files (add/modify) ---
    output.split('\n').forEach((line) => {
      const filePath = line.trim(); // This is the relative path from git root
      if (!filePath) return;

      const absPath = path.resolve(currentWorkingDir, filePath);

      // This logic is correct and protects you from .cursor/
      const isMarkdown = filePath.endsWith('.md') || filePath.endsWith('.mdx');
      const isInsideDocs = absPath.startsWith(docsAbsPath + path.sep);
      const isManifest = absPath === manifestAbsPath;
      const isRelevantFile = isManifest || (isMarkdown && isInsideDocs);

      if (isRelevantFile) {
        if (fs.existsSync(absPath)) {
          changedPaths.add(absPath);
        }
      }
    });

    // --- Process DELETED files ---
    deletedOutput.split('\n').forEach((line) => {
      const filePath = line.trim();
      if (filePath) {
        const absPath = path.resolve(currentWorkingDir, filePath);
        
        // Check if the deleted file was an ASSET
        const isInsideAssets = absPath.startsWith(assetsAbsPath + path.sep);

        if (isInsideAssets) {
          // The asset manager expects the key to be relative to the ASSETS_DIR
          // e.g., "icons/my-image.png"
          const manifestKey = path.relative(assetsAbsPath, absPath).replace(/\\/g, '/');
          deletedPaths.add(manifestKey);
        }
        
        // We don't need to track deleted .md files here.
        // The sync-planner finds doc deletions by comparing the full
        // local state (which won't have the file) with the remote state.
      }
    });

    utils.log(`✅ Git detected ${changedPaths.size} MD/Structural files for update/creation and ${deletedPaths.size} assets marked for deletion.`);
    return { changed: changedPaths, deleted: deletedPaths };
  } catch (error) {
    utils.warn(`⚠️ Git diff failed (Error: ${error.message}). Running full sync for safety (NO DELETIONS).`);
    return { changed: null, deleted: new Set() };
  }
}

exports.getChangedFilePaths = getChangedFilePaths;