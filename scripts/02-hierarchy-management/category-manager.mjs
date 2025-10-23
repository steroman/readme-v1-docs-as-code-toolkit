// scripts/hierarchy-manager/category-manager.mjs

import path from 'path';
import fs from 'fs-extra';
import inquirer from 'inquirer';
import yaml from 'js-yaml'; 

import { 
    DOCS_ROOT, 
    log, 
    asYAML, 
    slugify, 
    safeApiCall, 
    DRY_RUN 
} from './utils.mjs'; 

/**
 * Interactive flow to create a new category (API FIRST).
 * - Prompts for title.
 * - Calls ReadMe API to create category and get canonical ID/slug.
 * - Creates local folder and _category.yml file based on the canonical slug.
 * - NO category-map.json interaction.
 */
export async function createCategoryFlow(categories) {
  const { title } = await inquirer.prompt([
    { name: 'title', type: 'input', message: 'Category title:' },
  ]);
  
  if (!title) throw new Error('Title is required');
  
  const expectedSlug = slugify(title);

  if (categories.bySlug.has(expectedSlug.toLowerCase())) {
    throw new Error(`Category slug "${expectedSlug}" (derived from title) already exists locally. Please use a unique title.`);
  }

  const payload = { title, type: 'guide' };
  log(`📤 Calling API to create category: ${title} (ensures canonical slug and immediate availability)`);
  
  // 1. Call API to create the category and get the canonical slug
  const res = await safeApiCall('post', '/categories', payload, null, `create category ${title}`);
  
  const finalSlug = res.data.slug; 

  // 2. Create local files using the canonical slug
  const folderAbs = path.join(DOCS_ROOT, finalSlug); 
  const ymlAbs = path.join(folderAbs, '_category.yml');
  const ymlData = { slug: finalSlug, title }; 

  if (DRY_RUN) {
    log(`🗂  [DRY-RUN] Would create category folder: ${path.relative(process.cwd(), folderAbs)}`);
    log(`📝 [DRY-RUN] Would write _category.yml (Final Slug: ${finalSlug})`);
  } else {
    await fs.ensureDir(folderAbs);
    await fs.writeFile(ymlAbs, asYAML(ymlData), 'utf8');
  }
  
  return { created: [{ path: folderAbs }, { path: ymlAbs }] };
}

/**
 * Interactive flow to edit a category title.
 * (This remains local-only as previously agreed)
 */
export async function editCategoryFlow(categories) {
  const choices = categories.list.map((c) => ({ name: `${c.title} (${c.slug})`, value: c.slug }));
  const { slug } = await inquirer.prompt([
    { name: 'slug', type: 'list', message: 'Select category to edit:', choices },
  ]);
  const cat = categories.bySlug.get(slug.toLowerCase());
  if (!cat) throw new Error(`Category with slug "${slug}" not found in index.`);
  
  const { newTitle } = await inquirer.prompt([
    { name: 'newTitle', type: 'input', message: 'New title:', default: cat.title },
  ]);
  
  if (!newTitle || newTitle === cat.title) {
    log('No change.');
    return { updated: [] };
  }
  
  log(`✏️  Updating local category file for slug: ${slug} → New Title: ${newTitle}`);

  const ymlAbs = cat.ymlAbs;
  if (DRY_RUN) {
    log(`✏️  [DRY-RUN] Would update ${path.relative(process.cwd(), ymlAbs)} title → "${newTitle}"`);
  } else {
    // yaml.load and yaml.dump are now defined thanks to the new import.
    const yobj = yaml.load(await fs.readFile(ymlAbs, 'utf8')) || {};
    yobj.title = newTitle;
    await fs.writeFile(ymlAbs, asYAML(yobj), 'utf8');
  }
  
  return { updated: [{ path: ymlAbs }] };
}