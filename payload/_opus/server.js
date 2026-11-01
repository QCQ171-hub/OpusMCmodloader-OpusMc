/*
 * OpusMC Mod Loader — Node 本地服务器 / 注入器 / 无边框窗口启动器
 * ------------------------------------------------------------------
 * 零第三方依赖，只用 Node 内置模块。放哪都能跑：node server.js
 *
 * 它做三件事：
 *  1) 去边框：不再经过 Bilibili Toy 外壳(OpusMC.html)，而是把真正的游戏页
 *     OpusMC_files/index.html 当作顶层文档直供，并注入去残留样式。
 *  2) 启动前注入：扫描 <game>/mods 里的模组，按“早段/晚段”锚点把
 *     opus-loader.js 与各模组脚本插进 index.html（内存里改，绝不改磁盘原始文件）。
 *  3) 无边框窗口：自动找一个本机 Edge/Chrome，以 --app 模式开一个无地址栏、
 *     无 Bilibili 边框的独立窗口（比浏览器简洁），并保留本控制台看日志。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');

// ---------- 路径解析：server.js 位于 <game>/_opus/ ----------
const OPUS_DIR = __dirname;                       // .../_opus
const GAME_DIR = path.dirname(OPUS_DIR);           // .../OpusMC-new
const FILES_DIR = path.join(GAME_DIR, 'OpusMC_files');
const MODS_DIR = path.join(GAME_DIR, 'mods');
const CONFIG_FILE = path.join(OPUS_DIR, 'mods.config.json');
const LOADER_URL = '/_opus/opus-loader.js';

function log(...a) { console.log('[OpusMC]', ...a); }
function warn(...a) { console.warn('[OpusMC]', ...a); }

if (!fs.existsSync(FILES_DIR) || !fs.existsSync(path.join(FILES_DIR, 'index.html'))) {
  log('错误：没找到游戏目录 ' + FILES_DIR + '/index.html');
  log('请确认本加载器装在 OpusMC-new/ 内（即 _opus 与 OpusMC_files 同级）。');
  process.exit(1);
}

// ---------- 模组发现与排序 ----------
function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { return null; }
}

function discoverMods() {
  let cfg = readJSON(CONFIG_FILE) || {};
  let overrides = cfg.mods || cfg;             // 兼容两种写法
  const list = [];
  if (!fs.existsSync(MODS_DIR)) {
    warn('mods/ 目录不存在，跳过模组：' + MODS_DIR);
    return list;
  }
  for (const id of fs.readdirSync(MODS_DIR)) {
    const dir = path.join(MODS_DIR, id);
    if (!fs.statSync(dir).isDirectory()) continue;
    let man = readJSON(path.join(dir, 'manifest.json'));
    if (!man) { warn('跳过（无 manifest.json）: ' + id); continue; }
    const ov = overrides[man.id || id] || overrides[id] || {};
    const enabled = (typeof ov.enabled === 'boolean') ? ov.enabled
                  : (typeof man.enabled === 'boolean' ? man.enabled : true);
    if (!enabled) { log('已禁用模组: ' + (man.id || id)); continue; }
    list.push({
      id: man.id || id,
      dirName: id,
      name: man.name || id,
      version: man.version || '0.0.0',
      priority: (typeof ov.priority === 'number') ? ov.priority : (man.priority || 0),
      depends: man.depends || [],
      entry: [].concat(man.entry || 'main.js'),
      config: Object.assign({}, man.config || {}, ov.config || {})
    });
  }
  // 排序：priority 降序，其次 id 升序（依赖仅告警，复杂依赖请自行排 priority）
  list.sort((a, b) => (b.priority - a.priority) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const ids = new Set(list.map(m => m.id));
  for (const m of list) for (const d of m.depends) if (!ids.has(d))
    warn(`模组 ${m.id} 依赖 ${d} 未启用/不存在，可能出现异常`);
  return list;
}

// ---------- 生成注入片段 ----------
function buildInjection(mods) {
  const modsJson = JSON.stringify(mods.map(m => ({ id: m.id, dir: m.dirName, name: m.name, version: m.version, config: m.config })));
  // 早段：loader + 每个模组 begin/脚本
  let early = '';
  // 去边框一致性：隐藏可能残留的 Toy 角标/悬浮件（真正的边框来自外壳，本服务器根本不加载外壳）
  early += `<style id="opus-clean">[class*="toy-watermark"],[id*="toy-watermark"],[class*="toy-badge"],[class*="made-with-toy"],.toy-shell-sidebar,.toy-shell-stage,.toy-rail,#toy-footer,[class*="toy-rail"]{display:none!important;}</style>`;
  early += `<script id="opus-mods-list">window.__OPUS_MODS__=${modsJson};window.__OPUS_CFG__=${JSON.stringify({ cleanChrome: true })};</script>`;
  early += `<script src="${LOADER_URL}"></script>`;
  for (const m of mods) {
    early += `<script>OpusMC.__begin(${JSON.stringify(m.id)})</script>`;
    for (const f of m.entry) early += `<script src="/mods/${m.dirName}/${f}"></script>`;
    early += `<script>OpusMC.__end()</script>`;
  }
  const late = `<script>try{OpusMC.__late()}catch(e){console.error('[OpusMC] __late',e)}</script>`;
  return { early, late };
}

// ---------- 把注入片段插进 index.html ----------
function patchIndexHtml(html, mods) {
  const { early, late } = buildInjection(mods);

  // 早段锚点：放在“数据脚本之后、blocks.js 之前”。
  // 取 blockdata/itemdata/recipedata 里最靠后出现的那个 </script>，在其后插入。
  const dataAnchors = ['recipedata.js', 'itemdata.js', 'blockdata.js'];
  let earlyAt = -1, earlyAnchorName = '';
  for (const a of dataAnchors) {
    const i = html.lastIndexOf(a);
    if (i >= 0) {
      // 找到该脚本标签的结束 </script>
      const end = html.indexOf('</script>', i);
      if (end >= 0 && end + 9 > earlyAt) { earlyAt = end + 9; earlyAnchorName = a; }
    }
  }
  // 校验：确保 blocks.js 在插入点之后（否则时序不对会告警）
  const blocksAt = html.indexOf('blocks.js');
  if (earlyAt < 0) {
    warn('未能定位数据脚本锚点，早段退回到 </head> 或文档开头。');
    const head = html.indexOf('</head>');
    earlyAt = head >= 0 ? head : 0;
  } else if (blocksAt >= 0 && blocksAt < earlyAt) {
    warn(`时序风险：blocks.js(位置${blocksAt}) 在插入点(${earlyAt}) 之前，注册可能不生效。`);
  }
  html = html.slice(0, earlyAt) + '\n' + early + html.slice(earlyAt);

  // 晚段锚点：放在 main.js 的 <script 之前。
  // （早段插入改变了偏移，重新查找）
  const mainAt = html.lastIndexOf('main.js');
  let lateAt;
  if (mainAt >= 0) {
    const scriptStart = html.lastIndexOf('<script', mainAt);
    lateAt = scriptStart >= 0 ? scriptStart : mainAt;
  } else {
    const body = html.lastIndexOf('</body>');
    lateAt = body >= 0 ? body : html.length;
    warn('未找到 main.js，晚段退回到 </body> 之前。');
  }
  html = html.slice(0, lateAt) + late + '\n' + html.slice(lateAt);

  return html;
}

// ---------- MIME ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.glsl': 'text/plain; charset=utf-8', '.vert': 'text/plain; charset=utf-8', '.frag': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.map': 'application/json; charset=utf-8'
};
function mimeOf(urlPath) {
  let p = urlPath.split('?')[0];
  try { p = decodeURIComponent(p); } catch (e) {}   // 先把 %E4%B8%8B%E8%BD%BD 还原成 .下载
  if (p.endsWith('.下载')) p = p.slice(0, -'.下载'.length); // 浏览器另存为的后缀
  const ext = path.extname(p).toLowerCase();
  return MIME[ext] || (ext === '' ? 'application/octet-stream' : 'text/plain; charset=utf-8');
}

// ---------- 安全取路径（防目录穿越） ----------
function safeJoin(root, rel) {
  rel = decodeURIComponent(rel).replace(/\\/g, '/').replace(/^\/+/, '');
  const full = path.normalize(path.join(root, rel));
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

// ---------- 端口探测 ----------
function findFreePort(start, cb) {
  const srv = net.createServer();
  srv.once('error', () => { if (start < 65535) findFreePort(start + 1, cb); else cb(0); });
  srv.once('listening', () => { srv.close(() => cb(start)); });
  srv.listen(start, '127.0.0.1');
}

// ---------- 找浏览器并以 --app 开无边框窗口 ----------
function openAppWindow(url) {
  const cands = [];
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pfx = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local');
  cands.push(
    path.join(pfx, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pfx, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')
  );
  const profile = path.join(os.tmpdir(), 'OpusMC-AppProfile');
  try { fs.mkdirSync(profile, { recursive: true }); } catch (e) {}
  for (const b of cands) {
    if (b && fs.existsSync(b)) {
      const args = ['--new-window', `--app=${url}`, `--user-data-dir=${profile}`,
        '--no-first-run', '--no-default-browser-check'];
      try {
        const child = spawn(b, args, { detached: true, stdio: 'ignore' });
        child.unref();
        log('已用 ' + path.basename(b) + ' 打开无边框应用窗口。');
        return true;
      } catch (e) { warn('打开浏览器失败：' + e.message); }
    }
  }
  return false;
}

// ---------- HTTP 服务器 ----------
function serve(req, res) {
  const u = (req.url || '/').split('?')[0];

  const send = (buf, type) => {
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(buf);
  };
  const notFound = () => { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 ' + u); };
  const fail = (e) => { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('500 ' + e.message); };

  try {
    // 顶层：index.html 与根路径都返回“打过补丁”的游戏页
    if (u === '/' || u === '/index.html' || /index(\.html)?$/.test(u)) {
      let html = fs.readFileSync(path.join(FILES_DIR, 'index.html'), 'utf8');
      const mods = discoverMods();
      html = patchIndexHtml(html, mods);
      return send(Buffer.from(html, 'utf8'), 'text/html; charset=utf-8');
    }
    // 加载器与运行时的静态资源
    if (u.startsWith('/_opus/')) {
      const p = safeJoin(OPUS_DIR, u.slice('/_opus/'.length));
      if (!p || !fs.existsSync(p) || fs.statSync(p).isDirectory()) return notFound();
      return send(fs.readFileSync(p), mimeOf(u));
    }
    // 模组资源
    if (u.startsWith('/mods/')) {
      const p = safeJoin(MODS_DIR, u.slice('/mods/'.length));
      if (!p || !fs.existsSync(p) || fs.statSync(p).isDirectory()) return notFound();
      return send(fs.readFileSync(p), mimeOf(u));
    }
    // 其余：游戏原始资源
    const p = safeJoin(FILES_DIR, u);
    if (!p || !fs.existsSync(p) || fs.statSync(p).isDirectory()) return notFound();
    return send(fs.readFileSync(p), mimeOf(u));
  } catch (e) { return fail(e); }
}

function start(port) {
  const server = http.createServer(serve);
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') { log('端口 ' + port + ' 被占用'); }
    else { log('服务器错误：' + e.message); }
  });
  server.listen(port, '127.0.0.1', () => {
    // 只绑 IPv4 回环；必须用 127.0.0.1 访问（localhost 在部分系统优先解析到 IPv6 ::1 会被拒绝）
    const url = 'http://127.0.0.1:' + port + '/index.html';
    const mods = discoverMods();
    log('————————————————————————————');
    log('游戏服务器已启动 (去边框 + 模组注入)');
    log('入口 URL: ' + url);
    log('启用模组: ' + (mods.length ? mods.map(m => `${m.id}@${m.version}`).join(', ') : '(无)'));
    log('————————————————————————————');
    if (process.env.OPUS_NOWIN === '1') {
      log('OPUS_NOWIN=1，跳过弹出浏览器窗口（仅本地服务/自动化测试用）。');
    } else if (!openAppWindow(url)) {
      log('没找到 Edge/Chrome，请手动在浏览器打开上面的 URL。');
    }
  });
}

findFreePort(Number(process.env.PORT) || 8017, (port) => {
  if (!port) { log('没有可用端口'); process.exit(1); }
  start(port);
});
