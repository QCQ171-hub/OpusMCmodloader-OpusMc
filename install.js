/*
 * OpusMC 模组加载器 —— 安装器（由 install.bat 调用；也可单独 node install.js 运行）
 * ------------------------------------------------------------------
 * 设计：所有中文提示与文件操作都放在 Node 里（UTF-8 无歧义），
 *       install.bat 只是纯 ASCII 薄壳，避免 cmd + chcp 65001 解析多字节时炸裂。
 *
 * 用法：把整个 OpusModLoader 文件夹拖进【OpusMC-原版】(去边框原版) 内，
 *       再双击 OpusModLoader\install.bat。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const SELFDIR  = path.resolve(__dirname);          // ...\OpusModLoader
const PARENT   = path.dirname(SELFDIR);             // 期望 = 游戏目录
const PAYLOAD  = path.join(SELFDIR, 'payload');

function log(...a){ console.log(...a); }
function isGameDir(d){
  try { return d && fs.existsSync(path.join(d, 'OpusMC_files', 'index.html')); }
  catch (e) { return false; }
}

log('===========================================');
log('  OpusMC 模组加载器  一键安装程序');
log('===========================================');
log('');

// ---------- 定位游戏目录 ----------
let GAME = null, why = '';
if (isGameDir(PARENT)) { GAME = PARENT; why = '父目录'; }
else if (isGameDir(SELFDIR)) { GAME = SELFDIR; why = '当前目录'; }
else if (process.argv[2] && isGameDir(path.resolve(process.argv[2]))) { GAME = path.resolve(process.argv[2]); why = '命令行参数'; }

if (!GAME) {
  log('[错误] 没找到游戏目录（需含 OpusMC_files\\index.html）。');
  log('');
  log('正确用法：');
  log('  1) 打开“OpusMC-原版”文件夹（内含 OpusMC_files 与 server.js）。');
  log('  2) 把整个“OpusModLoader”文件夹拖进“OpusMC-原版”里面。');
  log('     拖完后应为： OpusMC-原版\\OpusModLoader\\install.bat');
  log('  3) 双击这个 install.bat。');
  log('');
  log('  （也支持命令行指定： node install.js "D:\\路径\\OpusMC-原版"）');
  log('');
  process.exitCode = 1;
  throw new Error('未找到游戏目录');
}
log('[OK] 目标游戏目录（' + why + '）：' + GAME);
log('');

if (!fs.existsSync(PAYLOAD)) {
  throw new Error('安装数据缺失：' + PAYLOAD + '（OpusModLoader 文件夹不完整）');
}

// ---------- 复制 _opus 运行时（总是覆盖更新） ----------
function copyDir(src, dst, { overwrite = true } = {}) {
  fs.mkdirSync(dst, { recursive: true });
  let count = 0;
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) { count += copyDir(s, d, { overwrite }); }
    else {
      if (!overwrite && fs.existsSync(d)) continue;
      fs.copyFileSync(s, d); count++;
    }
  }
  return count;
}

log('正在安装加载器运行时 (_opus) ...');
const nOpus = copyDir(path.join(PAYLOAD, '_opus'), path.join(GAME, '_opus'), { overwrite: true });
log('  · 已写入 _opus 内 ' + nOpus + ' 个文件');

log('正在安装示例模组 (mods) ...');
const srcMods = path.join(PAYLOAD, 'mods');
const dstMods = path.join(GAME, 'mods');
fs.mkdirSync(dstMods, { recursive: true });
if (fs.existsSync(srcMods)) {
  for (const m of fs.readdirSync(srcMods, { withFileTypes: true })) {
    if (!m.isDirectory()) continue;
    const target = path.join(dstMods, m.name);
    if (fs.existsSync(target)) { log('  · 已存在模组 ' + m.name + '，跳过'); continue; }
    copyDir(path.join(srcMods, m.name), target, { overwrite: true });
    log('  · 已安装模组 ' + m.name);
  }
}

// ---------- 复制开发文档到 _opus（OpusModLoader 自删后仍能保留可读副本） ----------
const readmeSrc = path.join(SELFDIR, 'README.md');
if (fs.existsSync(readmeSrc)) {
  fs.copyFileSync(readmeSrc, path.join(GAME, '_opus', 'README.md'));
  log('正在安装开发文档 (_opus\\README.md) ...');
}

// ---------- 生成启动器（纯 ASCII 内容，避免中文代码页问题） ----------
log('正在生成启动器 (启动OpusMC-模组版.bat) ...');
const LAUNCHER_BAT = [
  '@echo off',
  'chcp 65001 >nul',
  'title OpusMC Modded - local server',
  'cd /d "%~dp0"',
  'where node >nul 2>nul || (echo [OpusMC] Node.js not found. Install from https://nodejs.org & echo. & pause & exit /b 1)',
  'echo [OpusMC] Starting modded OpusMC (borderless + mods). Browser URL uses 127.0.0.1.',
  'echo [OpusMC] Closing this console window stops the server.',
  'echo.',
  'node "%~dp0_opus\\server.js"',
  'echo.',
  'echo [OpusMC] Server exited.',
  'pause',
  ''
].join('\r\n');
fs.writeFileSync(path.join(GAME, '启动OpusMC-模组版.bat'), LAUNCHER_BAT, 'utf8');

// ---------- 生成卸载脚本（纯 ASCII） ----------
log('正在生成卸载脚本 (卸载模组加载器.bat) ...');
const UNINSTALL_BAT = [
  '@echo off',
  'chcp 65001 >nul',
  'title OpusMC Uninstall loader',
  'set "_t=%~dp0"',
  'echo This will remove _opus folder and the modded launcher.',
  'echo The mods folder is kept. Press any key to continue, or close this window to cancel.',
  'pause >nul',
  'rmdir /s /q "%_t%_opus"',
  'del /q "%_t%OpusMC-*.bat"',
  'echo Uninstalled.',
  'pause',
  ''
].join('\r\n');
// 卸载脚本文件名也用 ASCII 更稳，但为可读性保留中文名；内容里用 ASCII。
fs.writeFileSync(path.join(GAME, '卸载模组加载器.bat'), UNINSTALL_BAT, 'utf8');

log('');
log('===========================================');
log('  安装完成！');
log('  启动模组版：双击  ' + path.join(GAME, '启动OpusMC-模组版.bat'));
log('  放模组：    把模组文件夹丢进  ' + path.join(GAME, 'mods') + '\\');
log('  开发文档：  ' + path.join(GAME, '_opus', 'README.md') + '  （安装目录 OpusModLoader 自删后仍在）');
log('  速查：      mods\\example-mod\\main.js 顶部注释');
log('  浏览器手动访问请用 http://127.0.0.1:8017/index.html （不要用 localhost，会被拒绝连接）。');
log('');
log('  本 OpusModLoader 安装目录将在几秒后自动删除（不影响已装好的 _opus/mods/启动器）。');
log('===========================================');
log('');

// ---------- 自删除 OpusModLoader（把 cwd 移出，spawn 一条 detached cmd 延迟 rd） ----------
try { process.chdir(os.tmpdir()); } catch (e) {}
const cleanup = 'ping 127.0.0.1 -n 4 >nul & rd /s /q "' + SELFDIR + '"';
try {
  const child = spawn('cmd.exe', ['/c', cleanup], { detached: true, stdio: 'ignore' });
  child.unref();
  log('[OK] 已安排删除：' + SELFDIR);
} catch (e) {
  log('[警告] 自动删除失败，可手动删掉：' + SELFDIR + '  (' + e.message + ')');
}
log('');
