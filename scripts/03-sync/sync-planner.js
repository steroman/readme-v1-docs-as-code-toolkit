// scripts/sync/sync-planner.js

const config = require('./config.js');
const utils = require('./utils.js');

function createSyncPlan(local, remote, gitChanges) {
  utils.log('\n3. Creating sync plan...');
  const { changed: changedFilePaths } = gitChanges;

  const plan = {
    categoryDeletions: [],
    docDeletions: [],
    categoryCreations: [],
    categoryUpdates: [],
    docUpdates: [],
    docCreations: [],
  };

  const isStructureFileModified = changedFilePaths === null || changedFilePaths.has(config.CONFIG.STRUCTURE_MANIFEST);

  // --- Category Plan ---
  for (const [remoteSlug, cat] of remote.categories.entries()) {
    if (!local.categories.has(remoteSlug)) {
      plan.categoryDeletions.push({ slug: remoteSlug, remoteId: cat.id });
    }
  }
  for (const [localSlug, localCat] of local.categories.entries()) {
    const remoteCat = remote.categories.get(localSlug);
    if (!remoteCat) {
      if (isStructureFileModified) plan.categoryCreations.push({ slug: localSlug, title: localCat.title, type: localCat.type });
    } else if (isStructureFileModified && (localCat.title !== remoteCat.title || localCat.type !== remoteCat.type)) {
      plan.categoryUpdates.push({ slug: localSlug, title: localCat.title, type: localCat.type });
    }
  }

  // --- Doc Plan ---
  for (const remoteSlug of remote.docs.keys()) {
    if (!local.docs.has(remoteSlug)) {
      plan.docDeletions.push({ slug: remoteSlug });
    }
  }

  for (const [localSlug, localDoc] of local.docs.entries()) {
    const remoteDoc = remote.docs.get(localSlug);
    const isMdFileModifiedByGit = changedFilePaths === null || changedFilePaths.has(localDoc.absPath);

    if (!remoteDoc) {
      plan.docCreations.push({ slug: localSlug, doc: localDoc });
      continue;
    }

    // Compare structural attributes. Excerpt is a content change, handled by git diff.
    const attributeChanged =
      localDoc.title !== remoteDoc.title ||
      localDoc.categorySlug !== remoteDoc.categorySlug ||
      localDoc.parentDocSlug !== remoteDoc.parentDocSlug ||
      localDoc.order !== remoteDoc.order ||
      localDoc.hidden !== remoteDoc.hidden;

    if (isMdFileModifiedByGit || attributeChanged) {
      plan.docUpdates.push({ slug: localSlug, doc: localDoc });
    }
  }

  utils.log(`   - Plan: ${plan.categoryCreations.length} Cat Create, ${plan.categoryDeletions.length} Cat Delete, ${plan.categoryUpdates.length} Cat Update`);
  utils.log(`   - Plan: ${plan.docCreations.length} Doc Create, ${plan.docDeletions.length} Doc Delete, ${plan.docUpdates.length} Doc Update`);

  return plan;
}

exports.createSyncPlan = createSyncPlan;