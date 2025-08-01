// ============================================================================
// FILE: index.js
// ============================================================================
import axios from 'axios';
import inquirer from 'inquirer';
import fs from 'fs/promises';
import path from 'path';
import Papa from 'papaparse';

// --- Configuration & Setup ---

// Caches to store data and minimize API calls
const authorCache = new Map();
const categoryCache = new Map();
const tagCache = new Map();
const mediaCache = new Map();

let axiosInstance;
let siteDomain; // Store domain for file naming

/**
 * Creates a reusable, authenticated Axios instance for all API requests.
 */
const setupApiClient = (domain, username, appPassword) => {
    siteDomain = domain;
    const baseURL = `https://${domain}/wp-json/wp/v2`;
    const encodedAuth = Buffer.from(`${username}:${appPassword}`).toString('base64');
    axiosInstance = axios.create({
        baseURL,
        headers: { 'Authorization': `Basic ${encodedAuth}`, 'User-Agent': 'WordPressDataExtractor/1.6' }
    });
};

// --- Pre-fetching and Caching Functions ---

/**
 * Generic function to fetch all items from a paginated endpoint.
 */
const fetchAndCacheAll = async (endpoint, cache, logName) => {
    console.log(`Fetching all ${logName}...`);
    let page = 1;
    let totalPages = 1;
    try {
        while (page <= totalPages) {
            const response = await axiosInstance.get(endpoint, { params: { per_page: 100, page } });
            if (page === 1) totalPages = parseInt(response.headers['x-wp-totalpages'], 10) || 1;
            response.data.forEach(item => cache.set(item.id, item.name));
            page++;
        }
        console.log(`Successfully cached ${cache.size} ${logName}.`);
    } catch (error) {
        console.warn(`Warning: Could not fetch ${logName}. This data may be missing from the report.`, error.message);
    }
};

/**
 * Fetches data for a given media ID and caches it.
 * @param {number} mediaId - The ID of the featured media item.
 * @returns {Promise<object>} An object with the image URL and alt text.
 */
const getFeaturedImageData = async (mediaId) => {
    if (!mediaId) return { url: '', alt: '' };
    if (mediaCache.has(mediaId)) return mediaCache.get(mediaId);

    try {
        const response = await axiosInstance.get(`/media/${mediaId}`, { params: { _fields: 'source_url,alt_text' } });
        const imageData = {
            url: response.data.source_url || '',
            alt: response.data.alt_text || ''
        };
        mediaCache.set(mediaId, imageData);
        return imageData;
    } catch (error) {
        console.warn(`Warning: Could not fetch media ID ${mediaId}.`, error.message);
        const errorData = { url: 'Error fetching image', alt: 'Error fetching image' };
        mediaCache.set(mediaId, errorData); // Cache the error to prevent retries
        return errorData;
    }
};

/**
 * Fetches all available, public post types from the WordPress site.
 */
const getPostTypes = async () => {
    console.log('Discovering available post types...');
    try {
        const response = await axiosInstance.get('/types');
        const availableTypes = Object.values(response.data)
            .filter(type => type.viewable && type.rest_base)
            .map(type => type.rest_base);

        if (availableTypes.length > 0) {
            console.log(`Found post types: ${availableTypes.join(', ')}`);
            return availableTypes;
        } else {
            console.warn('Warning: Could not automatically discover post types. Defaulting to "posts" and "pages".');
            return ['posts', 'pages'];
        }
    } catch (error) {
        console.error('Fatal: Could not fetch post types endpoint.', error.message);
        process.exit(1);
    }
};

/**
 * Fetches all items for a given post type, handling pagination.
 */
const fetchPaginatedData = async (postType) => {
    let allItems = [];
    let page = 1;
    let totalPages = 1;
    console.log(`\n--- Starting fetch for post type: '${postType}' ---`);

    const fields = [
        'id', 'title', 'author', 'date_gmt', 'modified_gmt', 'link', 'status',
        'excerpt', 'comment_status', 'template', 'categories', 'tags',
        'featured_media', 'yoast_head_json'
    ].join(',');

    try {
        while (page <= totalPages) {
            const response = await axiosInstance.get(`/${postType}`, {
                params: { per_page: 50, page, context: 'view', _fields: fields },
            });

            if (page === 1) {
                totalPages = parseInt(response.headers['x-wp-totalpages'], 10) || 1;
                console.log(`Found ${response.headers['x-wp-total']} items across ${totalPages} page(s).`);
            }
            if (response.data.length > 0) {
                allItems.push(...response.data);
                console.log(`Fetched page ${page}/${totalPages}... (${allItems.length} items so far)`);
            }
            page++;
        }
    } catch (error) {
        if (error.response && error.response.status === 404) {
             console.log(`No items found for post type '${postType}'. Skipping.`);
        } else {
            console.error(`Error fetching data for '${postType}': ${error.message}. Skipping this type.`);
        }
        return [];
    }
    return allItems;
};


// --- Data Processing and Saving ---

/**
 * Processes the raw API data and saves it as a CSV report.
 */
const createAndSaveReport = async (allData) => {
    if (allData.length === 0) {
        console.log('\n- No data was extracted. Report will not be generated.');
        return;
    }
    console.log('\nProcessing data for CSV report...');

    const flatData = await Promise.all(allData.map(async (item) => {
        const yoastData = item.yoast_head_json || {};
        const schema = yoastData.schema || {};
        const graph = schema['@graph'] || [];

        const article = graph.find(g => g['@type'] === 'Article') || {};
        const webpage = graph.find(g => g['@type'] === 'WebPage') || {};
        
        const focusKeyphrase = Array.isArray(article.keywords) ? article.keywords.join(', ') : article.keywords || '';
        const wordCount = webpage.wordCount || '';
        const hasMultipleH1s = (webpage.headline || '').split('</h1>').length - 1 > 1;

        const ogImageObject = yoastData.og_image && yoastData.og_image[0];
        const yoastTitle = yoastData.title || '';
        const yoastDesc = yoastData.description || '';

        const categoryNames = (item.categories || []).map(id => categoryCache.get(id) || `ID:${id}`).join(', ');
        const tagNames = (item.tags || []).map(id => tagCache.get(id) || `ID:${id}`).join(', ');
        const featuredImageData = await getFeaturedImageData(item.featured_media);

        // --- SEO Completeness Score Calculation ---
        let completenessScore = 0;
        const totalPossibleScore = 7;
        if ((item.categories || []).length > 0) completenessScore++;
        if ((item.tags || []).length > 0) completenessScore++;
        if (featuredImageData.url && !featuredImageData.url.startsWith('Error')) completenessScore++;
        if (featuredImageData.alt) completenessScore++; // Only count if alt text exists
        if (yoastDesc) completenessScore++;
        if (focusKeyphrase) completenessScore++;
        if (ogImageObject && ogImageObject.url) completenessScore++;

        // --- SEO Audit Boolean Checks ---
        const isTitleTooLong = yoastTitle.length > 60;
        const isTitleTooShort = yoastTitle.length < 30;
        const isDescMissing = !yoastDesc;
        const isDescTooLong = yoastDesc.length > 160;
        const isDescTooShort = yoastDesc.length > 0 && yoastDesc.length < 70;
        const isOgImageMissing = !ogImageObject;
        const isFeaturedImageAltMissing = featuredImageData.url && !featuredImageData.alt;

        return {
            'Post Type': item.postType,
            'ID': item.id,
            'Title': item.title?.rendered || 'No Title',
            'Status': item.status,
            'Author Name': authorCache.get(item.author) || `ID:${item.author}`,
            'Author ID': item.author,
            'Created Date (GMT)': item.date_gmt,
            'Last Updated Date (GMT)': item.modified_gmt,
            'Link': item.link,
            'Categories': categoryNames,
            'Tags': tagNames,
            'Comment Status': item.comment_status,
            'Template': item.template,
            'Excerpt': item.excerpt?.rendered.replace(/<[^>]+>/g, '').trim() || '',
            'Featured Image URL': featuredImageData.url,
            'Featured Image Alt Text': featuredImageData.alt,
            'Yoast Title': yoastTitle,
            'Yoast Description': yoastDesc,
            'Yoast Focus Keyphrase': focusKeyphrase,
            'Yoast Word Count': wordCount,
            'Yoast OG Title': yoastData.og_title,
            'Yoast OG Description': yoastData.og_description,
            'Yoast OG Image': ogImageObject ? ogImageObject.url : '',
            'Yoast Twitter Title': yoastData.twitter_title,
            'Yoast Twitter Description': yoastData.twitter_description,
            'Yoast Twitter Image': yoastData.twitter_image,
            'Yoast Canonical': yoastData.canonical,
            // SEO Audit Columns
            'AUDIT: SEO Meta Score': `${completenessScore} / ${totalPossibleScore}`,
            'AUDIT: Is Title Too Long (>60)': isTitleTooLong ? 'Yes' : 'No',
            'AUDIT: Is Title Too Short (<30)': isTitleTooShort ? 'Yes' : 'No',
            'AUDIT: Is Meta Desc Missing': isDescMissing ? 'Yes' : 'No',
            'AUDIT: Is Meta Desc Too Long (>160)': isDescTooLong ? 'Yes' : 'No',
            'AUDIT: Is Meta Desc Too Short (<70)': isDescTooShort ? 'Yes' : 'No',
            'AUDIT: Is OG Image Missing': isOgImageMissing ? 'Yes' : 'No',
            'AUDIT: Is Featured Image Alt Missing': isFeaturedImageAltMissing ? 'Yes' : 'No',
            'AUDIT: Has Multiple H1 Tags': hasMultipleH1s ? 'Yes' : 'No',
        };
    }));

    const csv = Papa.unparse(flatData);
    const now = new Date();
    const datetime = now.toISOString().replace(/[:.]/g, '-');
    const reportDir = path.join('reports', siteDomain);
    const fileName = `${datetime}-yoast-report.csv`;
    const filePath = path.join(reportDir, fileName);

    try {
        await fs.mkdir(reportDir, { recursive: true });
        await fs.writeFile(filePath, csv);
        console.log(`\n✅ Success! Report saved to: ${filePath}`);
    } catch (error) {
        console.error(`\n❌ Error saving CSV report to file: ${error.message}`);
    }
};


// --- Main Application Logic ---

const main = async () => {
    console.log('--- WordPress Data Extractor ---');
    
    const credentials = await inquirer.prompt([
        { type: 'input', name: 'domain', message: 'Enter the WordPress site domain (e.g., yoursite.com):', validate: input => !!input || 'Domain cannot be empty.' },
        { type: 'input', name: 'username', message: 'Enter your WordPress username:', validate: input => !!input || 'Username cannot be empty.' },
        { type: 'password', name: 'appPassword', message: 'Enter your WordPress Application Password:', mask: '*', validate: input => !!input || 'Application Password cannot be empty.' },
    ]);

    setupApiClient(credentials.domain, credentials.username, credentials.appPassword);

    // Pre-fetch and cache all supporting data
    await fetchAndCacheAll('/users', authorCache, 'users');
    await fetchAndCacheAll('/categories', categoryCache, 'categories');
    await fetchAndCacheAll('/tags', tagCache, 'tags');
    
    const postTypes = await getPostTypes();
    let allExtractedData = [];

    for (const type of postTypes) {
        const items = await fetchPaginatedData(type);
        if (items.length > 0) {
            const itemsWithType = items.map(item => ({ ...item, postType: type }));
            allExtractedData.push(...itemsWithType);
        }
    }
    
    await createAndSaveReport(allExtractedData);
};

// Run the application
main().catch(error => {
    console.error('\nAn unexpected error occurred:', error);
    process.exit(1);
});