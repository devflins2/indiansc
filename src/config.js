const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Helper to ensure Channel IDs always have -100 prefix
const formatChannelId = (id) => {
  if (!id) return id;
  const strId = id.toString().trim();
  return strId.startsWith('-100') ? strId : `-100${strId.replace(/^-/, '')}`;
};

module.exports = {
  // Bot Configuration
  BOT_TOKEN: (process.env.BOT_TOKEN || '').replace(/['"]/g, ''),
  MONGO_URI: (process.env.MONGO_URI || '').replace(/['"]/g, ''),
  NODE_ENV: process.env.NODE_ENV || 'development',

  // Channel Configuration
  CHANNEL_USERNAME: process.env.CHANNEL_USERNAME || '@YourChannel',
  CHANNEL_ID: formatChannelId(process.env.CHANNEL_ID),
  LOG_CHANNEL_ID: formatChannelId(process.env.LOG_CHANNEL_ID),

  // Admin IDs
  ADMIN_IDS: (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id)),

  // MTProto Config (for GramJS 2GB uploads)
  API_ID: process.env.API_ID ? parseInt(process.env.API_ID) : 2040,
  API_HASH: process.env.API_HASH || 'b18441a1ff607e10a989891a5462e627',

  // Cloud & Proxy Settings
  PROXY_URL: process.env.PROXY_URL || '',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',

  // Scraper Settings
  SOURCE_SITE: process.env.SOURCE_SITE || 'https://www.thekamababa.com',
  MAX_SIZE_MB: parseInt(process.env.MAX_SIZE_MB || '800'),
  SCRAPE_INTERVAL_MIN: parseInt(process.env.SCRAPE_INTERVAL_MIN || '15'),
  MAX_PAGES: parseInt(process.env.MAX_PAGES || '3'),
  CONCURRENT_DOWNLOADS: parseInt(process.env.CONCURRENT_DOWNLOADS || '1'),

  // Paths
  TEMP_DIR: process.env.TEMP_DIR || path.join(__dirname, '../temp'),

  // Performance Settings
  CHUNK_SIZE: 512 * 1024, // 512KB chunks
  TIMEOUT: 45000, // 45 seconds
  MAX_RETRIES: 2,

  // HTTP Headers for scraping (Stealth Mode)
  HEADERS: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'DNT': '1'
  }
};
