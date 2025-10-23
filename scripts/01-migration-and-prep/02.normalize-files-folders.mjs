// unified-normalization-final.mjs

import { promises as fs } from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as fsSync from 'fs';
import * as yaml from 'js-yaml';

// Load the single Production API key
dotenv.config();
const API_KEY = process.env.README_API_KEY_DOCS_SYNC;

const BASE_URL = 'https://dash.readme.com/api/v1';
const DOCS_DIR = 'docs';
const CATEGORY_YML_FILE = '_category.yml';
const MANIFEST_FILE = path.join(DOCS_DIR, '.readme-structure.json');

function readCategoryYml(filePath) {
    try {
        const content = fsSync.readFileSync(filePath, 'utf8');
        return yaml.load(content) || {};
    } catch (e) {
        return {};
    }
}

async function fetchReadme(endpoint, apiKey, params = {}) {
    if (!apiKey) {
        throw new Error(`API Key is missing for the request to ${endpoint}.`);
    }
    const url = new URL(path.join(BASE_URL, endpoint));
    Object.keys(params).forEach(key => url.searchParams.append(key, params[key]));
    const headers = {
        'Accept': 'application/json',
        'Authorization': `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`
    };
    const response = await fetch(url.toString(), { headers });
    if (!response.ok) {
        let errorBody;
        try {
            errorBody = await response.json();
        } catch {
            errorBody = await response.text();
        }
        throw new Error(`ReadMe API Error on ${endpoint} (${response.status} ${response.statusText}): ${JSON.stringify(errorBody, null, 2)}`);
    }
    if (response.status === 204) return null;
    return response.json();
}

function readFrontMatter(filePath) {
    const fmRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
    let fileContent;
    try {
        fileContent = fsSync.readFileSync(filePath, 'utf8');
    } catch (e) {
        if (e.code === 'ENOENT') return { frontMatter: {}, content: '' };
        throw e;
    }
    const match = fileContent.match(fmRegex);
    if (match) {
        const yamlContent = match[1];
        const content = match[2];
        const frontMatter = yaml.load(yamlContent) || {};
        return { frontMatter, content: content.trim() };
    }
    return { frontMatter: {}, content: fileContent.trim() };
}

async function writeFrontMatter(filePath, frontMatter, content, dryRun) {
    const fmString = yaml.dump(frontMatter, { lineWidth: -1, quotingType: '"', noRefs: true });
    const newContent = `---\n${fmString.trim()}\n---\n\n${content}\n`;
    if (dryRun) {
        console.log(`✏️  Would update FM: ${filePath}`);
    } else {
        await fs.writeFile(filePath, newContent, 'utf8');
    }
}

async function caseSafeRename(oldPath, newPath, dryRun) {
    const tempPath = `${oldPath}.__temp_rename__`;
    if (dryRun) {
        console.log(`🔤 Would case-fix "${path.basename(oldPath)}" → "${path.basename(newPath)}"`);
    } else {
        await fs.rename(oldPath, tempPath);
        await fs.rename(tempPath, newPath);
    }
}

async function recursiveMerge(source, target, dryRun) {
    const entries = await fs.readdir(source, { withFileTypes: true });
    for (const entry of entries) {
        const sourcePath = path.join(source, entry.name);
        const targetPath = path.join(target, entry.name);
        if (entry.isDirectory()) {
            if (dryRun) console.log(`📦 Would ensure target directory: ${targetPath}`);
            else await fs.mkdir(targetPath, { recursive: true });
            await recursiveMerge(sourcePath, targetPath, dryRun);
        } else if (entry.isFile()) {
            let finalTargetPath = targetPath;
            let counter = 0;
            const { name, ext } = path.parse(targetPath);
            while (!dryRun && await fs.access(finalTargetPath).then(() => true).catch(() => false)) {
                counter++;
                finalTargetPath = path.join(target, `${name}-${counter}${ext}`);
            }
            if (dryRun) {
                const action = counter > 0 ? `append to file as: ${path.basename(finalTargetPath)}` : 'copy file';
                console.log(`📦 Would merge file: ${entry.name} (${action})`);
            } else {
                await fs.copyFile(sourcePath, finalTargetPath);
            }
        }
    }
    const sourceEntries = await fs.readdir(source);
    if (sourceEntries.length === 0) {
        if (dryRun) console.log(`📦 Would remove empty source folder: ${source}`);
        else await fs.rmdir(source);
    }
}

async function findLocalMarkdownFiles(dir) {
    let files = [];
    let entries;
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
        if (e.code === 'ENOENT') return files;
        throw e;
    }
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
        if (entry.isDirectory()) {
            files = files.concat(await findLocalMarkdownFiles(fullPath));
        } else if (entry.isFile() && (entry.name.endsWith('.md') || entry.name.endsWith('.mdx'))) {
            files.push(fullPath);
        }
    }
    return files;
}

/**
 * Fetches all categories, guide categories, and the complete doc map
 * from the single (PROD) environment.
 */
async function fetchProdData() {
    console.log("--- Fetching ALL data and structure from PROD environment ---");
    const prodDocMap = new Map();
    let allProdCategories = [];
    let page = 1;
    let keepFetching = true;

    while(keepFetching) {
        // Use the single API_KEY
        const categoriesPage = await fetchReadme('/categories', API_KEY, { page, perPage: 100 });
        if (!categoriesPage || categoriesPage.length === 0) {
            keepFetching = false;
        } else {
            allProdCategories.push(...categoriesPage);
            if (categoriesPage.length < 100) keepFetching = false;
            else page++;
        }
    }
    
    // Get guide categories list (for folder renaming)
    const guideCategories = allProdCategories
        .filter(c => c.type === 'guide')
        .map(cat => ({ slug: cat.slug, title: cat.title }));

    console.log(`   - Found ${guideCategories.length} 'guide' categories in PROD.`);

    // Build the full doc map (for front matter normalization)
    for (const category of guideCategories) { // Only need to fetch docs for guide categories
        try {
            // Use the single API_KEY
            const docsTree = await fetchReadme(`/categories/${category.slug}/docs`, API_KEY);
            
            const flattenDocs = (arr, parentSlug = null) => {
                if (!Array.isArray(arr)) return;
                arr.forEach(doc => {
                    const docWithParentData = { ...doc, parent: parentSlug };
                    prodDocMap.set(doc.slug.toLowerCase(), docWithParentData);
                    
                    if (doc.children && doc.children.length > 0) {
                        flattenDocs(doc.children, doc.slug);
                    }
                });
            };

            flattenDocs(docsTree);
        } catch (e) {
             console.log(`   - ⚠️  Warning: Could not fetch docs for PROD category "${category.slug}". Skipping this category.`);
        }
    }

    console.log(`✅ Created a master list of ${prodDocMap.size} documents from PROD.`);
    
    // Return both the map and the category list
    return { prodDocMap, guideCategories };
}


async function renameCategoryFolders(categories, dryRun, mergeOnConflict) {
    console.log("\n--- Renaming Category Folders (Title -> slug) ---");
    let topLevelFolders;
    try {
        topLevelFolders = await fs.readdir(DOCS_DIR);
    } catch (error) {
        if (error.code === 'ENOENT') {
            if (dryRun) console.log(`⚠️ Warning: Directory '${DOCS_DIR}' not found. Assuming it exists.`);
            else await fs.mkdir(DOCS_DIR, { recursive: true });
            topLevelFolders = [];
        } else {
            throw error;
        }
    }
    const foldersByName = new Map(topLevelFolders.map(name => [name, name]));
    for (const category of categories) {
        const { title, slug } = category;
        const sourceFolderName = foldersByName.get(title);
        if (!sourceFolderName) {
            if (!foldersByName.has(slug)) console.log(`⚠️ Skipping: no folder named exactly "${title}"`);
            continue;
        }
        const sourcePath = path.join(DOCS_DIR, sourceFolderName);
        const targetPath = path.join(DOCS_DIR, slug);
        const targetExists = foldersByName.has(slug);
        const isCaseOnlyDiff = sourceFolderName.toLowerCase() === slug.toLowerCase() && sourceFolderName !== slug;
        if (sourceFolderName === slug) continue;
        if (isCaseOnlyDiff) {
            await caseSafeRename(sourcePath, targetPath, dryRun);
            foldersByName.delete(sourceFolderName);
            foldersByName.set(slug, slug);
        } else if (targetExists) {
            if (mergeOnConflict) {
                if (dryRun) console.log(`📦 Would merge "${sourceFolderName}" → "${slug}"`);
                else await recursiveMerge(sourcePath, targetPath, dryRun);
                foldersByName.delete(sourceFolderName);
            } else {
                console.log(`⚠️ Target "${slug}" exists; skipping rename of "${sourceFolderName}" (merge disabled)`);
            }
        } else {
            if (dryRun) console.log(`📁 Would rename "${sourceFolderName}" → "${slug}"`);
            else await fs.rename(sourcePath, targetPath);
            foldersByName.delete(sourceFolderName);
            foldersByName.set(slug, slug);
        }
    }
    return foldersByName;
}

async function ensureCategoryYml(categories, dryRun, currentFolders) {
    console.log("\n--- Ensuring _category.yml in slug folders ---");
    const existingSlugs = new Set();
    for (const category of categories) {
        const categoryPath = path.join(DOCS_DIR, category.slug);
        const ymlPath = path.join(categoryPath, CATEGORY_YML_FILE);
        const categoryYmlContent = `slug: ${category.slug}\ntitle: "${category.title}"\n`;
        const dirExists = currentFolders.has(category.slug);
        if (dirExists) {
            if (dryRun) console.log(`🗂 Would write ${ymlPath}`);
            else await fs.writeFile(ymlPath, categoryYmlContent, 'utf8');
            existingSlugs.add(category.slug);
        } else {
            if (dryRun) {
                console.log(`📁 Would create missing local directory: docs/${category.slug}/`);
                console.log(`🗂 Would write ${ymlPath}`);
            } else {
                await fs.mkdir(categoryPath, { recursive: true });
                await fs.writeFile(ymlPath, categoryYmlContent, 'utf8');
            }
            existingSlugs.add(category.slug);
        }
    }
    return existingSlugs;
}

async function updateDocFrontMatter(guideCategories, prodDocMap, dryRun) {
    console.log("\n--- Updating Front Matter with PROD Structure ---");
    for (const category of guideCategories) {
        const categorySlug = category.slug;
        console.log(`\n> Processing local files in category folder: ${categorySlug}`);
        const localDocPaths = await findLocalMarkdownFiles(path.join(DOCS_DIR, categorySlug));

        for (const localPath of localDocPaths) {
            const { name } = path.parse(localPath);
            const prodDoc = prodDocMap.get(name.toLowerCase());

            if (!prodDoc) {
                console.log(`   - ⚠️  Warning: Local file "${path.basename(localPath)}" has no matching doc in the PROD master list. Skipping update.`);
                continue;
            }

            const { frontMatter, content } = readFrontMatter(localPath);
            let fmChanged = false;
            const newFM = { ...frontMatter };

            const correctFM = {
                slug: prodDoc.slug,
                title: prodDoc.title,
                category: categorySlug,
                parent: prodDoc.parent || null,
                order: prodDoc.order,
                hidden: prodDoc.hidden,
            };

            for (const [key, newValue] of Object.entries(correctFM)) {
                const currentValue = newFM[key];
                
                if (currentValue !== newValue) {
                    newFM[key] = newValue;
                    fmChanged = true;
                }
            }
            
            if ('createdAt' in newFM) { delete newFM.createdAt; fmChanged = true; }
            if ('updatedAt' in newFM) { delete newFM.updatedAt; fmChanged = true; }

            if (fmChanged) {
                await writeFrontMatter(localPath, newFM, content, dryRun);
            }
        }
    }
}

function buildAndSortTreeWithParent(arr, parentSlug = null) {
    arr.sort((a, b) => {
        const orderA = a.order !== undefined ? a.order : Infinity;
        const orderB = b.order !== undefined ? b.order : Infinity;
        if (orderA !== orderB) return orderA - orderB;
        return a.slug.localeCompare(b.slug);
    });
    return arr.map(doc => ({
        slug: doc.slug,
        title: doc.title,
        order: doc.order !== undefined ? doc.order : 9999,
        parent: parentSlug,
        children: buildAndSortTreeWithParent(doc.children, doc.slug)
    }));
}

async function buildAndWriteManifest(existingSlugs, dryRun) {
    console.log("\n--- Building and Writing Manifest (.readme-structure.json) ---");
    const manifest = { categories: [] };
    const allLocalDocs = await findLocalMarkdownFiles(DOCS_DIR);
    const categoriesMap = new Map();
    const docsBySlug = new Map();
    const docsByCategorySlug = new Map();
    for (const categorySlug of existingSlugs) {
        try {
            const ymlPath = path.join(DOCS_DIR, categorySlug, CATEGORY_YML_FILE);
            const catFM = readCategoryYml(ymlPath);
            if (fsSync.existsSync(ymlPath) && catFM.slug && catFM.title) {
                categoriesMap.set(categorySlug, { slug: catFM.slug, title: catFM.title, docs: [] });
                docsByCategorySlug.set(categorySlug, []);
            }
        } catch (e) {
            console.warn(`⚠️ Error processing category YML for ${categorySlug}: ${e.message}`);
        }
    }
    for (const docPath of allLocalDocs) {
        const { frontMatter } = readFrontMatter(docPath);
        const { slug, title, category, order, parent } = frontMatter;
        let matchingCategorySlug = null;
        if (category) {
            for (const key of categoriesMap.keys()) {
                if (key.toLowerCase() === category.toLowerCase()) {
                    matchingCategorySlug = key;
                    break;
                }
            }
        }
        if (slug && title && matchingCategorySlug) {
            const docItem = { slug, title, order, parent: parent || null, children: [] };
            docsBySlug.set(slug, docItem);
            docsByCategorySlug.get(matchingCategorySlug).push(docItem);
        }
    }
    categoriesMap.forEach(category => {
        const docsList = docsByCategorySlug.get(category.slug);
        const topLevelDocs = [];
        docsList.forEach(doc => {
            if (doc.parent) {
                const parentDoc = docsBySlug.get(doc.parent);
                if (parentDoc) parentDoc.children.push(doc);
                else topLevelDocs.push(doc);
            } else {
                topLevelDocs.push(doc);
            }
        });
        category.docs = buildAndSortTreeWithParent(topLevelDocs, null);
        manifest.categories.push(category);
    });
    manifest.categories.sort((a, b) => a.slug.localeCompare(b.slug));
    const manifestContent = JSON.stringify(manifest, null, 2) + '\n';
    if (dryRun) {
        console.log(`🪴 Would write ${MANIFEST_FILE}`);
    } else {
        await fs.writeFile(MANIFEST_FILE, manifestContent, 'utf8');
    }
}

async function main() {
    if (!API_KEY) {
        console.error("\n❌ FATAL: The required API key is missing.");
        console.error("   Please ensure README_API_KEY is set in your .env file.");
        process.exit(1);
    }
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run') || args.includes('-n');
    const mergeOnConflict = args.includes('--merge-on-conflict');
    if (dryRun) {
        console.log("========================================");
        console.log("         ✨ DRY RUN MODE ACTIVE ✨        ");
        console.log("========================================");
    }
    try {
        // Fetch both structure and categories from the single PROD source
        const { prodDocMap, guideCategories } = await fetchProdData();
        
        // The rest of the script uses these variables
        const currentFolders = await renameCategoryFolders(guideCategories, dryRun, mergeOnConflict);
        const existingSlugs = await ensureCategoryYml(guideCategories, dryRun, currentFolders);
        await updateDocFrontMatter(guideCategories, prodDocMap, dryRun);
        await buildAndWriteManifest(existingSlugs, dryRun);

        console.log("\n========================================");
        console.log(dryRun ? "Dry run complete. No files were modified." : "Normalization complete. Files have been updated.");
        console.log("========================================");
    } catch (error) {
        console.error("\n❌ An error occurred during normalization:", error.message);
        if (error.stack) console.error(error.stack);
        process.exit(1);
    }
}

main();