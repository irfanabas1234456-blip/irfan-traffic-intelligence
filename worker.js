
const CACHE_PREFIX = "iti:free:domain:v1:";
const CACHE_TTL = 24 * 60 * 60;
const MAX_HTML_BYTES = 1024 * 1024;
const MAX_XML_BYTES = 1024 * 1024;
const MAX_PAGES = 5;
const FETCH_TIMEOUT = 10000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*"
    }
  });
}

function safeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function normalizePublicDomain(value) {
  const input = String(value || "").trim();

  if (!input || input.length > 2048) {
    throw new Error("Enter a valid public website domain.");
  }

  let parsed;

  try {
    parsed = new URL(/^https?:\/\//i.test(input) ? input : "https://" + input);
  } catch (_) {
    throw new Error("Enter a valid website URL or domain.");
  }

  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.port
  ) {
    throw new Error("Enter a valid public HTTP or HTTPS website.");
  }

  const domain = parsed.hostname.toLowerCase().replace(/^www\./, "");

  if (
    !domain.includes(".") ||
    domain.length > 253 ||
    !/^[a-z0-9.-]+$/.test(domain) ||
    domain.includes("..") ||
    domain.startsWith(".") ||
    domain.endsWith(".") ||
    domain === "localhost" ||
    domain.endsWith(".localhost") ||
    domain.endsWith(".local") ||
    domain.endsWith(".internal") ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(domain)
  ) {
    throw new Error("Enter a public domain name, not a local or IP address.");
  }

  return domain;
}

function isSafePublicUrl(value) {
  try {
    const u = new URL(value);

    return (
      ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      !u.port &&
      !u.hostname.endsWith(".local") &&
      !u.hostname.endsWith(".localhost") &&
      !u.hostname.endsWith(".internal") &&
      !/^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname)
    );
  } catch (_) {
    return false;
  }
}

async function readLimited(response, limit) {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    total += value.byteLength;

    if (total > limit) {
      await reader.cancel();
      throw new Error("Website response is too large for the free analysis limit.");
    }

    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder("utf-8").decode(merged);
}

async function fetchPublicPage(input, limit = MAX_HTML_BYTES) {
  let current = new URL(input);

  for (let i = 0; i <= 3; i++) {
    if (!isSafePublicUrl(current.href)) {
      throw new Error("The website redirected to an unsupported address.");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    let response;

    try {
      response = await fetch(current.href, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": "IRFAN-Traffic-Intelligence-Free-Audit/1.0",
          "Accept": "text/html,application/xhtml+xml,application/xml,text/plain,*/*"
        }
      });
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("The website took too long to respond.");
      }
      throw new Error("Could not connect to the public website.");
    } finally {
      clearTimeout(timeout);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");

      if (!location || i === 3) {
        throw new Error("The website has too many redirects.");
      }

      current = new URL(location, current);
      continue;
    }

    const contentType = response.headers.get("content-type") || "";
    const text = await readLimited(response, limit);

    return {
      status: response.status,
      url: current.href,
      contentType,
      text,
      headers: {
        contentType,
        server: response.headers.get("server") || null,
        lastModified: response.headers.get("last-modified") || null,
        contentLength: safeNumber(response.headers.get("content-length"))
      }
    };
  }

  throw new Error("Could not load the public website.");
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractTag(html, tag) {
  const match = html.match(
    new RegExp("<" + tag + "\\b[^>]*>([\\s\\S]*?)<\\/" + tag + "\\s*>", "i")
  );

  return match ? decodeXml(match[1].replace(/<[^>]*>/g, "").trim()) : null;
}

function extractMeta(html, name) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];

  for (const tag of tags) {
    const nameMatch = tag.match(/\b(?:name|property)\s*=\s*["']([^"']+)["']/i);
    const contentMatch = tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i);

    if (
      nameMatch &&
      contentMatch &&
      nameMatch[1].toLowerCase() === name.toLowerCase()
    ) {
      return decodeXml(contentMatch[1].trim());
    }
  }

  return null;
}

function extractCanonical(html, baseUrl) {
  const tags = html.match(/<link\b[^>]*>/gi) || [];

  for (const tag of tags) {
    if (!/\brel\s*=\s*["'][^"']*\bcanonical\b[^"']*["']/i.test(tag)) continue;

    const match = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i);

    if (match) {
      try {
        return new URL(decodeXml(match[1]), baseUrl).href;
      } catch (_) {
        return null;
      }
    }
  }

  return null;
}

function analyzeHtml(html, pageUrl, status, headers) {
  const title = extractTag(html, "title");
  const description = extractMeta(html, "description");
  const h1Matches = html.match(/<h1\b[^>]*>/gi) || [];
  const images = html.match(/<img\b[^>]*>/gi) || [];
  const links = html.match(/<a\b[^>]*>/gi) || [];
  const canonical = extractCanonical(html, pageUrl);
  const robots = extractMeta(html, "robots");
  const viewport = extractMeta(html, "viewport");

  const imagesWithAlt = images.filter(tag =>
    /\balt\s*=\s*["'][^"']+["']/i.test(tag)
  ).length;

  const internalLinks = links.filter(tag => {
    const match = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!match) return false;

    try {
      return new URL(match[1], pageUrl).hostname === new URL(pageUrl).hostname;
    } catch (_) {
      return false;
    }
  }).length;

  const externalLinks = Math.max(0, links.length - internalLinks);

  const noindex = /\bnoindex\b/i.test(robots || "");

  return {
    url: pageUrl,
    status,
    title,
    titleLength: title ? title.length : 0,
    description,
    descriptionLength: description ? description.length : 0,
    h1Count: h1Matches.length,
    canonical,
    robots,
    noindex,
    viewport: Boolean(viewport),
    imageCount: images.length,
    imagesWithAlt,
    imagesWithoutAlt: Math.max(0, images.length - imagesWithAlt),
    internalLinks,
    externalLinks,
    server: headers.server,
    lastModified: headers.lastModified
  };
}

async function getRobots(domain, origin) {
  const url = origin + "/robots.txt";

  try {
    const result = await fetchPublicPage(url, 150000);

    if (result.status >= 400) {
      return {
        available: false,
        status: result.status,
        sitemaps: [],
        rules: [],
        notice: "robots.txt was not available."
      };
    }

    const lines = result.text.split(/\r?\n/);
    const sitemaps = [];
    const rules = [];

    for (const line of lines) {
      const clean = line.trim();

      if (/^sitemap\s*:/i.test(clean)) {
        const sitemap = clean.replace(/^sitemap\s*:/i, "").trim();
        if (isSafePublicUrl(sitemap)) sitemaps.push(sitemap);
      }

      if (/^(user-agent|allow|disallow)\s*:/i.test(clean)) {
        rules.push(clean.slice(0, 300));
      }
    }

    return {
      available: true,
      status: result.status,
      sitemaps: [...new Set(sitemaps)].slice(0, 5),
      rules: rules.slice(0, 30),
      notice: "Public robots.txt file retrieved."
    };
  } catch (error) {
    return {
      available: false,
      status: null,
      sitemaps: [],
      rules: [],
      notice: error.message
    };
  }
}

async function getSitemap(origin, robotsSitemaps) {
  const candidates = [
    ...robotsSitemaps,
    origin + "/sitemap.xml"
  ];

  const seen = new Set();
  let urls = [];
  let sitemapAvailable = false;

  for (const candidate of candidates) {
    if (seen.has(candidate) || !isSafePublicUrl(candidate)) continue;
    seen.add(candidate);

    try {
      const result = await fetchPublicPage(candidate, MAX_XML_BYTES);

      if (result.status >= 400) continue;

      sitemapAvailable = true;

      const locations = [...result.text.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)]
        .map(match => decodeXml(match[1].trim()))
        .filter(value => isSafePublicUrl(value));

      const sitemapIndex = /<sitemapindex\b/i.test(result.text);

      if (sitemapIndex) {
        for (const child of locations.slice(0, 3)) {
          try {
            const childResult = await fetchPublicPage(child, MAX_XML_BYTES);

            if (childResult.status < 400) {
              const childUrls = [...childResult.text.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)]
                .map(match => decodeXml(match[1].trim()))
                .filter(value => isSafePublicUrl(value));

              urls.push(...childUrls);
            }
          } catch (_) {}
        }
      } else {
        urls.push(...locations);
      }

      if (urls.length) break;
    } catch (_) {}
  }

  const unique = [...new Set(urls)].filter(value => {
    try {
      return new URL(value).hostname === new URL(origin).hostname;
    } catch (_) {
      return false;
    }
  });

  return {
    available: sitemapAvailable,
    totalUrlsFound: unique.length,
    urls: unique.slice(0, MAX_PAGES),
    notice: sitemapAvailable
      ? "Public sitemap retrieved. URL count reflects the sitemap entries inspected."
      : "No accessible XML sitemap was found."
  };
}

function buildAudit(pages, robots, sitemap) {
  const findings = [];

  if (!pages.length) {
    findings.push("No crawlable HTML pages were available for inspection.");
  }

  const homepage = pages[0];

  if (homepage) {
    if (!homepage.title) findings.push("Homepage is missing a title tag.");
    else if (homepage.titleLength < 15 || homepage.titleLength > 60) {
      findings.push("Homepage title length is outside the commonly recommended 15–60 character range.");
    }

    if (!homepage.description) findings.push("Homepage is missing a meta description.");
    else if (homepage.descriptionLength < 70 || homepage.descriptionLength > 160) {
      findings.push("Homepage meta description length is outside the commonly recommended 70–160 character range.");
    }

    if (homepage.h1Count === 0) findings.push("Homepage has no H1 heading.");
    if (homepage.h1Count > 1) findings.push("Homepage has more than one H1 heading.");
    if (!homepage.canonical) findings.push("Homepage has no detected canonical link.");
    if (!homepage.viewport) findings.push("Homepage has no detected viewport meta tag.");
    if (homepage.noindex) findings.push("Homepage contains a noindex directive.");
    if (homepage.imagesWithoutAlt > 0) {
      findings.push(homepage.imagesWithoutAlt + " homepage image(s) have no detected alt text.");
    }
  }

  if (!robots.available) findings.push("robots.txt could not be retrieved.");
  if (!sitemap.available) findings.push("No accessible sitemap was detected.");

  const totalImages = pages.reduce((sum, p) => sum + p.imageCount, 0);
  const missingAlt = pages.reduce((sum, p) => sum + p.imagesWithoutAlt, 0);
  const indexedPages = pages.filter(p => !p.noindex).length;

  return {
    pagesChecked: pages.length,
    successfulPages: pages.filter(p => p.status >= 200 && p.status < 400).length,
    homepageStatus: homepage ? homepage.status : null,
    titlePresent: homepage ? Boolean(homepage.title) : null,
    descriptionPresent: homepage ? Boolean(homepage.description) : null,
    h1Count: homepage ? homepage.h1Count : null,
    canonicalPresent: homepage ? Boolean(homepage.canonical) : null,
    viewportPresent: homepage ? homepage.viewport : null,
    robotsAvailable: robots.available,
    sitemapAvailable: sitemap.available,
    sitemapUrlCount: sitemap.totalUrlsFound,
    imagesChecked: totalImages,
    imagesMissingAlt: missingAlt,
    pagesWithoutNoindex: indexedPages,
    findings
  };
}

async function kvGet(env, key) {
  if (!env.TRAFFIC_HISTORY) return null;

  try {
    return await env.TRAFFIC_HISTORY.get(key, "json");
  } catch (_) {
    return null;
  }
}

async function kvPut(env, key, value, ttl) {
  if (!env.TRAFFIC_HISTORY) return false;

  try {
    await env.TRAFFIC_HISTORY.put(key, JSON.stringify(value), {
      expirationTtl: ttl
    });
    return true;
  } catch (_) {
    return false;
  }
}

async function analyzeDomain(domain, env) {
  const saved = await kvGet(env, CACHE_PREFIX + domain);

  if (saved && saved.ok && saved.domain === domain) {
    return { ...saved, cached: true };
  }

  const origin = "https://" + domain;
  const homepageResponse = await fetchPublicPage(origin);

  if (
    homepageResponse.status < 200 ||
    homepageResponse.status >= 400 ||
    !/html|xhtml/i.test(homepageResponse.contentType)
  ) {
    throw new Error("The website did not return a successful HTML homepage.");
  }

  const homepage = analyzeHtml(
    homepageResponse.text,
    homepageResponse.url,
    homepageResponse.status,
    homepageResponse.headers
  );

  const robots = await getRobots(domain, origin);
  const sitemap = await getSitemap(origin, robots.sitemaps);

  const pageUrls = sitemap.urls
    .filter(url => url !== homepageResponse.url)
    .slice(0, MAX_PAGES - 1);

  const pageResults = await Promise.all(
    pageUrls.map(async pageUrl => {
      try {
        const response = await fetchPublicPage(pageUrl);

        if (
          response.status < 200 ||
          response.status >= 400 ||
          !/html|xhtml/i.test(response.contentType)
        ) {
          return null;
        }

        return analyzeHtml(
          response.text,
          response.url,
          response.status,
          response.headers
        );
      } catch (_) {
        return null;
      }
    })
  );

  const pagesChecked = [
    homepage,
    ...pageResults.filter(Boolean)
  ];

  const technicalAudit = buildAudit(pagesChecked, robots, sitemap);

  const result = {
    ok: true,
    domain,
    checkedAt: new Date().toISOString(),

    overview: {
      organicTraffic: null,
      organicKeywords: null,
      trafficValue: null,
      domainRating: null,
      urlRating: null,
      positions: {
        top1: null,
        top3: null,
        top10: null
      }
    },

    keywords: [],
    countries: [],

    countryNotice:
      "No genuine public country-traffic data source is connected. Country traffic is shown as No Data.",

    countrySource: "No Data",

    countryTraffic: {
      available: false,
      totalVisits: null
    },

    keywordLocation: null,
    pageLocation: null,

    pages: pagesChecked.slice(0, 5).map(page => ({
      url: page.url,
      estimatedTraffic: null
    })),

    history: [],

    technicalAudit,
    robots,
    sitemap,
    pageDetails: pagesChecked,

    source: "Public website HTML + robots.txt + XML sitemap",

    estimateNotice:
      "This free report inspects publicly accessible website pages, robots.txt and XML sitemaps. Public website files do not reveal a site's actual Google organic traffic, keyword rankings, search volumes, traffic value or visitor country distribution. These metrics are therefore shown as No Data. Discovered sitemap pages are not traffic-ranked pages. No traffic, rankings, visits or historical values have been invented.",

    cached: false,
    stale: false
  };

  await kvPut(env, CACHE_PREFIX + domain, result, CACHE_TTL);

  return result;
}

export class DomainLock {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.queue = Promise.resolve();
  }

  fetch(request) {
    const task = this.queue.then(
      () => this.handle(request),
      () => this.handle(request)
    );

    this.queue = task.then(
      () => undefined,
      () => undefined
    );

    return task;
  }

  async handle(request) {
    const url = new URL(request.url);
    let domain;

    try {
      domain = normalizePublicDomain(url.searchParams.get("domain") || "");
    } catch (error) {
      return json({ ok: false, error: error.message }, 400);
    }

    const key = "report:" + domain;
    const saved = await this.state.storage.get(key);

    if (saved && saved.expiresAt > Date.now() && saved.report?.ok) {
      return json({ ...saved.report, cached: true });
    }

    try {
      const report = await analyzeDomain(domain, this.env);

      await this.state.storage.put(key, {
        savedAt: Date.now(),
        expiresAt: Date.now() + CACHE_TTL * 1000,
        report
      });

      return json(report);
    } catch (error) {
      return json({
        ok: false,
        domain,
        error: String(error?.message || "Website analysis failed.").slice(0, 400)
      }, 502);
    }
  }
}

async function healthCheck(env) {
  return json({
    ok: true,
    worker: "IRFAN Traffic Intelligence",
    version: "12.0-free-public-audit",
    publicDashboard: true,
    publicAnalyzer: true,
    googleLoginRequired: false,
    googleSearchConsole: false,
    paidProvidersRequired: false,
    kvConfigured: Boolean(env.TRAFFIC_HISTORY),
    durableObjectConfigured: Boolean(env.DOMAIN_LOCKS),
    dailyAnalysisLimit: null,
    artificialDailyLimit: false,
    cacheDurationHours: 24,
    dataSource: "Public website HTML + robots.txt + XML sitemap",
    trafficPolicy:
      "No paid SEO API, private Search Console, fabricated traffic, invented rankings, search volume, country visits or historical values. Missing metrics are returned as null."
  });
}

function htmlResponse(html) {
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
      "content-security-policy":
        "default-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data: https:; font-src 'self' https://fonts.gstatic.com data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com"
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-allow-headers": "content-type"
        }
      });
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      return healthCheck(env);
    }

    if (
      url.pathname === "/api/public/analyze" &&
      request.method === "GET"
    ) {
      if (!env.DOMAIN_LOCKS) {
        return json({
          ok: false,
          error: "DOMAIN_LOCKS Durable Object binding is missing. Configure it in Cloudflare Worker settings."
        }, 503);
      }

      let domain;

      try {
        domain = normalizePublicDomain(url.searchParams.get("domain") || "");
      } catch (error) {
        return json({ ok: false, error: error.message }, 400);
      }

      const id = env.DOMAIN_LOCKS.idFromName(domain);
      const stub = env.DOMAIN_LOCKS.get(id);

      return stub.fetch(request);
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ ok: false, error: "API endpoint not found." }, 404);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ ok: false, error: "Method not allowed." }, 405);
    }

    return htmlResponse(APP_HTML);
  }
};

// ======================================================
// IRFAN TRAFFIC INTELLIGENCE — ORIGINAL DASHBOARD DESIGN
// ======================================================

const APP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>IRFAN Traffic Intelligence</title>
<meta name="description" content="IRFAN Traffic Intelligence — free public website and technical SEO analysis.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{--bg:#071426;--panel:#10213b;--line:#263b59;--muted:#9aabc4;--gold:#e9b43d;--blue:#087de5;--green:#20c997;--red:#ef5365}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(circle at 20% 0%,#142b4c,#071426 55%);color:#eef4ff;font-family:Inter,Arial,sans-serif;min-height:100vh}
.layout{display:flex;min-height:100vh}
.sidebar{width:235px;flex:0 0 235px;background:linear-gradient(180deg,#08172b,#071426);border-right:1px solid #203858;padding:22px 16px;display:flex;flex-direction:column}
.logo{text-align:center;font-size:39px;letter-spacing:2px;font-weight:950;margin:5px 0 0;color:#f2bd42;text-shadow:0 2px 16px #d69a2c33}
.logo small{display:block;font-size:12px;letter-spacing:1.4px;text-transform:uppercase;color:#f7d987;font-weight:750;margin-top:2px}
.logo-mark{font-size:62px;line-height:1;color:#e9b43d;text-align:center;margin:0 auto 4px;text-shadow:0 4px 18px #e5a72b55}
.nav{margin-top:44px}
.nav div{padding:12px 14px;margin:6px 0;border-radius:10px;color:#dbe7fa;font-size:15px}
.nav .active{background:linear-gradient(100deg,#f3c54f,#d99d27);color:#081426;font-weight:850;box-shadow:0 4px 16px #e7ad3833}
.nav .tool-active{background:linear-gradient(100deg,#0758ad,#087de5);color:#fff;font-weight:800}
.side-note{margin-top:auto;padding:20px 8px;text-align:center;color:#f4c34a;font-size:17px;font-weight:900;line-height:1.35}
main{flex:1;min-width:0;padding:25px 28px;max-width:1800px}
.header{display:flex;align-items:center;justify-content:space-between;gap:15px;margin-bottom:22px;flex-wrap:wrap;border-bottom:1px solid #b98a2d;padding-bottom:16px}
h1{font-size:30px;margin:0;font-weight:900;color:#f2f6ff}
.sub{font-size:12px;color:#f1cf7d;letter-spacing:.5px}
.panel,.metric{background:linear-gradient(145deg,#10213b,#0a172b);border:1px solid #203858;border-radius:14px;box-shadow:0 8px 25px #0004}
.panel{padding:19px;margin-bottom:18px}
.metric{padding:17px;color:white;min-width:0}
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.metric:nth-child(1){background:linear-gradient(120deg,#164b83,#102b4d)}
.metric:nth-child(2){background:linear-gradient(120deg,#126b66,#10443f)}
.metric:nth-child(3){background:linear-gradient(120deg,#6246a2,#352b70)}
.metric:nth-child(4){background:linear-gradient(120deg,#a66b1b,#654112)}
.metric .label{font-size:12px;opacity:.92}
.metric .value{font-size:28px;font-weight:850;margin-top:6px}
.metric .hint{font-size:11px;opacity:.8}
.sitebox{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.sitebox input{flex:1;min-width:180px;border:1px solid #294365;background:#07162d;font-weight:700;font-size:16px;color:#fff}
input,select{border:1px solid #294365;border-radius:10px;padding:11px;background:#08172e;color:#eef4ff;font:inherit}
button{border:0;background:linear-gradient(110deg,#f0c24a,#c98d21);color:#101b2a;padding:11px 16px;border-radius:10px;font-weight:800;cursor:pointer}
button.secondary{background:#19304f;color:#edf4ff;border:1px solid #315174}
button:disabled{opacity:.5;cursor:wait}
.status{background:#073b39;color:#49e0b1;padding:7px 12px;border-radius:30px;font-size:12px}
.section-title{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:13px}
h2{font-size:17px;margin:0;color:#f4f7ff}
.grid{display:grid;grid-template-columns:1.15fr .85fr;gap:18px}
table{width:100%;border-collapse:collapse;min-width:580px}
th,td{padding:12px 10px;border-bottom:1px solid #263b59;text-align:left;white-space:nowrap}
th{font-size:11px;color:#a9bad1;text-transform:uppercase}
td{font-size:13px}
td a{color:#75b8ff;text-decoration:none}
td a:hover{text-decoration:underline}
.table-wrap{overflow-x:auto}
.chart{width:100%;height:210px;display:block}
.chart text{fill:#9aabc4;font-size:10px}
.empty{text-align:center;color:#9aabc4;padding:25px}
.notice{padding:12px 14px;border-radius:10px;background:#142b49;color:#bcd8ff;margin:12px 0}
.error{background:#451e2a;color:#ffb9c1}
.public-analyzer{border-top:3px solid #e7b43d;background:linear-gradient(145deg,#10213b,#0a172b)}
.public-analyzer .sitebox input{border:1px solid #294365;border-radius:10px;padding:12px 14px;background:#07162d;font-size:15px;font-weight:550;color:#fff}
.public-metrics{margin-top:16px}
.public-analyzer .grid{margin-top:16px}
.public-analyzer .panel{box-shadow:none;border-color:#263b59}
.small{font-size:11px;color:#9aabc4}
.foot{text-align:center;color:#8194b0;font-size:11px;margin:25px}
.report-overlay{position:fixed;inset:0;z-index:1000;background:#020817d9;display:flex;align-items:center;justify-content:center;padding:18px;overflow:auto}
.report-sheet{width:min(1200px,100%);max-height:calc(100vh - 36px);overflow:auto;background:#fff;color:#111827;border-radius:7px;box-shadow:0 25px 90px #0009;padding:28px 30px 20px;position:relative;font-family:Arial,Helvetica,sans-serif}
.report-sheet h2,.report-sheet h3{color:#111827}
.report-close{position:absolute;right:18px;top:10px;background:transparent;color:#6b7280;font-size:28px;padding:0 7px}
.report-title{font-size:36px;line-height:1.14;font-weight:500;margin:0 38px 4px 0;overflow-wrap:anywhere}
.report-subtitle{color:#64748b;font-size:16px;margin-bottom:18px}
.report-top{display:grid;grid-template-columns:1fr 1.1fr;gap:28px;align-items:start}
.report-numbers{display:flex;gap:34px;flex-wrap:wrap}
.report-number label{display:block;font-size:14px;font-weight:700;margin-bottom:2px}
.report-number strong{font-size:54px;line-height:1.15;font-weight:500;letter-spacing:-1.5px}
.report-number .money{font-size:36px}
.rating-box{margin-top:15px;background:#f2f3f5;padding:15px 18px;border-radius:3px;display:flex;gap:35px;align-items:center;min-height:96px}
.rating-item{display:flex;gap:12px;align-items:center}
.rating-circle{width:50px;height:50px;border:10px solid #087de5;border-radius:50%;box-shadow:0 0 0 3px #087de51a}
.rating-item:nth-child(2) .rating-circle{border-color:#ef5365;box-shadow:0 0 0 3px #ef53651a}
.rating-label{font-size:15px;font-weight:700}
.rating-value{font-size:18px;color:#64748b}
.rating-foot{font-size:13px;color:#475569;margin-top:8px}
.report-chart{width:100%;height:250px;display:block}
.report-chart text{font-size:12px;fill:#94a3b8}
.report-chart .gridline{stroke:#e5e7eb;stroke-width:1}
.report-chart .trend{stroke:#087de5;stroke-width:3.5;fill:none;stroke-linecap:round;stroke-linejoin:round}
.report-chart .area{fill:url(#trafficFill)}
.report-lower{display:grid;grid-template-columns:1fr 1.35fr;gap:38px;margin-top:20px}
.report-section h3{font-size:17px;margin:0 0 8px;font-weight:700}
.report-table{min-width:0;width:100%;border-collapse:collapse}
.report-table th,.report-table td{padding:7px 4px;border-bottom:1px solid #e5e7eb;color:#111827;font-size:14px;white-space:normal}
.report-table th{font-size:13px;text-transform:none;color:#334155}
.report-table td.num,.report-table th.num{text-align:right;white-space:nowrap}
.report-pages{margin-top:16px}
.report-pages .report-table td:first-child{width:26px}
.report-pages a{color:#0756cf;text-decoration:none;overflow-wrap:anywhere}
.report-note{display:flex;gap:9px;align-items:flex-start;border-top:1px solid #e5e7eb;margin-top:12px;padding-top:10px;color:#475569;font-size:12px}
.report-note .info{background:#20a878;color:white;border-radius:50%;width:18px;height:18px;text-align:center;font-weight:700;flex-shrink:0}
.report-empty{color:#64748b;font-style:italic}
.report-status{font-size:12px;color:#64748b;margin-top:10px}
.country-scope{display:inline-block;background:#e8f1ff;color:#0758ad;border-radius:20px;padding:4px 9px;font-size:11px;font-weight:700;margin:0 0 8px}
.country-scope-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#20c997;margin-right:5px}
.chart-legend{display:flex;gap:14px;align-items:center;font-size:11px;color:#64748b;margin-top:4px}
.chart-legend i{display:inline-block;width:18px;height:3px;border-radius:3px;background:#087de5;vertical-align:middle;margin-right:5px}
.chart-legend .legend-dot{width:8px;height:8px;border-radius:50%;background:#20c997;display:inline-block;margin-right:5px}
.audit-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:12px}
.audit-item{background:#f1f5f9;padding:11px;border-radius:5px}
.audit-item strong{display:block;font-size:19px;color:#0f2745}
.audit-item span{font-size:12px;color:#64748b}
.audit-findings{padding-left:18px;margin:8px 0;color:#475569;font-size:13px;line-height:1.7}
.hidden{display:none!important}
@media(max-width:950px){.sidebar{width:190px}.metrics{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr}.report-top{grid-template-columns:1fr}.report-lower{grid-template-columns:1fr 1fr}}
@media(max-width:650px){.sidebar{display:none}main{padding:13px}h1{font-size:22px}.metrics{gap:8px}.metric{padding:12px}.metric .value{font-size:22px}.panel{padding:13px}.sitebox input{font-size:14px}.report-overlay{padding:0}.report-sheet{max-height:100vh;border-radius:0;padding:22px 15px}.report-title{font-size:26px}.report-number strong{font-size:40px}.report-number .money{font-size:30px}.report-lower{grid-template-columns:1fr;gap:20px}.report-chart{height:210px}.rating-box{gap:15px;flex-wrap:wrap}.audit-grid{grid-template-columns:repeat(2,1fr)}}
</style>
</head>
<body>
<div class="layout">
<aside class="sidebar">
  <div class="logo-mark">♛↗</div>
  <div class="logo">IRFAN<small>TRAFFIC INTELLIGENCE</small><small>ANALYZE · TRACK · GROW</small></div>
  <div class="nav">
    <div class="active">⌂ &nbsp; Dashboard</div>
    <div>▥ &nbsp; Performance</div>
    <div>⌕ &nbsp; Keywords</div>
    <div>▤ &nbsp; Top Articles</div>
    <div>◎ &nbsp; Countries</div>
    <div class="tool-active">⌕ &nbsp; Domain Analyzer</div>
  </div>
  <div class="side-note">REAL DATA<br>REAL INSIGHTS　↗</div>
</aside>

<main>
<header class="header">
  <div>
    <h1>IRFAN Traffic Intelligence</h1>
    <div class="sub">PROFESSIONAL SEO ANALYTICS · FREE PUBLIC WEBSITE DATA</div>
  </div>
  <div style="display:flex;align-items:center;gap:10px">
    <span class="status" id="systemStatus">● PUBLIC ANALYZER</span>
    <button id="healthCheck" type="button">CHECK API</button>
  </div>
</header>

<section class="panel public-analyzer">
  <div class="section-title">
    <div>
      <h2>Domain Analyzer</h2>
      <div class="small">Analyze any public website · No login or paid API required</div>
    </div>
    <span class="status">● FREE PUBLIC DATA</span>
  </div>
  <div class="sitebox">
    <input id="publicDomain" type="text" placeholder="Enter website domain, e.g. example.com" autocomplete="url" aria-label="Website domain">
    <button id="publicAnalyze" type="button">Analyze Domain</button>
  </div>
  <div id="publicMessage" class="notice hidden"></div>
</section>

<div id="publicReport" class="report-overlay hidden" role="dialog" aria-modal="true" aria-label="Domain analysis report">
 <section class="report-sheet">
  <button class="report-close" id="closePublicReport" aria-label="Close report">×</button>
  <h2 class="report-title" id="pubTitle">Public website analysis</h2>
  <div class="report-subtitle">Public website data · Technical SEO inspection</div>

  <div class="report-top">
   <div>
    <div class="report-numbers">
     <div class="report-number">
       <label>Organic traffic <span title="Not available from public website files">ⓘ</span></label>
       <strong id="pubTraffic">No Data</strong>
     </div>
     <div class="report-number">
       <label>Traffic value <span title="Not available from public website files">ⓘ</span></label>
       <strong class="money" id="pubValue">No Data</strong>
     </div>
    </div>

    <div class="rating-box">
      <div class="rating-item">
        <div class="rating-circle"></div>
        <div>
          <div class="rating-label">Domain<br>Rating</div>
          <div class="rating-value" id="pubDR">No Data</div>
        </div>
      </div>
      <div class="rating-item">
        <div class="rating-circle"></div>
        <div>
          <div class="rating-label">URL<br>Rating</div>
          <div class="rating-value" id="pubUR">No Data</div>
        </div>
      </div>
    </div>
    <div class="rating-foot">Public website files do not disclose traffic or third-party domain rating metrics.</div>
   </div>

   <div>
     <svg id="pubTrafficChart" class="report-chart" viewBox="0 0 560 250" preserveAspectRatio="none" aria-label="Organic traffic history unavailable"></svg>
     <div class="chart-legend"><span><i></i>Organic traffic</span><span><b class="legend-dot"></b>No Data</span></div>
     <div id="pubChartCaption" class="report-status">No verified historical traffic data is available.</div>
   </div>
  </div>

  <div class="report-lower">
   <section class="report-section">
     <h3>Top countries <span title="Country traffic is unavailable">ⓘ</span></h3>
     <div class="country-scope"><span class="country-scope-dot"></span>Public country traffic data</div>
     <table class="report-table">
       <thead><tr><th>Country</th><th class="num">Visits</th><th class="num">Share</th></tr></thead>
       <tbody id="pubCountryRows"><tr><td colspan="3" class="report-empty">No Data</td></tr></tbody>
     </table>
     <div id="pubCountryNote" class="report-status">Public website files do not disclose visitor countries.</div>
   </section>

   <section class="report-section">
     <h3>Top keywords <span title="Keyword rankings are unavailable">ⓘ</span>
       <span id="pubKeywordCountry" style="font-size:12px;font-weight:400;color:#64748b">(No ranking data)</span>
     </h3>
     <table class="report-table">
       <thead><tr><th>Keyword</th><th class="num">Position</th><th class="num">Volume</th><th class="num">Traffic</th></tr></thead>
       <tbody id="pubKeywordRows"></tbody>
     </table>
   </section>
  </div>

  <section class="report-section report-pages">
    <h3>Discovered pages <span style="float:right;font-size:13px">Traffic: No Data</span></h3>
    <table class="report-table"><tbody id="pubPageRows"></tbody></table>
  </section>

  <section class="report-section report-pages">
    <h3>Technical SEO Audit</h3>
    <div class="audit-grid" id="reportAuditGrid"></div>
    <ul class="audit-findings" id="reportAuditFindings"></ul>
  </section>

  <div class="report-note">
    <span class="info">i</span>
    <span id="pubDisclaimer">Public website data cannot reveal actual Google organic traffic, keyword rankings, search volume or country visits. Missing metrics are shown as No Data.</span>
  </div>
  <div class="report-status" id="pubCheckedAt"></div>
 </section>
</div>

<section id="app">
  <section class="panel">
    <div class="section-title">
      <div>
        <h2>Domain Performance Overview</h2>
        <div class="small" id="dashboardDomain">Analyze any public website to load its public SEO data.</div>
      </div>
      <span class="status">● PUBLIC SEO DATA</span>
    </div>

    <div class="metrics">
      <div class="metric">
        <div class="label">ESTIMATED ORGANIC TRAFFIC</div>
        <div class="value" id="dashTraffic">No Data</div>
        <div class="hint">Not disclosed by public website files</div>
      </div>
      <div class="metric">
        <div class="label">ORGANIC KEYWORDS</div>
        <div class="value" id="dashKeywords">No Data</div>
        <div class="hint">Rankings not publicly disclosed</div>
      </div>
      <div class="metric">
        <div class="label">ESTIMATED TRAFFIC VALUE</div>
        <div class="value" id="dashValue">No Data</div>
        <div class="hint">No public traffic-value source</div>
      </div>
      <div class="metric">
        <div class="label">PAGES CHECKED</div>
        <div class="value" id="dashTop10">No Data</div>
        <div class="hint">Public HTML pages inspected</div>
      </div>
    </div>
  </section>

  <section class="panel">
    <div class="section-title">
      <h2>Estimated Organic Visits History</h2>
      <span class="small">No verified traffic history source</span>
    </div>
    <svg id="dashboardChart" class="chart" viewBox="0 0 700 210" preserveAspectRatio="none" aria-label="Organic traffic history unavailable"></svg>
    <div class="chart-legend"><span><i></i>Organic traffic</span><span><b class="legend-dot"></b>No Data</span></div>
    <div class="small" id="dashboardChartNote">No historical traffic values are invented or displayed.</div>
  </section>

  <div class="grid">
    <section class="panel" id="dashboardKeywords">
      <div class="section-title">
        <h2>Top 5 Organic Keywords</h2>
        <span class="small">Position · Search volume · Traffic</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Keyword</th><th>Position</th><th>Search Volume</th><th>Traffic</th></tr></thead>
          <tbody id="dashboardKeywordRows"><tr><td colspan="4" class="empty">No public keyword ranking data.</td></tr></tbody>
        </table>
      </div>
    </section>

    <section class="panel" id="dashboardCountries">
      <div class="section-title">
        <h2>Top Countries</h2>
        <span class="small">Visitor traffic distribution</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Country</th><th>Estimated Visits</th><th>Traffic Share</th></tr></thead>
          <tbody id="dashboardCountryRows"><tr><td colspan="3" class="empty">No country traffic data.</td></tr></tbody>
        </table>
      </div>
      <p class="small" id="dashboardCountryNote">Country traffic is not disclosed by public website files.</p>
    </section>
  </div>

  <section class="panel" id="dashboardPages">
    <div class="section-title">
      <h2>Discovered Articles / Pages</h2>
      <span class="small">Sitemap URLs · Traffic unavailable</span>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Article / Page URL</th><th>Estimated Traffic</th></tr></thead>
        <tbody id="dashboardPageRows"><tr><td colspan="3" class="empty">Analyze a domain to discover public pages.</td></tr></tbody>
      </table>
    </div>
  </section>

  <section class="panel">
    <div class="section-title">
      <h2>Technical SEO Audit</h2>
      <span class="small">Public pages · robots.txt · XML sitemap</span>
    </div>
    <div class="audit-grid" id="dashboardAuditGrid">
      <div class="audit-item"><strong>—</strong><span>Pages checked</span></div>
      <div class="audit-item"><strong>—</strong><span>Images checked</span></div>
      <div class="audit-item"><strong>—</strong><span>Missing image alt</span></div>
    </div>
    <ul class="audit-findings" id="dashboardAuditFindings">
      <li>Analyze a website to see technical SEO findings.</li>
    </ul>
  </section>

  <section class="panel">
    <div class="section-title">
      <h2>Visits / Sessions</h2>
      <span class="small">Public data availability</span>
    </div>
    <div class="empty">Verified website sessions and Analytics visits are private account data. This public analyzer does not invent or estimate them.</div>
  </section>
</section>

<div class="foot">IRFAN Traffic Intelligence · Free public website analysis · Source-backed data only.</div>
</main>
</div>

<script>
const $ = id => document.getElementById(id);
let analyzing = false;

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

function compactCount(value) {
  if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) {
    return "No Data";
  }

  const n = Number(value);

  if (n >= 1000000) {
    return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1).replace(/\.0$/, "") + "M";
  }

  if (n >= 1000) {
    return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "") + "K";
  }

  return String(Math.round(n));
}

function publicMessage(text, bad = false) {
  const el = $("publicMessage");
  el.textContent = text;
  el.classList.remove("hidden", "error");
  if (bad) el.classList.add("error");
}

function safeLink(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.href;
  } catch (_) {}
  return "";
}

function renderNoTrafficCharts() {
  const message = '<text x="50%" y="48%" text-anchor="middle" fill="#94a3b8" font-size="15">No Data — public traffic history unavailable</text>';

  $("pubTrafficChart").innerHTML = message;
  $("dashboardChart").innerHTML = message;
  $("pubChartCaption").textContent = "No verified historical traffic data is available.";
  $("dashboardChartNote").textContent = "No historical traffic values are invented or displayed.";
}

function renderKeywords() {
  $("pubKeywordRows").innerHTML =
    '<tr><td colspan="4" class="report-empty">No public keyword ranking data available.</td></tr>';

  $("dashboardKeywordRows").innerHTML =
    '<tr><td colspan="4" class="empty">No public keyword ranking data available.</td></tr>';
}

function renderCountries() {
  const message = "No public country traffic data available.";

  $("pubCountryRows").innerHTML =
    '<tr><td colspan="3" class="report-empty">No Data</td></tr>';

  $("dashboardCountryRows").innerHTML =
    '<tr><td colspan="3" class="empty">No Data</td></tr>';

  $("pubCountryNote").textContent = message;
  $("dashboardCountryNote").textContent = message;
}

function renderPages(pages) {
  const rows = Array.isArray(pages) ? pages.slice(0, 5) : [];

  $("pubPageRows").innerHTML = rows.length
    ? rows.map((p, i) => {
        const link = safeLink(p.url);

        return '<tr><td>' + (i + 1) + '</td><td>' +
          (link
            ? '<a href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">' + esc(p.url) + '</a>'
            : esc(p.url || "—")) +
          '</td><td class="num">No Data</td></tr>';
      }).join("")
    : '<tr><td colspan="3" class="report-empty">No sitemap pages discovered.</td></tr>';

  $("dashboardPageRows").innerHTML = rows.length
    ? rows.map((p, i) => {
        const link = safeLink(p.url);

        return "<tr><td>" + (i + 1) + "</td><td>" +
          (link
            ? '<a href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">' + esc(p.url) + '</a>'
            : esc(p.url || "—")) +
          "</td><td>No Data</td></tr>";
      }).join("")
    : '<tr><td colspan="3" class="empty">No sitemap pages discovered.</td></tr>';
}

function renderAudit(audit) {
  const a = audit || {};

  const items = [
    [a.pagesChecked ?? "—", "Pages checked"],
    [a.successfulPages ?? "—", "Successful pages"],
    [a.imagesChecked ?? "—", "Images checked"],
    [a.imagesMissingAlt ?? "—", "Images missing alt"],
    [a.sitemapUrlCount ?? "—", "Sitemap URLs found"],
    [a.homepageStatus ?? "—", "Homepage HTTP status"]
  ];

  const html = items.map(item =>
    '<div class="audit-item"><strong>' + esc(item[0]) +
    '</strong><span>' + esc(item[1]) + "</span></div>"
  ).join("");

  $("reportAuditGrid").innerHTML = html;
  $("dashboardAuditGrid").innerHTML = html;

  const findings = Array.isArray(a.findings) ? a.findings : [];
  const list = findings.length
    ? findings.map(item => "<li>" + esc(item) + "</li>").join("")
    : "<li>No issues were detected in the inspected public pages. This is not a full technical SEO certification.</li>";

  $("reportAuditFindings").innerHTML = list;
  $("dashboardAuditFindings").innerHTML = list;
}

function renderPublicAnalysis(d) {
  $("pubTitle").textContent = "Public website analysis of " + d.domain;

  $("pubTraffic").textContent = "No Data";
  $("pubValue").textContent = "No Data";
  $("pubDR").textContent = "No Data";
  $("pubUR").textContent = "No Data";

  $("dashboardDomain").textContent =
    "Domain: " + d.domain + " · Public website technical analysis";

  $("dashTraffic").textContent = "No Data";
  $("dashKeywords").textContent = "No Data";
  $("dashValue").textContent = "No Data";
  $("dashTop10").textContent =
    d.technicalAudit ? compactCount(d.technicalAudit.pagesChecked) : "No Data";

  renderNoTrafficCharts();
  renderKeywords();
  renderCountries();
  renderPages(d.pages || []);
  renderAudit(d.technicalAudit);

  $("pubKeywordCountry").textContent = "(No ranking data)";

  $("pubDisclaimer").textContent =
    d.estimateNotice ||
    "Public website files do not disclose actual organic traffic, keyword rankings, search volume or visitor countries. Missing values are shown as No Data.";

  $("pubCheckedAt").textContent =
    "Domain: " + d.domain +
    " · Source: Public website HTML, robots.txt and XML sitemap" +
    " · Checked: " + new Date(d.checkedAt || Date.now()).toLocaleString() +
    (d.cached ? " · CACHED REPORT" : "");

  $("publicReport").classList.remove("hidden");
}

async function runPublicAnalysis() {
  if (analyzing) return;

  const domain = $("publicDomain").value.trim();

  if (!domain) {
    publicMessage("Please enter a website domain first.", true);
    $("publicDomain").focus();
    return;
  }

  analyzing = true;

  const button = $("publicAnalyze");
  const original = button.textContent;

  button.disabled = true;
  button.textContent = "Analyzing...";
  $("publicReport").classList.add("hidden");

  publicMessage("Checking the public homepage, robots.txt and sitemap. Please wait.");

  try {
    const response = await fetch(
      "/api/public/analyze?domain=" + encodeURIComponent(domain),
      {
        method: "GET",
        headers: { "accept": "application/json" },
        cache: "no-store"
      }
    );

    const data = await response.json().catch(
      () => ({ error: "Invalid server response." })
    );

    if (!response.ok || !data.ok) {
      throw new Error(data.error || "Domain analysis failed.");
    }

    renderPublicAnalysis(data);

    publicMessage(
      data.cached
        ? "Showing the saved public website analysis. No new crawl was needed."
        : "Analysis complete. Public pages, robots.txt and sitemap checked. Traffic and keyword metrics remain No Data because public files do not disclose them."
    );

  } catch (error) {
    publicMessage(
      error.message || "Could not analyze this domain. Please try again.",
      true
    );
  } finally {
    analyzing = false;
    button.disabled = false;
    button.textContent = original;
  }
}

async function checkApi() {
  const button = $("healthCheck");
  const original = button.textContent;

  button.disabled = true;
  button.textContent = "CHECKING...";

  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data.error || "API health check failed.");
    }

    if (!data.durableObjectConfigured) {
      $("systemStatus").textContent = "● LOCK NOT CONFIGURED";
      publicMessage(
        "Worker is online, but DOMAIN_LOCKS Durable Object binding is missing.",
        true
      );
    } else {
      $("systemStatus").textContent = "● WORKER ONLINE";
      publicMessage(
        "Worker is online. Free public website analysis is enabled. No paid API keys, Google login, private Search Console or artificial daily analysis limit are required."
      );
    }
  } catch (error) {
    $("systemStatus").textContent = "● API ERROR";
    publicMessage(error.message || "API connection failed.", true);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

$("publicAnalyze").addEventListener("click", event => {
  event.preventDefault();
  runPublicAnalysis();
});

$("publicDomain").addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    runPublicAnalysis();
  }
});

$("closePublicReport").addEventListener("click", () => {
  $("publicReport").classList.add("hidden");
});

$("publicReport").addEventListener("click", event => {
  if (event.target.id === "publicReport") {
    $("publicReport").classList.add("hidden");
  }
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    $("publicReport").classList.add("hidden");
  }
});

$("healthCheck").addEventListener("click", checkApi);
</script>
</body>
</html>`;
