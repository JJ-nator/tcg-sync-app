const express = require('express');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const { parse } = require('csv-parse/sync');
const { Client } = require('ssh2');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// CONFIG
// ==========================================
const config = {
  TCGCSV_BASE: 'https://tcgcsv.com/tcgplayer',
  POKEMON_CATEGORY_ID: 3,
  CATEGORY_SINGLES_ID: parseInt(process.env.CATEGORY_SINGLES_ID) || 199,
  MIN_PRICE_COP: 200,
  
  // SSH Config (for fast direct sync)
  SSH_HOST: process.env.SSH_HOST || '82.29.80.231',
  SSH_PORT: parseInt(process.env.SSH_PORT) || 65002,
  SSH_USER: process.env.SSH_USER || 'u621990880',
  SSH_PASS: process.env.SSH_PASS,
  
  // MySQL (accessed via SSH)
  DB_NAME: process.env.DB_NAME || 'u621990880_mig',
  DB_USER: process.env.DB_USER || 'u621990880_mig',
  DB_PASS: process.env.DB_PASS,
  DB_PREFIX: process.env.DB_PREFIX || 'wpjx_',
  
  // Paths on remote server
  WP_PATH: '/home/u621990880/domains/tcgcolombia.com/public_html',
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
  errors: 0,
  currentSet: '',
  logs: [],
  startTime: null,
  endTime: null,
  mode: null,
  method: null,
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
    errors: 0,
    currentSet: '',
    logs: [],
    startTime: null,
    endTime: null,
    mode: null,
    method: null,
  };
}

function log(msg, type = 'info') {
  const timestamp = new Date().toISOString();
  const entry = { timestamp, msg, type };
  syncState.logs.push(entry);
  if (syncState.logs.length > 1000) syncState.logs.shift();
  broadcast({ type: 'log', data: entry });
  console.log(`[${timestamp}] [${type.toUpperCase()}] ${msg}`);
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
</ul>`.trim();
}

function escapeSQL(str) {
  if (str === null || str === undefined) return 'NULL';
  return "'" + String(str).replace(/'/g, "''").replace(/\\/g, '\\\\') + "'";
}

// ==========================================
// SSH HELPERS
// ==========================================

function sshExec(command) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let output = '';
    let errorOutput = '';
    
    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          conn.end();
          return reject(err);
        }
        
        stream.on('close', (code) => {
          conn.end();
          if (code === 0) {
            resolve(output);
          } else {
            reject(new Error(`Command failed (code ${code}): ${errorOutput || output}`));
          }
        });
        
        stream.on('data', (data) => { output += data.toString(); });
        stream.stderr.on('data', (data) => { errorOutput += data.toString(); });
      });
    });
    
    conn.on('error', reject);
    
    conn.connect({
      host: config.SSH_HOST,
      port: config.SSH_PORT,
      username: config.SSH_USER,
      password: config.SSH_PASS,
    });
  });
}

async function mysqlQuery(query) {
  const cmd = `mysql -u ${config.DB_USER} -p'${config.DB_PASS}' ${config.DB_NAME} -N -e "${query.replace(/"/g, '\\"')}"`;
  return sshExec(cmd);
}

// ==========================================
// FAST SSH SYNC
// ==========================================

async function runSSHSync(mode = 'full') {
  const pricesOnly = mode === 'prices';
  
  log('🚀 Starting SSH-based sync (FAST MODE)...', 'info');
  updateProgress({ method: 'ssh' });

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

  // Phase 3: Fetch existing products via SQL
  updateProgress({ phase: 'fetching' });
  log('📋 Fetching existing products from database...', 'info');
  
  const existingQuery = `
    SELECT p.ID, sku.meta_value as sku, price.meta_value as price
    FROM ${config.DB_PREFIX}posts p
    JOIN ${config.DB_PREFIX}postmeta sku ON p.ID = sku.post_id AND sku.meta_key = '_sku'
    LEFT JOIN ${config.DB_PREFIX}postmeta price ON p.ID = price.post_id AND price.meta_key = '_price'
    WHERE p.post_type = 'product' AND p.post_status != 'trash' AND sku.meta_value != ''
  `;
  
  const existingRaw = await mysqlQuery(existingQuery);
  const existingProducts = new Map();
  
  existingRaw.trim().split('\n').forEach(line => {
    if (!line) return;
    const [id, sku, price] = line.split('\t');
    if (sku) existingProducts.set(sku, { id: parseInt(id), price: parseFloat(price) || 0 });
  });
  
  log(`📦 Found ${existingProducts.size} existing products`, 'success');

  // Phase 4: Process sets
  updateProgress({ phase: 'syncing', progress: 0 });
  log('🛒 Starting product sync...', 'info');

  let totalCreated = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const groupId = group.groupId;
    const setName = groupsMap[groupId];
    const abbrev = abbrevMap[groupId] || groupId;
    
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
      totalErrors++;
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

    // Collect updates for batch SQL
    const priceUpdates = []; // [{id, price}]
    const newProducts = []; // full product data for WP-CLI
    
    for (const row of singles) {
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

      // Calculate price (round to nearest 100)
      let priceCOP = Math.ceil(parseFloat(row.marketPrice) * trm / 100) * 100;
      if (priceCOP < config.MIN_PRICE_COP) priceCOP = config.MIN_PRICE_COP;

      const existing = existingProducts.get(sku);

      if (existing) {
        // Check if price changed
        if (Math.abs(existing.price - priceCOP) > 1) {
          priceUpdates.push({ id: existing.id, price: priceCOP });
        } else {
          totalSkipped++;
        }
      } else if (!pricesOnly) {
        // New product
        newProducts.push({
          sku,
          title,
          price: priceCOP,
          description: buildDescription(row, setName),
          image: row.imageUrl ? row.imageUrl.replace('_200w', '_400w') : '',
          setName,
        });
      } else {
        totalSkipped++;
      }
    }

    // Batch update prices via SQL (FAST!)
    if (priceUpdates.length > 0) {
      try {
        // Build CASE statement for bulk update
        for (let j = 0; j < priceUpdates.length; j += 500) {
          const batch = priceUpdates.slice(j, j + 500);
          const caseStmt = batch.map(u => `WHEN ${u.id} THEN '${u.price}'`).join(' ');
          const ids = batch.map(u => u.id).join(',');
          
          // Update _price and _regular_price
          await mysqlQuery(`
            UPDATE ${config.DB_PREFIX}postmeta 
            SET meta_value = CASE post_id ${caseStmt} END 
            WHERE meta_key = '_price' AND post_id IN (${ids})
          `);
          await mysqlQuery(`
            UPDATE ${config.DB_PREFIX}postmeta 
            SET meta_value = CASE post_id ${caseStmt} END 
            WHERE meta_key = '_regular_price' AND post_id IN (${ids})
          `);
          
          totalUpdated += batch.length;
          updateProgress({ updated: totalUpdated });
        }
      } catch (e) {
        log(`⚠️ Price update error: ${e.message}`, 'warn');
        totalErrors++;
      }
    }

    // Create new products via WP-CLI (handles all WooCommerce hooks properly)
    if (newProducts.length > 0 && !pricesOnly) {
      for (const p of newProducts) {
        try {
          const wpCmd = `cd ${config.WP_PATH} && wp wc product create ` +
            `--name=${escapeSQL(p.title).replace(/'/g, "\\'")} ` +
            `--sku=${p.sku} ` +
            `--regular_price=${p.price} ` +
            `--type=simple ` +
            `--status=publish ` +
            `--manage_stock=true ` +
            `--stock_quantity=0 ` +
            `--categories='[{"id":${config.CATEGORY_SINGLES_ID}}]' ` +
            `--user=1 --porcelain 2>/dev/null || echo "SKIP"`;
          
          const result = await sshExec(wpCmd);
          if (result.trim() !== 'SKIP') {
            totalCreated++;
            existingProducts.set(p.sku, { id: parseInt(result), price: p.price });
            updateProgress({ created: totalCreated });
          }
        } catch (e) {
          // Skip errors (likely duplicate SKU)
          totalErrors++;
        }
        
        // Small delay to avoid overwhelming server
        if (totalCreated % 10 === 0) await sleep(100);
      }
    }

    // Log progress every 10 sets
    if ((i + 1) % 10 === 0) {
      log(`📂 ${i + 1}/${groups.length} sets | ✏️ ${totalUpdated} | ➕ ${totalCreated} | ⏭️ ${totalSkipped}`, 'info');
    }
  }

  // Update final state
  syncState.created = totalCreated;
  syncState.updated = totalUpdated;
  syncState.skipped = totalSkipped;
  syncState.errors = totalErrors;
  
  return { created: totalCreated, updated: totalUpdated, skipped: totalSkipped, errors: totalErrors };
}

// ==========================================
// MAIN SYNC HANDLER
// ==========================================

async function runSync(mode = 'full', method = 'ssh') {
  if (syncState.running) {
    log('⚠️ Sync already running', 'warn');
    return;
  }

  resetState();
  syncState.running = true;
  syncState.mode = mode;
  syncState.method = method;
  syncState.startTime = new Date().toISOString();
  updateProgress({ phase: 'starting' });

  try {
    let result;
    
    if (method === 'ssh' && config.SSH_PASS) {
      result = await runSSHSync(mode);
    } else {
      throw new Error('SSH credentials not configured. Set SSH_PASS environment variable.');
    }

    syncState.endTime = new Date().toISOString();
    updateProgress({ phase: 'complete', running: false });
    
    const duration = ((new Date(syncState.endTime) - new Date(syncState.startTime)) / 1000 / 60).toFixed(1);
    const summary = `🎉 Sync complete in ${duration} min! Created: ${result.created}, Updated: ${result.updated}, Skipped: ${result.skipped}`;
    log(summary, 'success');

  } catch (e) {
    log(`❌ Sync failed: ${e.message}`, 'error');
    console.error(e);
    updateProgress({ phase: 'error', running: false });
    syncState.endTime = new Date().toISOString();
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

  res.write(`data: ${JSON.stringify({ type: 'init', data: syncState })}\n\n`);

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// Get current status
app.get('/api/status', (req, res) => {
  res.json(syncState);
});

// Get product count
app.get('/api/products/count', async (req, res) => {
  try {
    if (!config.SSH_PASS) {
      return res.json({ count: null, error: 'SSH not configured' });
    }
    const result = await mysqlQuery(`SELECT COUNT(*) FROM ${config.DB_PREFIX}posts WHERE post_type='product' AND post_status='publish'`);
    res.json({ count: parseInt(result.trim()) });
  } catch (e) {
    res.json({ count: null, error: e.message });
  }
});

// Start sync
app.post('/api/sync', (req, res) => {
  if (syncState.running) {
    return res.status(400).json({ error: 'Sync already running' });
  }
  
  const mode = req.body.mode || 'full'; // 'full' or 'prices'
  const method = req.body.method || 'ssh';
  
  runSync(mode, method).catch(e => {
    log(`❌ Sync error: ${e.message}`, 'error');
    updateProgress({ phase: 'error', running: false });
  });
  
  res.json({ status: 'started', mode, method });
});

// Stop sync
app.post('/api/sync/stop', (req, res) => {
  if (!syncState.running) {
    return res.status(400).json({ error: 'No sync running' });
  }
  
  // Mark as stopping (sync loop will check this)
  syncState.stopping = true;
  log('⏹️ Stop requested...', 'warn');
  res.json({ status: 'stopping' });
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
  console.log(`   SSH: ${config.SSH_HOST}:${config.SSH_PORT}`);
  console.log(`   Method: SSH (fast direct DB)`);
});
