const axios = require('axios');
const { Api } = require('telegram');
const fs = require('fs');
const cheerio = require('cheerio');
const { HttpsProxyAgent } = require('https-proxy-agent');
const path = require('path');
const crypto = require('crypto');
const PQueue = require('p-queue').default;
const { pipeline } = require('stream/promises');
const config = require('./config');
const db = require('./database');
const logger = require('./logger');

// Create temp directory
if (!fs.existsSync(config.TEMP_DIR)) {
  fs.mkdirSync(config.TEMP_DIR, { recursive: true });
} else {
  // Cleanup temp directory on startup
  fs.readdirSync(config.TEMP_DIR).forEach(file => {
    fs.unlinkSync(path.join(config.TEMP_DIR, file));
  });
}

// Download queue with concurrency control
const downloadQueue = new PQueue({
  concurrency: config.CONCURRENT_DOWNLOADS
});

// Memory track for videos currently being processed (to strictly prevent duplicates in same batch)
const processingTitles = new Set();

// ============ HELPER FUNCTIONS ============

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Proxy Agent handle
const proxyAgent = config.PROXY_URL ? new HttpsProxyAgent(config.PROXY_URL) : null;
if (proxyAgent) logger.log('🌐 Proxy support enabled');

// Global variable to hold dynamic session cookies from Cloudflare
let dynamicCookies = '';

const updateCookies = (response) => {
  if (response && response.headers && response.headers['set-cookie']) {
    const newCookies = response.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
    dynamicCookies = newCookies; // Session token save kar liya Cloudflare ke liye
  }
};

// Add cookies to bypass age gates / 18+ warnings on tube sites like 4free
const getScrapeHeaders = () => {
  return {
    ...config.HEADERS,
    'Cookie': `age_confirmed=1; is_adult=1; warning_accepted=true; splash_seen=1; kt_lang=en; ${dynamicCookies}`
  };
};

const normalizeUrl = (url) => {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    // Remove query params that often change but same content
    parsed.search = '';
    // Remove trailing slash
    return parsed.toString().replace(/\/$/, '');
  } catch (e) {
    return url.replace(/\/$/, '');
  }
};

// ============ HOMEPAGE SCRAPING ============

const getVideoLinks = async () => {
  const urls = new Set();
  let emptyPagesCount = 0; // Stop condition for deep scraping
  const maxPages = config.MAX_PAGES || 3; // Wapas pehle jaisa simple 3 page wala limit
  let page = 1; // Loop ke bahar define kiya taaki error block ko mil sake

  try {
    console.log(`▶️ [DEBUG] getVideoLinks() execution started... fetching from ${config.SOURCE_SITE}`);
    logger.log(`🕵️‍♂️ Starting QUICK scrape of ${maxPages} pages...`);
    
    for (page = 1; page <= maxPages; page++) {

      // Remove trailing slash to prevent //page/2/ format errors
      let url = config.SOURCE_SITE.replace(/\/$/, '');
      if (page > 1) {
        if (url.includes('?')) {
          url = `${url}&page=${page}`;
        } else {
          url = `${url}/page/${page}/`;
        }
      }

      console.log(`⏳ [DEBUG] Requesting Page ${page}: ${url}`);
      const tempLinks = new Set();
      const response = await axios.get(url, {
        headers: getScrapeHeaders(),
        timeout: config.TIMEOUT,
        maxRedirects: 10,
        httpsAgent: proxyAgent,
        httpAgent: proxyAgent
      });
      updateCookies(response);
      const data = response.data;
      console.log(`✅ [DEBUG] Successfully downloaded Page ${page} HTML (${data.length} bytes)`);

      const $ = cheerio.load(data);
      $('a').each((i, el) => {
        let foundUrl = $(el).attr('href') || $(el).attr('data-href');
        if (!foundUrl || foundUrl === '#' || foundUrl === '/') return;

        // Bahari links (Ads wagera) ignore karo
        if (foundUrl.startsWith('http') && !foundUrl.includes(new URL(config.SOURCE_SITE).hostname)) return;

        // Categories, Tags aur Search pages ko exclude karo
        const skipWords = ['/category', '/tag', '/search', '/login', '/signup', '/page/', '/model', '/channel', '?', '2257', 'dmca', 'privacy', 'terms', 'contact', 'about'];
        if (skipWords.some(w => foundUrl.toLowerCase().includes(w))) return;

        // Flexible Matching: Almost any link on homepage is a video if not in skipWords
        // This regex covers KamaBaba, Clipsage and similar tube sites better
        const isLikelyVideo = /(video|watch|tube|porn|sex|xxx|mms|leak|desi|hindi|pakistani|bangla|aunty|bhabhi|girl|couple|chudai|incest|adult|mms|clip|leaked|\/v\/|\/post\/|\d{3,}|.html$)/i.test(foundUrl);

        if (isLikelyVideo) {
          if (foundUrl.startsWith('/')) {
            const baseUrl = new URL(config.SOURCE_SITE).origin;
            foundUrl = baseUrl + foundUrl;
          }
          const cleanUrl = normalizeUrl(foundUrl);
          tempLinks.add(cleanUrl);
        }
      });

      // Check against Database to find TRULY new videos
      let newLinksFound = 0;
      for (const link of tempLinks) {
        if (!urls.has(link)) {
          urls.add(link);
          const exists = await db.videoExists(link);
          if (!exists) {
            newLinksFound++;
          }
        }
      }

      // Agar is page par koi naya video nahi mila (ya toh end aagaya, ya purane videos aagaye)
      if (newLinksFound === 0) {
        emptyPagesCount++;
        const pageTitle = $('title').text();
        console.error(`🛑 RENDER DEBUG: Page Title received: "${pageTitle}"`);

        if (pageTitle.toLowerCase().includes('cloudflare') || pageTitle.toLowerCase().includes('just a moment')) {
          logger.error(`🛑 CLOUDFLARE BLOCK: Render ki IP ko Cloudflare ne block kar diya hai!`);
          console.error('💡 Recommendation: Enable PROXY_URL in .env to bypass Cloudflare.');
        }

        logger.log(`⚠️ Page ${page}: No NEW videos found (All already in DB or empty page)`);
        if (emptyPagesCount >= 2) {
          logger.log(`🛑 Reached old content. Stopping pagination at page ${page}.`);
          break;
        }
      } else {
        emptyPagesCount = 0;
        logger.log(`📄 Page ${page}: Found ${newLinksFound} NEW videos to download!`);
      }

      // Anti-ban: Sleep random 4-8 seconds before next page to mimic human behavior
      await sleep(Math.floor(Math.random() * 4000) + 4000);
    }
  } catch (error) {
    console.error(`❌ [DEBUG] Error downloading page ${page}:`, error.message);
    if (error.response && error.response.status === 404) {
      logger.log(`🛑 Reached 404 on page ${page}. Pagination finished.`);
    } else {
      logger.error(`Homepage scraping error on page ${page}`, error);
    }
  }

  const result = Array.from(urls);
  logger.log(`✅ Scrape complete. Total unique links found: ${result.length}`);
  return result;
};

// ============ SINGLE VIDEO SCRAPING ============

const scrapeVideoInfo = async (url) => {
  let cleanUrl = normalizeUrl(url);

  try {
    const response = await axios.get(cleanUrl, {
      headers: { ...getScrapeHeaders(), 'Referer': config.SOURCE_SITE },
      timeout: config.TIMEOUT,
      maxRedirects: 10,
      httpsAgent: proxyAgent,
      httpAgent: proxyAgent
    });
    updateCookies(response);
    const data = response.data;

    const $ = cheerio.load(data);
    let title = $('meta[property="og:title"]').attr('content') || $('title').text() || 'Unknown Video';
    title = title.split('–')[0].split('|')[0].trim().substring(0, 100);
    let thumbnail = $('meta[property="og:image"]').attr('content') || $('video').attr('poster') || null;

    const videoPatterns = [
      /source\s+src=['"]([^'"]+\.mp4[^'"]*)['"]/i,
      /['"](?:file|url|src)['"]\s*:\s*['"](https?:\/\/[^'"]+\.mp4[^'"]*)['"]/i,
      /video_url\s*=\s*['"](https?:\/\/[^'"]+\.mp4[^'"]*)['"]/i,
      /video_url\s*:\s*['"]([^'"]+)['"]/i,
      /html5_video_file['"]?\s*:\s*['"]([^'"]+)['"]/i,
      /data-src=['"]([^'"]+\.mp4[^'"]*)['"]/i,
      /file:\s*['"]([^'"]+\.mp4[^'"]*)['"]/i,
      /['"](https?:\/\/[^'"]+\.mp4\?[^'"]+)['"]/i, // Links with tokens
      /['"](https?:\/\/[^'"]+\.mp4)['"]/i           // Any direct mp4 link
    ];

    let directUrl = null;
    for (const pattern of videoPatterns) {
      const match = data.match(pattern);
      if (match) {
        directUrl = match[1].replace(/\\\//g, '/');
        break;
      }
    }

    if (!directUrl) {
      const sourceSrc = $('source[type="video/mp4"]').attr('src') || $('video source').attr('src') || $('video').attr('src');
      if (sourceSrc) directUrl = sourceSrc;
    }

    if (!directUrl) {
      logger.log(`⚠️ No direct video URL found: ${url} \n🚨 (Website ka HTML format match nahi kar raha)`);
      return null;
    }

    if (directUrl.startsWith('/')) {
      const baseUrl = new URL(cleanUrl).origin;
      directUrl = baseUrl + directUrl;
    }

    // Check file size
    const headResponse = await axios.head(directUrl, {
      headers: getScrapeHeaders(),
      timeout: 15000,
      httpsAgent: proxyAgent,
      httpAgent: proxyAgent
    }).catch(() => null);
    if (headResponse) updateCookies(headResponse);

    const sizeBytes = headResponse && headResponse.headers['content-length'] ? parseInt(headResponse.headers['content-length']) : 0;
    const sizeMb = sizeBytes > 0 ? sizeBytes / (1024 * 1024) : 10;

    if (sizeMb > config.MAX_SIZE_MB) {
      logger.log(`⚠️ Too large (${sizeMb.toFixed(1)}MB): ${title}`);
      return null;
    }

    if (sizeBytes > 0 && sizeMb < 1) {
      logger.log(`⚠️ Too small (${sizeMb.toFixed(1)}MB): ${title}`);
      return null;
    }

    return {
      url,
      title,
      directUrl,
      sizeMb,
      thumbnail
    };

  } catch (error) {
    if (error.code === 'ECONNABORTED') {
      logger.log(`⏱️ Timeout scraping page: ${url}`);
    } else {
      logger.error(`Scrape error for ${url}`, error);
    }
    return null;
  }
};

// ============ DOWNLOAD & UPLOAD ============

const downloadVideo = async (bot, directUrl, filepath, videoInfo, statusMsgId = null) => {
  const writer = fs.createWriteStream(filepath);
  let lastUpdate = 0;

  const response = await axios({
    url: directUrl,
    method: 'GET',
    headers: getScrapeHeaders(),
    responseType: 'stream',
    timeout: 300000, // 5 minutes
    maxRedirects: 5,
    httpsAgent: proxyAgent,
    httpAgent: proxyAgent
  });

  const totalLength = parseInt(response.headers['content-length'] || '0');
  let downloadedLength = 0;

  response.data.on('data', (chunk) => {
    downloadedLength += chunk.length;
    if (totalLength > 0) {
      const percent = ((downloadedLength / totalLength) * 100).toFixed(1);
      const now = Date.now();

      // Update Telegram every 5 seconds to avoid rate limits
      if (statusMsgId && now - lastUpdate > 5000) {
        bot.telegram.editMessageText(
          config.CHANNEL_ID,
          statusMsgId,
          null,
          `⏳ *Downloading:* ${videoInfo.title.substring(0, 50)}...\n📊 *Progress:* ${percent}%`,
          { parse_mode: 'Markdown' }
        ).catch(() => { }); // Ignore edit errors
        lastUpdate = now;
      }
    }
  });

  try {
    // Safe pipeline: Auto-cleans up memory & streams if connection fails (Zero crashes)
    await pipeline(response.data, writer);
    return true;
  } catch (error) {
    if (fs.existsSync(filepath)) {
      try { fs.unlinkSync(filepath); } catch (e) {}
    }
    throw error;
  }
};

const uploadToTelegram = async (bot, client, filepath, videoInfo, statusMsgId = null) => {
  const caption = `🎬 ${videoInfo.title}\n📦 ${videoInfo.sizeMb.toFixed(1)} MB\n\n${config.CHANNEL_USERNAME}`;
  let lastUpdate = 0;

  try {
    // Send file using GramJS Client
    // This allows uploading files up to 2000 MB!
    const message = await client.sendFile(BigInt(config.CHANNEL_ID), {
      file: filepath,
      caption: caption,
      workers: 4,
      supportsStreaming: true,
      attributes: [
        new Api.DocumentAttributeVideo({
          duration: 0,
          w: 0,
          h: 0,
          supportsStreaming: true,
        }),
      ],
      progressCallback: (progress) => {
        const percent = (progress * 100).toFixed(1);
        const now = Date.now();
        // Update Telegram every 5 seconds
        if (statusMsgId && now - lastUpdate > 5000) {
          bot.telegram.editMessageText(
            config.CHANNEL_ID,
            statusMsgId,
            null,
            `📤 *Uploading:* ${videoInfo.title.substring(0, 50)}...\n📊 *Progress:* ${percent}%`,
            { parse_mode: 'Markdown' }
          ).catch(() => { });
          lastUpdate = now;
        }
      }
    });

    // GramJS returns a message object. We store the message ID in the DB
    return { file_id: message.id.toString(), duration: 0 };
  } catch (error) {
    logger.error('Telegram upload error', error);
    throw error;
  }
};

const processVideo = async (bot, client, videoInfo) => {
  const fileHash = crypto
    .createHash('md5')
    .update(videoInfo.url)
    .digest('hex')
    .substring(0, 10);

  const filepath = path.join(config.TEMP_DIR, `${fileHash}.mp4`);
  let statusMsg = null;

  try {
    // Create initial status message on Telegram
    try {
      statusMsg = await bot.telegram.sendMessage(
        config.CHANNEL_ID,
        `⏳ *Preparing:* ${videoInfo.title.substring(0, 50)}...`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      logger.error('Failed to send initial status message', e);
    }

    logger.log(`[1/3] ⏳ Downloading: ${videoInfo.title}`);

    await downloadVideo(bot, videoInfo.directUrl, filepath, videoInfo, statusMsg?.message_id);

    // Verify file exists and has size
    if (!fs.existsSync(filepath)) {
      throw new Error('Downloaded file not found');
    }

    const fileSize = fs.statSync(filepath).size;
    if (fileSize < 1024) {
      throw new Error('Downloaded file too small');
    }

    logger.log(`[2/3] 📤 Uploading: ${videoInfo.title}`);

    const video = await uploadToTelegram(bot, client, filepath, videoInfo, statusMsg?.message_id);

    // Save to database
    await db.addVideo({
      url: videoInfo.url,
      title: videoInfo.title,
      fileId: video.file_id,
      sizeMb: videoInfo.sizeMb,
      thumbnail: videoInfo.thumbnail,
      duration: video.duration || 0,
      channelPosted: true
    });

    logger.log(`[3/3] ✅ Success: ${videoInfo.title}`);

    return true;

  } catch (error) {
    logger.error(`Processing failed for "${videoInfo.title}"`, error);
    return false;

  } finally {
    // Delete status message if it exists
    if (statusMsg) {
      bot.telegram.deleteMessage(config.CHANNEL_ID, statusMsg.message_id).catch(() => { });
    }

    // Cleanup
    if (fs.existsSync(filepath)) {
      try {
        fs.unlinkSync(filepath);
      } catch (e) {
        logger.error('File cleanup error', e);
      }
    }
  }
};

// ============ BATCH PROCESSING ============

const processBatch = async (bot, client, queueItems) => {
  const tasks = [];

  for (const item of queueItems) {
    try {
      // Check if already exists
      const exists = await db.videoExists(item.url);
      if (exists) {
        await db.markScrapeDone(item._id);
        continue;
      }

      // Scrape video info
      const videoInfo = await scrapeVideoInfo(item.url);

      // Anti-ban: Wait random 4-7 seconds between checking videos
      await sleep(Math.floor(Math.random() * 3000) + 4000);

      if (!videoInfo) {
        await db.markScrapeFailed(item._id, 'Failed to scrape');
        continue;
      }

      // Secondary check: Title-based duplicate detection
      const titleExists = await db.videoTitleExists(videoInfo.title);
      if (titleExists) {
        logger.log(`⚠️ Duplicate title found, skipping: ${videoInfo.title}`);
        await db.markScrapeDone(item._id);
        continue;
      }

      // Third check: Is it currently being downloaded in this exact moment?
      if (processingTitles.has(videoInfo.title)) {
        logger.log(`⚠️ Video is currently downloading, preventing duplicate: ${videoInfo.title}`);
        await db.markScrapeDone(item._id);
        continue;
      }

      // Mark as processing immediately in memory
      processingTitles.add(videoInfo.title);

      // Add to download queue (respects concurrency)
      const task = downloadQueue.add(async () => {
        try {
          const success = await processVideo(bot, client, videoInfo);

          if (success) {
            await db.markScrapeDone(item._id);
          } else {
            await db.markScrapeFailed(item._id, 'Download/upload failed');
          }
        } catch (queueErr) {
          logger.error('Queue execution crash prevented', queueErr);
          await db.markScrapeFailed(item._id, 'Crash protected error');
        } finally {
          // Remove from memory after processing is completely done (success or fail)
          processingTitles.delete(videoInfo.title);
        }
      });

      tasks.push(task);

    } catch (error) {
      logger.error('Batch item processing error', error);
      await db.markScrapeFailed(item._id, error.message);
    }
  }

  // Wait for all to complete
  await Promise.all(tasks);
  await downloadQueue.onIdle();
};

// ============ MAIN SCRAPER CYCLE ============

const scraperCycle = async (bot, client) => {
  console.log('▶️ [DEBUG] Entered scraperCycle()... checking for videos');
  try {
    // Force cleanup before every cycle to guarantee disk space
    try {
      if (fs.existsSync(config.TEMP_DIR)) {
        const files = fs.readdirSync(config.TEMP_DIR);
        for (const file of files) {
          fs.unlinkSync(path.join(config.TEMP_DIR, file));
        }
      }
    } catch (e) { }

    console.log('⏳ [DEBUG] Calling getVideoLinks()...');
    const videoUrls = await getVideoLinks();
    console.log(`✅ [DEBUG] getVideoLinks() returned ${videoUrls?.length || 0} links`);

    if (videoUrls.length === 0) {
      logger.log('⚠️ Scraper cycle: No new video links found on homepage. Either site structure changed or Cloudflare is blocking.');
      console.error('🛑 RENDER DEBUG: 0 videos found! Render ki IP ko Cloudflare ne block kar diya hai (Captcha page mila).');
      console.error('💡 Hint: Check the "Page Title received" log above to see what Cloudflare is showing.');
      return;
    }

    await db.addToScrapeQueue(videoUrls);

    // Process queue in batches
    let processedAny = false;
    let batchCount = 0;
    let maxBatchesPerCycle = 10; // Sirf 50 (10x5) videos ek baar me karega, fir 15 min wait karega
    
    while (batchCount < maxBatchesPerCycle) {
      const batch = await db.getPendingBatch(5);

      if (batch.length === 0) {
        break; // Queue khali ho gayi, ab loop stop hoga
      }

      processedAny = true;
      await processBatch(bot, client, batch);

      logger.log('⏳ Waiting 15 seconds before next batch to avoid Telegram Rate Limits...');
      await sleep(15000); // Telegram FloodWait se bachne ke liye 15 sec ka buffer
      batchCount++;
    }

    if (processedAny) logger.log('✅ Scraper cycle completed.');

  } catch (error) {
    logger.error('Scraper cycle failed', error);
  }
};

// ============ AUTO SCRAPER LOOP ============

const startAutoScraper = (bot, client) => {
  console.log(`[DEBUG] startAutoScraper trigger set! Wait 10 seconds...`);
  logger.log(`🤖 Auto scraper started. Interval: ${config.SCRAPE_INTERVAL_MIN} min.`);

  const runCycle = async () => {
    console.log(`[DEBUG] 🚀 runCycle fired! Time to scrape!`);
    try {
      await scraperCycle(bot, client);
      await db.cleanupOldQueue();
    } catch (error) {
      logger.error('Auto-scraper loop error (will retry)', error);
    }

    // Schedule next cycle
    const interval = config.SCRAPE_INTERVAL_MIN * 60 * 1000;
    setTimeout(runCycle, interval);
  };

  // Start after 10 seconds
  setTimeout(runCycle, 10000);
};

// ============ CLEANUP LOOP ============

const startCleanupLoop = () => {
  setInterval(() => {
    try {
      if (fs.existsSync(config.TEMP_DIR)) {
        const files = fs.readdirSync(config.TEMP_DIR);

        for (const file of files) {
          const filepath = path.join(config.TEMP_DIR, file);
          const stats = fs.statSync(filepath);

          // Delete files older than 1 hour
          const age = Date.now() - stats.mtimeMs;
          if (age > 60 * 60 * 1000) {
            fs.unlinkSync(filepath);
          }
        }

        if (files.length > 0) {
          logger.log(`🧹 Temp directory cleanup: Found ${files.length} leftover files. Deleting files older than 1 hour.`);
        }
      }
    } catch (error) {
      logger.error('Temp directory cleanup loop error', error);
    }
  }, 60 * 60 * 1000); // Every hour
};

module.exports = {
  startAutoScraper,
  startCleanupLoop
};
