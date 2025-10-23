// scripts/sync/main.js

const config = require('./config.js');
const utils = require('./utils.js');
const gitUtils = require('./git-utils.js');
const assetManager = require('./asset-manager.js');
const stateManager = require('./state-manager.js');
const syncPlanner = require('./sync-planner.js');
const syncExecutor = require('./sync-executor.js');

// --- MAIN EXECUTION ---

async function main() {
  utils.log('===================================================');
  utils.log(`  ReadMe Repository Sync Script ${config.DRY_RUN ? '(DRY-RUN)' : ''}`);
  utils.log('===================================================');

  try {
    // 1. Load initial state & determine changes
    const hashManifest = await assetManager.fetchExternalManifest();
    const gitChanges = gitUtils.getChangedFilePaths();
    const localState = await stateManager.loadLocalState();
    const remoteState = await stateManager.fetchRemoteState();

    // 2. Create a plan based on the diff
    const syncPlan = syncPlanner.createSyncPlan(localState, remoteState, gitChanges);
    const assetDeletions = gitChanges.deleted;
    localState.hashManifest = hashManifest; // Attach manifest for executor

    // 3. Handle Dry Run output
    if (config.DRY_RUN) {
      utils.log(`\n--- DRY RUN SUMMARY ---`);
      utils.log(`  - Categories: ${syncPlan.categoryCreations.length} to create, ${syncPlan.categoryUpdates.length} to update, ${syncPlan.categoryDeletions.length} to delete`);
      utils.log(`  - Docs: ${syncPlan.docCreations.length} to create, ${syncPlan.docUpdates.length} to update, ${syncPlan.docDeletions.length} to delete`);
      utils.log(`  - Assets: ${assetDeletions.size} to delete`);
      utils.log(`\nDry Run Complete. No changes were made.`);
      return;
    }

    // 4. Execute asset-related tasks
    utils.log('\n4. Synchronizing Assets...');
    let manifestUpdated = await assetManager.syncAllLocalAssets(hashManifest);
    const manifestUpdatedAfterDeletes = await assetManager.deleteS3Assets([...assetDeletions], hashManifest);
    manifestUpdated = manifestUpdated || manifestUpdatedAfterDeletes;
    
    // 5. Execute the plan for docs and categories
    await syncExecutor.executeSyncPlan(syncPlan, localState);

    // 6. Finalize by saving manifest if it changed
    if (manifestUpdated) {
      await assetManager.saveExternalManifest(hashManifest);
    }
  } catch (error) {
    utils.err('Sync process failed:', error.message);
    process.exit(1);
  }
}

main();