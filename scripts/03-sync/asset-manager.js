// scripts/sync/asset-manager.js

const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const fg = require('fast-glob');
let pMap = require('p-map');
if (typeof pMap !== 'function') { pMap = pMap.default; }
const config = require('./config.js');
const utils = require('./utils.js');

// --- INITIALIZATION ---

let s3Client;
let s3Enabled = false;

if (config.CONFIG.S3_BUCKET_NAME && config.CONFIG.S3_PUBLIC_URL_BASE) {
  s3Enabled = true;
  if (!config.DRY_RUN) {
    // SDK will automatically pick up credentials from the environment (IAM role)
    // as per your CI/CD setup.
    s3Client = new S3Client({
      region: config.CONFIG.S3_REGION,
    });
  }
} else {
  utils.warn('S3_BUCKET_NAME or S3_PUBLIC_URL_BASE missing. Image processing will be skipped/fail.');
}

// --- MIME Type Helper ---
const getMimeType = (filename) => {
  const mimeTypes = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
  };
  const ext = path.extname(filename).toLowerCase();
  return mimeTypes[ext] || 'application/octet-stream';
};

// --- EXTERNAL MANIFEST ---

async function fetchExternalManifest() {
  if (!s3Enabled) return {};
  utils.log('   - Fetching external hash manifest from S3...');

  if (config.DRY_RUN) {
    utils.log('   [DRY-RUN] Would fetch manifest from S3.');
    return {}; // Return empty for dry run to avoid complexity
  }

  for (let attempt = 1; attempt <= config.CONFIG.MANIFEST_MAX_RETRIES; attempt++) {
    try {
      if (attempt > 1) {
        utils.log(`   [INFO] Retrying manifest fetch (Attempt ${attempt})...`);
        await new Promise(resolve => setTimeout(resolve, config.CONFIG.MANIFEST_RETRY_DELAY_MS));
      }

      const command = new GetObjectCommand({
        Bucket: config.CONFIG.S3_BUCKET_NAME,
        Key: config.CONFIG.S3_MANIFEST_KEY,
      });
      const response = await s3Client.send(command);
      const bodyString = await response.Body.transformToString('utf-8');
      const parsedManifest = JSON.parse(bodyString);

      if (Object.keys(parsedManifest).length > 0) return parsedManifest;

      if (attempt < config.CONFIG.MANIFEST_MAX_RETRIES) {
        utils.warn(`   [WARNING] Manifest is empty/stale. Retrying...`);
        continue;
      }
    } catch (e) {
      if (e.name === 'NoSuchKey') {
        utils.log('   - Manifest not found. Starting with an empty manifest.');
        return {};
      }
      utils.err(`Could not execute manifest fetch (Attempt ${attempt}): ${e.message}`);
    }
  }

  utils.log('   - Failed to load non-empty manifest. Starting with an empty manifest.');
  return {};
}

async function saveExternalManifest(manifestObject) {
  if (config.DRY_RUN || !s3Enabled) {
    utils.log(`   [DRY-RUN/SKIPPED] Would upload updated hash manifest to S3.`);
    return;
  }
  const manifestContent = JSON.stringify(manifestObject, null, 2);
  utils.log('   - Uploading updated hash manifest to S3...');
  try {
    const command = new PutObjectCommand({
      Bucket: config.CONFIG.S3_BUCKET_NAME,
      Key: config.CONFIG.S3_MANIFEST_KEY,
      Body: manifestContent,
      ContentType: 'application/json',
      CacheControl: 'no-cache, no-store, must-revalidate',
    });
    await s3Client.send(command);
    utils.log('   - Manifest successfully pushed to S3.');
  } catch (e) {
    utils.err(`Failed to upload manifest to S3: ${e.message}`);
    throw new Error('Critical: Failed to save external manifest.');
  }
}

// --- ASSET SYNC ---

async function deleteS3Assets(deletedAssetFileNames, hashManifest) {
  if (!s3Enabled || deletedAssetFileNames.length === 0) return false;
  const toDelete = deletedAssetFileNames.filter(filename => hashManifest[filename]);
  if (toDelete.length === 0) return false;

  utils.log(`🗑️ Deleting ${toDelete.length} assets from S3.`);
  const keysToDelete = toDelete.map(filename => `${config.CONFIG.S3_ASSET_FOLDER}/${filename}`);

  if (config.DRY_RUN) {
    utils.log(`   [DRY-RUN] Would delete S3 Keys: ${keysToDelete.join(', ')}`);
    return false;
  }

  try {
    const command = new DeleteObjectsCommand({
      Bucket: config.CONFIG.S3_BUCKET_NAME,
      Delete: {
        Objects: keysToDelete.map(key => ({ Key: key })),
        Quiet: false, // We want results back
      },
    });
    const result = await s3Client.send(command);
    let manifestUpdated = false;

    if (result.Deleted && result.Deleted.length > 0) {
      const deletedKeys = new Set(result.Deleted.map(d => d.Key));
      toDelete.forEach(filename => {
        const s3Key = `${config.CONFIG.S3_ASSET_FOLDER}/${filename}`;
        if (deletedKeys.has(s3Key)) {
          delete hashManifest[filename];
          manifestUpdated = true;
          utils.log(`   - Deleted: ${filename} (Key: ${s3Key})`);
        }
      });
    }

    if (result.Errors && result.Errors.length > 0) {
      result.Errors.forEach(err => {
        utils.warn(`   - Failed to delete S3 Key ${err.Key}: ${err.Message}`);
      });
    }
    
    return manifestUpdated;
  } catch (e) {
    utils.warn(`Failed to delete assets from S3: ${e.message}`);
    return false;
  }
}

async function syncAllLocalAssets(hashManifest) {
  if (!s3Enabled) return false;
  if (!fs.existsSync(config.CONFIG.ASSETS_DIR)) {
    utils.log('ℹ️ Asset directory not found. Skipping image hash scan.');
    return false;
  }

  let manifestUpdated = false;
  let uploadedCount = 0;
  const allAssetFiles = await fg('**/*.{png,jpg,jpeg,gif,svg,webp}', { cwd: config.CONFIG.ASSETS_DIR, onlyFiles: true });
  utils.log(`🖼️ Starting hash scan against ${allAssetFiles.length} local assets...`);

  const s3UrlBase = config.CONFIG.S3_PUBLIC_URL_BASE.replace(/\/$/, '');

  await pMap(
    allAssetFiles,
    async (relativeFileName) => {
      // Use forward slashes for cross-platform compatibility in S3 keys
      const imageFileName = relativeFileName.replace(/\\/g, '/');
      const imageAbsPath = path.join(config.CONFIG.ASSETS_DIR, imageFileName);
      
      // We use the relative path (including subfolders) as the manifest key
      const manifestKey = imageFileName; 
      const currentHash = utils.getFileHash(imageAbsPath);
      const manifestEntry = hashManifest[manifestKey];

      if (manifestEntry && currentHash === manifestEntry.hash) return;
      
      const s3Key = `${config.CONFIG.S3_ASSET_FOLDER}/${imageFileName}`;
      let s3Url;

      if (config.DRY_RUN) {
        s3Url = `${s3UrlBase}/${s3Key}`;
        utils.log(`   [DRY-RUN] Would upload ${imageFileName} to S3 Key: ${s3Key}`);
      } else {
        try {
          const fileContent = await fs.readFile(imageAbsPath);
          const mimeType = getMimeType(imageFileName);

          const command = new PutObjectCommand({
            Bucket: config.CONFIG.S3_BUCKET_NAME,
            Key: s3Key,
            Body: fileContent,
            ContentType: mimeType,
            Metadata: {
              hash: currentHash, // Store hash in S3 metadata for reference
            },
          });

          await s3Client.send(command);
          
          // Construct the public URL
          s3Url = `${s3UrlBase}/${s3Key}`;
          
          utils.log(`   - Uploaded/Updated Asset: ${imageFileName}`);
          uploadedCount++;
        } catch (e) {
          utils.err(`   - Upload Failed for ${imageFileName}: ${e.message}.`);
          return;
        }
      }
      hashManifest[manifestKey] = { hash: currentHash, url: s3Url };
      manifestUpdated = true;
    },
    { concurrency: config.CONFIG.MAX_CONCURRENT_API_CALLS }
  );

  if (uploadedCount > 0) utils.log(`✅ Successfully synced ${uploadedCount} image assets.`);
  else utils.log('🖼️ No image assets needed update.');

  return manifestUpdated;
}

// --- CONTENT PREPARATION ---

async function prepareDocBody(docRecord, hashManifest) {
  let content = docRecord.content;
  // This regex finds local image paths, including those in subfolders.
  const LOCAL_IMAGE_PATTERN = /!\[(.*?)\]\((?!https?:\/\/)([^)\s]+)(\s+["'].*?[""])?\)/g;

  content = content.replace(LOCAL_IMAGE_PATTERN, (fullMatch, altText, localImagePath, quotedTitle) => {
    // Normalize path to use forward slashes, matching the manifest key
    const manifestKey = localImagePath.replace(/\\/g, '/');
    const manifestEntry = hashManifest[manifestKey];
    
    if (manifestEntry) {
      return `![${altText}](${manifestEntry.url}${quotedTitle || ''})`;
    }
    
    // Fallback for simple (non-nested) paths just in case
    const imageFileName = path.basename(localImagePath);
    const fallbackEntry = hashManifest[imageFileName];
    if (fallbackEntry) {
      utils.warn(`   - Image link in ${docRecord.slug} for ${localImagePath} found using fallback (basename). Consider using relative paths.`);
      return `![${altText}](${fallbackEntry.url}${quotedTitle || ''})`;
    }
    
    utils.warn(`   - Image link in ${docRecord.slug} for ${localImagePath} missing from manifest. Skipping replacement.`);
    return fullMatch;
  });

  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

exports.fetchExternalManifest = fetchExternalManifest;
exports.saveExternalManifest = saveExternalManifest;
exports.deleteS3Assets = deleteS3Assets;
exports.syncAllLocalAssets = syncAllLocalAssets;
exports.prepareDocBody = prepareDocBody;