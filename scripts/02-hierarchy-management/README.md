# Hierarchy manager

The hierarchy manager is a local, interactive command-line tool for managing your documentation's structure after the [initial migration](/scripts/01-migration-and-prep/README.md). Its main purpose is to replace the ReadMe.com dashboard UI for all structural tasks, like creating categories, moving documents, and re-ordering.

It is built on a strict set of local validation rules to ensure your file system, front matter, and the structural manifest (`.readme-structure.json`) are always in perfect sync before you sync your changes with ReadMe using the [sync script](/scripts/03-sync/README.md) in your CI/CD pipeline.

## Core concepts

This tool enforces a specific, "local-first" philosophy. Understanding these rules is key to using the tool effectively.

- Rule 1: Front matter is the source of truth
- The hierarchy is defined by the `parent`, `category`, `order`, and `hidden` fields in each markdown file's front matter. This tool reads all files to build its understanding of the structure.

- Rule 2: Physical file path must match the logical hierarchy
- The tool *requires* that a file's physical location on disk matches its `parent` front matter.
- **Correct:** A doc with `slug: child-doc` and `parent: parent-doc` *must* be located at: `docs/my-category/parent-doc/child-doc.md`.
- **Incorrect:** A doc with `parent: parent-doc` located at `docs/my-category/child-doc.md`.
- The **"Move docs"** command handles this for you automatically.

- Rule 3: Categories are defined by `_category.yml`
- The tool discovers categories by scanning for `_category.yml` files, which must contain a `slug` and `title`.

- Rule 4: The manifest is a build artifact
- You should *never* edit the `.readme-structure.json` file by hand.
- This tool generates it *from* your front matter.
- The sync script then reads this file to update ReadMe.

- Rule 5: Parent and child docs must share a category
- You cannot set a doc's `parent` to a slug that exists in a *different* category.

## How to run

To start the interactive manager, run the `main.mjs` script:

```sh
node scripts/hierarchy-manager/main.mjs
```

This will load the main tool menu.

![](/assets/hierarchy-manager-menu.png)

### Menu options

#### Create a category (API + Local files) 🌐

This option creates a remote category using the ReadMe API. The category creation is the only operation done before the sync, because otherwise you wouldn't be able to add articles to a non-existing category.

This is the only action of this script that requires a live API key stored locally in your `.env` file.
If no API key is provided, this option will be hidden from the menu. This logic can be used if you want to allow only specific contributors to be able to create categories.

The category creation follows an "API-first" workflow:

1. It asks you for a title.
2. It calls the ReadMe API to create the category.
3. ReadMe generates and returns a "canonical slug" (e.g., "My New Title" becomes "my-new-title").
4. The script then creates the local folder (e.g., docs/my-new-title-1/) and the _category.yml file using this canonical slug.

This process ensures your local folder name perfectly matches the remote slug from day one.

### Edit a category title (Local file only)

This option lets you edit a category's title.

> 📘 The remote category title is only updated when the sync happens

- It presents a list of all local categories, asks for a new title, and updates the title field in the corresponding _category.yml file.
- This does NOT change the slug or folder name. That's not possible using the ReadMe API v1. If you want to change the slug of a category, you must create a new category and then move all docs to the new one.

### Move docs (bulk: multi-source → one destination) 🔄

This option is the primary tool for restructuring your docs. It moves one or more documents to a new destination (either the root of a category or under a new parent doc).
By using this command, you won't have to move the files manually or edit the front matter of the documents you are moving, the script takes care of everything.

The script performs the following actions:

1. Updates front matter: It changes the category and parent fields inside the .md files you are moving.
2. Moves files: It physically moves the .md files to their new correct file path, as required by "Rule 2".
3. (Optional) If children are detected, it asks you whether you want to move the entire tree or "promote" the children to be top-level.

### Validate structure only

This option runs a full check of your repository structure against the `.readme-structure.json` manifest and tells you whether the structure is valid.

It's especially helpful to prevent mistakes if you're moving docs around manually.

It checks for:

- Duplicate slugs
- Broken parent links
- Category mismatches
- Incorrect file locations
- Circular dependencies
- Docs exceeding max depth (MAX_DOC_DEPTH)
- Inconsistencies with the .readme-structure.json manifest
- It prints a detailed list of all errors found

### Rebuild manifest only

Re-generates the .readme-structure.json file based on the current physical structure of the docs.

- It scans all _category.yml files and all .md front matter to build a complete, new representation of your hierarchy and saves it to the manifest.
- The categories in the manifest are sorted alphabetically by slug to ensure consistent output.
- If there's a mismatch between the manifest and the actual folder structure, it prints a detailed list of the errors found.

## CI/CD automation

The manager also provides non-interactive modes for use in scripts and CI/CD pipelines.

### Pre-commit hook (structural-check)

The tool is designed to be run as a pre-commit hook.

- You can run `node scripts/hierarchy-manager/main.mjs structural-check` and the script will:

1. Run a `git diff --cached` to see which files are staged for commit.
2. Check if any staged .md or .mdx files have changes to structural front matter keys (slug, title, parent, order, hidden, category).
3. There are 2 possible outcomes:

- If structural changes are found, it automatically runs the rebuildManifest logic and stages the updated .readme-structure.json file for you.
- If no structural changes are found, it ensures the manifest is not staged, preventing accidental commits of a stale manifest.

### Validation (validate)

This mode is perfect for a CI check to ensure the structure is valid.

You can run `node scripts/hierarchy-manager/main.mjs validate` and the script will:

1. Run the "Validate structure only" logic.  
2. Exit with a success (0) or error (1) code.

### Manifest rebuild (manifest)

Use this in a build script to ensure your manifest is always up-to-date before a sync.

You can run `node scripts/hierarchy-manager/main.mjs manifest` and the script will run the "Rebuild manifest only" logic and exit.

### Move docs

This runs the "Move docs" flow non-interactively.

You can run `node scripts/hierarchy-manager/main.mjs --from slug-a,slug-b --to destination-slug` and the script will:  

1. Process the `--from` flag as a comma-separated list of doc slugs to move.  
2. Process the `--to` flag as the single destination slug (which can be either a category slug or a doc slug).  
