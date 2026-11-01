/*
 * OpusMC Mod Loader — 浏览器端运行时 (opus-loader.js)
 * ------------------------------------------------------------------
 * 注入时机（由 server.js 决定，务必理解，否则注册会失效）：
 *   早段 EARLY：在 recipedata.js 之后、blocks.js 之前加载本文件与各模组。
 *     —— 此时 self.BLOCK_DATA / ITEM_DATA / RECIPE_DATA / window.ASSETS 已就绪，
 *        但 blocks.js 尚未把它们建成查找表，所以“注册方块/物品/配方/贴图别名”
 *        必须发生在这里：push 进数组 / 写 ASSETS.tiles / 写 RECIPE_DATA 子数组即可被采纳。
 *   晚段 LATE ：在 main.js（bootstrap）之前调用 OpusMC.__late()。
 *     —— 此时所有脚本（含 game.js 里的 Game 类、cmdrun.js 的 cmdExec 全局函数）都已加载，
 *        可以安全地改写 Game.prototype、wrap cmdExec 插入模组命令、
 *        重绘 ASSETS.strip 引入自定义贴图 —— 满足“允许模组开发者修改所有 JS”。
 *
 * 设计哲学：不改写任何原始文件、不删脚本，全部在内存里动态注入；
 *           模组想“破坏”也只影响本次会话，禁用即恢复，可移植且不影响游戏本体。
 *
 * 公开 API 全览（详见 README.md）：
 *   OpusMC.on/off/emit                  事件总线（生命周期钩子）
 *   OpusMC.afterLoad(fn)                加载后改写入口（Game 已就绪、可 wrap prototype）
 *   OpusMC.wrap / override / g          通用改写工具
 *   OpusMC.registerBlock / Item / BlockItem / editBlock / removeBlock / hasBlock / hasItem
 *   OpusMC.getBlock / getItem / getBlockById / getBlockDef / nextBlockId
 *   OpusMC.registerRecipe (路由) / registerCraftingRecipe / registerShapedRecipe /
 *   registerShapelessRecipe / registerCookingRecipe / registerSmeltingRecipe /
 *   registerBlastingRecipe / registerSmokingRecipe / registerCampfireRecipe /
 *   registerStonecuttingRecipe / addTag / hasTag / getTag
 *   OpusMC.aliasTexture / registerTexture / hasTexture / texIndex / texName
 *   OpusMC.registerCommand / listCommands / unregisterCommand
 *   OpusMC.registerCreativeTab / listCreativeTabs
 *   OpusMC.modUrl / modSelf / mods / version / data / stats / list
 *   常量：OpusMC.MAX_BLOCK_ID=4095  OpusMC.START_ITEM_ID=10000  OpusMC.START_TEX_INDEX=2650
 */
(function () {
  'use strict';

  var G = (typeof window !== 'undefined') ? window : self;
  if (G.OpusMC && G.OpusMC.__loaded) { return; }   // 幂等，防重复注入

  // ---------- 全局词法桥（关键） ----------
  // 引擎的 game.js/render.js/entity.js 等用的是「顶层 class / const」声明，
  // 例如 `class Game{}`、`class Renderer{}`、`class Living{}`、`const ITEMS=[]`、
  // `const BLOCKS=[]`、`const ITEM_KEY={}`。这些是“全局词法绑定”，
  // 在普通 <script> 里【不会】成为 window 属性，所以 `window.Game` 是 undefined。
  // 但所有普通脚本共享同一“全局词法作用域”，用【间接 eval】在全局作用域求值，
  // 就能读到这些绑定。据此把它们“挂回 window”，让加载器自身的 G.Game、
  // 以及模组里的 win.Game / win.ITEMS 都能正常拿到。
  function resolveGlobal(name) {
    if (Object.prototype.hasOwnProperty.call(G, name)) return G[name]; // 已是 window 属性（如 cmdExec / self.BLOCK_DATA）
    try { return (0, eval)(name); } catch (e) { return undefined; }    // 顶层 class/const/let → 全局词法作用域
  }
  // 需要桥接的引擎全局候选名（不存在则自动跳过，不影响运行）
  var _ENGINE_GLOBALS = [
    'Game', 'Renderer', 'Living', 'Entity', 'Player',
    'ITEMS', 'BLOCKS', 'ITEM_KEY', 'BLOCK_KEY',
    'BLOCK_DATA', 'BLOCK_TAGS', 'ITEM_DATA', 'RECIPE_DATA'
  ];
  function bridgeEngineGlobals() {
    for (var i = 0; i < _ENGINE_GLOBALS.length; i++) {
      var n = _ENGINE_GLOBALS[i];
      if (G[n] !== undefined) continue;           // window 已有就不覆盖（引擎数据用 self.X 的那批本就在）
      var v = resolveGlobal(n);
      if (v !== undefined) { try { G[n] = v; } catch (_) {} }
    }
  }

  // ---------- 数据数组的“活动引用”（缺失则补空数组，保证不报错） ----------
  self.BLOCK_DATA  = self.BLOCK_DATA  || [];
  self.ITEM_DATA   = self.ITEM_DATA   || [];
  // 引擎里 RECIPE_DATA 是对象 { tags:{}, crafting:[], cooking:[], stonecutting:[], smithing:[], special:{}, enchantments:[] }
  if (!self.RECIPE_DATA || Array.isArray(self.RECIPE_DATA)) {
    self.RECIPE_DATA = { tags: {}, crafting: [], cooking: [], stonecutting: [], smithing: [], special: {}, enchantments: [] };
  }
  // ASSETS 在 assets.js 之后就已就绪（我们注入点更晚）
  G.ASSETS = G.ASSETS || { tiles: {}, cols: 64, count: 2650, strip: '' };
  G.ASSETS.tiles = G.ASSETS.tiles || {};

  // ---------- 公开对象 ----------
  var O = {};
  O.__loaded = true;
  O.version  = '1.1.1';
  O.MAX_BLOCK_ID   = 4095;   // 引擎 MAX_BLOCKS=4096
  O.START_ITEM_ID  = 10000;  // 模组物品 id 起始（避开原版）
  O.START_TEX_INDEX = 2650;  // 模组贴图 index 起始（避开原版图集已用区）
  O.data = {
    blocks:  self.BLOCK_DATA,
    items:   self.ITEM_DATA,
    recipes: self.RECIPE_DATA
  };

  // ---------- 内部簿记 ----------
  var _hooks    = {};          // event -> [fn]
  var _lateFns  = [];          // afterLoad 队列（__late 里跑）
  var _modStack = [];          // 当前正在加载的模组上下文（__begin/__end 栈）
  var _nextBlockId = 0;        // 方块 id 分配器（__early 里初始化）
  var _nextItemId  = O.START_ITEM_ID;   // 模组物品 id 分配器
  var _nextTexIdx  = O.START_TEX_INDEX; // 模组贴图 index 分配器
  var _records  = [];          // 所有由模组新增的数据条目（供 list() 调试导出）
  var _texQueue = [];          // 待晚段绘制的自定义贴图 {name, src, idx}
  var _texUsedSet = null;      // 原版 tiles 值集合（判重用）
  var _modCmds  = {};          // name -> {fn, usage, desc, mod}
  var _tabs     = [];          // 创造栏登记
  var _itemToBlocks = {};      // itemId -> [blockId,...] 由 registerBlockItem 建立

  function activeMod() { return _modStack[_modStack.length - 1] || null; }

  // =================================================================
  //                       事件总线 / 生命周期
  // =================================================================
  O.on = function (evt, fn) {
    (_hooks[evt] || (_hooks[evt] = [])).push(fn);
    return function () { O.off(evt, fn); };
  };
  O.off = function (evt, fn) {
    var a = _hooks[evt]; if (!a) return;
    var i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
  };
  O.emit = function (evt, ctx) {
    var a = _hooks[evt]; if (!a) return;
    for (var i = 0; i < a.length; i++) {
      try { a[i](ctx, O); }
      catch (e) { console.error('[OpusMC] 钩子 "' + evt + '" 出错：', e); }
    }
  };

  O.afterLoad = function (fn) { if (typeof fn === 'function') _lateFns.push(fn); };

  // =================================================================
  //                       通用改写：修改所有 JS
  // =================================================================
  // 用法: OpusMC.wrap(Game.prototype, 'tick', function(orig, args, self){ ... return orig.apply(self, args); })
  // 返回一个 undo() 函数，调用即恢复原方法。
  O.wrap = function (target, method, wrapper) {
    if (!target || typeof target[method] !== 'function') {
      throw new Error('OpusMC.wrap: 目标方法不存在或不是函数 -> ' + method);
    }
    var orig = target[method];
    var patched = function () { return wrapper.call(this, orig, arguments, this); };
    patched.__opus_orig = orig;
    patched.__opus_wrapped = true;
    target[method] = patched;
    return function undo() { target[method] = orig; };
  };
  O.override = function (target, method, fn) {
    return O.wrap(target, method, function () { return fn.apply(this, arguments); });
  };
  O.g = function (name) { return resolveGlobal(name); };
  O.resolve = resolveGlobal;   // 安全读取任意引擎全局（含顶层 class/const 词法绑定）

  // =================================================================
  //                       方块 API
  // =================================================================
  function recomputeMaxId() {
    var m = 0;
    for (var i = 0; i < self.BLOCK_DATA.length; i++) {
      var id = self.BLOCK_DATA[i].id;
      if (typeof id === 'number' && id > m) m = id;
    }
    return m;
  }
  O.nextBlockId = function () {
    var id = ++_nextBlockId;
    if (id > O.MAX_BLOCK_ID) throw new Error('OpusMC: 方块 id 已超出 ' + O.MAX_BLOCK_ID);
    return id;
  };

  function findBlock(key) {
    for (var i = 0; i < self.BLOCK_DATA.length; i++) if (self.BLOCK_DATA[i].key === key) return self.BLOCK_DATA[i];
    return null;
  }
  O.getBlock = findBlock;
  O.getBlockById = function (id) {
    for (var i = 0; i < self.BLOCK_DATA.length; i++) if (self.BLOCK_DATA[i].id === id) return self.BLOCK_DATA[i];
    return null;
  };
  O.hasBlock = function (key) { return !!findBlock(key); };

  /**
   * 注册方块。def（可选字段用 ★）：
   *   key            必填，唯一英文键（例："opus_crystal"）
   *   cn             中文显示名（缺省=key）
   *   id             引擎方块 id，缺省自动分配（2090+ 到 4095）
   *   hardness       破坏硬度（默认 1.0；0=瞬间）
   *   sound          音效组名（"stone","wood","grass","metal","glass","sand","snow","limestone"…；引擎缺失时回退）
   *   tool           推荐工具：'pickaxe'|'axe'|'shovel'|'hoe'|null（null=徒手）
   *   needsTool      是否必须用对应工具才掉落（默认 false）
   *   ★level         工具等级门槛（1=木 2=石 3=铁 4=钻 5=下界合金），配合 needsTool 使用
   *   ★light         发光强度 0~15（默认 0）
   *   ★fuel          作为熔炉燃料的烧炼值（秒数；例如木板=15，煤炭=80）
   *   ★slip          滑动系数（默认 0.6，冰≈0.98）
   *   ★damage        踩上去的伤害（半心为单位）
   *   ★climbable     可攀爬（梯子类）
   *   ★replaceable   可被右键放置替换（草丛类）
   *   ★tint          颜色标识：'grass'|'foliage'|'#RRGGBB'
   *   ★drops         破坏掉落物（详见下方 drops 说明）
   *   ★xp            破坏经验值
   *   ★axis          原木类：按轴朝向
   *   ★leaves        树叶类：cutout + 易燃 + 自带落叶表
   *   ★translucent   半透明（玻璃类）
   *   ★cutout        镂空贴图（有 alpha 通道，无光照混合）
   *   ★nonsolid      非实体（可穿过）
   *   ★noitem        不给它自动创建同名物品
   *   ★states        变体状态数组 [{prop:val,...}, ...]（进阶）
   *   ★kind          'cube' | 'model' | 'entity' | 'none'（默认 'cube'）
   *   ★model         kind='model' 时的模型函数名或字符串标识（进阶）
   *   ★multipart     kind='model' 时的部件数组（进阶）
   *   tex            ★ 六面贴图名。三种写法：
   *                    'gold_block'                       // 六面同
   *                    [top, bottom, east, west, south, north]   // 数组（顶/底/东西南北）
   *                    { top:'grass_block_top', side:'grass_block_side' }  // 对象
   *                  贴图名必须在 ASSETS.tiles 中；用 aliasTexture/registerTexture 可获得自定义名
   *   particle       破坏粒子贴图名（缺省用顶面）
   *   extra          一个自由对象，直接 Object.assign 进条目（用于兜底未列字段）
   * 返回：新加入 BLOCK_DATA 的对象本体。
   */
  O.registerBlock = function (def) {
    if (!def || !def.key) throw new Error('registerBlock: 需要 def.key');
    if (findBlock(def.key)) throw new Error('registerBlock: 方块已存在 ' + def.key);
    var b = {
      key: def.key,
      hardness: def.hardness != null ? def.hardness : 1.0,
      sound: def.sound || 'stone',
      tool: def.tool != null ? def.tool : null,
      needsTool: !!def.needsTool,
      id: def.id != null ? def.id : O.nextBlockId(),
      cn: def.cn || def.key,
      kind: def.kind || 'cube',
      tex: normalizeTex(def.tex != null ? def.tex : def.key),
      modelTint: !!def.modelTint,
      particle: def.particle || firstOfTex(def.tex, def.key)
    };
    // 常见可选字段：只在给了值时才写入，保持条目紧凑
    var opt = ['level','light','fuel','slip','damage','climbable','replaceable','tint','xp',
               'axis','leaves','translucent','cutout','nonsolid','noitem','states','model',
               'multipart','ores','drop','door','slab','stairs','wall','fence','gate','carpet',
               'bed','pane','trapdoor','ladder','auto','be','plant','log','flame'];
    for (var i = 0; i < opt.length; i++) { var k = opt[i]; if (def[k] !== undefined) b[k] = def[k]; }
    if (def.extra) Object.assign(b, def.extra);
    self.BLOCK_DATA.push(b);
    _records.push({ type: 'block', key: b.key, id: b.id, mod: (activeMod() && activeMod().id) || null });
    return b;
  };

  /** 修改一个已存在的方块条目（对原版方块也生效，仅本会话）。 */
  O.editBlock = function (keyOrId, patch) {
    var b = (typeof keyOrId === 'number') ? O.getBlockById(keyOrId) : findBlock(keyOrId);
    if (!b) throw new Error('editBlock: 找不到方块 ' + keyOrId);
    Object.assign(b, patch || {});
    return b;
  };
  /** 从 BLOCK_DATA 中移除一个方块条目（对原版方块也生效，仅本会话）。 */
  O.removeBlock = function (keyOrId) {
    var i = -1;
    for (var j = 0; j < self.BLOCK_DATA.length; j++) {
      var b = self.BLOCK_DATA[j];
      if (typeof keyOrId === 'number' ? b.id === keyOrId : b.key === keyOrId) { i = j; break; }
    }
    if (i < 0) return null;
    var removed = self.BLOCK_DATA.splice(i, 1)[0];
    _records.push({ type: 'removeBlock', key: removed.key, mod: (activeMod() && activeMod().id) || null });
    return removed;
  };

  // =================================================================
  //                       物品 API
  // =================================================================
  function findItem(key) {
    for (var i = 0; i < self.ITEM_DATA.length; i++) if (self.ITEM_DATA[i].key === key) return self.ITEM_DATA[i];
    return null;
  }
  O.getItem = findItem;
  O.hasItem = function (key) { return !!findItem(key); };

  /**
   * 注册一个纯物品（不会放置方块）。def：
   *   key ★ id(可选，缺省自动分配 10000+) ★ stack(64) ★ cn ★ tab(创造栏分类)
   *   ★ dur 耐久  ★ atk 攻击力  ★ aspd 攻击速度  ★ food [饱食, 隐藏回复]
   *   ★ ench  enchantability  ★ rep 修补材料键  ★ rar 稀有度  ★ glint 常驻附魔光泽
   *   ★ tex 物品贴图名（若未定义，引擎会尝试 `i_<key>`）——若用自定义贴图名，须先 registerTexture
   *   ★ places 若希望该物品被右键能放置某方块，填方块 key
   *   ★ spawnEgg 生成蛋的目标实体键（可选）
   *   ★ extra 兜底字段
   */
  O.registerItem = function (def) {
    if (!def || !def.key) throw new Error('registerItem: 需要 def.key');
    if (findItem(def.key)) throw new Error('registerItem: 物品已存在 ' + def.key);
    var it = {
      key: def.key,
      stack: def.stack != null ? def.stack : 64,
      tab: def.tab || 'ingredients',
      cn: def.cn || def.key,
      id: def.id != null ? def.id : _nextItemId++
    };
    var opt = ['dur','atk','aspd','food','ench','rep','rar','glint','tex','places','spawnEgg','fuel'];
    for (var i = 0; i < opt.length; i++) { var k = opt[i]; if (def[k] !== undefined) it[k] = def[k]; }
    if (def.extra) Object.assign(it, def.extra);
    self.ITEM_DATA.push(it);
    _records.push({ type: 'item', key: it.key, id: it.id, mod: (activeMod() && activeMod().id) || null });
    return it;
  };

  /**
   * 一步注册“可放置方块的物品 + 方块本体”。
   *   blockDef：见 registerBlock
   *   opt：{ tab, stack, cn }（物品显示名默认沿用 blockDef.cn）
   */
  O.registerBlockItem = function (blockDef, opt) {
    opt = opt || {};
    var b = O.registerBlock(blockDef);
    var it = O.registerItem({
      key: blockDef.key,
      cn: opt.cn || blockDef.cn || blockDef.key,
      tab: opt.tab || 'building_blocks',
      stack: opt.stack != null ? opt.stack : 64,
      places: blockDef.key,           // 关键：让同名物品右键放置该方块
      tex: blockDef.tex && !Array.isArray(blockDef.tex) ? blockDef.tex : blockDef.key // 物品图标沿用顶面贴图名（可选）
    });
    _itemToBlocks[it.id] = [b.id];
    return { block: b, item: it };
  };

  // =================================================================
  //                       配方 API
  // =================================================================
  // RECIPE_DATA 元组约定：
  //   crafting 条目：
  //     ["s", <result>, <count>, <pattern:["##"," #"]>, <keyMap:{"#":"stone"}>]
  //     ["l", <result>, <count>, <ingredients:["stick","stone"]>]
  //     材料里以 # 开头表示引用 tags 里的标签名。
  //   cooking 条目：[<method>, <input>, <output>, <xp>, <cookTicks>]
  //     method 取 "smelting" | "blasting" | "smoking" | "campfire_cooking"
  //   stonecutting 条目：[<input>, <output>, <count>]
  //   tags: { <tag_name>: ["item1","item2"] }（引用时用 "#<tag_name>"）

  O.registerRecipe = function (def) {
    if (!def) throw new Error('registerRecipe: 需要 def');
    var t = def.type || def.kind;
    if (t === 'cooking' || t === 'smelting' || t === 'blasting' || t === 'smoking' || t === 'campfire_cooking')
      return O.registerCookingRecipe(def);
    if (t === 'stonecutting') return O.registerStonecuttingRecipe(def);
    if (t === 'shapeless') return O.registerShapelessRecipe(def);
    if (t === 'shaped') return O.registerShapedRecipe(def);
    if (def.pattern) return O.registerShapedRecipe(def);
    if (def.ingredients) return O.registerShapelessRecipe(def);
    throw new Error('registerRecipe: 未识别的配方（请提供 type=shaped/shapeless/cooking/smelting/.../stonecutting，或直接给 pattern/ingredients）');
  };

  O.registerShapedRecipe = function (def) {
    if (!def || !def.result || !def.pattern || !def.key) throw new Error('registerShapedRecipe: 需要 result/pattern/key');
    var tuple = ['s', def.result, def.count != null ? def.count : 1, def.pattern.slice(), Object.assign({}, def.key)];
    self.RECIPE_DATA.crafting.push(tuple);
    _records.push({ type: 'recipe', shape: 'shaped', result: def.result, mod: (activeMod() && activeMod().id) || null });
    return tuple;
  };
  O.registerShapelessRecipe = function (def) {
    if (!def || !def.result || !def.ingredients) throw new Error('registerShapelessRecipe: 需要 result/ingredients');
    var tuple = ['l', def.result, def.count != null ? def.count : 1, def.ingredients.slice()];
    self.RECIPE_DATA.crafting.push(tuple);
    _records.push({ type: 'recipe', shape: 'shapeless', result: def.result, mod: (activeMod() && activeMod().id) || null });
    return tuple;
  };
  O.registerCraftingRecipe = function (def) {
    if (!def) throw new Error('registerCraftingRecipe: 需要 def');
    if (def.pattern) return O.registerShapedRecipe(def);
    return O.registerShapelessRecipe(def);
  };
  O.registerCookingRecipe = function (def) {
    if (!def || !def.input || !def.output) throw new Error('registerCookingRecipe: 需要 input/output');
    var tuple = [def.method || 'smelting', def.input, def.output, def.xp != null ? def.xp : 0.1, def.cookTime != null ? def.cookTime : 200];
    self.RECIPE_DATA.cooking.push(tuple);
    _records.push({ type: 'recipe', shape: 'cooking', method: tuple[0], result: def.output, mod: (activeMod() && activeMod().id) || null });
    return tuple;
  };
  O.registerSmeltingRecipe = function (def) { return O.registerCookingRecipe(Object.assign({ method: 'smelting' }, def || {})); };
  O.registerBlastingRecipe = function (def) { return O.registerCookingRecipe(Object.assign({ method: 'blasting' }, def || {})); };
  O.registerSmokingRecipe  = function (def) { return O.registerCookingRecipe(Object.assign({ method: 'smoking'  }, def || {})); };
  O.registerCampfireRecipe = function (def) { return O.registerCookingRecipe(Object.assign({ method: 'campfire_cooking' }, def || {})); };

  O.registerStonecuttingRecipe = function (def) {
    if (!def || !def.input || !def.output) throw new Error('registerStonecuttingRecipe: 需要 input/output');
    var tuple = [def.input, def.output, def.count != null ? def.count : 1];
    self.RECIPE_DATA.stonecutting.push(tuple);
    _records.push({ type: 'recipe', shape: 'stonecutting', result: def.output, mod: (activeMod() && activeMod().id) || null });
    return tuple;
  };

  O.addTag = function (name, items) {
    if (!name || !Array.isArray(items)) throw new Error('addTag: 需要 name 与 items 数组');
    var T = self.RECIPE_DATA.tags;
    T[name] = T[name] || [];
    for (var i = 0; i < items.length; i++) if (T[name].indexOf(items[i]) < 0) T[name].push(items[i]);
    _records.push({ type: 'tag', name: name, added: items.slice(), mod: (activeMod() && activeMod().id) || null });
    return T[name];
  };
  O.hasTag = function (name) { return !!self.RECIPE_DATA.tags[name]; };
  O.getTag = function (name) { return self.RECIPE_DATA.tags[name] || null; };

  // =================================================================
  //                       贴图 API
  // =================================================================
  function texUsedSet() {
    if (_texUsedSet) return _texUsedSet;
    var s = {}; var tiles = G.ASSETS.tiles;
    for (var k in tiles) s[tiles[k]] = 1;
    _texUsedSet = s; return s;
  }
  /** 把已存在的一张贴图起个别名（不复制像素，只加名字索引）。返回 index。 */
  O.aliasTexture = function (newName, existingName) {
    if (!newName || !existingName) throw new Error('aliasTexture: 需要 newName/existingName');
    var tiles = G.ASSETS.tiles;
    if (tiles[newName] !== undefined) return tiles[newName];
    var src = tiles[existingName];
    if (src === undefined) { console.warn('[OpusMC] aliasTexture: 找不到源贴图 ' + existingName + '，回退到 white'); src = tiles.white || 0; }
    tiles[newName] = src;
    _records.push({ type: 'texture', name: newName, aliasOf: existingName, mod: (activeMod() && activeMod().id) || null });
    return src;
  };

  /**
   * 注册一张全新的贴图。早段立刻分配一个未用的 index 到 ASSETS.tiles[name]（这样 blocks.js 中 T(name) 能查到），
   * 晚段再异步把 src 图重绘进 ASSETS.strip 精灵图集对应格。
   *   name    贴图键（后续 registerBlock({tex:name}) 用）
   *   src     Image URL（推荐 OpusMC.modUrl('assets/foo.png')）；也可以是 HTMLImageElement / Canvas
   *   opts    { clear:bool 未加载失败时的回退；aliasOnFail:'tileName' }
   * 返回：分配到的 index（数字）。
   */
  O.registerTexture = function (name, src, opts) {
    if (!name) throw new Error('registerTexture: 需要 name');
    var tiles = G.ASSETS.tiles;
    if (tiles[name] !== undefined) {
      console.warn('[OpusMC] registerTexture: 贴图名已存在 ' + name + '，改用 alias');
      return tiles[name];
    }
    var idx;
    var used = texUsedSet();
    if (G.ASSETS.count > O.START_TEX_INDEX) {
      // 之前有过模组贴图：从当前 count 往后追加
      idx = G.ASSETS.count;
      G.ASSETS.count = idx + 1;
    } else {
      // 第一次：从 START_TEX_INDEX=2650 起，找到未用槽位
      idx = O.START_TEX_INDEX;
      while (used[idx] !== undefined) idx++;
      G.ASSETS.count = Math.max(G.ASSETS.count, idx + 1);
    }
    tiles[name] = idx;
    _nextTexIdx = idx + 1;
    _texQueue.push({ name: name, src: src, idx: idx, opts: opts || {} });
    _records.push({ type: 'texture', name: name, index: idx, queued: true, mod: (activeMod() && activeMod().id) || null });
    return idx;
  };

  O.hasTexture = function (name) { return G.ASSETS.tiles[name] !== undefined; };
  O.texIndex = function (name) { return G.ASSETS.tiles[name]; };
  O.texName = function (idx) {
    var t = G.ASSETS.tiles;
    for (var k in t) if (t[k] === idx) return k;
    return null;
  };

  /**
   * 晚段：把 _texQueue 里所有自定义贴图重绘进 strip。
   * 步骤：加载当前 strip → 加载所有 src → 新建更大 canvas → 复制原图 → 把新 tile 画到对应 idx 位置
   *       → ASSETS.strip = canvas.toDataURL('image/png')
   * 关键：必须早于 render.js 的 init()。我们挂在 Renderer.init 前的 wrap 上。
   */
  function flushTextures(cb) {
    if (!_texQueue.length) { cb && cb(); return; }
    var jobs = _texQueue.slice(); _texQueue.length = 0;
    var cols = G.ASSETS.cols || 64;
    var total = G.ASSETS.count;
    var rowsNeeded = Math.ceil(total / cols);
    var img = new Image();
    img.onload = function () {
      try {
        var cv = document.createElement('canvas');
        cv.width = cols * 16; cv.height = rowsNeeded * 16;
        var cx = cv.getContext('2d');
        cx.imageSmoothingEnabled = false;
        cx.drawImage(img, 0, 0);
        var pending = jobs.length, done = function () {
          if (--pending !== 0) return;
          try { G.ASSETS.strip = cv.toDataURL('image/png'); console.log('[OpusMC] 已注入自定义贴图 ' + jobs.length + ' 张'); }
          catch (e) { console.error('[OpusMC] strip.toDataURL 失败：', e); }
          cb && cb();
        };
        jobs.forEach(function (j) {
          function paint(srcImg) {
            var x0 = (j.idx % cols) * 16, y0 = Math.floor(j.idx / cols) * 16;
            try { cx.drawImage(srcImg, x0, y0, 16, 16); } catch (e) { console.error('[OpusMC] 贴图绘制失败 ' + j.name, e); }
            done();
          }
          if (j.src && typeof j.src === 'object' && (j.src.width || j.src.naturalWidth)) { paint(j.src); return; }
          var im = new Image();
          im.crossOrigin = 'anonymous';
          im.onload = function () { paint(im); };
          im.onerror = function () {
            console.warn('[OpusMC] 贴图加载失败: ' + j.name + ' <- ' + j.src);
            // 可选回退：alias 到某个已有 tile
            var fb = j.opts && j.opts.aliasOnFail;
            if (fb && G.ASSETS.tiles[fb] !== undefined) G.ASSETS.tiles[j.name] = G.ASSETS.tiles[fb];
            done();
          };
          im.src = (typeof j.src === 'string') ? j.src : '';
        });
      } catch (e) { console.error('[OpusMC] strip 重绘异常：', e); cb && cb(); }
    };
    img.onerror = function () { console.error('[OpusMC] 无法读取引擎图集 ASSETS.strip，自定义贴图未注入'); cb && cb(); };
    img.src = G.ASSETS.strip;
  }

  // =================================================================
  //                       命令 API（斜杠命令 / 一堆语句）
  // =================================================================
  // 引擎的 cmdrun.js 里顶层 `function cmdExec(g,text,src)` → window.cmdExec 是可 wrap 的。
  // 命令表 CMD_RUN 是 const 拿不到，但 wrap cmdExec 就能拦截未识别的模组命令名。
  /**
   * 注册一个模组斜杠命令。
   *   name           命令名（不带 /）
   *   def.fn         执行函数 fn(ctx, args, g)；ctx 与原版命令一致（含 g,pos,rot,entity,name,say）
   *   def.usage      用法提示（显示在帮助）
   *   def.description 描述
   */
  O.registerCommand = function (name, def) {
    if (!name) throw new Error('registerCommand: 需要 name');
    name = String(name).toLowerCase().replace(/^minecraft:/, '');
    if (typeof def === 'function') def = { fn: def };
    if (!def || typeof def.fn !== 'function') throw new Error('registerCommand: 需要 def.fn');
    _modCmds[name] = {
      fn: def.fn, usage: def.usage || '/'+name, description: def.description || '',
      mod: activeMod() ? activeMod().id : null
    };
    _records.push({ type: 'command', key: name, mod: activeMod() && activeMod().id });
  };
  O.unregisterCommand = function (name) { delete _modCmds[String(name).toLowerCase()]; };
  O.listCommands = function () {
    var r = []; for (var k in _modCmds) r.push({ name: k, usage: _modCmds[k].usage, description: _modCmds[k].description, mod: _modCmds[k].mod });
    return r;
  };

  function makeCmdCtx(g, src) {
    var p = g && g.player;
    if (src) {
      return {
        g: g, pos: (src.pos ? src.pos.slice() : (p ? p.pos.slice() : [0,64,0])),
        rot: src.rot ? src.rot.slice() : [0,0], entity: src.entity || p, name: src.name || 'server',
        say: function (m) { try { src.say(String(m), true); } catch (e) { console.log(m); } }
      };
    }
    return {
      g: g, pos: (p && p.pos) ? p.pos.slice() : [0,64,0],
      rot: p ? [p.yaw || 0, p.pitch || 0] : [0,0], entity: p, name: (g && g.playerName) || '玩家',
      say: function (m, color) {
        try { if (g && g.ui && g.ui.message) g.ui.message(String(m), color || '#AAAAAA'); else console.log(m); }
        catch (e) { console.log(m); }
      }
    };
  }

  function installCommandHook() {
    var names = Object.keys(_modCmds);
    if (!names.length) return;
    if (typeof G.cmdExec !== 'function') { console.warn('[OpusMC] 未找到 window.cmdExec，模组命令不可用'); return; }
    if (G.cmdExec.__opusHooked) return;
    var hook = O.wrap(G, 'cmdExec', function (orig, args, selfRef) {
      var g = args[0], text = args[1], src = args[2];
      if (typeof text !== 'string') return orig.apply(selfRef, args);
      var t = (src && text[0] !== '/') ? ('/' + text) : text;
      if (t[0] !== '/') return orig.apply(selfRef, args);
      var rest = t.slice(1).trim();
      var sp = rest.search(/\s/);
      var cmdName = (sp < 0 ? rest : rest.slice(0, sp)).toLowerCase().replace(/^minecraft:/, '');
      var a = (sp < 0 ? [] : rest.slice(sp + 1).trim().split(/\s+/).filter(Boolean));
      var mc = _modCmds[cmdName];
      if (!mc) return orig.apply(selfRef, args);
      var ctx = makeCmdCtx(g, src);
      try { mc.fn(ctx, a, g); return true; }
      catch (e) { console.error('[OpusMC] 命令 /' + cmdName + ' 出错：', e); try { ctx.say('[模组命令错误] ' + e.message, '#FF5555'); } catch (x) {} return true; }
    });
    G.cmdExec.__opusHooked = true;
    G.cmdExec.__opusUndo = hook;
    console.log('[OpusMC] 已注册模组命令: ' + names.map(function(n){return '/'+n;}).join(', '));
  }

  // =================================================================
  //                       创造栏
  // =================================================================
  O.registerCreativeTab = function (def) {
    if (!def || !def.key) throw new Error('registerCreativeTab: 需要 def.key');
    _tabs.push(def);
    O.emit('creative-tab', def);
    _records.push({ type: 'creativeTab', key: def.key, mod: activeMod() && activeMod().id });
    return def;
  };
  O.listCreativeTabs = function () { return _tabs.slice(); };

  // =================================================================
  //                       模组资源 / 上下文
  // =================================================================
  /**
   * 返回模组自身资源文件的 URL（相对模组目录）。例如：
   *   OpusMC.modUrl('assets/foo.png')   → '/mods/<currentModDir>/assets/foo.png'
   * 服务器已经把 /mods/<dir>/** 静态服务；模组可以把 PNG/JSON/音频等文件放到自己目录下。
   */
  O.modUrl = function (rel) {
    var m = activeMod();
    if (!m) throw new Error('modUrl: 不在任何模组上下文内');
    var dir = m.dir || m.id;
    rel = String(rel || '').replace(/^\.?\//, '');
    return '/mods/' + encodeURIComponent(dir) + '/' + rel;
  };
  O.self = null;   // 每个模组脚本运行时切到对应上下文
  O.mods = [];     // 启用模组列表（由 server 注入的 __OPUS_MODS__ 同步过来）

  // =================================================================
  //                       调试 / 统计
  // =================================================================
  O.list = function () { return _records.slice(); };
  O.stats = function () {
    return {
      blocks:  self.BLOCK_DATA.length,
      items:   self.ITEM_DATA.length,
      recipes: {
        crafting: (self.RECIPE_DATA.crafting || []).length,
        cooking:  (self.RECIPE_DATA.cooking  || []).length,
        stonecutting: (self.RECIPE_DATA.stonecutting || []).length,
        tags:     Object.keys(self.RECIPE_DATA.tags || {}).length
      },
      modCmds: Object.keys(_modCmds).length,
      modTextures: _texQueue.length + (_records.filter(function(r){return r.type==='texture'&&r.index!==undefined;}).length),
      added: _records.length,
      maxBlockId: _nextBlockId,
      nextItemId: _nextItemId,
      nextTexIdx: _nextTexIdx
    };
  };

  // =================================================================
  //                       内部辅助
  // =================================================================
  function normalizeTex(tex) {
    if (tex == null) return null;
    if (typeof tex === 'string') return [tex, tex, tex, tex, tex, tex];
    if (Array.isArray(tex)) { var a = tex.slice(); while (a.length < 6) a.push(a[0]); return a.slice(0, 6); }
    if (typeof tex === 'object') {
      // { top, bottom, side } 或 { top, bottom, east, west, south, north }
      var top = tex.top || tex.up || tex.side || 'white';
      var bot = tex.bottom || tex.down || tex.side || top;
      var e = tex.east  || tex.side || top;
      var w = tex.west  || tex.side || top;
      var s = tex.south || tex.side || top;
      var n = tex.north || tex.side || top;
      return [top, bot, e, w, s, n];
    }
    return null;
  }
  function firstOfTex(tex, fallback) {
    if (!tex) return fallback;
    if (typeof tex === 'string') return tex;
    if (Array.isArray(tex)) return tex[0] || fallback;
    if (typeof tex === 'object') return tex.top || tex.side || fallback;
    return fallback;
  }

  // =================================================================
  //                       模组上下文（server 在每个模组脚本前用 OpusMC.__begin(id) 切换）
  // =================================================================
  G.OpusMC = O;            // 先暴露，供内联 __begin / 模组脚本引用
  O.__begin = function (id) {
    var arr = G.__OPUS_MODS__ || [];
    var m = null;
    for (var i = 0; i < arr.length; i++) if (arr[i].id === id) { m = arr[i]; break; }
    _modStack.push({
      id: id, dir: m && m.dir, name: m && m.name || id, version: m && m.version,
      config: (m && m.config) || {}, game: null
    });
    O.self = _modStack[_modStack.length - 1];
  };
  O.__end = function () { _modStack.pop(); O.self = activeMod(); };
  O.__setMods = function (list) { O.mods = Array.isArray(list) ? list.slice() : []; };

  // =================================================================
  //                       早段 / 晚段入口（server 注入调用）
  // =================================================================
  O.__early = function () {
    _nextBlockId = recomputeMaxId();
    // 让 __OPUS_MODS__ 也暴露给 API
    O.mods = (G.__OPUS_MODS__ || []).slice();
    O.emit('before-load', O);
  };

  O.__late = function () {
    // 0) 先把引擎顶层 class/const（Game/Renderer/ITEMS/Living…）桥回 window，
    //    否则 G.Game / 模组的 win.Game 都是 undefined，改写与秒杀会静默失效。
    bridgeEngineGlobals();

    // 1) 接线生命周期
    var GameCls = resolveGlobal('Game');
    if (GameCls && GameCls.prototype) {
      var proto = GameCls.prototype;
      if (typeof proto.init === 'function') {
        O.wrap(proto, 'init', function (orig, args, self) {
          O.emit('game:pre-init', self);
          var r = orig.apply(self, args);
          if (r && typeof r.then === 'function') {
            return r.then(function (v) {
              self.__opusReady = true;
              O.emit('game:init', self); O.emit('game:ready', self);
              return v;
            });
          }
          O.emit('game:init', self);
          return r;
        });
      }
      if (typeof proto.tick  === 'function') O.wrap(proto, 'tick',  function (o, a, s) { var r = o.apply(s, a); O.emit('game:tick', s); return r; });
      if (typeof proto.frame === 'function') O.wrap(proto, 'frame', function (o, a, s) { var r = o.apply(s, a); O.emit('game:frame', s); return r; });
      if (typeof proto.render=== 'function') O.wrap(proto, 'render',function (o, a, s) { O.emit('game:pre-render', s); var r = o.apply(s, a); O.emit('game:render', s); return r; });
    }

    // 2) 挂自定义贴图：wrap Renderer.init 让 strip 重绘发生在 GL 上传之前
    var RendererCls = resolveGlobal('Renderer');
    if (RendererCls && RendererCls.prototype && typeof RendererCls.prototype.init === 'function' && !RendererCls.prototype.init.__opusTexHook) {
      O.wrap(RendererCls.prototype, 'init', function (orig, args, self) {
        // 先异步把模组贴图注入 strip，再调用真正的 init()（它会 loadImage(ASSETS.strip)）
        return new Promise(function (resolve, reject) {
          flushTextures(function () {
            try { var r = orig.apply(self, args); resolve(r); }
            catch (e) { reject(e); }
          });
        });
      });
      RendererCls.prototype.init.__opusTexHook = true;
    } else if (_texQueue.length) {
      // 兜底：若 Renderer 类拿不到，就直接跑 flush（可能已经错过 init）
      flushTextures();
    }

    // 3) 安装模组命令 hook（wrap window.cmdExec）
    installCommandHook();

    // 4) 跑模组自己排队的 afterLoad 回调
    for (var i = 0; i < _lateFns.length; i++) {
      try { _lateFns[i](O, G); }
      catch (e) { console.error('[OpusMC] afterLoad 回调出错：', e); }
    }
    _lateFns.length = 0;

    cleanChrome();
    O.emit('after-load', O);
  };

  // =================================================================
  //                       去边框（外壳由 server.js 直接绕开，这里只清 index.html 里可能的 Toy 残留）
  // =================================================================
  function cleanChrome() {
    if (G.__OPUS_CFG__ && G.__OPUS_CFG__.cleanChrome === false) return;
    if (document.getElementById('opus-clean-chrome')) return;
    var css = [
      '[class*="toy-"],[class*="toy_"],[id*="toy-"],[id*="toy_"]{display:none!important}',
      '[class*="bili-"],[class*="bili_"],[class*="bilibili"]{display:none!important}',
      '.plasmo-csui,.plasmo-csui-container,#plasmo-shadow-container{display:none!important}',
      'canvas{outline:none}'
    ].join('\n');
    var s = document.createElement('style');
    s.id = 'opus-clean-chrome';
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  // 自动跑早段（脚本一加载即分配 id、同步 mods 列表）
  O.__early();
})();
