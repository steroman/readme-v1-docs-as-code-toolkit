// scripts/sync/sync-executor.js

let pMap = require('p-map'); // <-- ADD THIS LINE
if (typeof pMap !== 'function') { pMap = pMap.default; }
const apiClient = require('./api-client.js');
const assetManager = require('./asset-manager.js');
const config = require('./config.js');
const utils = require('./utils.js');

async function executeSyncPlan(plan, localState) {
  utils.log('\n5. Executing Document/Category Plan...');
  let opsCount = 0;

  const execute = (items, message, action) =>
    pMap(items, async op => {
      utils.log(`     ${message}: ${op.slug}`);
      await action(op);
      opsCount++;
    }, { concurrency: config.CONFIG.MAX_CONCURRENT_API_CALLS });

  const processAndPushDoc = async ({ slug, doc }, method) => {
    const finalContent = await assetManager.prepareDocBody(doc, localState.hashManifest);
    const payload = {
      title: doc.title,
      slug,
      excerpt: doc.excerpt,
      body: finalContent,
      categorySlug: doc.categorySlug,
      parentDocSlug: doc.parentDocSlug || undefined,
      hidden: doc.hidden,
      order: doc.order,
      type: doc.type,
    };
    await apiClient.throttledApiCall(method, `/docs${method === 'put' ? `/${slug}` : ''}`, payload);
  };

  utils.log('\n   >> Phase 5A: Category Creations & Updates');
  await execute(plan.categoryCreations, '➕ CREATE Category', op => apiClient.throttledApiCall('post', '/categories', { title: op.title, type: op.type }));
  await execute(plan.categoryUpdates, '✏️ UPDATE Category', op => apiClient.throttledApiCall('put', `/categories/${op.slug}`, { title: op.title, type: op.type }));

  utils.log('\n   >> Phase 5B: Doc Deletions');
  await pMap(plan.docDeletions, async (op) => {
    utils.log(`     🗑️ DELETE Doc: ${op.slug}`);
    const res = await apiClient.throttledApiCall('delete', `/docs/${op.slug}`);
    if (res.status === 204) opsCount++;
    else if (res.status === 404) utils.warn(`Doc ${op.slug} was already deleted.`);
  }, { concurrency: config.CONFIG.MAX_CONCURRENT_API_CALLS });

  utils.log('\n   >> Phase 5C: Category Deletions');
  await execute(plan.categoryDeletions, '🗑️ DELETE Category', op => apiClient.throttledApiCall('delete', `/categories/${op.slug}`));

  utils.log('\n   >> Phase 5D: Doc Creations & Updates');
  await execute(plan.docCreations, '➕ CREATE Doc', op => processAndPushDoc(op, 'post'));
  await execute(plan.docUpdates, '✏️ UPDATE Doc', op => processAndPushDoc(op, 'put'));

  utils.log(`\n✅ Sync complete! Total operations: ${opsCount}`);
}

exports.executeSyncPlan = executeSyncPlan;