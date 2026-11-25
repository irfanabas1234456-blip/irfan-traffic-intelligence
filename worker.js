
const CACHE_PREFIX = "iti:public:domain:v7:";
const STALE_PREFIX = "iti:public:stale:v7:";
const HISTORY_PREFIX = "iti:public:history:v7:";

const CACHE_TTL = 30 * 24 * 60 * 60;
const STALE_TTL = 365 * 24 * 60 * 60;
const HISTORY_TTL = 31536000;

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

// Preserve genuine zero values.
function positiveEstimate(value) {
  return safeNumber(value);
}

function normalizePublicDomain(value) {
  const input = String(value || "").trim();

  if (!input || input.length > 2048) {
    throw new Error("Enter a valid public website domain.");
  }

  let parsed;

  try {
    parsed = new URL(
      /^https?:\/\//i.test(input) ? input : "https://" + input
    );
  } catch (_) {
    throw new Error("Enter a valid website URL or domain.");
  }

  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("Enter a valid public HTTP or HTTPS website.");
  }

  const domain = parsed.hostname.toLowerCase().replace(/^www\./, "");

  if (
    !domain.includes(".") ||
    domain.length > 253 ||
    !/^[a-z0-9.-]+$/.test(domain) ||
    domain.includes("..")
  ) {
    throw new Error("Enter a valid public website domain.");
  }

  if (
    domain === "localhost" ||
    domain.endsWith(".localhost") ||
    domain.endsWith(".local") ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(domain)
  ) {
    throw new Error("Enter a public domain name, not a local or IP address.");
  }

  return domain;
}

function unwrap(data) {
  if (!data || typeof data !== "object") return {};
  return data.data && typeof data.data === "object" ? data.data : data;
}

async function yepPost(env, path, body) {
  if (!env.YEPAPI_API_KEY) {
    throw new Error("YEPAPI_API_KEY secret is missing in Cloudflare Worker settings.");
  }

  const response = await fetch("https://api.yepapi.com" + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.YEPAPI_API_KEY
    },
    body: JSON.stringify(body)
  });

  const raw = await response.text();
  let data;

  try {
    data = JSON.parse(raw);
  } catch (_) {
    throw new Error("YepAPI returned an invalid response (HTTP " + response.status + ").");
  }

  if (!response.ok || data?.ok === false || data?.error) {
    const message =
      data?.message ||
      data?.error?.message ||
      data?.error ||
      data?.detail ||
      ("YepAPI request failed (HTTP " + response.status + ")");

    throw new Error(String(message).slice(0, 350));
  }

  return data;
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
    await env.TRAFFIC_HISTORY.put(
      key,
      JSON.stringify(value),
      { expirationTtl: ttl }
    );
    return true;
  } catch (_) {
    return false;
  }
}

function rowsFrom(data, names) {
  for (const name of names) {
    if (Array.isArray(data?.[name])) return data[name];
  }
  return [];
}

async function getSavedReport(env, domain, stale = false) {
  const key = stale
    ? STALE_PREFIX + domain
    : CACHE_PREFIX + domain;

  const saved = await kvGet(env, key);

  if (!saved?.ok || saved.domain !== domain) return null;

  saved.history =
    (await kvGet(env, HISTORY_PREFIX + domain)) ||
    saved.history ||
    [];

  saved.cached = true;

  if (stale) {
    saved.stale = true;
    saved.staleNotice =
      "Live data could not be refreshed. Showing the last successfully saved YepAPI report. The figures may be older than 30 days.";
  }

  return saved;
}

async function analyzeDomain(request, env) {
  const url = new URL(request.url);
  let domain;

  try {
    domain = normalizePublicDomain(url.searchParams.get("domain") || "");
  } catch (e) {
    return json({ ok: false, error: e.message }, 400);
  }

  const cacheKey = CACHE_PREFIX + domain;

  // The Durable Object also stores a persistent copy.
  // This KV check is an additional cache layer.
  const cached = await getSavedReport(env, domain, false);

  if (cached) return json(cached);

  const staleReport = await getSavedReport(env, domain, true);

  if (!env.YEPAPI_API_KEY) {
    if (staleReport) return json(staleReport);

    return json({
      ok: false,
      domain,
      error: "This domain has no saved report yet. Live analysis is temporarily unavailable because the YepAPI key is not configured."
    }, 503);
  }

  try {
    // Mandatory whole-domain metrics request.
    const metricsRaw = await yepPost(
      env,
      "/v1/seo/domain/metrics",
      { domain }
    );

    const metricsData = unwrap(metricsRaw);
    const domainMetrics = metricsData.domainMetrics || {};
    const pageMetrics = metricsData.page || {};

    if (!metricsData.domainMetrics) {
      throw new Error(
        "YepAPI Domain Metrics response did not contain domainMetrics. Please check the API response and account access."
      );
    }

    // Optional report sections.
    const [keywordsRaw, pagesRaw, rankRaw] = await Promise.all([
      yepPost(
        env,
        "/v1/seo/domain/keywords",
        {
          domain,
          limit: 100,
          offset: 0,
          location_code: 2840,
          language: "en"
        }
      ).catch(e => ({ _optionalError: e.message })),

      yepPost(
        env,
        "/v1/seo/domain/pages",
        {
          domain,
          limit: 5,
          offset: 0,
          location_code: 2840,
          language: "en"
        }
      ).catch(e => ({ _optionalError: e.message })),

      yepPost(
        env,
        "/v1/seo/domain/rank-overview",
        {
          domain,
          location: "us",
          language: "en"
        }
      ).catch(e => ({ _optionalError: e.message }))
    ]);

    const traffic = safeNumber(domainMetrics.traffic);
    const keywordCount = safeNumber(domainMetrics.organicKeywords);
    const trafficValue = safeNumber(domainMetrics.trafficValue);
    const domainRating = safeNumber(domainMetrics.domainRating);
    const urlRating = safeNumber(pageMetrics.urlRating);

    const keywordData = unwrap(keywordsRaw);

    const rawKeywords = rowsFrom(
      keywordData,
      ["keywords", "items", "results"]
    );

    const keywords = rawKeywords
      .map(k => ({
        keyword: String(k.keyword ?? k.query ?? "").slice(0, 300),
        position: safeNumber(k.position ?? k.rank),
        searchVolume: safeNumber(
          k.volume ?? k.searchVolume ?? k.search_volume
        ),
        estimatedTraffic: safeNumber(k.traffic ?? k.etv),
        url: String(k.url ?? "").slice(0, 1500)
      }))
      .filter(k => k.keyword)
      .sort((a, b) => (a.position ?? 99999) - (b.position ?? 99999))
      .slice(0, 5);

    const pageData = unwrap(pagesRaw);

    const rawPages = rowsFrom(
      pageData,
      ["pages", "items", "results"]
    );

    const pages = rawPages
      .map(p => ({
        url: String(p.url ?? p.page ?? "").slice(0, 1500),
        estimatedTraffic: safeNumber(p.traffic ?? p.etv)
      }))
      .filter(p => p.url)
      .slice(0, 5);

    const rankData = unwrap(rankRaw);
    const organic = rankData.organic || rankData;
    const pos = organic.positions || rankData.positions || {};

    const top1 = safeNumber(pos.pos1);
    const top3 = safeNumber(pos.pos2_3);
    const top10 = safeNumber(pos.pos4_10);

    let history =
      (await kvGet(env, HISTORY_PREFIX + domain)) || [];

    const today = new Date().toISOString().slice(0, 10);

    if (traffic !== null) {
      const index = history.findIndex(item => item.date === today);
      const snapshot = { date: today, traffic };

      if (index >= 0) history[index] = snapshot;
      else history.push(snapshot);

      history = history
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-90);

      await kvPut(
        env,
        HISTORY_PREFIX + domain,
        history,
        HISTORY_TTL
      );
    }

    const result = {
      ok: true,
      domain,
      checkedAt: new Date().toISOString(),

      overview: {
        organicTraffic: traffic,
        organicKeywords: keywordCount,
        trafficValue,
        domainRating,
        urlRating,
        positions: {
          top1,
          top3,
          top10
        }
      },

      keywords,
      pages,

      // These selected YepAPI endpoints do not provide
      // country-level traffic distribution.
      countries: [],

      countryNotice:
        "Country-level traffic distribution is not supplied by the selected YepAPI endpoints. United States is only the selected keyword and page ranking-data location, not a verified traffic country.",

      keywordLocation: "United States",
      pageLocation: "United States",

      history,

      source: "YepAPI Domain Metrics + Domain Keywords + Domain Pages",

      estimateNotice:
        "Domain organic traffic is the provider's whole-domain monthly estimate from Domain Metrics. Keyword positions, keyword traffic and top-page traffic are US-location estimates. The United States label identifies the ranking-data location only; it does not represent the domain's main traffic country. These are third-party SEO database estimates, not verified Google Analytics visits or private Google Search Console measurements. Search volume is separate from estimated organic traffic. Missing provider values are shown as No Data. Genuine zero values remain 0.",

      optionalWarnings: [
        keywordsRaw._optionalError,
        pagesRaw._optionalError,
        rankRaw._optionalError
      ].filter(Boolean),

      cached: false,
      stale: false
    };

    // Save the fresh report and the one-year backup.
    await Promise.all([
      kvPut(env, cacheKey, result, CACHE_TTL),
      kvPut(env, STALE_PREFIX + domain, result, STALE_TTL)
    ]);

    return json(result);

  } catch (e) {
    if (staleReport) return json(staleReport);

    const message = String(
      e?.message || "Domain analysis failed."
    ).slice(0, 400);

    const creditProblem =
      /credit|balance|quota|insufficient|payment|limit exceeded/i.test(message);

    return json({
      ok: false,
      domain,
      error: creditProblem
        ? "Live analysis is temporarily unavailable because the SEO data provider has no available credits. This domain has no previously saved report yet."
        : message
    }, 502);
  }
}

// ======================================================
// DURABLE OBJECT: one serialized analysis queue per domain
// ======================================================

export class DomainLock {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.queue = Promise.resolve();
  }

  fetch(request) {
    // Every request for this domain waits for the previous
    // request to finish before it can start an API analysis.
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
      domain = normalizePublicDomain(
        url.searchParams.get("domain") || ""
      );
    } catch (e) {
      return json({ ok: false, error: e.message }, 400);
    }

    // Durable Object storage is strongly consistent.
    // It prevents KV propagation delays from causing
    // a second provider charge for the same domain.
    const saved = await this.state.storage.get("freshReport");

    if (
      saved &&
      saved.domain === domain &&
      saved.expiresAt > Date.now() &&
      saved.report?.ok
    ) {
      const report = { ...saved.report, cached: true, stale: false };

      report.history =
        (await kvGet(this.env, HISTORY_PREFIX + domain)) ||
        report.history ||
        [];

      return json(report);
    }

    // Expired saved report can no longer be served as fresh.
    if (saved) {
      await this.state.storage.delete("freshReport");
    }

    // Only this serialized Durable Object request can now
    // reach YepAPI for this domain.
    const response = await analyzeDomain(request, this.env);
    const result = await response.clone().json().catch(() => null);

    // Persist only successful, fresh reports.
    // Failed requests and stale backups do not reset the
    // 30-day fresh-cache period.
    if (
      response.ok &&
      result?.ok === true &&
      result?.stale !== true
    ) {
      await this.state.storage.put("freshReport", {
        domain,
        savedAt: Date.now(),
        expiresAt: Date.now() + CACHE_TTL * 1000,
        report: result
      });
    }

    return response;
  }
}

async function healthCheck(env) {
  return json({
    ok: true,
    worker: "IRFAN Traffic Intelligence",
    version: "9.0-domain-durable-lock-30-day",

    publicDashboard: true,
    publicAnalyzer: true,

    googleLoginRequired: false,
    googleSearchConsole: false,
    trackeeConfigured: false,

    yepapiConfigured: Boolean(env.YEPAPI_API_KEY),
    kvConfigured: Boolean(env.TRAFFIC_HISTORY),
    durableObjectConfigured: Boolean(env.DOMAIN_LOCKS),

    cacheDurationDays: 30,
    backupDurationDays: 365,

    dataSource:
      "YepAPI Domain Metrics (whole-domain traffic) + Domain Keywords (US rankings) + Domain Pages (US page estimates)",

    trafficPolicy:
      "Per-domain Durable Object serialization and persistent 30-day report cache. Successful reports are reused by all visitors. Whole-domain traffic is a third-party estimate. Country traffic distribution is not fabricated. Genuine zero values are preserved."
  });
}

function htmlResponse(html) {
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
      "content-security-policy":
        "default-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com; connect-src 'self' https://api.yepapi.com; img-src 'self' data: https:; font-src 'self' https://fonts.gstatic.com data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com"
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
          error: "DOMAIN_LOCKS Durable Object binding is missing. Configure the binding before using the public analyzer."
        }, 503);
      }

      let domain;

      try {
        domain = normalizePublicDomain(
          url.searchParams.get("domain") || ""
        );
      } catch (e) {
        return json({ ok: false, error: e.message }, 400);
      }

      // A stable Durable Object ID is created for each normalized domain.
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
// ORIGINAL IRFAN TRAFFIC INTELLIGENCE DASHBOARD
// Design and layout preserved.
// ======================================================

const APP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>IRFAN Traffic Intelligence</title>
<meta name="description" content="IRFAN Traffic Intelligence — professional SEO analytics and public domain analysis.">
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
.hidden{display:none!important}
@media(max-width:950px){.sidebar{width:190px}.metrics{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr}.report-top{grid-template-columns:1fr}.report-lower{grid-template-columns:1fr 1fr}}
@media(max-width:650px){.sidebar{display:none}main{padding:13px}h1{font-size:22px}.metrics{gap:8px}.metric{padding:12px}.metric .value{font-size:22px}.panel{padding:13px}.sitebox input{font-size:14px}.report-overlay{padding:0}.report-sheet{max-height:100vh;border-radius:0;padding:22px 15px}.report-title{font-size:26px}.report-number strong{font-size:40px}.report-number .money{font-size:30px}.report-lower{grid-template-columns:1fr;gap:20px}.report-chart{height:210px}.rating-box{gap:15px;flex-wrap:wrap}}
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
    <div class="sub">PROFESSIONAL SEO ANALYTICS · YEPAPI SEO DATABASE</div>
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
      <div class="small">Analyze any public website · No Google login required</div>
    </div>
    <span class="status">● YEPAPI DOMAIN DATA</span>
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
  <h2 class="report-title" id="pubTitle">Organic traffic of domain</h2>
  <div class="report-subtitle">Domain including subdomains</div>

  <div class="report-top">
   <div>
    <div class="report-numbers">
     <div class="report-number">
       <label>Organic traffic <span title="Third-party estimate">ⓘ</span></label>
       <strong id="pubTraffic">—</strong>
     </div>
     <div class="report-number">
       <label>Traffic value <span title="Estimated monetary value">ⓘ</span></label>
       <strong class="money" id="pubValue">—</strong>
     </div>
    </div>

    <div class="rating-box">
      <div class="rating-item">
        <div class="rating-circle"></div>
        <div>
          <div class="rating-label">Domain<br>Rating</div>
          <div class="rating-value" id="pubDR">—</div>
        </div>
      </div>
      <div class="rating-item">
        <div class="rating-circle"></div>
        <div>
          <div class="rating-label">URL<br>Rating</div>
          <div class="rating-value" id="pubUR">—</div>
        </div>
      </div>
    </div>
    <div class="rating-foot">Domain Rating and URL Rating are provider-supplied metrics.</div>
   </div>

   <div>
     <svg id="pubTrafficChart" class="report-chart" viewBox="0 0 560 250" preserveAspectRatio="none" aria-label="Estimated organic visits history chart"></svg>
     <div class="chart-legend"><span><i></i>Estimated organic visits</span><span><b class="legend-dot"></b>Latest estimate</span></div>
     <div id="pubChartCaption" class="report-status">History will appear as dated snapshots become available.</div>
   </div>
  </div>

  <div class="report-lower">
   <section class="report-section">
     <h3>Top countries <span title="Country distribution">ⓘ</span></h3>
     <div class="country-scope"><span class="country-scope-dot"></span>Country traffic distribution</div>
     <table class="report-table">
       <thead><tr><th>Country</th><th class="num">Data coverage</th></tr></thead>
       <tbody id="pubCountryRows"><tr><td colspan="2" class="report-empty">No Data</td></tr></tbody>
     </table>
   </section>

   <section class="report-section">
     <h3>Top keywords <span title="US ranked keywords">ⓘ</span>
       <span id="pubKeywordCountry" style="font-size:12px;font-weight:400;color:#64748b">(US rankings)</span>
     </h3>
     <table class="report-table">
       <thead><tr><th>Keyword</th><th class="num">Position</th><th class="num">Volume</th><th class="num">Traffic</th></tr></thead>
       <tbody id="pubKeywordRows"></tbody>
     </table>
   </section>
  </div>

  <section class="report-section report-pages">
    <h3>Top 5 articles / pages <span style="float:right;font-size:13px">US estimated monthly traffic</span></h3>
    <table class="report-table"><tbody id="pubPageRows"></tbody></table>
  </section>

  <div class="report-note">
    <span class="info">i</span>
    <span id="pubDisclaimer">Domain traffic is a whole-domain third-party estimate. Keyword and page estimates are US-location data. Country distribution is shown only when the provider supplies it.</span>
  </div>
  <div class="report-status" id="pubCheckedAt"></div>
 </section>
</div>

<section id="app">
  <section class="panel">
    <div class="section-title">
      <div>
        <h2>Domain Performance Overview</h2>
        <div class="small" id="dashboardDomain">Analyze any public website to load its SEO metrics.</div>
      </div>
      <span class="status">● PUBLIC SEO DATA</span>
    </div>

    <div class="metrics">
      <div class="metric">
        <div class="label">ESTIMATED ORGANIC TRAFFIC</div>
        <div class="value" id="dashTraffic">—</div>
        <div class="hint">Whole-domain monthly organic estimate</div>
      </div>
      <div class="metric">
        <div class="label">ORGANIC KEYWORDS</div>
        <div class="value" id="dashKeywords">—</div>
        <div class="hint">Whole-domain provider estimate</div>
      </div>
      <div class="metric">
        <div class="label">ESTIMATED TRAFFIC VALUE</div>
        <div class="value" id="dashValue">—</div>
        <div class="hint">Provider traffic cost estimate</div>
      </div>
      <div class="metric">
        <div class="label">TOP 10 RANKINGS</div>
        <div class="value" id="dashTop10">—</div>
        <div class="hint">US position distribution</div>
      </div>
    </div>
  </section>

  <section class="panel">
    <div class="section-title">
      <h2>Estimated Organic Visits History</h2>
      <span class="small">Saved dated snapshots · monthly estimate</span>
    </div>
    <svg id="dashboardChart" class="chart" viewBox="0 0 700 210" preserveAspectRatio="none" aria-label="Estimated organic visits history chart"></svg>
    <div class="chart-legend"><span><i></i>Estimated organic visits</span><span><b class="legend-dot"></b>Latest estimate</span></div>
    <div class="small" id="dashboardChartNote">History will appear after dated domain analyses are saved.</div>
  </section>

  <div class="grid">
    <section class="panel" id="dashboardKeywords">
      <div class="section-title">
        <h2>Top 5 Organic Keywords</h2>
        <span class="small">US position · Search volume · Traffic</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Keyword</th><th>Position</th><th>Search Volume</th><th>Traffic</th></tr></thead>
          <tbody id="dashboardKeywordRows"><tr><td colspan="4" class="empty">Analyze a domain to load keyword data.</td></tr></tbody>
        </table>
      </div>
    </section>

    <section class="panel" id="dashboardCountries">
      <div class="section-title">
        <h2>Top Countries</h2>
        <span class="small">Traffic distribution</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Country</th><th>Data coverage</th></tr></thead>
          <tbody id="dashboardCountryRows"><tr><td colspan="2" class="empty">Country data not supplied by provider.</td></tr></tbody>
        </table>
      </div>
      <p class="small">The selected YepAPI endpoints do not provide country-level traffic distribution.</p>
    </section>
  </div>

  <section class="panel" id="dashboardPages">
    <div class="section-title">
      <h2>Top 5 Articles / Pages</h2>
      <span class="small">US estimated monthly page traffic</span>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Article / Page URL</th><th>Estimated Traffic</th></tr></thead>
        <tbody id="dashboardPageRows"><tr><td colspan="3" class="empty">Analyze a domain to load top pages.</td></tr></tbody>
      </table>
    </div>
  </section>

  <section class="panel">
    <div class="section-title">
      <h2>Visits / Sessions</h2>
      <span class="small">Provider availability</span>
    </div>
    <div class="empty">YepAPI SEO database does not provide verified website sessions or analytics visits. The history chart above shows estimated organic visits from the provider's organic traffic metric, not verified Analytics sessions.</div>
  </section>
</section>

<div class="foot">IRFAN Traffic Intelligence · Public domain analysis · Source-backed estimates only.</div>
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

function moneyValue(value) {
  if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) {
    return "No Data";
  }

  return "$" + Number(value).toLocaleString("en-US", {
    maximumFractionDigits: 2
  });
}

function publicMessage(text, bad = false) {
  const el = $("publicMessage");
  el.textContent = text;
  el.classList.remove("hidden", "error");
  if (bad) el.classList.add("error");
}

function renderTrafficHistory(history, currentTraffic) {
  const targets = [$("pubTrafficChart"), $("dashboardChart")];

  const rows = Array.isArray(history)
    ? history.filter(x =>
        x.traffic !== null &&
        x.traffic !== undefined &&
        Number.isFinite(Number(x.traffic)) &&
        Number(x.traffic) >= 0
      )
    : [];

  const w = 560, h = 250, left = 12, right = 42, top = 18, bottom = 34;
  const plotW = w - left - right;
  const plotH = h - top - bottom;
  let out = "";

  if (rows.length < 2) {
    const value = safeChartNumber(currentTraffic);
    const y = top + plotH - (value > 0 ? plotH * 0.72 : 0);

    out =
      '<line class="gridline" x1="' + left + '" y1="' + (top + plotH) +
      '" x2="' + (w - right) + '" y2="' + (top + plotH) +
      '"/>' +
      (value !== null
        ? '<line x1="' + left + '" y1="' + y +
          '" x2="' + (w - right - 5) + '" y2="' + y +
          '" stroke="#087de5" stroke-width="3" stroke-linecap="round" stroke-dasharray="6 6" opacity=".75"/>' +
          '<circle cx="' + (w - right - 5) + '" cy="' + y +
          '" r="5" fill="#20c997" stroke="#ffffff" stroke-width="2"/>'
        : "") +
      '<text x="' + (w - right) + '" y="' + (h - 7) +
      '" text-anchor="end">Latest</text><text x="' +
      left + '" y="' + (top + plotH - 7) + '">' +
      (value !== null ? esc(compactCount(value)) : "No Data") + "</text>";

    $("pubChartCaption").textContent =
      rows.length === 1
        ? "One dated estimate is available. A real history trend will appear after more dated analyses."
        : "Latest estimate shown. A real history trend will appear after multiple dated analyses.";

    $("dashboardChartNote").textContent =
      "The dashed line marks the latest estimate only. A historical trend requires multiple dated snapshots; no past values are invented.";
  } else {
    const vals = rows.map(x => Number(x.traffic));
    const max = Math.max(1, ...vals) * 1.15;

    const pts = rows.map((r, i) => ({
      x: left + (plotW * i / (rows.length - 1)),
      y: top + plotH - (Number(r.traffic) / max) * plotH,
      label: r.date,
      traffic: Number(r.traffic)
    }));

    const line = pts.map(p => p.x + "," + p.y).join(" ");
    const area =
      "M " + pts[0].x + " " + (top + plotH) +
      " L " + line.replace(/ /g, " L ") +
      " L " + pts[pts.length - 1].x + " " + (top + plotH) + " Z";

    out =
      '<defs><linearGradient id="trafficFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#087de5" stop-opacity=".24"/><stop offset="100%" stop-color="#20c997" stop-opacity=".02"/></linearGradient></defs>';

    for (let i = 0; i < 4; i++) {
      const y = top + (plotH * i / 3);
      out +=
        '<line class="gridline" x1="' + left + '" y1="' + y +
        '" x2="' + (w - right) + '" y2="' + y +
        '"/><text x="' + (w - right + 7) + '" y="' + (y + 4) +
        '">' + esc(compactCount(max * (1 - i / 3))) + "</text>";
    }

    out += '<path class="area" d="' + area + '"/><polyline class="trend" points="' + line + '"/>';

    pts.forEach((p, i) => {
      out +=
        '<circle cx="' + p.x + '" cy="' + p.y +
        '" r="4" fill="#20c997" stroke="#ffffff" stroke-width="1.5"><title>' +
        esc(p.label) + ": " + compactCount(p.traffic) +
        ' estimated organic visits</title></circle>';

      if (i === 0 || i === pts.length - 1 || i === Math.floor(pts.length / 2)) {
        out +=
          '<text x="' + p.x + '" y="' + (h - 8) +
          '" text-anchor="middle">' + esc(p.label) + "</text>";
      }
    });

    $("pubChartCaption").textContent =
      "Saved dated estimates · hover over chart points for estimated organic visits.";

    $("dashboardChartNote").textContent =
      "Saved daily whole-domain monthly organic traffic estimates, displayed as estimated organic visits.";
  }

  targets.forEach(svg => {
    if (svg) svg.innerHTML = out;
  });
}

function safeChartNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function renderKeywords(keywords) {
  const rows = Array.isArray(keywords) ? keywords.slice(0, 5) : [];

  $("pubKeywordRows").innerHTML = rows.length
    ? rows.map(k =>
        '<tr><td>' + esc(k.keyword) +
        '</td><td class="num">' +
        (k.position === null || k.position === undefined ? "—" : esc(k.position)) +
        '</td><td class="num">' + compactCount(k.searchVolume) +
        '</td><td class="num">' + compactCount(k.estimatedTraffic) +
        "</td></tr>"
      ).join("")
    : '<tr><td colspan="4" class="report-empty">No ranked keyword data available.</td></tr>';

  $("dashboardKeywordRows").innerHTML = rows.length
    ? rows.map(k =>
        "<tr><td>" + esc(k.keyword) +
        "</td><td>" +
        (k.position === null || k.position === undefined ? "—" : esc(k.position)) +
        "</td><td>" + compactCount(k.searchVolume) +
        "</td><td>" + compactCount(k.estimatedTraffic) +
        "</td></tr>"
      ).join("")
    : '<tr><td colspan="4" class="empty">No ranked keyword data available.</td></tr>';
}

function safeLink(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.href;
  } catch (_) {}
  return "";
}

function renderPages(pages) {
  const rows = Array.isArray(pages) ? pages.slice(0, 5) : [];

  $("pubPageRows").innerHTML = rows.length
    ? rows.map((p, i) => {
        const link = safeLink(p.url);
        return '<tr><td>' + (i + 1) +
          '</td><td>' +
          (link
            ? '<a href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">' + esc(p.url) + '</a>'
            : esc(p.url || "—")) +
          '</td><td class="num">' + compactCount(p.estimatedTraffic) + "</td></tr>";
      }).join("")
    : '<tr><td colspan="3" class="report-empty">No page traffic data supplied by provider.</td></tr>';

  $("dashboardPageRows").innerHTML = rows.length
    ? rows.map((p, i) => {
        const link = safeLink(p.url);
        return "<tr><td>" + (i + 1) +
          '</td><td>' +
          (link
            ? '<a href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">' + esc(p.url) + '</a>'
            : esc(p.url || "—")) +
          "</td><td>" + compactCount(p.estimatedTraffic) + "</td></tr>";
      }).join("")
    : '<tr><td colspan="3" class="empty">No page traffic data supplied by provider.</td></tr>';
}

function renderPublicAnalysis(d) {
  const o = d.overview || {};
  const pos = o.positions || {};

  const top10Values = [pos.top1, pos.top3, pos.top10]
    .filter(v => v !== null && v !== undefined && Number.isFinite(Number(v)))
    .map(Number);

  const top10 = top10Values.length
    ? top10Values.reduce((sum, v) => sum + v, 0)
    : null;

  $("pubTitle").textContent = "Organic traffic of https://" + d.domain;
  $("pubTraffic").textContent = compactCount(o.organicTraffic);
  $("pubValue").textContent = moneyValue(o.trafficValue);
  $("pubDR").textContent = o.domainRating === null || o.domainRating === undefined ? "No Data" : String(o.domainRating);
  $("pubUR").textContent = o.urlRating === null || o.urlRating === undefined ? "No Data" : String(o.urlRating);

  $("dashboardDomain").textContent =
    "Domain: " + d.domain + " · Whole-domain traffic estimate · Source: YepAPI";

  $("dashTraffic").textContent = compactCount(o.organicTraffic);
  $("dashKeywords").textContent = compactCount(o.organicKeywords);
  $("dashValue").textContent = moneyValue(o.trafficValue);
  $("dashTop10").textContent = top10 === null ? "No Data" : compactCount(top10);

  renderTrafficHistory(d.history, o.organicTraffic);

  const countries = Array.isArray(d.countries) ? d.countries : [];

  const countryHtml = countries.length
    ? countries.slice(0, 5).map(c =>
        "<tr><td>" + esc(c.country || "—") +
        '</td><td class="num">' + esc(c.dataScope || "No traffic-share data") + "</td></tr>"
      ).join("")
    : '<tr><td colspan="2" class="report-empty">' +
      esc(d.countryNotice || "Country traffic data is not available from these endpoints.") +
      "</td></tr>";

  $("pubCountryRows").innerHTML = countryHtml;

  $("dashboardCountryRows").innerHTML = countries.length
    ? countryHtml
    : '<tr><td colspan="2" class="empty">Country-level traffic is not supplied by the selected YepAPI endpoints.</td></tr>';

  $("pubKeywordCountry").textContent = d.keywordLocation ? "(" + d.keywordLocation + " rankings)" : "";
  renderKeywords(d.keywords || []);
  renderPages(d.pages || []);

  $("pubDisclaimer").textContent =
    d.staleNotice
      ? d.staleNotice + " " + (d.estimateNotice || "")
      : (d.estimateNotice ||
        "Metrics are third-party SEO database estimates, not verified Google Analytics or private Google Search Console measurements.");

  $("pubCheckedAt").textContent =
    "Domain: " + d.domain +
    " · Source: YepAPI Domain Metrics · Checked: " +
    new Date(d.checkedAt || Date.now()).toLocaleString() +
    (d.stale ? " · SAVED BACKUP REPORT" : d.cached ? " · CACHED REPORT" : "");

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

    if (data.stale) {
      publicMessage(
        "Showing the last saved report. Live refresh is temporarily unavailable."
      );
    } else if (data.cached) {
      publicMessage(
        "Showing saved YepAPI data. No new API request was needed."
      );
    } else {
      publicMessage(
        "Analysis complete. Whole-domain traffic estimate loaded from YepAPI Domain Metrics."
      );
    }

  } catch (e) {
    publicMessage(
      e.message || "Could not analyze this domain. Please try again.",
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

    if (!data.yepapiConfigured) {
      $("systemStatus").textContent = "● SAVED REPORTS AVAILABLE";
      publicMessage(
        "Worker is online. Saved reports can still be viewed, but new domain analysis needs the YepAPI key.",
        true
      );
    } else if (!data.durableObjectConfigured) {
      $("systemStatus").textContent = "● LOCK NOT CONFIGURED";
      publicMessage(
        "YepAPI is configured, but the DOMAIN_LOCKS Durable Object binding is missing.",
        true
      );
    } else {
      $("systemStatus").textContent = "● WORKER ONLINE";
      publicMessage(
        "Worker, YepAPI and Durable Object are configured. This check confirms configuration, not remaining API credits."
      );
    }
  } catch (e) {
    $("systemStatus").textContent = "● API ERROR";
    publicMessage(e.message || "API connection failed.", true);
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
