const express = require('express');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const { parse } = require('csv-parse/sync');
const WooCommerceRestApi = require('@woocommerce/woocommerce-rest-api').default;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// CONFIG
// ==========================================
const config = {
  TCGCSV_BASE: 'https://tcgcsv.com/tcgplayer',
  POKEMON_CATEGORY_ID: 3,
  WC_URL: process.env.WC_URL || 'https://tcgcolombia.com',
  WC_KEY: process.env.WC_KEY,
  WC_SECRET: process.env.WC_SECRET,
  CATEGORY_SINGLES_ID: parseInt(process.env.CATEGORY_SINGLES_ID) || 199,
  MIN_PRICE_COP: 200,
  BATCH_SIZE: 100,
  RATE_LIMIT_MS: 300,
};

// ==========================================
// STATE
// ==========================================
let syncState = {
  running: false,
  phase: 'idle',
  progress: 0,
  total: 0,
  created: 0,
  updated: 0,
  skipped: 0,
  currentSet: '',
  logs: [],
  startTime: null,
  endTime: null,
};

const sseClients = new Set();

function resetState() {
  syncState = {
    running: false,
    phase: 'idle',
    progress: 0,
    total: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    currentSet: '',
    logs: [],
    startTime: null,
    endTime: null,
  };
}

function log(msg, type = 'info') {
  const timestamp = new Date().toISOString();
  const entry = { timestamp, msg, type };
  syncState.logs.push(entry);
  // Keep last 500 logs
  if (syncState.logs.length > 500) syncState.logs.shift();
  broadcast({ type: 'log', data: entry });
  console.log(`[${timestamp}] ${msg}`);
}

function updateProgress(updates) {
  Object.assign(syncState, updates);
  broadcast({ type: 'progress', data: syncState });
}

function broadcast(msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  sseClients.forEach(client => client.write(data));
}

// ==========================================
// UTILITIES
// ==========================================

function slugify(text) {
  if (!text) return '';
  return text.toString().toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-');
}

async function getTRM() {
  try {
    const res = await fetch('https://www.datos.gov.co/resource/32sa-8pi3.json?$limit=1&$order=vigenciahasta%20DESC');
    const data = await res.json();
    return parseFloat(data[0].valor);
  } catch (e) {
    log('⚠️ Could not fetch TRM, using default 4200', 'warn');
    return 4200;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildDescription(row, setName) {
  const val = (col) => row[col] || '-';
  return `
<div style="background-color: #fff3cd; border: 1px solid #ffeeba; color: #856404; padding: 10px; border-radius: 4px; margin-bottom: 15px;">
  <strong>⚠️ Idioma:</strong> Puede variar entre Inglés y Español.
</div>
<ul style="list-style: none; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px;">
  <li><strong>Set:</strong> ${setName}</li>
  <li><strong>Número:</strong> ${val('extNumber')}</li>
  <li><strong>Rareza:</strong> ${val('extRarity')}</li>
  <li><strong>Tipo:</strong> ${val('extCardType')}</li>
  <li><strong>HP:</strong> ${val('extHP')}</li>
</ul>
  `.trim();
}

// ==========================================
// SYNC LOGIC
// ==========================================

async function runSync(mode = 'full') {
  if (syncState.running) {
    log('⚠️ Sync already running', 'warn');
    return;
  }

  const pricesOnly = mode === 'prices';
  
  resetState();
  syncState.running = true;
  syncState.mode = mode;
  syncState.startTime = new Date().toISOString();
  updateProgress({ phase: 'starting' });
  
  log(`🚀 Starting ${pricesOnly ? 'PRICE-ONLY' : 'FULL'} sync...`, 'info');

  try {
    // Phase 1: Download CSVs
    updateProgress({ phase: 'downloading' });
    log('📥 Downloading card data from tcgcsv.com...', 'info');
    
    const groupsUrl = `${config.TCGCSV_BASE}/${config.POKEMON_CATEGORY_ID}/Groups.csv`;
    const groupsRes = await fetch(groupsUrl);
    const groupsCsv = await groupsRes.text();
    const groups = parse(groupsCsv, { columns: true, skip_empty_lines: true });
    
    log(`📦 Found ${groups.length} Pokemon sets`, 'success');
    updateProgress({ total: groups.length });
    
    const groupsMap = {};
    const abbrevMap = {};
    groups.forEach(g => {
      groupsMap[g.groupId] = g.name;
      abbrevMap[g.groupId] = g.abbreviation || g.groupId;
    });

    // Phase 2: Get TRM
    const trm = await getTRM();
    log(`💱 Exchange rate: ${trm.toLocaleString()} COP/USD`, 'info');

    // Phase 3: Initialize WooCommerce
    updateProgress({ phase: 'connecting' });
    log('🔌 Connecting to WooCommerce...', 'info');
    
    const wcApi = new WooCommerceRestApi({
      url: config.WC_URL,
      consumerKey: config.WC_KEY,
      consumerSecret: config.WC_SECRET,
      version: 'wc/v3',
      timeout: 120000,
    });

    // Phase 4: Fetch existing products
    updateProgress({ phase: 'fetching' });
    log('📋 Fetching existing products...', 'info');
    
    const existingProducts = new Map();
    let page = 1;
    let hasMore = true;
    
    while (hasMore) {
      try {
        const res = await wcApi.get('products', { per_page: 100, page, status: 'any' });
        const products = res.data;
        products.forEach(p => {
          if (p.sku) existingProducts.set(p.sku, { id: p.id, status: p.status });
        });
        hasMore = products.length === 100;
        page++;
        if (page % 5 === 0) {
          log(`   Fetched ${existingProducts.size} products...`, 'info');
        }
      } catch (e) {
        log(`⚠️ Error fetching page ${page}: ${e.message}`, 'warn');
        hasMore = false;
      }
    }
    
    log(`📦 Found ${existingProducts.size} existing products in store`, 'success');

    // Phase 5: Process sets
    updateProgress({ phase: 'syncing', progress: 0 });
    log('🛒 Starting WooCommerce sync...', 'info');

    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      const groupId = group.groupId;
      const setName = groupsMap[groupId];
      
      updateProgress({ 
        progress: i + 1, 
        currentSet: setName 
      });

      // Download set CSV
      let products;
      try {
        const setUrl = `${config.TCGCSV_BASE}/${config.POKEMON_CATEGORY_ID}/${groupId}/ProductsAndPrices.csv`;
        const setRes = await fetch(setUrl);
        const setCsv = await setRes.text();
        products = parse(setCsv, { columns: true, skip_empty_lines: true });
      } catch (e) {
        continue;
      }

      // Filter to singles only
      const singles = products.filter(p => {
        const extNum = (p.extNumber || '').trim();
        const hasSlash = extNum.includes('/');
        const hasPrice = p.marketPrice && parseFloat(p.marketPrice) > 0;
        return hasSlash && hasPrice;
      });

      if (singles.length === 0) continue;

      // Build batch operations
      const toCreate = [];
      const toUpdate = [];

      for (const row of singles) {
        const abbrev = abbrevMap[groupId] || groupId;
        const productId = row.productId;
        const subType = slugify(row.subTypeName || 'normal') || 'base';
        const sku = `${productId}-${subType}-${abbrev}`;

        // Build title
        const baseName = (row.name || row.cleanName || '').trim().replace(' - ', ' | ');
        const extNumber = (row.extNumber || '').trim();
        let title = baseName.includes(extNumber) ? baseName : `${baseName} | ${extNumber}`;
        if (row.subTypeName) title += ` | ${row.subTypeName}`;
        title += ` | ${setName}`;
        title = title.replace(/\s+/g, ' ').trim();

        // Calculate price
        let priceCOP = Math.round(parseFloat(row.marketPrice) * trm);
        if (priceCOP < config.MIN_PRICE_COP) priceCOP = config.MIN_PRICE_COP;

        const existing = existingProducts.get(sku);

        if (existing) {
          // Price-only mode: just update price
          const updateData = pricesOnly 
            ? { id: existing.id, regular_price: String(priceCOP) }
            : {
                id: existing.id,
                name: title,
                regular_price: String(priceCOP),
                categories: [{ id: config.CATEGORY_SINGLES_ID }],
                tags: [{ name: setName }],
                status: existing.status === 'trash' ? 'publish' : undefined,
              };
          toUpdate.push(updateData);
        } else if (!pricesOnly) {
          // Full mode only: create new products
          toCreate.push({
            name: title,
            type: 'simple',
            sku,
            regular_price: String(priceCOP),
            short_description: buildDescription(row, setName),
            manage_stock: true,
            stock_quantity: 0,
            categories: [{ id: config.CATEGORY_SINGLES_ID }],
            tags: [{ name: setName }],
            images: row.imageUrl ? [{ src: row.imageUrl.replace('_200w', '_400w') }] : [],
          });
        } else {
          // Price-only mode: skip new products
          syncState.skipped++;
        }
      }

      // Execute batch creates (only in full mode)
      if (!pricesOnly) {
        for (let j = 0; j < toCreate.length; j += config.BATCH_SIZE) {
          const batch = toCreate.slice(j, j + config.BATCH_SIZE);
          try {
            await wcApi.post('products/batch', { create: batch });
            syncState.created += batch.length;
            batch.forEach(p => existingProducts.set(p.sku, { id: 0, status: 'publish' }));
            updateProgress({ created: syncState.created });
          } catch (e) {
            log(`⚠️ Batch create error: ${e.message}`, 'warn');
          }
          await sleep(config.RATE_LIMIT_MS);
        }
      }

      // Execute batch updates
      for (let j = 0; j < toUpdate.length; j += config.BATCH_SIZE) {
        const batch = toUpdate.slice(j, j + config.BATCH_SIZE);
        try {
          await wcApi.post('products/batch', { update: batch });
          syncState.updated += batch.length;
          updateProgress({ updated: syncState.updated });
        } catch (e) {
          log(`⚠️ Batch update error: ${e.message}`, 'warn');
        }
        await sleep(config.RATE_LIMIT_MS);
      }

      if (toCreate.length > 0 || toUpdate.length > 0) {
        log(`✅ ${setName}: +${toCreate.length} created, ~${toUpdate.length} updated`, 'success');
      }
    }

    // Done!
    syncState.endTime = new Date().toISOString();
    updateProgress({ phase: 'complete', running: false });
    const summary = pricesOnly 
      ? `🎉 Price sync complete! Updated: ${syncState.updated}, Skipped (new): ${syncState.skipped}`
      : `🎉 Full sync complete! Created: ${syncState.created}, Updated: ${syncState.updated}`;
    log(summary, 'success');

  } catch (e) {
    log(`❌ Sync failed: ${e.message}`, 'error');
    updateProgress({ phase: 'error', running: false });
  }
}

// ==========================================
// ROUTES
// ==========================================

// SSE endpoint for real-time updates
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send current state
  res.write(`data: ${JSON.stringify({ type: 'init', data: syncState })}\n\n`);

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// Get current status
app.get('/api/status', (req, res) => {
  res.json(syncState);
});

// Start sync
app.post('/api/sync', (req, res) => {
  if (syncState.running) {
    return res.status(400).json({ error: 'Sync already running' });
  }
  
  const mode = req.body.mode || 'full'; // 'full' or 'prices'
  
  // Start sync in background
  runSync(mode).catch(e => {
    log(`❌ Sync error: ${e.message}`, 'error');
    updateProgress({ phase: 'error', running: false });
  });
  
  res.json({ status: 'started', mode });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ==========================================
// START
// ==========================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🎴 TCG Sync App running on port ${PORT}`);
});
