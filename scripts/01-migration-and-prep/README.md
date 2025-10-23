# 01: Migration & prep scripts

Goal: To perform a one-time migration, converting an existing ReadMe.com project export into a clean, `docs-as-code` repository structure.

This toolset automates the most painful parts of a migration: it cleans up non-guide files, downloads all remote images, converts ReadMe-specific syntax to standard Markdown, renames folders, and normalizes all front matter.

## Before you start

- Make sure you read the [main README.md file](../../README.md) in this repository.
- Make sure you have set your `README_API_KEY` in your `.env` file.

## Step 1. Export files from ReadMe

You must manually export your project from ReadMe first.

1.  In your ReadMe project, go to Project Settings > Export Project.
2.  Download the `.zip` file.
3.  Unzip the contents and place the entire `docs/` folder into the root of this repository.

Your folder structure will look messy, with folders named after category titles:

## Step 2. Run the migration scripts in order

These three scripts are designed to be run sequentially.

### 1. `01-cleanup-guides.mjs`

- What it does: Fetches all categories from your ReadMe project and identifies which are "guides" (i.e., not an API reference). It then deletes all local files and folders that do not belong to a "guide" category.
- Command: `node 01-cleanup-guides.mjs`

### 2. `02-normalize-structure.mjs`

- What it does: This is the main structural-fixup script. It fetches the full documentation structure from ReadMe (all docs, parents, order, etc.). It then:
  - Renames your local category folders from titles (`Getting Started`) to slugs (`getting-started`).
  - Creates a `_category.yml` file inside each category folder that stores the category information (title and slug). This is because the slug of a category cannot be edited and ReadMe assigns it automatically from the title. But a title can be edited with the slug as the source of truth.
  - Updates the front matter of every single Markdown file to match the "live" structure in ReadMe, correcting the `slug`, `title`, `category`, `parent`, `order`, and `hidden` fields, as well as deleting unnecessary front matter fields such as `CreatedAt
  - Creates the first `.readme-structure.json` manifest file based on this newly-normalized structure.
- Command: `npm run migrate:normalize`
- Note: This script requires a valid `README_API_KEY` in your `.env` file to fetch your project's structure.

> 📘 The role of the `.readme-structure-json` file
>
> This JSON file is the canonical source of truth that stores the complete, nested parent-child hierarchy and category structure of the repository. After it's created at this stage, the hierarchy manager tool uses it to validate consistency between individual doc front matter (parent, category) and the overall structure. The file automatically rebuilt and staged by the pre-commit hook whenever structural changes are detected in markdown files or can be updated manually using the hierarchy manager. Finally, the sync script monitor this file to understand whether there are structural changes and trigger the necessary updates in ReadMe.

### 3. `03-normalize-assets.mjs`

- What it does: Prepares the markdown files by removing ReadMe-specific syntax and creating canonical image paths. It will:
  - Convert `[block:image]`, `[block:parameters]`, and `[block:embed]` tags into standard Markdown (images, tables, and HTML).
  - Find all remote image URLs (`https://files.readme.io/...`).
  - Download every image and save it to your local `docs/assets` folder.
  - Update the Markdown links to use new relative paths (e.g., `../assets/my-image.png`).
- Command: `npm run migrate:assets`

> 📘 Other ReadMe-flavored syntax
>
> This script does not clean up the `[block:html]` tags or any others not mentioned here. The only ones that are cleaned up are `[block:image]`, `[block:parameters]`, and `[block:embed]`. You can fork this repo and modify this behavior if you need to.

## How to run

> ✅ Dry-run mode available
> 
> These scripts can be run with the `--dry-run` flag to see what changes would be made without writing any files. We recommend always running them with this flag first to make sure everything looks good before committing changes to your repo.

1.  Make sure you have set your `README_API_KEY` in your `.env` file.
2.  Run each script in order:

```sh
# 1. Deletes all non-guide files
node 01-cleanup-guides.mjs

# 2. Renames folders and fixes all front matter
node 02-normalize-structure.mjs

# 3. Downloads images and converts ReadMe blocks
node 03-normalize-assets.mjs
```

## Next steps

Your `docs/` folder is now clean, normalized, and ready to be synced to ReadMe.

Next guide: [02: Hierarchy Management Guide](../02-hierarchy-management/README.md)