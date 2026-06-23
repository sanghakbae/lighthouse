import express from 'express';
import cors from 'cors';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 리포트 저장은 클라이언트에서 Firebase Firestore로 직접 처리 (서버 측 스토리지 없음)

// 헤드리스 Chrome 실행 플래그 (컨테이너 환경 대응: --no-sandbox, --disable-dev-shm-usage)
const CHROME_FLAGS = ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];

// ── Device configurations ──────────────────────────────────────────────────
const DEVICES = {
  iphone: {
    label: 'iPhone',
    formFactor: 'mobile',
    screenEmulation: { mobile: true, width: 390, height: 844, deviceScaleFactor: 3, disabled: false },
  },
  galaxy: {
    label: 'Galaxy',
    formFactor: 'mobile',
    screenEmulation: { mobile: true, width: 360, height: 780, deviceScaleFactor: 3, disabled: false },
  },
  tablet: {
    label: 'iPad',
    formFactor: 'mobile',
    screenEmulation: { mobile: true, width: 1024, height: 1366, deviceScaleFactor: 2, disabled: false },
  },
  pc: {
    label: 'Desktop',
    formFactor: 'desktop',
    screenEmulation: { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false },
  },
};

// ── Screenshot device specs (실제 디바이스 에뮬레이션) ──────────────────────
const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  galaxy: 'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  tablet: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
};
const SHOT_DEVICES = {
  iphone: { width: 390,  height: 844,  dsf: 3, mobile: true,  ua: UA.iphone },
  galaxy: { width: 360,  height: 780,  dsf: 3, mobile: true,  ua: UA.galaxy },
  tablet: { width: 1024, height: 1366, dsf: 2, mobile: true,  ua: UA.tablet },
  pc:     { width: 1350, height: 940,  dsf: 1, mobile: false, ua: null },
};

// ── Express app ────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(cors({
  origin(origin, cb) {
    const ok = !origin ||
      origin.includes('localhost') ||
      origin.includes('127.0.0.1') ||
      origin.endsWith('.github.io') ||
      origin.endsWith('.pages.dev') ||
      origin.endsWith('sanghak.kr');
    cb(null, ok);
  },
  credentials: true,
}));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    field: process.env.CRUX_API_KEY ? 'enabled' : 'disabled',
  });
});

// ── Field data (CrUX 실제 사용자 데이터) — PageSpeed Insights 필드 데이터 ──
const CWV_THRESHOLDS = {
  lcp:  { good: 2500, ni: 4000 },
  inp:  { good: 200,  ni: 500  },
  cls:  { good: 0.1,  ni: 0.25 },
  fcp:  { good: 1800, ni: 3000 },
  ttfb: { good: 800,  ni: 1800 },
};
const CRUX_KEYMAP = {
  largest_contentful_paint: 'lcp',
  interaction_to_next_paint: 'inp',
  cumulative_layout_shift: 'cls',
  first_contentful_paint: 'fcp',
  experimental_time_to_first_byte: 'ttfb',
};
function rateMetric(key, p75) {
  const t = CWV_THRESHOLDS[key]; if (!t) return 'na';
  return p75 <= t.good ? 'good' : p75 <= t.ni ? 'ni' : 'poor';
}
function parseCrux(record) {
  const out = { metrics: {}, collectionPeriod: record.collectionPeriod || null };
  for (const [cruxKey, m] of Object.entries(record.metrics || {})) {
    const key = CRUX_KEYMAP[cruxKey]; if (!key) continue;
    const p75 = parseFloat(m.percentiles?.p75);
    const dens = (m.histogram || []).map(h => Math.round((h.density || 0) * 100));
    out.metrics[key] = {
      p75,
      good: dens[0] || 0, ni: dens[1] || 0, poor: dens[2] || 0,
      rating: rateMetric(key, p75),
    };
  }
  // Core Web Vitals 평가: LCP·INP·CLS 모두 good 이면 통과
  const core = ['lcp', 'inp', 'cls'].map(k => out.metrics[k]).filter(Boolean);
  out.assessment = (core.length >= 1 && core.every(m => m.rating === 'good')) ? 'pass' : 'fail';
  return out;
}
async function cruxQuery(key, body) {
  const r = await fetch(`https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${key}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return r;
}
app.get('/field', async (req, res) => {
  const key = process.env.CRUX_API_KEY;
  if (!key) return res.json({ available: false, reason: 'no-key' });
  let { url, device = 'pc' } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });
  if (!url.startsWith('http')) url = 'https://' + url;
  const formFactor = device === 'pc' ? 'DESKTOP' : 'PHONE';  // CrUX: TABLET 데이터 거의 없음 → PHONE

  try {
    // 1) URL 단위 조회
    let r = await cruxQuery(key, { url, formFactor });
    let scope = 'url';
    if (!r.ok) {
      // 2) 데이터 부족 시 origin 단위로 폴백
      const origin = new URL(url).origin;
      r = await cruxQuery(key, { origin, formFactor });
      scope = 'origin';
    }
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      return res.json({ available: false, reason: 'no-data', detail: err.error?.message || null });
    }
    const data = await r.json();
    res.json({ available: true, scope, formFactor, ...parseCrux(data.record || {}) });
  } catch (e) {
    res.json({ available: false, reason: e.message });
  }
});

// ── Screenshot (디바이스 뷰포트 실제 렌더링; X-Frame-Options 무관) ──────────
app.get('/screenshot', async (req, res) => {
  let { url, device = 'pc', fullPage, cookie = '' } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });
  if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url;
  const d = SHOT_DEVICES[device] || SHOT_DEVICES.pc;

  let chrome, browser;
  try {
    const chromeLauncher = await import('chrome-launcher');
    chrome = await chromeLauncher.launch({ chromeFlags: [...CHROME_FLAGS, '--hide-scrollbars'], chromePath: process.env.CHROME_PATH || undefined });
    const puppeteer = (await import('puppeteer-core')).default;
    browser = await puppeteer.connect({ browserURL: `http://localhost:${chrome.port}`, defaultViewport: null });

    const page = await browser.newPage();
    await page.setViewport({ width: d.width, height: d.height, deviceScaleFactor: d.dsf, isMobile: d.mobile, hasTouch: d.mobile });
    if (d.ua) await page.setUserAgent(d.ua);
    if (cookie) await page.setExtraHTTPHeaders({ Cookie: cookie });  // 세션 쿠키 주입 (로그인 화면 캡처)
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    const buf = await page.screenshot({ type: 'png', fullPage: fullPage === '1' });

    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-store');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    try { if (browser) await browser.disconnect(); } catch {}
    if (chrome) await chrome.kill();
  }
});

// ── Live proxy (경로 기반: X-Frame-Options/CSP 제거 + JS/CSS 동일출처화) ─────
// SPA의 ES 모듈 스크립트가 교차출처(CORS)로 막히지 않도록 모든 리소스를
// /p/<실제URL> 경로로 우리 서버를 통해 제공 → iframe 실시간 미리보기 동작.
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function proxifyHtml(html, finalUrl) {
  const origin = new URL(finalUrl).origin;
  const baseTag = `<base href="/p/${finalUrl}">`;
  // 절대경로(/assets/..) → /p/<origin>/assets/.. , 프로토콜상대(//host) → /p/https://host
  html = html.replace(/\b(src|href|action)=("|')(\/[^"'>]*)\2/gi, (m, a, q, v) =>
    v.startsWith('//') ? `${a}=${q}/p/https:${v}${q}` : `${a}=${q}/p/${origin}${v}${q}`);
  // 동일출처 절대 URL(https://origin/..) → /p/https://origin/..
  const originRe = new RegExp(`\\b(src|href|action)=("|')(${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"'>]*)\\2`, 'gi');
  html = html.replace(originRe, (m, a, q, v) => `${a}=${q}/p/${v}${q}`);
  // 런타임 fetch/XHR을 프록시로 우회
  const inject = `<script>(function(){var O=${JSON.stringify(origin)},B=${JSON.stringify(finalUrl)};` +
    `function p(u){try{var a=new URL(u,B);if(a.origin===O)return "/p/"+a.href;}catch(e){}return u;}` +
    `var of=window.fetch;window.fetch=function(i,n){try{var u=(typeof i==='string')?i:(i&&i.url);return of(p(u),n);}catch(e){return of.apply(this,arguments);}};` +
    `var oo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){try{arguments[1]=p(u);}catch(e){}return oo.apply(this,arguments);};` +
    `})();</script>`;
  if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, m => m + baseTag + inject);
  else if (/<html[^>]*>/i.test(html)) html = html.replace(/<html[^>]*>/i, m => m + '<head>' + baseTag + inject + '</head>');
  else html = baseTag + inject + html;
  return html;
}

// fetch 실패 원인(undici cause)까지 노출 (ECONNREFUSED/ETIMEDOUT/ENOTFOUND 등)
function errMsg(e) {
  const c = e && e.cause;
  const detail = c ? (c.code || c.message) : '';
  return detail ? `${e.message} — ${detail}` : (e && e.message) || String(e);
}

// 쿠키 jar 헬퍼 (lhpx 쿠키에 세션 누적 → 로그인 흐름 유지)
function parseCookiePairs(s) {
  const map = {};
  (s || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) map[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
  return map;
}
function serializeCookieMap(m) {
  return Object.entries(m).map(([k, v]) => `${k}=${v}`).join('; ');
}
function readJar(req) {
  const m = (req.headers.cookie || '').match(/lhpx=([^;]+)/);
  if (!m) return {};
  try { return parseCookiePairs(Buffer.from(m[1], 'base64').toString()); } catch { return {}; }
}
function extractSetCookies(r) {
  const out = {};
  const arr = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
  for (const sc of arr) {
    const first = (sc || '').split(';')[0]; const i = first.indexOf('=');
    if (i > 0) out[first.slice(0, i).trim()] = first.slice(i + 1).trim();
  }
  return out;
}

// 모든 메서드 지원 프록시 (GET/POST/...). 본문·쿠키 전달, 리다이렉트 재작성.
const rawBody = express.raw({ type: () => true, limit: '25mb' });
async function proxyForward(req, res, target, ua, isEntry) {
  const jar = readJar(req);
  if (isEntry && req.query.cookie) Object.assign(jar, parseCookiePairs(req.query.cookie)); // 진입 시 주입 쿠키 병합

  const headers = {
    'User-Agent': ua || DESKTOP_UA,
    'Accept': req.headers['accept'] || 'text/html,application/xhtml+xml,*/*;q=0.8',
    'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
    'Referer': target,
  };
  const cookieStr = serializeCookieMap(jar);
  if (cookieStr) headers.Cookie = cookieStr;

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
    if (Buffer.isBuffer(req.body) && req.body.length) body = req.body;          // raw (폼/멀티파트)
    else if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) body = JSON.stringify(req.body); // express.json이 파싱한 경우
    else if (typeof req.body === 'string' && req.body) body = req.body;
  }

  const r = await fetch(target, { method: req.method, headers, body, redirect: 'manual' });

  // 응답 Set-Cookie를 jar에 누적 (로그인 세션 establishment)
  const setck = extractSetCookies(r);
  const jarChanged = Object.keys(setck).length > 0;
  if (jarChanged) Object.assign(jar, setck);

  const outCookies = [];
  if (isEntry) outCookies.push(`lhpo=${Buffer.from(new URL(target).origin).toString('base64')}; Path=/; SameSite=Lax`);
  if (isEntry || jarChanged) outCookies.push(`lhpx=${Buffer.from(serializeCookieMap(jar)).toString('base64')}; Path=/; SameSite=Lax`);
  if (outCookies.length) res.set('Set-Cookie', outCookies);
  res.set('Cache-Control', 'no-store');

  // 리다이렉트 → Location을 프록시 경로로 재작성 (브라우저가 프록시 안에서 따라가게)
  if (r.status >= 300 && r.status < 400) {
    const loc = r.headers.get('location');
    if (loc) { res.status(r.status).set('Location', '/p/' + new URL(loc, target).href); return res.end(); }
  }

  const ct = r.headers.get('content-type') || '';
  res.status(r.status);
  if (ct.includes('text/html')) {
    const html = await r.text();
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.send(proxifyHtml(html, r.url || target));
  }
  const buf = Buffer.from(await r.arrayBuffer());
  if (ct) res.set('Content-Type', ct);
  return res.send(buf);
}

// 진입점: HTML 페이지 (세션 쿠키/디바이스 적용)
app.all('/proxy', rawBody, async (req, res) => {
  let { url, device = 'pc' } = req.query;
  if (!url) return res.status(400).send('url required');
  if (!/^https?:\/\//.test(url)) url = 'https://' + url;
  const d = SHOT_DEVICES[device] || SHOT_DEVICES.pc;
  try { await proxyForward(req, res, url, d.ua, true); }
  catch (e) { res.status(502).send(`<div style="font-family:sans-serif;padding:24px;color:#f85149">실시간 프록시 로드 실패: ${errMsg(e)}</div>`); }
});

// 하위 리소스/폼 제출: /p/<실제 URL> (상대경로 해석되도록 경로 구조 보존, 모든 메서드)
app.all(/^\/p\//, rawBody, async (req, res) => {
  const target = req.originalUrl.slice(3); // '/p/' 제거 → https://host/path?query
  if (!/^https?:\/\//.test(target)) return res.status(400).send('bad target');
  try { await proxyForward(req, res, target, DESKTOP_UA, false); }
  catch (e) { res.status(502).send('proxy error: ' + errMsg(e)); }
});

// ── Audit (SSE streaming) ──────────────────────────────────────────────────
app.post('/audit', async (req, res) => {
  let { url, categories, device = 'pc', cookie = '' } = req.body;

  if (!url) return res.status(400).json({ error: 'URL is required' });
  if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  let chrome;
  try {
    send({ type: 'status', message: 'Chrome 실행 중...' });
    const chromeLauncher = await import('chrome-launcher');
    chrome = await chromeLauncher.launch({ chromeFlags: CHROME_FLAGS, chromePath: process.env.CHROME_PATH || undefined });

    send({ type: 'status', message: '페이지 분석 중...' });
    const lighthouse = (await import('lighthouse')).default;
    const deviceCfg = DEVICES[device] || DEVICES.pc;
    const enabledCategories = categories?.length ? categories : ['performance', 'accessibility', 'best-practices', 'seo'];

    const runnerResult = await lighthouse(url, {
      logLevel: 'error',
      output: 'json',
      locale: 'ko',                       // 한글 리포트 (제목·설명 공식 번역)
      onlyCategories: enabledCategories,
      port: chrome.port,
      formFactor: deviceCfg.formFactor,
      screenEmulation: deviceCfg.screenEmulation,
      throttlingMethod: 'simulate',
      // 세션 쿠키 주입 → 로그인된 페이지 분석 (모든 요청에 Cookie 헤더 적용)
      ...(cookie ? { extraHeaders: { Cookie: cookie } } : {}),
    });

    const lhr = runnerResult.lhr;
    const result = buildResult(lhr, device, deviceCfg.label);

    // 저장은 클라이언트가 Firestore로 처리
    send({ type: 'result', data: result });
  } catch (err) {
    send({ type: 'error', message: err.message });
  } finally {
    if (chrome) await chrome.kill();
    res.end();
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────
function buildResult(lhr, device, deviceLabel) {
  const result = {
    url: lhr.finalDisplayedUrl,
    fetchTime: lhr.fetchTime,
    device,
    deviceLabel,
    categories: {},
    audits: {},
    metrics: {},
  };

  for (const [key, cat] of Object.entries(lhr.categories)) {
    result.categories[key] = {
      title: cat.title,
      score: cat.score,
      auditRefs: cat.auditRefs.map(r => r.id),
    };
  }

  const metricIds = [
    'first-contentful-paint', 'largest-contentful-paint',
    'total-blocking-time', 'cumulative-layout-shift',
    'speed-index', 'interactive', 'server-response-time',
  ];
  for (const id of metricIds) {
    const a = lhr.audits[id];
    if (a) result.metrics[id] = { title: a.title, displayValue: a.displayValue, score: a.score, numericValue: a.numericValue };
  }

  for (const [id, a] of Object.entries(lhr.audits)) {
    result.audits[id] = {
      id, title: a.title, description: a.description,
      score: a.score, scoreDisplayMode: a.scoreDisplayMode,
      displayValue: a.displayValue, details: a.details,
    };
  }
  return result;
}

// ── 캐치올 프록시: 프록시 페이지에서 발생한 절대경로 요청을 실제 사이트로 전달 ──
// (React가 런타임에 만든 <img src="/icon.svg">, 동적 청크, /api 호출 등을 자동 처리)
app.all(/.*/, rawBody, async (req, res, next) => {
  const ref = req.headers.referer || '';
  if (!/\/(proxy\?|p\/)/.test(ref)) return next();        // 프록시 iframe에서 온 요청만
  const mo = (req.headers.cookie || '').match(/lhpo=([^;]+)/);
  if (!mo) return next();
  let origin = '';
  try { origin = Buffer.from(mo[1], 'base64').toString(); } catch { return next(); }
  if (!/^https?:\/\//.test(origin)) return next();
  try { await proxyForward(req, res, origin + req.originalUrl, DESKTOP_UA, false); }
  catch { next(); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Lighthouse UI → http://localhost:${PORT}`));
