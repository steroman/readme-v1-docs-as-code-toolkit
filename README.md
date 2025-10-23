# ReadMe.com legacy (v1) docs-as-code workflow

[![Node.js CI](https://img.shields.io/badge/node.js-18%2B-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

A collection of Node.js scripts that provide a one-way, `docs-as-code` workflow for projects on ReadMe.com's legacy (v1) API.

This solution is for teams who want to use a Git repository as the single source of truth for their GUIDE documentation and automatically publish changes to ReadMe (legacy, API v1), without giving up the benefits of version control, pull requests, and local development. It's meant to be a temporary patch while you can migrate to the new ReadMe version (Reloaded).

> 📘 **This stuff was vibe coded**
>
> While I made sure to check the logic and accuracy of the code with the knowledge I have, this code is far from perfect. One example is that some scripts are in CommonJS, while others are ES6 modules. Use it at your own risk and feel free to contribute to this repo if you want to improve it.

## Core concepts and assumptions

### ⚠️ One-way sync (Repo → ReadMe)

This is a one-way synchronization workflow. After the migration, your git repository becomes the single source of truth.

- Changes in your repo (e.g., merging a PR) are pushed to ReadMe.
- Changes made in the ReadMe UI (e.g., editing a doc) will be overwritten by the sync script on its next run.

This system is not bi-directional. For bi-directional sync, you can use ReadMe's newer "Reloaded" platform (which uses their v2 API).

## Key features

- Slug-based: All operations are based on document and category `slugs`, not ReadMe's internal `_id`s. This makes the sync stable and resilient. This is because ReadMe "forks" all documentation when you create a new version, generating new unique `_id`s for every document. This breaks any `_id`-based sync. Slugs, however, remain consistent across versions.
- Default version sync: The sync script always targets your project's main (default) version in ReadMe. It does not use the `x-readme-version` header, ensuring your `main` branch always matches ReadMe's primary content.
- Markdown portability: Some scripts convert ReadMe-flavored Markdown syntax (like `[block:image]` or `[block:parameters]`) into standard, portable Markdown. This makes your content cleaner and easier to move to other platforms in the future.
  - Note: The scripts intentionally preserve `[block:html]` tags, as these are often used for custom components. You are free to fork the repo and modify this behavior.
- External image handling. The ReadMe v1 API does not provide any endpoints for managing images. This project works around this limitation by using an external S3 bucket (or any public file storage) as the host for your images and automatically replacing local image paths with their permanent public URLs every time a document is pushed to ReadMe.

## Key limitations

- It's not possible to reorder categories because the ReadMe API does not provide an endpoint to do so. If you want to reorder categories, you'll have to do it manually from the UI. New categories are always added at the bottom.
- It's not possible to handle images because the ReadMe API does not provide an endpoint to do so. As explained in [Key features](#key-features), the scripts work around this limitation by pushing images to an external bucket and parsing the public url to the content before it's pushed to ReadMe

## Requirements

Before you begin, ensure you have the following:

- Node.js: v18.0.0 or higher is recommended.
- npm: This is included with Node.js.
- ReadMe account (Legacy v1): You must have an active ReadMe.com project on the legacy v1 API platform.
- ReadMe API key: You'll need your project's API key. This is required for the migration scripts and hierarchy manager, and for the sync script in CI/CD.
- AWS S3 or Cloudinary bucket with a reachable public URL: This will be used to host your images.

## Workflow

This project is divided into three toolsets, each in its own folder, to guide you from migration to automated sync.

### Step 1. Preparation (Manual)

Before you can use the scripts, you must export your existing documentation from ReadMe.

1. In your ReadMe project, go to Project Settings > Export Project.
2. Download the `.zip` file.
3. Unzip the contents, navigate to the latest version (e.g., `v1.0.0`).

![](/assets/readme-export-folders.png)

4. copy its content in the `/docs` folder of your repository so that it resembles the following structure:

```txt
docs/
├── Getting Started/
│   ├── Introduction.md
│   ├── Quickstart.md
│   └── Making Your First Call.md
│
├── Authentication/
│   ├── API Keys.md
│   └── OAuth 2.0.md
│
├── API Reference/
│   ├── The Basics.md
│   ├── Users API.md
│   ├── Widgets API.md
│   └── Errors.md
│
├── SDKs and Tools/
│   ├── NodeJS SDK.md
│   └── Python SDK.md
│
└── Webhooks/
    ├── Subscribing to Events.md
    └── Webhook Signatures.md
```

### Step 2. Migration & cleanup

The `01-migration-and-prep` folder contains a collection of scripts meant to be run one time to clean your exported files and make them compatible with this `docs-as-code` system. They will:

- Delete API reference files and folder keeping only "guides." When you export your ReadMe project, it includes content from other categories too.
- Rename your folders from titles to slugs.
- Create `_category.yml` files inside the top-level folders to store category info
- Normalize all doc front matter by adding: order, parent, category, hidden status, and excerpt
- Download all remote images to `docs/assets` and replace the local image paths in all the markdown files
- Replace ReadMe-flavored Markdown syntax with vanilla syntax

### Step 3. Hierarchy management

The `02-hierarchy-management` script is an interactive CLI tool for local development. You can use it to safely create new categories, move documents, or validate your local file structure before you commit your changes.

This tool isn't mandatory to complete your migration, but you'll be using it often after you migrated to maintain your documentation hierarchy safe and sound.

### 4. Automated sync (CI/CD)

The `03-sync` script is what you will run in your CI/CD pipeline (e.g., GitHub Actions). It compares your repository's `docs/` folder with your ReadMe project and automatically syncs all changes, including creating, updating, and deleting docs, categories, and images.

## Installation and project setup

This toolset is designed to be added to your existing documentation repository.

Your `docs/` folder should be at the root of your project. You will then add the scripts and configuration files alongside it.

### Recommended project structure

We recommend creating a scripts/ folder in your project to hold the toolsets. Your final project structure should look like this:

```txt
your-docs-repo/
├── .env                      # Where you store your ReadMe API key and other secrets
├── .github/
│   └── workflows/
│       └── sync-docs.yml     # CI/CD workflow
├── package.json              # Manages all dependencies and scripts
│
├── docs/                     # Your documentation lives here
│   ├── assets/               # Your local images. This folder will be created automatically when you run one of the prep scripts
│   ├── {category_folder}/
│   │   ├── _category.yml     # Defines the category slug and title
│   │   └── introduction.md   # A sampledocument
│   └── ...
│
└── scripts/                  <-- Create this folder for the tools
    ├── 01-migration-and-prep/    # Copy the 'migration' toolset here
    ├── 02-hierarchy-management/  # Copy the 'hierarchy' toolset here
    └── 03-sync/                  # Copy the 'sync' toolset here
```

### How to install

1. Create a scripts/ folder in your project's root directory.

2. Copy the toolsets (`01-migration-and-prep`, `02-hierarchy-management`, and `03-sync`) into your new `scripts/` folder.

3. Copy the pre-commit hook into your project's hooks folder. You can find it in the `/hooks/` folder of this repository.

4. Add configuration files:

- Copy the `.env.example` file from this repository to your project's root.
- Copy the `package.json` file. If you already have a package.json, merge the dependencies and scripts sections from this repo into your own.

4. Install dependencies:

```bash
npm install
```

5. Create your local .env file:

```bash
cp .env.example .env
```

6. Edit your `.env` file and add your README_API_KEY and other variables. This key is required for the migration and hierarchy management scripts to work locally.

7. Add the `README_API_KEY` secret to your CI/CD workflow (e.g., GitHub Actions). This key is required for the sync script to work in your CI/CD pipeline.

## Usage & next steps

This project is divided into three distinct guides, each in its own folder. We recommend following them in order.

| Step | Guide | When to use it |
| --- | --- | --- |
| 1 | [Migration & prep guide](./scripts/01-migration-and-prep/README.md) | Start here. Run these scripts one time to clean your exported ReadMe docs. |
| 2 | [Hierarchy management guide](./scripts/02-hierarchy-management/README.md) | Use this interactive tool for your day-to-day work: creating categories, moving docs, and validating your structure. |
| 3 | [Sync (CI/CD) guide](./scripts/03-sync/README.md) | This is the final step. Set this up in your CI/CD pipeline to automate publishing your docs to ReadMe. |
