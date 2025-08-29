// ==== HDR WebUI main.js — Fast start + correct preselect ====
// 用法：<script type="module" src="scripts/main.js"></script>
import { exec, spawn, toast } from './assets/kernelsu.js';

const MODULE_DIR    = '/data/adb/modules/enable-hdr-oneplus13-webui';
const APP_LIST_XMLS = [
  `${MODULE_DIR}/appList.xml`,   // 你模块的 XML（大写 L）
];
const LOG_PATH      = `${MODULE_DIR}/webui.log`;
const CACHE_PATH    = `${MODULE_DIR}/app_cache.json`; // 应用名称缓存文件
// 移除 LOG_MAX_BYTES，因为每次启动都会清除日志

const $ = (id) => document.getElementById(id);
const listEl   = () => document.getElementById('list') || document.getElementById('applist');
const emptyEl  = () => document.getElementById('empty');
const searchEl = () => document.getElementById('search');
const loadEl   = () => document.getElementById('loading');
const countEl  = () => document.getElementById('count');

// 状态
let APPS = [];             // [{ pkg, name, apk?, labeled:boolean }]
let APP_MAP = new Map();   // pkg -> app
let SELECTED = new Set();  // 预选集合
let FILTER_Q = '';
let NEED_SORT_SELECTED = false; // 是否需要将已选应用排到前面
let LABEL_CACHE = new Map(); // 内存中的应用名称缓存 pkg -> name
let PERSISTENT_CACHE = new Map(); // 从文件读取的持久化缓存 pkg -> {name, timestamp}
let CACHE_DIRTY = false; // 缓存是否有未保存的更改

// —— 工具 & 日志 ——
const isPromise = (x) => !!x && typeof x.then === 'function';
async function runExec(cmd, opts){
  try { const r = exec(cmd, opts); return isPromise(r) ? await r : r; }
  catch(e){ return { errno: 1, stdout: '', stderr: String(e) }; }
}

// ---------- logging ----------
function nowISO(){ try { return new Date().toISOString(); } catch(_) { return ''; } }
function esc(s){ return String(s).replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\n/g,'\\n').replace(/\r/g,'\\r'); }

// 每次启动时清除旧日志
async function clearLogOnStartup(){
  try{
    await runExec(`sh -c 'rm -f "${LOG_PATH}" "${LOG_PATH}.1" 2>/dev/null || true'`);
  }catch(_){}
}

async function fileLog(stage,msg,data){
  try{
    const line = JSON.stringify({ ts: nowISO(), stage: stage||'', msg: msg||'', data: (data===undefined?null:data) });
    // 简化版：直接追加到日志文件，不需要大小检查
    await runExec(`sh -c 'printf "%s\\n" "${esc(line)}" >> "${LOG_PATH}"'`);
  }catch(_){}
}

// ---------- 持久化缓存管理 ----------
// 初始化缓存文件（如果不存在则创建空文件）
async function initCacheFile(){
  try{
    // 检查文件是否存在
    const checkResult = await runExec(`sh -c '[ -f "${CACHE_PATH}" ] && echo "exists" || echo "not_exists"'`);
    const exists = (checkResult.stdout || '').trim() === 'exists';
    
    if (!exists) {
      await fileLog('cache','init-create',{ path: CACHE_PATH });
      
      // 确保目录存在
      await ensureCacheDir();
      
      // 创建空的缓存文件
      const emptyCache = JSON.stringify({}, null, 2);
      const cmd = `sh -c 'cat > "${CACHE_PATH}" << "EOF"
${emptyCache}
EOF
chmod 0644 "${CACHE_PATH}"'`;
      
      const r = await runExec(cmd);
      if (r.errno === 0) {
        await fileLog('cache','init-success',{ path: CACHE_PATH });
      } else {
        await fileLog('cache','init-error',{ errno: r.errno, stderr: r.stderr, path: CACHE_PATH });
      }
    } else {
      await fileLog('cache','init-exists',{ path: CACHE_PATH });
    }
  }catch(e){
    await fileLog('cache','init-exception',{ error: String(e), path: CACHE_PATH });
  }
}

async function loadPersistentCache(){
  try{
    await fileLog('cache','load-start',{ path: CACHE_PATH });
    
    // 首先尝试初始化缓存文件
    await initCacheFile();
    
    const r = await runExec(`sh -c 'cat "${CACHE_PATH}" 2>/dev/null'`);
    const content = (r.stdout || '').trim();
    
    if (!content) {
      await fileLog('cache','load-empty',{ path: CACHE_PATH });
      return;
    }

    // 尝试解析 JSON
    try{
      const cacheData = JSON.parse(content);
      let loadedCount = 0;
      
      // 验证数据格式并加载
      if (cacheData && typeof cacheData === 'object') {
        for (const [pkg, info] of Object.entries(cacheData)) {
          if (info && typeof info === 'object' && info.name && typeof info.name === 'string') {
            PERSISTENT_CACHE.set(pkg, {
              name: info.name,
              timestamp: info.timestamp || Date.now()
            });
            LABEL_CACHE.set(pkg, info.name); // 同时加载到内存缓存
            loadedCount++;
          }
        }
      }
      
      await fileLog('cache','load-success',{ 
        loadedCount, 
        totalEntries: Object.keys(cacheData || {}).length 
      });
      
    }catch(parseError){
      await fileLog('cache','load-parse-error',{ 
        error: String(parseError),
        contentLength: content.length 
      });
      // 解析错误时不抛出异常，继续运行
    }
    
  }catch(readError){
    await fileLog('cache','load-read-error',{ error: String(readError) });
  }
}

// 确保缓存目录存在
async function ensureCacheDir(){
  try{
    // 确保模块目录存在并具有正确权限
    await runExec(`sh -c 'mkdir -p "$(dirname "${CACHE_PATH}")" && chmod 755 "$(dirname "${CACHE_PATH}")"'`);
    return true;
  }catch(e){
    await fileLog('cache','ensure-dir-error',{ error: String(e) });
    return false;
  }
}

// 保存缓存到文件
async function savePersistentCache(){
  if (!CACHE_DIRTY) return; // 没有更改则不保存
  
  try{
    await fileLog('cache','save-start',{ cacheSize: PERSISTENT_CACHE.size });
    
    // 确保目录存在
    const dirReady = await ensureCacheDir();
    if (!dirReady) {
      await fileLog('cache','save-abort','Directory not ready');
      return;
    }
    
    // 构建保存对象
    const cacheData = {};
    for (const [pkg, info] of PERSISTENT_CACHE.entries()) {
      cacheData[pkg] = {
        name: info.name,
        timestamp: info.timestamp || Date.now()
      };
    }
    
    // 生成 JSON 内容
    const jsonContent = JSON.stringify(cacheData, null, 2);
    const tempFile = `${CACHE_PATH}.tmp`;
    
    // 写入临时文件，然后原子性地移动到目标位置
    const cmd = `sh -c 'cat > "${tempFile}" << "EOF"
${jsonContent}
EOF
if [ $? -eq 0 ]; then
  mv "${tempFile}" "${CACHE_PATH}" && chmod 0644 "${CACHE_PATH}"
else
  rm -f "${tempFile}" 2>/dev/null || true
  exit 1
fi'`;

    const r = await runExec(cmd);
    
    if (r.errno === 0) {
      CACHE_DIRTY = false; // 标记为已保存
      await fileLog('cache','save-success',{ 
        entriesCount: Object.keys(cacheData).length,
        fileSize: jsonContent.length,
        filePath: CACHE_PATH
      });
    } else {
      await fileLog('cache','save-error',{ 
        errno: r.errno, 
        stderr: r.stderr,
        filePath: CACHE_PATH
      });
    }
    
  }catch(saveError){
    await fileLog('cache','save-exception',{ error: String(saveError) });
  }
}

// 添加或更新缓存条目
function updateCache(pkg, name) {
  if (!pkg || !name) return;
  
  const existing = PERSISTENT_CACHE.get(pkg);
  const now = Date.now();
  
  // 如果名称发生变化，更新缓存
  if (!existing || existing.name !== name) {
    PERSISTENT_CACHE.set(pkg, {
      name: name,
      timestamp: now
    });
    LABEL_CACHE.set(pkg, name); // 同步到内存缓存
    CACHE_DIRTY = true; // 标记缓存需要保存
    
    // 立即更新UI中的显示
    const row = document.querySelector(`.card[data-pkg="${pkg}"]`);
    if (row) {
      const nameEl = row.querySelector('.name');
      if (nameEl && nameEl.textContent !== name) {
        nameEl.textContent = name;
      }
    }
  }
}

// 批量更新缓存
function batchUpdateCache(updates) {
  let changeCount = 0;
  for (const [pkg, name] of updates.entries()) {
    if (pkg && name) {
      const existing = PERSISTENT_CACHE.get(pkg);
      if (!existing || existing.name !== name) {
        updateCache(pkg, name);
        changeCount++;
      }
    }
  }
  
  if (changeCount > 0) {
    // 延迟保存，避免频繁写入
    setTimeout(() => savePersistentCache(), 2000);
  }
}

// 清理缓存中不存在的应用
async function cleanupCache() {
  if (PERSISTENT_CACHE.size === 0) return;
  
  const currentPkgs = new Set(APPS.map(app => app.pkg));
  const cacheKeys = Array.from(PERSISTENT_CACHE.keys());
  let removedCount = 0;
  
  for (const pkg of cacheKeys) {
    if (!currentPkgs.has(pkg)) {
      PERSISTENT_CACHE.delete(pkg);
      LABEL_CACHE.delete(pkg);
      removedCount++;
      CACHE_DIRTY = true;
    }
  }
  
  if (removedCount > 0) {
    await fileLog('cache','cleanup',{ removedCount, remainingCount: PERSISTENT_CACHE.size });
    await savePersistentCache();
  }
}

// 页面退出时保存缓存
function setupCacheAutoSave() {
  // 页面卸载前保存
  window.addEventListener('beforeunload', () => {
    if (CACHE_DIRTY) {
      // 使用 sendBeacon 进行最后的保存尝试
      try {
        savePersistentCache();
      } catch(_) {}
    }
  });
  
  // 页面隐藏时保存
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && CACHE_DIRTY) {
      savePersistentCache();
    }
  });
  
  // 定期保存（每5分钟）
  setInterval(() => {
    if (CACHE_DIRTY) {
      savePersistentCache();
    }
  }, 5 * 60 * 1000);
}
function showLoading(show){ const el=loadEl(); if(el) el.style.display = show?'':'none'; }
function setCount(sel,total){ 
  const el=countEl(); 
  if(el) {
    if (sel === 0) {
      el.style.display = 'none';
    } else {
      el.style.display = 'inline-block';
      el.textContent = `${sel} / ${total}`;
    }
  }
}

// 菜单交互逻辑
async function setupMenuInteractions() {
  await fileLog('menu','function-start');
  
  const menuToggle = document.getElementById('menuToggle');
  const menuDropdown = document.getElementById('menuDropdown');
  
  await fileLog('menu','elements-check',{ 
    menuToggle: !!menuToggle, 
    menuDropdown: !!menuDropdown 
  });
  
  if (!menuToggle || !menuDropdown) {
    await fileLog('menu','elements-missing');
    return;
  }
  
  // 简化的切换函数
  function toggleMenu(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    
    const isShown = menuDropdown.classList.contains('show');
    
    if (isShown) {
      menuDropdown.classList.remove('show');
    } else {
      menuDropdown.classList.add('show');
    }
  }
  
  // 隐藏菜单
  function hideMenu() {
    menuDropdown.classList.remove('show');
  }
  
  // 绑定菜单按钮事件
  await fileLog('menu','binding-toggle');
  
  menuToggle.onclick = function(e) {
    toggleMenu(e);
  };
  
  // 查找菜单项
  const menuItems = menuDropdown.querySelectorAll('.menu-item');
  await fileLog('menu','found-items',{ count: menuItems.length });
  
  // 绑定菜单项事件
  menuItems.forEach((item, index) => {
    item.onclick = function() {
      setTimeout(hideMenu, 150);
    };
  });
  
  // 简化的外部点击处理
  document.addEventListener('click', function(e) {
    if (!menuToggle.contains(e.target) && !menuDropdown.contains(e.target)) {
      hideMenu();
    }
  });
  
  await fileLog('menu','setup-complete');
}

// ---------- 已选读取/保存 ----------
async function loadSelectedFromXml(){
  const found = new Set();
  
  await fileLog('loadSelected','start',{ paths: APP_LIST_XMLS });

  // 读取文件内容
  for (const p of APP_LIST_XMLS){
    const r = await runExec(`sh -c 'cat "${p}" 2>/dev/null'`);
    const s = (r.stdout||'').trim();
    
    await fileLog('loadSelected','read-file',{ path: p, hasContent: !!s, contentLength: s.length });
    
    if (!s) continue;

    // 直接逐行读取，不使用 XML 解析器
    try{
      const lines = s.split('\n');
      let foundInFile = 0;
      
      for (const line of lines) {
        const trimmedLine = line.trim();
        
        // 跳过空行和注释行（以 <!-- 开头的行）
        if (!trimmedLine || trimmedLine.startsWith('<!--')) {
          continue;
        }
        
        // 匹配你的格式：<application name="包名"></application>
        const appMatch = trimmedLine.match(/<application\s+name="([^"]+)"\s*><\/application>/);
        if (appMatch && appMatch[1]) {
          const pkg = appMatch[1].trim();
          if (pkg) {
            found.add(pkg);
            foundInFile++;
          }
          continue;
        }
        
        // 兼容旧格式：<app package="包名"/>
        const legacyMatch = trimmedLine.match(/<app\s+package="([^"]+)"\s*\/?\s*>/);
        if (legacyMatch && legacyMatch[1]) {
          const pkg = legacyMatch[1].trim();
          if (pkg) {
            found.add(pkg);
            foundInFile++;
          }
          continue;
        }
        
        // 如果这行看起来像是配置行但没有匹配，记录一下
        if (trimmedLine.includes('application') || trimmedLine.includes('app')) {
          await fileLog('loadSelected','unmatched-line',{ line: trimmedLine });
        }
      }
      
      await fileLog('loadSelected','line-parsed',{ path: p, foundInFile, totalFound: found.size });
      
    }catch(e){
      await fileLog('loadSelected','line-parse-error',{ path: p, error: String(e) });
    }
  }

  SELECTED = found;
  await fileLog('loadSelected','complete',{ totalSelected: SELECTED.size, selectedApps: Array.from(SELECTED) });
}

async function saveSelected() {
  const pkgs = Array.from(SELECTED);
  
  // --- 开始：旧逻辑，保存到 appList.xml (维持原样) ---
  let existingContentOld = '';
  let existingLinesOld = [];
  let commentedAppsOld = new Set();
  
  try {
    const r = await runExec(`sh -c 'cat "${MODULE_DIR}/appList.xml" 2>/dev/null'`);
    existingContentOld = r.stdout || '';
    existingLinesOld = existingContentOld.split('\n');
    
    for (const line of existingLinesOld) {
      const trimmedLine = line.trim();
      if (trimmedLine.startsWith('<!--') && trimmedLine.includes('-->')) {
        const appMatch = trimmedLine.match(/<!--\s*<application\s+name="([^"]+)"\s*><\/application>\s*-->/);
        if (appMatch && appMatch[1]) {
          commentedAppsOld.add(appMatch[1]);
        }
      }
    }
  } catch (e) {
    console.error('Error reading old appList.xml:', e);
  }
  
  const newLinesOld = [];
  for (const pkg of pkgs) {
    newLinesOld.push(`<application name="${pkg}"></application>`);
  }
  for (const commentedPkg of commentedAppsOld) {
    if (!pkgs.includes(commentedPkg)) {
      newLinesOld.push(`<!--<application name="${commentedPkg}"></application>-->`);
    }
  }
  
  const payloadOld = newLinesOld.join('\n') + (newLinesOld.length > 0 ? '\n' : '');
  const targetOld = `${MODULE_DIR}/appList.xml`;
  const tmpOld = `${targetOld}.tmp`;
  
  const cmdOld =
    `sh -c 'cat > "${tmpOld}" << "EOF"\n${payloadOld}EOF\n` +
    `mv "${tmpOld}" "${targetOld}" && chmod 0644 "${targetOld}"'`;
  
  await runExec(cmdOld);
  // --- 结束：旧逻辑 ---
  

// --- 开始：新逻辑，保存到 appList_new.xml (新增) ---
let existingContentNew = '';
let existingLinesNew = [];
let commentedAppsNew = new Set(); 

try {
  const r = await runExec(`sh -c 'cat "${MODULE_DIR}/appList_new.xml" 2>/dev/null'`);
  existingContentNew = r.stdout || '';
  existingLinesNew = existingContentNew.split('\n');

  for (const line of existingLinesNew) {
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith('<!--') && trimmedLine.includes('-->')) {
      // 修改正则表达式，更准确地匹配 <app>包名</app> 格式
      const appMatch = trimmedLine.match(/<!--\s*<app>([^<]+)<\/app>\s*-->/);
      if (appMatch && appMatch[1]) {
        commentedAppsNew.add(appMatch[1].trim());
      }
    }
    // 同时也要匹配非注释的 <app>包名</app> 行
    else if (trimmedLine.startsWith('<app>') && trimmedLine.includes('</app>')) {
      const appMatch = trimmedLine.match(/<app>([^<]+)<\/app>/);
      if (appMatch && appMatch[1]) {
        // 将这些包名也添加到注释集合中，因为我们要重新生成所有内容
        commentedAppsNew.add(appMatch[1].trim());
      }
    }
  }
} catch (e) {
  console.error('Error reading new appList_new.xml:', e);
}

const newLinesNew = [];
for (const pkg of pkgs) {
  newLinesNew.push(`<app>${pkg}</app>`);
}
for (const commentedPkg of commentedAppsNew) {
  if (!pkgs.includes(commentedPkg)) {
    newLinesNew.push(`<!--<app>${commentedPkg}</app>-->`);
  }
}

const payloadNew = newLinesNew.join('\n') + (newLinesNew.length > 0 ? '\n' : '');
const targetNew = `${MODULE_DIR}/appList_new.xml`;
const tmpNew = `${targetNew}.tmp`;

const cmdNew =
  `sh -c 'cat > "${tmpNew}" << "EOF"\n${payloadNew}EOF\n` +
  `mv "${tmpNew}" "${targetNew}" && chmod 0644 "${targetNew}"'`;
  
const rNew = await runExec(cmdNew);
  // --- 结束：新逻辑 ---


  // --- 统一的日志和 UI 反馈 ---
  // 这里可以只用新文件的保存结果来决定是否成功
  await fileLog('save','result',{
    errno: rNew.errno,
    selectedCount: pkgs.length,
    commentedCount: commentedAppsOld.size + commentedAppsNew.size,
    format: 'dual-file'
  });
  
  if (rNew.errno === 0) {
    toast('保存完成，请重启手机以套用更变');
    NEED_SORT_SELECTED = true;
    render(APPS);
  } else {
    toast('保存失败');
    await fileLog('save','error',{ stderr: rNew.stderr });
  }
}

// ---------- ABI & aapt 检测（仅在真的需要时才调用） ----------
let AAPT_PATH = '';
async function detectAbi(){
  const r = await runExec(`getprop ro.product.cpu.abilist || getprop ro.product.cpu.abi`);
  const s = (r.stdout||'').toLowerCase();
  if (s.includes('arm64')) return 'arm64-v8a';
  if (s.includes('armeabi-v7a')) return 'armeabi-v7a';
  return 'arm64-v8a';
}
async function ensureAapt(){
  if (AAPT_PATH) return AAPT_PATH;
  const abi = await detectAbi();
  const cand = `${MODULE_DIR}/bin/${abi}/aapt`;
  await runExec(`sh -c '[ -f "${cand}" ] && chmod 0755 "${cand}" || true'`);
  const ok = await runExec(`sh -c '[ -x "${cand}" ] && echo ok || echo no'`);
  if ((ok.stdout||'').trim()==='ok'){ AAPT_PATH = cand; }
  else {
    const r2 = await runExec(`sh -c 'which aapt 2>/dev/null || which aapt2 2>/dev/null || true'`);
    AAPT_PATH = (r2.stdout||'').trim().split('\n')[0] || '';
  }
  await fileLog('aapt','detect',{ path: AAPT_PATH || null });
  return AAPT_PATH;
}

// ---------- 列包（首屏"快"）：只拿包名，先渲染，再懒加载名称 ——
async function listPackagesFast(){
  const cmds = [
    'pm list packages -3',
    'cmd package list packages -3',
    '/system/bin/pm list packages -3',
    '/system/bin/cmd package list packages -3',
  ];
  for (const c of cmds){
    const r = await runExec(c);
    await fileLog('pm','run',{ cmd:c, errno:r.errno, len:(r.stdout||'').length });
    if (r.errno===0 && r.stdout){
      return r.stdout.split('\n').map(s=>s.replace(/^package:/,'').trim()).filter(Boolean);
    }
  }
  return [];
}

// ---------- 快速通道拿应用名（不阻塞 UI） ——
function fastLabelByAPI(pkg){
  // 优先检查持久化缓存
  if (PERSISTENT_CACHE.has(pkg)) {
    const cached = PERSISTENT_CACHE.get(pkg);
    LABEL_CACHE.set(pkg, cached.name); // 同步到内存缓存
    return cached.name;
  }
  
  // 再检查内存缓存
  if (LABEL_CACHE.has(pkg)) {
    return LABEL_CACHE.get(pkg);
  }
  
  let label = null;
  
  try{
    if (typeof window.ksu?.getPackagesInfo === 'function'){
      const info = JSON.parse(window.ksu.getPackagesInfo(`[${pkg}]`));
      if (info?.[0]?.appLabel) {
        label = String(info[0].appLabel);
      }
    }
  }catch{}
  
  if (!label) {
    try{
      if (typeof window.$packageManager !== 'undefined'){
        const ai = window.$packageManager.getApplicationInfo(pkg, 0, 0);
        const labelResult = ai?.getLabel?.();
        if (labelResult) {
          label = String(labelResult);
        }
      }
    }catch{}
  }
  
  // 如果获取到标签，更新缓存
  if (label) {
    updateCache(pkg, label);
  }
  
  return label;
}

// 批量获取应用信息
async function batchGetLabels(pkgs) {
  const results = new Map();
  const toFetch = [];
  
  // 先从缓存中获取已有的标签
  for (const pkg of pkgs) {
    if (PERSISTENT_CACHE.has(pkg)) {
      const cached = PERSISTENT_CACHE.get(pkg);
      results.set(pkg, cached.name);
      LABEL_CACHE.set(pkg, cached.name); // 同步到内存
    } else if (LABEL_CACHE.has(pkg)) {
      results.set(pkg, LABEL_CACHE.get(pkg));
    } else {
      toFetch.push(pkg);
    }
  }
  
  // 只为未缓存的包获取标签
  if (toFetch.length > 0) {
    try {
      if (typeof window.ksu?.getPackagesInfo === 'function' && toFetch.length > 1) {
        const pkgArray = JSON.stringify(toFetch);
        const infos = JSON.parse(window.ksu.getPackagesInfo(pkgArray));
        if (Array.isArray(infos)) {
          const cacheUpdates = new Map();
          infos.forEach((info, index) => {
            if (info?.appLabel && toFetch[index]) {
              const label = String(info.appLabel);
              results.set(toFetch[index], label);
              cacheUpdates.set(toFetch[index], label);
            }
          });
          
          // 批量更新缓存
          if (cacheUpdates.size > 0) {
            batchUpdateCache(cacheUpdates);
          }
        }
      }
    } catch(e) {
      // 失败时逐个尝试快速API
      for (const pkg of toFetch) {
        const label = fastLabelByAPI(pkg);
        if (label) {
          results.set(pkg, label);
        }
      }
    }
  }
  
  return results;
}

// ---------- 慢通道（只对出现在视口的项尝试）：pm path → aapt → dumpsys —— 
async function getApkPath(pkg){
  const r = await runExec(`sh -c 'pm path "${pkg}" | grep -m 1 "base.apk" | cut -d: -f2'`);
  return (r.stdout||'').trim();
}
async function labelByAapt(pkg){
  const apk = await getApkPath(pkg);
  if (!apk) return '';
  const aapt = await ensureAapt();
  if (!aapt) return '';
  const r = await runExec(`sh -c '${aapt} dump badging "${apk}" 2>/dev/null | grep -m 1 "application-label"'`);
  if (r.errno===0 && r.stdout) {
    const label = parseAaptLabel(r.stdout);
    if (label) {
      updateCache(pkg, label); // 更新缓存
    }
    return label;
  }
  return '';
}

async function labelByDump(pkg){
  const tries = [ `dumpsys package "${pkg}"`, `pm dump "${pkg}"` ];
  for (const cmd of tries){
    const r = await runExec(cmd);
    if (r.errno===0 && r.stdout){
      let m = r.stdout.match(/application-label:\s*(.*)/);
      if (m && m[1]) {
        const label = m[1].trim();
        updateCache(pkg, label); // 更新缓存
        return label;
      }
      m = r.stdout.match(/label=([^\n]+)/);
      if (m && m[1]) {
        const label = m[1].trim();
        updateCache(pkg, label); // 更新缓存
        return label;
      }
    }
  }
  return '';
}

// 解析 aapt 输出的应用标签
function parseAaptLabel(output) {
  const match = output.match(/application-label:'([^']+)'/);
  return match ? match[1] : '';
}

// ---------- 快速首屏 + 并发补齐 ----------
const LABEL_QUEUE = [];
const LABEL_DONE  = new Set();
let   LABEL_RUNNING = 0;
const LABEL_CONCURRENCY = 8; // 增加并发数到8

async function labelWorker(){
  if (LABEL_RUNNING >= LABEL_CONCURRENCY) return;
  LABEL_RUNNING++;
  try{
    while (LABEL_QUEUE.length){
      const app = LABEL_QUEUE.shift();
      if (!app || app.labeled) continue;

      // 首先检查缓存（持久化和内存）
      let label = null;
      if (PERSISTENT_CACHE.has(app.pkg)) {
        const cached = PERSISTENT_CACHE.get(app.pkg);
        label = cached.name;
        LABEL_CACHE.set(app.pkg, label); // 同步到内存缓存
      } else if (LABEL_CACHE.has(app.pkg)) {
        label = LABEL_CACHE.get(app.pkg);
      }

      // 如果缓存中没有，尝试获取
      if (!label) {
        // 快速通道先试（一般足够快）
        label = fastLabelByAPI(app.pkg);

        // 慢通道只在必要时使用
        if (!label) label = await labelByAapt(app.pkg);
        if (!label) label = await labelByDump(app.pkg);
      }

      if (label && label !== app.name){
        app.name = label;
        app.labeled = true;
        const row = document.querySelector(`.card[data-pkg="${app.pkg}"]`);
        if (row){
          const nameEl = row.querySelector('.name');
          if (nameEl) nameEl.textContent = label;
        }
        
        // 如果标签是新获取的（不是从缓存来的），更新缓存
        if (!PERSISTENT_CACHE.has(app.pkg) || PERSISTENT_CACHE.get(app.pkg).name !== label) {
          updateCache(app.pkg, label);
        }
      }
      await fileLog('label','update',{ pkg: app.pkg, got: !!label, fromCache: PERSISTENT_CACHE.has(app.pkg) });
    }
  } finally {
    LABEL_RUNNING--;
  }
}

// 定义 runLabelWorkers 函数
function runLabelWorkers(){
  // 这个函数会启动多个 worker 来并发处理所有未标记的应用
  while (LABEL_QUEUE.length > 0 && LABEL_RUNNING < LABEL_CONCURRENCY) {
    labelWorker();
  }
}

// ---------- 渲染 & 懒加载名称（IntersectionObserver） ——
let OBSERVER = null; // 初始化 OBSERVER 变量
OBSERVER = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) {
      const pkg = e.target.getAttribute('data-pkg');
      const app = APP_MAP.get(pkg);
      if (app && !app.labeled) {
        LABEL_QUEUE.push(app);
        runLabelWorkers();
      }
    }
  }
}, { root: null, rootMargin: '100px', threshold: 0 });

// 渲染应用列表
function render(apps){
  const L = listEl(); if (!L) return;
  L.innerHTML = '';
  const tpl = document.getElementById('card');

  // 智能排序：只在需要时将已选应用排到前面
  let sortedApps = [...apps];
  if (NEED_SORT_SELECTED) {
    sortedApps = apps.sort((a, b) => {
      if (SELECTED.has(a.pkg) && !SELECTED.has(b.pkg)) return -1;
      if (!SELECTED.has(a.pkg) && SELECTED.has(b.pkg)) return 1;
      return 0;
    });
    // 排序完成后重置标志
    NEED_SORT_SELECTED = false;
  }

  // 注销旧 observer
  if (OBSERVER){ try{ OBSERVER.disconnect(); }catch(_){ } }
  
  // 为每个应用项绑定 IntersectionObserver
  for (const app of sortedApps){
    let node;
    if (tpl && tpl.content && tpl.content.firstElementChild){
      node = tpl.content.firstElementChild.cloneNode(true);
    } else {
      node = document.createElement('div');
      node.className = 'card';
      node.innerHTML = `
        <input type="checkbox" class="checkbox" />
        <div class="info">
          <div class="name"></div>
          <div class="pkg"></div>
        </div>`;
    }
    node.setAttribute('data-pkg', app.pkg);

    const nameEl = node.querySelector('.name');
    const pkgEl  = node.querySelector('.pkg');
    const cb     = node.querySelector('.checkbox');

    if (nameEl) nameEl.textContent = app.name || app.pkg;
    if (pkgEl)  pkgEl.textContent  = app.pkg;

    if (cb){
      cb.checked = SELECTED.has(app.pkg);  // 预勾选 ✅
      cb.onchange = () => {
        if (cb.checked) {
          SELECTED.add(app.pkg);
        } else {
          SELECTED.delete(app.pkg);
        }
        setCount(SELECTED.size, APPS.length);
        // 注意：这里不重新排序，只有保存和重新加载时才排序
      };
    }

    L.appendChild(node);
    // 观察进入视口后再补齐真实名称
    OBSERVER.observe(node);
  }

  setCount(SELECTED.size, APPS.length);
}

// ---------- 过滤 ---------- 
function applyFilter(){
  const q = (searchEl()?.value || '').trim().toLowerCase();
  FILTER_Q = q;
  if (!q) return render(APPS);
  const filtered = APPS.filter(a =>
    (a.pkg||'').toLowerCase().includes(q) ||
    (a.name||'').toLowerCase().includes(q)
  );
  render(filtered);
}

// ---------- 初始化 ---------- 
async function init(){
  // 每次启动时清除旧日志
  await clearLogOnStartup();
  
  await fileLog('init','start',{ ua:(navigator?.userAgent)||'', url:(location?.href)||'' });
  showLoading(true);
  try{
    // 1) 先加载持久化缓存
    await loadPersistentCache();

    // 2) 读取预勾选（XML）
    await loadSelectedFromXml();

    // 3) 秒拿包名并渲染（标题优先用缓存，否则用包名尾段）
    const pkgs = await listPackagesFast();
    APPS = pkgs.map(pkg => {
      let name;
      if (PERSISTENT_CACHE.has(pkg)) {
        // 优先使用缓存中的名称
        name = PERSISTENT_CACHE.get(pkg).name;
        LABEL_CACHE.set(pkg, name); // 同步到内存缓存
        return { pkg, name, labeled: true }; // 标记为已标记
      } else {
        // 否则使用包名尾段
        const tail = pkg.split('.').pop() || pkg;
        name = tail.charAt(0).toUpperCase() + tail.slice(1);
        return { pkg, name, labeled: false };
      }
    });

    // 更新应用映射
    APPS.forEach(app => APP_MAP.set(app.pkg, app));
    
    // 4) 重新加载时需要排序
    NEED_SORT_SELECTED = true;
    
    // 5) 对于未缓存的应用，尝试批量获取前50个的名称
    const unlabeledApps = APPS.filter(app => !app.labeled);
    const firstBatch = unlabeledApps.slice(0, 50);
    if (firstBatch.length > 0) {
      const batchLabels = await batchGetLabels(firstBatch.map(a => a.pkg));
      
      // 应用批量获取的结果
      firstBatch.forEach(app => {
        if (batchLabels.has(app.pkg)) {
          app.name = batchLabels.get(app.pkg);
          app.labeled = true;
        }
      });
    }
    
    // 6) 渲染列表（此时 SELECTED 已经包含了从 XML 读取的数据）
    render(APPS);

    // 7) 立即设置菜单交互（最高优先级）
    await fileLog('menu','setup-start');
    try {
      await setupMenuInteractions();
      await fileLog('menu','setup-success');
    } catch(e) {
      await fileLog('menu','setup-error',{ error: String(e) });
    }

    // 8) 延迟处理剩余未标记的应用（低优先级）
    setTimeout(() => {
      const remaining = APPS.filter(app => !app.labeled);
      if (remaining.length > 0) {
        LABEL_QUEUE.push(...remaining);
        runLabelWorkers();
      }
    }, 500); // 延迟500ms，让菜单优先设置
    
    // 8) 对于前100个应用中未缓存的，立即尝试快速API
    setTimeout(async () => {
      const quickBatch = APPS.slice(0, 100).filter(app => !app.labeled);
      const cacheUpdates = new Map();
      
      for (const app of quickBatch) {
        const label = fastLabelByAPI(app.pkg);
        if (label && label !== app.name) {
          app.name = label;
          app.labeled = true;
          cacheUpdates.set(app.pkg, label);
          
          // 立即更新UI
          const row = document.querySelector(`.card[data-pkg="${app.pkg}"]`);
          if (row) {
            const nameEl = row.querySelector('.name');
            if (nameEl) nameEl.textContent = label;
          }
        }
      }
      
      // 批量更新缓存
      if (cacheUpdates.size > 0) {
        batchUpdateCache(cacheUpdates);
      }
      
    }, 500); // 500ms后开始快速标记，确保菜单优先设置
    
    const cachedCount = APPS.filter(app => app.labeled).length;
    await fileLog('init','first-render',{ 
      count: APPS.length, 
      preselected: SELECTED.size, 
      cachedCount: cachedCount,
      uncachedCount: APPS.length - cachedCount
    });
    
    // 9) 设置缓存自动保存和清理
    setupCacheAutoSave();
    
    // 10) 清理缓存中不存在的应用（延迟执行，避免阻塞UI）
    setTimeout(() => cleanupCache(), 5000);
    
  }catch(e){
    await fileLog('init','error',{ error: String(e) });
  }finally{
    showLoading(false);
    await fileLog('init','complete');
  }

  
  // 事件绑定
  const s = searchEl(); 
  if (s) {
    s.addEventListener('input', applyFilter);
  }
  
  const r = $('reload'); 
  if (r) {
    const reloadHandler = async () => {
      NEED_SORT_SELECTED = true; // 重新加载时需要排序
      await init();
    };
    r.addEventListener('click', reloadHandler);
  }
  
  const sa = $('selectAll'); 
  if (sa) {
    const selectAllHandler = () => { 
      APPS.forEach(a=>SELECTED.add(a.pkg)); 
      applyFilter(); 
    };
    sa.addEventListener('click', selectAllHandler);
  }
  
  const da = $('deselectAll'); 
  if (da) {
    const deselectAllHandler = () => { 
      SELECTED.clear(); 
      applyFilter(); 
    };
    da.addEventListener('click', deselectAllHandler);
  }
  
  const sv = $('save'); 
  if (sv) {
    const saveHandler = async () => {
      await saveSelected();
    };
    sv.addEventListener('click', saveHandler);
  }
}


document.addEventListener('DOMContentLoaded', () => { init(); });
