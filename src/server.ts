
//
import { AngularNodeAppEngine, createNodeRequestHandler, isMainModule, writeResponseToNodeResponse } from '@angular/ssr/node';
import express from 'express';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import NodeCache from 'node-cache';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js'
import fs from 'fs'
import path from 'path'
const md = new MarkdownIt({
  html:true,
  typographer: true,
  breaks: true,
  linkify: true,
  langPrefix: 'language-',
  highlight: function (str:any, lang:any) {
    console.log('highlight :: ',str,lang)
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<div class="hljs-lang">${hljs.highlight(str, { language: lang }).value}</div>`;
      } catch (__) {}
    }

    return ''; // use external default escaping
  }
});

const serverDistFolder = dirname(fileURLToPath(import.meta.url));
const browserDistFolder = resolve(serverDistFolder, '../browser');

const app = express();
const angularApp = new AngularNodeAppEngine();

// Local server cache (short TTL since CloudFront is primary cache)
const renderCache = new NodeCache({
  stdTTL: 300, // 5 minutes
  checkperiod: 60,
  maxKeys: 1000 // Limit memory usage
});

// Cache statistics for monitoring
let cacheStats = {
  hits: 0,
  misses: 0,
  renders: 0
};

// Logging utility
function log(level: string, message: string, meta?: any) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level}] ${message}`, meta ? JSON.stringify(meta) : '');
}

// Request logging middleware
app.use((req, res, next) => {
  const startTime = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    log('INFO', `${req.method} ${req.url}`, {
      status: res.statusCode,
      duration: `${duration}ms`,
      cacheStats
    });
  });
  next();
});

// CloudFront cache headers helper
function setCacheHeaders(res: express.Response, maxAge: number, sMaxAge: number) {
  res.set({
    'Cache-Control': `public, max-age=${maxAge}, s-maxage=${sMaxAge}, stale-while-revalidate=86400`,
    'CDN-Cache-Control': `max-age=${sMaxAge}`,
    'Vary': 'Accept-Encoding'
  });
}

app.use((req, res, next) => {
  // Store original URL in req object
  req.originalUrl = req.originalUrl || req.url;

  log('DEBUG', 'Original URL captured', {
    url: req.url,
    originalUrl: req.originalUrl,
    path: req.path,
    query: req.query
  });

  next();
});

// Static files - long cache
app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
    setHeaders: (res, path) => {
      // Immutable assets (hashed filenames)
      if (/\.(js|css|woff2?|ttf|eot|svg|png|jpg|jpeg|gif|webp|ico)$/.test(path)) {
        res.set('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  })
);

app.get('/api/test', async (req, res, next) => {
  const cacheKey = `page:${req.originalUrl}`;
  const cached = renderCache.get(cacheKey);

  if (cached) {
    cacheStats.hits++;
    log('DEBUG', `Local cache HIT: ${req.originalUrl||req.url}`);

    // Set CloudFront cache headers
    setCacheHeaders(res, 300, 3600); // 5min browser, 1hr CloudFront

    return res.send(cached);
  }

  // Cache miss - perform SSR
  cacheStats.misses++;
  log('DEBUG', `Local cache MISS test: ${req.originalUrl}`);

  try {
    cacheStats.renders++;
    const mdPath = path.resolve(serverDistFolder, '../browser/assets/dummy.md');
    if (!fs.existsSync(mdPath)) {
      log('ERROR', 'dummy.md not found in bundle', { mdPath });
      return res.status(404).send('dummy.md not found');
    }

    const content = fs.readFileSync(mdPath, 'utf-8');
    const html = md.render(content);
    renderCache.set(cacheKey, html);

    // Set appropriate cache headers based on content type
    const cacheStrategy = getCacheStrategy(req.originalUrl || req.url);
    console.log('cacheStrategy',cacheStrategy,req.url)
    setCacheHeaders(res, cacheStrategy.browser, cacheStrategy.cdn);

    return res.status(200).json({html});
  } catch (error: any) {
    log('ERROR', `SSR error: ${req.url}`, { error: error.message });
    return next(error);
  }
});

// SSR with multi-tier caching
app.use('/**', async (req, res, next) => {
  // Skip caching for certain routes
  const shouldCache = !req.url.includes('/api/') &&
    !req.url.includes('/auth/') &&
    req.method === 'GET';

  if (!shouldCache) {
    return handleSSR(req, res, next);
  }

  const cacheKey = `page:${req.originalUrl}`;
  const cached = renderCache.get(cacheKey);

  if (cached) {
    cacheStats.hits++;
    log('DEBUG', `Local cache HIT: ${req.originalUrl||req.url}`);

    // Set CloudFront cache headers
    setCacheHeaders(res, 300, 3600); // 5min browser, 1hr CloudFront

    return res.send(cached);
  }

  // Cache miss - perform SSR
  cacheStats.misses++;
  log('DEBUG', `Local cache MISS: ${req.originalUrl}`);

  try {
    const response = await angularApp.handle(req);

    if (response) {
      cacheStats.renders++;

      // Extract HTML from response
      const html = await response.text();

      // Store in local cache
      renderCache.set(cacheKey, html);

      // Set appropriate cache headers based on content type
      const cacheStrategy = getCacheStrategy(req.originalUrl || req.url);
      console.log('cacheStrategy',cacheStrategy,req.url)
      setCacheHeaders(res, cacheStrategy.browser, cacheStrategy.cdn);

      // Copy other headers from Angular response
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() !== 'cache-control') {
          res.set(key, value);
        }
      });

      res.status(response.status).send(html);
    } else {
      next();
    }
  } catch (error: any) {
    log('ERROR', `SSR error: ${req.url}`, { error: error.message });
    next(error);
  }
});

function handleSSR(req:any, res:any, next:any) {
  angularApp
    .handle(req)
    .then((response) => {
      if (response) {
        return writeResponseToNodeResponse(response, res);
      } else {
        return next();
      }
    })
    .catch((error) => {
      next(error);
    });
}

// Cache strategy based on route
function getCacheStrategy(url: string) {
  // Homepage and landing pages - aggressive caching
  if (url === '/' || url.match(/^\/(about|contact|pricing)/)) {
    return { browser: 300, cdn: 3600 }; // 5min / 1hr
  }

  // Blog posts - moderate caching
  if (url.match(/^\/api\/test\//)) {
    return { browser: 600, cdn: 7200 }; // 10min / 2hr
  }

  // Product pages - moderate caching
  if (url.match(/^\/products\//)) {
    return { browser: 300, cdn: 1800 }; // 5min / 30min
  }

  // User-specific pages - minimal caching
  if (url.match(/^\/(dashboard|profile|account)/)) {
    return { browser: 60, cdn: 300 }; // 1min / 5min
  }

  // Default
  return { browser: 300, cdn: 1800 }; // 5min / 30min
}

// Cache statistics endpoint
app.get('/api/cache-stats', (req, res) => {
  const hitRate = cacheStats.hits + cacheStats.misses > 0
    ? ((cacheStats.hits / (cacheStats.hits + cacheStats.misses)) * 100).toFixed(2)
    : 0;

  res.json({
    ...cacheStats,
    hitRate: `${hitRate}%`,
    cacheSize: renderCache.keys().length,
    memoryUsage: process.memoryUsage()
  });
});

// Cache invalidation endpoint (protect in production!)
app.post('/api/cache-clear', (req, res) => {
  renderCache.flushAll();
  cacheStats = { hits: 0, misses: 0, renders: 0 };
  log('INFO', 'Cache cleared manually');
  res.json({ success: true, message: 'Cache cleared' });
});

// Error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  log('ERROR', `Unhandled error`, { error: err.message, url: req.url });
  if (!res.headersSent) {
    res.status(500).send('Internal Server Error');
  }
});

// Server startup
if (isMainModule(import.meta.url)) {
  const port = process.env['PORT'] || 4000;

  app.listen(port, () => {
    log('INFO', `🚀 Server started`, {
      port,
      url: `http://localhost:${port}`,
      cacheEnabled: true
    });
  });
}

export const reqHandler = createNodeRequestHandler(app);
