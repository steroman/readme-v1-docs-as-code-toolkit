// scripts/hierarchy-manager/utils.mjs

import 'dotenv/config';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';
import yaml from 'js-yaml';
import slugifyLib from 'slugify';
import axios from 'axios';

// ---------------------------
// Constants / Env
// ---------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DOCS_ROOT = path.resolve(process.cwd(), 'docs');
export const STRUCTURE_MANIFEST = path.join(DOCS_ROOT, '.readme-structure.json'); 
export const MAX_DOC_DEPTH = 3; // Max depth for doc nesting (parent/child/grandchild)

const README_BASE_URL = process.env.README_BASE_URL || 'https://dash.readme.com/api/v1';
const README_API_KEY = process.env.README_API_KEY_DOCS_SYNC; 

// --- MODIFICATION HERE ---
// We now export a boolean instead of exiting the process.
export let API_KEY_PRESENT = true;
if (!README_API_KEY) {
  API_KEY_PRESENT = false;
  // Silently hide the option, no warning needed.
}
// --- END MODIFICATION ---

// flags - read from main process arguments
export const ARGS = new Set(process.argv.slice(2));
export const DRY_RUN = ARGS.has('--dry-run') || ARGS.has('-n');
export const NO_COMMIT = ARGS.has('--no-commit');

// ---------------------------
// Small utilities
// ---------------------------
export const log = (...a) => console.log(...a);
export const warn = (...a) => console.warn(...a);
export const err = (...a) => console.error(...a);

export const slugify = (s) =>
  slugifyLib(String(s), { lower: true, strict: true, remove: /[^a-zA-Z0-9\s-]/g });

export const asYAML = (obj) => yaml.dump(obj, { noRefs: true, lineWidth: 120 });

// ---------------------------
// File I/O
// ---------------------------
export async function readDoc(absPath) {
  const src = await fs.readFile(absPath, 'utf8');
  const parsed = matter(src);
  return { content: parsed.content || '', fm: parsed.data || {} };
}

export async function writeDoc(absPath, content, fm) {
  const out = matter.stringify(content ?? '', fm, { language: 'yaml' });
  if (DRY_RUN) return;
  await fs.ensureDir(path.dirname(absPath));
  await fs.writeFile(absPath, out, 'utf8');
}

// ---------------------------
// HTTP Client / API Wrapper
// ---------------------------

const http = axios.create({
  baseURL: README_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 30000,
});

export async function safeApiCall(method, endpoint, payload, headers, actionLabel) {
    if (!API_KEY_PRESENT) {
        throw new Error(`API Key is missing. Cannot perform API action: ${actionLabel}`);
    }
    if (DRY_RUN) {
        log(`   [DRY-RUN] Would ${actionLabel} ${endpoint}`);
        // Return a mock object with keys the original code relies on
        return { 
            data: { 
                _id: `[DRY-RUN-ID-${Math.random().toFixed(4)}]`, 
                title: payload?.title || actionLabel, 
                slug: slugify(payload?.title || 'dry-run-slug') 
            } 
        };
    }
    
    // Ensure Basic Auth is calculated and added on every call
    const authHeaderValue = `Basic ${Buffer.from(`${README_API_KEY}:`).toString('base64')}`;
    
    const finalHeaders = {
        ...headers,
        Authorization: authHeaderValue,
    };
    
    try {
        const res = await http({ 
            method, 
            url: endpoint, 
            data: payload, 
            headers: finalHeaders // Use dynamically generated headers
        });
        return res;
    } catch (e) {
        if (e.response) throw new Error(`API Error on ${endpoint}: ${e.response.status} - ${JSON.stringify(e.response.data)}`);
        throw e;
    }
}