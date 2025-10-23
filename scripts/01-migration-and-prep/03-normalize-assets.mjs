import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import fetch from 'node-fetch';

// --- Configuration ---

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DOCS_ROOT = path.join(__dirname, 'docs');
const ASSETS_DIR_NAME = 'assets';
const ASSETS_DIR_PATH = path.join(DOCS_ROOT, ASSETS_DIR_NAME);

// --- Regex Patterns ---

const IMAGE_BLOCK_PATTERN = /\[block:image\]\s*({[\s\S]*?})\s*\[\/block\]/g;
const EMBED_BLOCK_PATTERN = /\[block:embed\]\s*({[\s\S]*?})\s*\[\/block\]/g;
const PARAMETERS_BLOCK_PATTERN = /\[block:parameters\]\s*({[\s\S]*?})\s*\[\/block\]/g;
const AUTOLINK_PATTERN = /<(https?:\/\/[^ >]+)>/g;
const REMOTE_MD_IMAGE_PATTERN = /!\[.*?\]\((https:\/\/files\.readme\.io\/[^\s)]+)(?:\s+"[^"]*")?\)/g;

// --- Helper Functions (Block Conversion) ---

function convertImageBlock(match, blockContent) {
    try {
        const data = JSON.parse(blockContent);
        if (!data.images) return '';
        const mdImages = data.images.map(img => {
            const url = Array.isArray(img.image) ? img.image[0] : null;
            if (url) {
                return `![](${url})`;
            }
            return '';
        }).filter(Boolean);
        return mdImages.join('\n\n');
    } catch (e) {
        console.warn(`⚠️ Could not parse image block: ${e.message}`);
        return match;
    }
}

function convertEmbedBlock(match, blockContent) {
    try {
        const data = JSON.parse(blockContent);
        const html = data.html || '';
        if (html) return html.trim();
        const url = data.url || '';
        const title = data.title || '';
        return `[Embed: ${title || url}]`;
    } catch (e) {
        console.warn(`⚠️ Could not parse embed block: ${e.message}`);
        return match;
    }
}

function convertParametersBlock(match, blockContent) {
    try {
        const data = JSON.parse(blockContent);
        const tableData = data.data || {};
        const cols = data.cols || 0;
        const rows = data.rows || 0;
        const headers = Array.from({ length: cols }, (_, i) => tableData[`h-${i}`] || "");
        const headerRow = `| ${headers.join(' | ')} |`;
        const separatorRow = `| ${headers.map(() => '---').join(' | ')} |`;
        const bodyRows = Array.from({ length: rows }, (_, r) => {
            const row = Array.from({ length: cols }, (_, c) => tableData[`${r}-${c}`] || "");
            return `| ${row.join(' | ')} |`;
        });
        return [headerRow, separatorRow, ...bodyRows].join('\n');
    } catch (e) {
        console.warn(`⚠️ Could not parse parameters block: ${e.message}`);
        return match;
    }
}

function fixAutolink(match, url) {
    return `[${url}](${url})`;
}

// --- Main Logic Functions ---

/**
 * Downloads a file from a URL to the local assets folder with a normalized filename.
 * @param {string} url The remote file URL.
 * @param {Map<string, string>} imageMap The map to store original URL to local path mapping.
 * @param {boolean} dryRun If true, just log without making changes.
 * @returns {Promise<string|null>} The relative asset path or the original URL on failure/dryRun.
 */
async function downloadImage(url, imageMap, dryRun) {
    if (imageMap.has(url)) {
        return imageMap.get(url);
    }

    const originalFilename = url.split('/').pop();

    // **MODIFICATION START**
    // Updated regex to match either a 7-char hex string OR a 32+ char hex string.
    const readmeHashRegex = /^([a-f0-9]{7}|[a-f0-9]{32,})-/i;

    // Create a cleaner, more readable filename by removing the hash prefix.
    const localFilename = originalFilename.replace(readmeHashRegex, '');
    // **MODIFICATION END**
    
    const localAssetPath = path.join(ASSETS_DIR_PATH, localFilename);
    const relativeAssetPath = path.join(ASSETS_DIR_NAME, localFilename);

    if (dryRun) {
        console.log(`   • [Dry Run] Would process: ${url} -> ${relativeAssetPath}`);
        imageMap.set(url, relativeAssetPath);
        return relativeAssetPath;
    }

    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const buffer = await response.buffer();
        await fs.writeFile(localAssetPath, buffer);

        console.log(`   ⬇️ Downloaded: ${localFilename} from ${url}`);
        imageMap.set(url, relativeAssetPath);
        return relativeAssetPath;
    } catch (e) {
        console.error(`   ❌ Failed to download ${url}: ${e.message}`);
        imageMap.set(url, url);
        return url;
    }
}


/**
 * Main function to process a single Markdown file.
 * @param {string} filepath The full path to the .md file.
 * @param {Map<string, string>} globalImageMap The map to store original URL to local path mapping globally.
 * @param {object} stats - Statistics object.
 * @param {boolean} dryRun - If true, just log without making changes.
 */
async function processFile(filepath, globalImageMap, stats, dryRun) {
    const relativeFilePath = path.relative(DOCS_ROOT, filepath);
    try {
        let content = await fs.readFile(filepath, 'utf-8');
        const originalContent = content;
        const fileStats = {
            images: 0,
            embeds: 0,
            parameters: 0,
            autolinks: 0,
            remoteImages: 0
        };
        
        fileStats.images = Array.from(content.matchAll(IMAGE_BLOCK_PATTERN)).length;
        content = content.replace(IMAGE_BLOCK_PATTERN, convertImageBlock);
        
        fileStats.embeds = Array.from(content.matchAll(EMBED_BLOCK_PATTERN)).length;
        content = content.replace(EMBED_BLOCK_PATTERN, convertEmbedBlock);

        fileStats.parameters = Array.from(content.matchAll(PARAMETERS_BLOCK_PATTERN)).length;
        content = content.replace(PARAMETERS_BLOCK_PATTERN, convertParametersBlock);

        fileStats.autolinks = Array.from(content.matchAll(AUTOLINK_PATTERN)).length;
        content = content.replace(AUTOLINK_PATTERN, fixAutolink);

        const remoteImageUrls = Array.from(content.matchAll(REMOTE_MD_IMAGE_PATTERN))
            .map(match => match[1]);
        
        const uniqueRemoteUrls = [...new Set(remoteImageUrls)];
        
        fileStats.remoteImages = uniqueRemoteUrls.length;
        stats.images += uniqueRemoteUrls.length;

        const downloadPromises = uniqueRemoteUrls.map(url => 
            downloadImage(url, globalImageMap, dryRun)
        );
        await Promise.all(downloadPromises);

        content = content.replace(REMOTE_MD_IMAGE_PATTERN, (match, url) => {
            const localPath = globalImageMap.get(url);
            
            if (localPath && !localPath.startsWith('http')) {
                const depth = relativeFilePath.split(path.sep).length - 1;
                const pathPrefix = depth > 0 ? Array(depth).fill('..').join('/') + '/' : './';
                
                return `![](${pathPrefix}${localPath})`;
            }
            return match;
        });

        if (content !== originalContent) {
            if (!dryRun) {
                await fs.writeFile(filepath, content, 'utf-8');
                stats.files_changed += 1;
            }
            
            console.log(`✅ ${dryRun ? '[Dry Run] ' : ''}Updated: ${relativeFilePath}`);
            if (fileStats.images > 0) console.log(`   • Converted ${fileStats.images} image block(s)`);
            if (fileStats.embeds > 0) console.log(`   • Converted ${fileStats.embeds} embed block(s)`);
            if (fileStats.parameters > 0) console.log(`   • Converted ${fileStats.parameters} parameters block(s)`);
            if (fileStats.autolinks > 0) console.log(`   • Fixed ${fileStats.autolinks} autolink(s)`);
            if (fileStats.remoteImages > 0) console.log(`   • Processed ${fileStats.remoteImages} remote image link(s)`);

        } else {
            console.log(`⏭️ ${dryRun ? '[Dry Run] ' : ''}Skipped: ${relativeFilePath} (no changes)`);
        }
        
        stats.files_total += 1;

    } catch (e) {
        console.error(`   ❌ Error processing ${relativeFilePath}: ${e.message}`);
    }
}

/**
 * Traverses the docs folder and processes all Markdown files.
 * @param {boolean} dryRun - If true, performs a dry run.
 */
async function processFolder(dryRun) {
    if (dryRun) {
        console.log("===================================");
        console.log("🦉 Starting Asset Normalization: DRY RUN");
        console.log("===================================");
    } else {
        console.log("===================================");
        console.log(`🖼️ Starting Asset Normalization: Downloading remote images to ${ASSETS_DIR_PATH}`);
        console.log("===================================");
        await fs.mkdir(ASSETS_DIR_PATH, { recursive: true });
    }

    const stats = {
        files_total: 0,
        files_changed: 0,
        images: 0,
    };

    const globalImageMap = new Map();
    const filesToProcess = [];

    async function collectFiles(dir) {
        try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory() && entry.name !== ASSETS_DIR_NAME) {
                    await collectFiles(fullPath);
                } else if (entry.isFile() && entry.name.endsWith('.md')) {
                    filesToProcess.push(fullPath);
                }
            }
        } catch (e) {
            console.error(`Error reading directory ${dir}: ${e.message}`);
        }
    }
    
    await collectFiles(DOCS_ROOT);

    for (const filepath of filesToProcess) {
        await processFile(filepath, globalImageMap, stats, dryRun);
    }

    console.log("==================================="); 
    console.log("🎉 Normalization Complete.");
    console.log("===================================");
    console.log("📊 Summary:");
    console.log(`   • Files scanned:       ${stats.files_total}`);
    console.log(`   • Files ${dryRun ? 'would be' : ''} updated: ${stats.files_changed}`);
    console.log(`   • Images ${dryRun ? 'would be' : ''} processed: ${stats.images}`);
}

// --- Execution ---

const dryRun = process.argv.includes('--dry-run');

processFolder(dryRun).catch(error => {
    console.error('\n🛑 Script failed with an error:', error);
    process.exit(1);
});