// scripts/sync/config.js

const path = require('path');
require('dotenv/config');

const CONFIG = {

  DOCS_ROOT: path.resolve(process.cwd(), 'docs'),
  STRUCTURE_MANIFEST: path.resolve(process.cwd(), 'docs', '.readme-structure.json'),
  ASSETS_DIR: path.join(path.resolve(process.cwd(), 'docs'), 'assets'),
  
  TARGET_GIT_BRANCH: process.env.TARGET_GIT_BRANCH || 'main',

  // --- ReadMe API Config ---
  README_BASE_URL: process.env.README_BASE_URL || 'https://dash.readme.com/api/v1',
  README_API_KEY: process.env.README_API_KEY,
  README_VERSION: process.env.README_VERSION,

  // --- AWS S3 Config ---
  S3_BUCKET_NAME: process.env.S3_BUCKET_NAME, 
  S3_REGION: process.env.S3_REGION,
  S3_PUBLIC_URL_BASE: process.env.S3_PUBLIC_URL_BASE, // e.g., 'https://my-cdn.com/assets'
  S3_ASSET_FOLDER: process.env.S3_ASSET_FOLDER || 'readme-assets', 
  S3_MANIFEST_KEY: process.env.S3_MANIFEST_KEY || 'readme-assets/image-hashes-manifest.json',

  // --- Sync Behavior Config ---
  MAX_CONCURRENT_API_CALLS: 5,
  API_CALL_DELAY_MS: 250,
  MANIFEST_RETRY_DELAY_MS: 2000,
  MANIFEST_MAX_RETRIES: 3,
};

// Updated error checks
if (!CONFIG.README_API_KEY) {
  console.error('❌ FATAL: Missing README_API_KEY in your .env file or environment.');
  process.exit(1);
}

// Check for EITHER S3 bucket OR a base URL, as a user might not use S3.
if (!CONFIG.S3_BUCKET_NAME && !CONFIG.S3_PUBLIC_URL_BASE) {
  console.warn('⚠️ WARNING: S3_BUCKET_NAME and S3_PUBLIC_URL_BASE are not set.');
  console.warn('   Image uploading and asset management will be skipped.');
} else if (CONFIG.S3_BUCKET_NAME && (!CONFIG.S3_REGION || !CONFIG.S3_PUBLIC_URL_BASE)) {
  console.error('❌ FATAL: To use S3, you must set S3_BUCKET_NAME, S3_REGION, and S3_PUBLIC_URL_BASE.');
  process.exit(1);
}

const DRY_RUN = process.argv.includes('--dry-run') || process.argv.includes('-n');

module.exports = {
  CONFIG,
  DRY_RUN,
};