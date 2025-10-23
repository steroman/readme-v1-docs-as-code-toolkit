# 03: Synchronization Script

## What is the sync script?

This is the final, automated step in the "docs-as-code" workflow. This script is designed to be run in a CI/CD pipeline (e.g., on a push to the `main` branch).

Its job is to compare the local `docs/` repository against the content in ReadMe.com and execute the necessary API calls to make ReadMe match the local "source of truth".

## Core features

- Delta-based sync. The script syncs only files that have changed in git (POST, PUT, or DELETE), rather than all files every time.
- Full-state comparison. It builds a complete map of the local state and the remote state to detect and handle remote-only content that needs to be deleted.
- Asset management. It uploads local images from `docs/assets` to a specified S3 bucket, replaces local paths with S3 URLs, and deletes remote assets that are no longer used.
- Safe and throttled. It includes a full `--dry-run` mode and throttles all API calls to respect ReadMe rate limits.

## How it works: the sync process

The script executes in a specific order to ensure a safe and efficient sync.

### 1. Git diff

The script first runs `git diff` to find all files changed or deleted between the current `HEAD` and the `TARGET_GIT_BRANCH` (e.g., `main`). This creates two lists:

- A list of modified `.md` files and the `.readme-structure.json` file.
- A list of deleted asset files (e.g., `assets/image.png`).

### 2. Load local state

It scans the entire local `docs/` folder, reading the front matter from every `.md` file and the content of every `_category.yml` file. This builds a complete map of the desired local state.

### 3. Fetch remote state

It makes a series of paginated API calls to ReadMe to fetch all existing guide categories and a flattened list of all documents.

### 4. Create sync plan

The "sync planner" compares the local and remote states.

- Any doc or category in `local` but not `remote` is marked for creation.
- Any doc or category in `remote` but not `local` is marked for deletion.
- For docs that exist in both, it plans an update only if the file was flagged by the git diff (from step 1) or if its core attributes (like `title` or `parent`) have changed.
- Category updates (like title changes) are planned if the `.readme-structure.json` file was modified in the git diff.

### 5. Sync assets (S3)

Before executing the doc plan, the script handles all images. This is covered in detail in [Asset management](#asset-management).

### 6.Execute sync plan

The "sync executor" runs the plan, making throttled API calls for each change. For any doc being created or updated, it first replaces local image paths (e.g., `../assets/img.png`) with their new S3 URLs before sending the content to ReadMe. This allows the local docs to maintain a standard markdown syntax, while keeping the content synced.

## Asset management (S3 integration)

This script requires an S3-compatible bucket to host images.

### Hash manifest

To avoid re-uploading thousands of unchanged images on every run, the script maintains an `image-hashes-manifest.json` file in your S3 bucket.
This file maps a local file path (e.g., `assets/screenshot-1.png`) to its content hash and public S3 URL. This way, the script can skip reuploading images that haven't changed.

### Upload process

The script scans the local `docs/assets` directory. For any new or changed images (where the local hash doesn't match the manifest hash), it uploads them to S3 and updates the manifest in memory.

### Deletion process

If the git diff (step 1) detected any deleted asset files, they are removed from the S3 bucket, and their entries are removed from the manifest.

### Content replacement
  
When a doc is about to be sent to ReadMe, the script replaces all local image paths with their corresponding S3 URLs from the manifest.

## Configuration and running

### Environment variables

The script is configured entirely through environment variables, as defined in `config.js`.

- `README_API_KEY`, Required. Your ReadMe project API key.
- `TARGET_GIT_BRANCH`, Optional. The git branch to compare against for the "delta" sync. Defaults to `main`.
- `S3_BUCKET_NAME`, Required for asset management. The name of your S3 bucket.
- `S3_REGION`, Required for asset management. The AWS region for your bucket (e.g., `us-east-1`).
- `S3_PUBLIC_URL_BASE`, Required for asset management. The public-facing URL for your assets (e.g., your CDN or S3 public URL).
- `S3_ASSET_FOLDER`, Optional. A folder name to prefix all assets with in the S3 bucket. Defaults to `readme-assets`.

### How to run

Once configured, you can set the script to run in your CI/CD pipeline.

You can find a sample workflow in the `.github/workflows/sync.yml` file in this repository.

### Dry-run mode

To see a full report of what the script would do without making any API calls or file changes, use the `--dry-run` or `-n` flag.

```bash
node scripts/03-sync/main.js --dry-run
```
