# OpusMC 模组加载器 (OpusModLoader)

给「网页版我的世界」去边框版本做的**零依赖**模组加载器：用 JavaScript 写模组，注册方块 / 物品 / 配方 / 贴图 / 斜杠命令，改写游戏逻辑；启动前把模组注入到页面里，**不修改任何游戏原始文件**。

- 模组语言：**纯 JavaScript**（浏览器端脚本）。
- 加载原理：**启动前注入**——本地 Node 服务器在游戏页 `index.html` 的两个锚点处插入加载器与模组脚本，早段注册数据、晚段改写逻辑。
- 一键安装：把 `OpusModLoader` 文件夹拖进游戏目录，双击 `install.bat`，装好自动删自己。
- 可关闭：在 `_opus/mods.config.json` 里 `enabled:false` 即干净禁用某模组；只影响本次运行。

---

## 0. 目录关系（原版与加载器分开放）

```
OpusMC-原版\        纯净原版（server.js + OpusMC_files\）
│   ├─ OpusMC_files\   游戏本体（index.html 与全部 .js）
│   ├─ server.js       去边框原版服务器（无模组）
│   └─ 启动OpusMC-原版.bat
└─ OpusModLoader\      ← 加载器安装包（拖进 OpusMC-原版 里安装）
    ├─ install.bat     一键安装入口（双击）
    ├─ install.js      安装逻辑（Node，中文提示都在这）
    ├─ README.md       本文档
    └─ payload\
        ├─ launcher.bat
        ├─ _opus\  (server.js / opus-loader.js / mods.config.json)
        └─ mods\example-mod\
```

装完后 `OpusMC-原版\` 变成“模组版”（多出 `_opus\`、`mods\`、`启动OpusMC-模组版.bat`、`卸载模组加载器.bat`），`OpusModLoader\` 自我删除。原版 `server.js` 与模组版 `_opus\server.js` 互不干扰，想用哪个点哪个 bat。

---

## 1. 安装

1. 打开 `OpusMC-原版`（里面有 `OpusMC_files` 和 `server.js`）。
2. 把**整个 `OpusModLoader` 文件夹**拖进 `OpusMC-原版` 里面。拖完后路径应是：
   `OpusMC-原版\OpusModLoader\install.bat`
3. 双击 `install.bat`。看到 “安装完成！” 即成功，几秒后 `OpusModLoader` 会自动删除。

> 需要 **Node.js**（本机已装即可）。安装器只做复制与生成脚本，不联网、不装任何东西。

---

## 2. 运行

- **模组版**：双击 `OpusMC-原版\启动OpusMC-模组版.bat`。
  它会用 Node 起本地服务，并自动弹一个**无边框应用窗口**（Edge/Chrome `--app`，无地址栏、无 Bilibili 边框）。关掉那个控制台窗口即停止。
- **原版**：双击 `OpusMC-原版\启动OpusMC-原版.bat`（纯净、无模组）。
- 也可用浏览器手动访问控制台里打印的 **`http://127.0.0.1:8017/index.html`**。
  ⚠️ 一定用 `127.0.0.1`，**不要用 `localhost`**——服务器只绑 IPv4 回环，`localhost` 在本机会先解析成 IPv6 `::1` 而“拒绝连接”。

---

## 3. 卸载

双击 `OpusMC-原版\卸载模组加载器.bat`：删除 `_opus\` 与模组版启动器。`mods\` 目录会保留，可自行删除。原始游戏文件从头到尾没被动过。

---

## 4. 放模组

把模组文件夹丢进 `OpusMC-原版\mods\` 里，重启游戏即可。每个模组至少要有 `manifest.json` 和入口脚本。

```
mods\
└─ my-mod\
   ├─ manifest.json     必需：模组元信息
   ├─ main.js           入口脚本（manifest.entry 里列出，可多个）
   └─ assets\           可选：贴图/JSON/音频等自带资源
       └─ foo.png
```

启用/禁用与加载顺序在 `_opus\mods.config.json` 里控制。

---

## 5. 模组需要资源文件夹吗？

**不是必需。** 只有当你需要“自带文件”时才用：

- 复用引擎已有贴图、注册方块/物品/配方/命令、改写逻辑 —— 只要 `manifest.json` + `main.js`，**不需要**任何资源文件夹。
- 需要**自定义贴图**（全新方块外观）、额外分片脚本、配置 JSON、音频等 —— 在模组目录里建 `assets\`（或任意子目录），把文件放进去。加载器会把 `/mods/<模组目录名>/**` 当静态文件伺服，用 `OpusMC.modUrl('assets/foo.png')` 取它的 URL。

自定义贴图如何真正“进游戏图集”，见 §7。

---

## 6. manifest.json 字段

```json
{
  "id": "my-mod",              // 唯一 ID（缺省用文件夹名）
  "name": "我的模组",
  "version": "1.0.0",
  "author": "you",
  "description": "……",
  "priority": 0,               // 越大越先加载（默认 0）
  "depends": ["other-mod"],    // 依赖的模组 id（缺失只会告警）
  "entry": ["main.js"],        // 入口脚本数组，按顺序加载
  "config": { "greeting": "hi" } // 传给模组的配置（可被 mods.config.json 覆盖）
}
```

---

## 7. API 参考（全部挂在 `window.OpusMC`）

### 7.1 生命周期与执行阶段（务必先理解）

- **早段**：模组 `main.js` 的顶层在这里运行（数据已就绪、查找表未建）。**注册方块/物品/配方/贴图别名必须在这里同步做。**
- **晚段 (`afterLoad`)**：所有游戏脚本加载完、`main.js` 启动前运行。此时 `Game` 类、`cmdExec` 等才存在，适合 `wrap` 改写、挂生命周期钩子。
- `registerCommand` 与 `registerTexture` 内部已自动处理阶段，直接调用即可。

### 7.2 方块

```js
OpusMC.registerBlock(def)          // 返回写入 BLOCK_DATA 的对象本体
OpusMC.registerBlockItem(blockDef, { tab, stack, cn })  // 方块 + 同名“可放置”物品，一步到位
OpusMC.editBlock(keyOrId, patch)   // 修改已存在方块（含原版，仅本会话）
OpusMC.removeBlock(keyOrId)        // 移除方块（仅本会话）
OpusMC.getBlock(key) / getBlockById(id) / hasBlock(key)
OpusMC.nextBlockId()               // 手动取一个未用方块 id
```

`registerBlock` 的 `def`（★为可选）：

| 字段 | 说明 |
|---|---|
| `key` | 必填，唯一英文键，如 `"my_crystal"` |
| `cn` | 中文显示名（缺省=key） |
| `id` | 方块 id，缺省自动分配（2090+） |
| `hardness` | 硬度（默认 1；0=瞬间） |
| `sound` | 音效组名：`stone/wood/grass/metal/glass/sand/snow/…` |
| `tool` | `'pickaxe'/'axe'/'shovel'/'hoe'/null` |
| `needsTool` | 是否必须用对应工具才掉落 |
| ★`level` | 工具等级门槛（1木2石3铁4钻5合金） |
| ★`light` | 发光 0~15 |
| ★`fuel` | 熔炉燃料值 |
| ★`slip` `damage` `climbable` `replaceable` `tint` `xp` | 物理/视觉细节 |
| ★`axis` `leaves` `translucent` `cutout` `nonsolid` `noitem` | 类别开关（原木/树叶/玻璃/镂空/可穿透/不建物品） |
| `tex` | 六面贴图名：`'gold_block'` 或 `[顶,底,东,西,南,北]` 或 `{top,bottom,side}` |
| `particle` | 破坏粒子贴图名 |
| ★`extra` | 兜底：任意额外字段，直接并入条目 |

### 7.3 物品

```js
OpusMC.registerItem(def)
OpusMC.getItem(key) / hasItem(key)
```

`def`：`key`(必填)、`cn`、`stack`(默认64)、`tab`(创造栏)、`id`(缺省自动 10000+)、★`dur`(耐久)、★`atk`/`aspd`(武器)、★`food:[饱食,回复]`、★`rar`、★`glint`、★`rep`(修补料)、★`ench`、★`tex`(图标贴图名；未给则尝试 `i_<key>`)、★`places`(右键放置的方块 key)。

创造栏 `tab` 取值：`natural_blocks, building_blocks, functional_blocks, colored_blocks, redstone_blocks, tools_and_utilities, ingredients, combat, food_and_drinks, spawn_eggs`。

### 7.4 配方（`RECIPE_DATA` 是对象，加载器按类型写入对应子数组）

```js
// 有序（工作台）
OpusMC.registerShapedRecipe({
  result: 'my_crystal_block', count: 1,
  pattern: ['#B#','BoB','#B#'],
  key: { '#':'stone', 'B':'iron_block', 'o':'my_gem' }   // 值可用 "#tagname" 引用标签
});

// 无序
OpusMC.registerShapelessRecipe({ result: 'my_gem', count: 9, ingredients: ['my_crystal_block'] });

// 烧炼：smelting / blasting / smoking / campfire
OpusMC.registerSmeltingRecipe({ input:'raw_copper', output:'my_crystal_block', xp:0.7, cookTime:200 });

// 切石机
OpusMC.registerStonecuttingRecipe({ input:'my_crystal_block', output:'stone', count:2 });

// 万能路由 + 标签
OpusMC.registerRecipe(def);          // 按 def.type 自动分流
OpusMC.addTag('my_alloys', ['iron_block','my_crystal_block']);
OpusMC.hasTag(name) / getTag(name);
```

材料引用：直接写物品 key；写标签用 `"#标签名"`（如 `"#logs"`）。

### 7.5 贴图

```js
// 给已有贴图起别名（零成本，推荐做“换名复用”）：物品图标是 i_<名>，地形方块用裸名
OpusMC.aliasTexture('my_gem_tile', 'i_diamond');   // 之后 registerItem({tex:'my_gem_tile'})

// 注册一张全新贴图（模组自带 PNG）
OpusMC.registerTexture('my_crystal_tile', OpusMC.modUrl('assets/crystal.png'), { aliasOnFail:'gold_block' });
OpusMC.hasTexture(name) / texIndex(name) / texName(idx);
```

原理：`registerTexture` 在早段立刻从 `2650` 往后占一个空闲图集格子并写进 `ASSETS.tiles`（保证 `blocks.js` 建表时 `T(名字)` 能查到），晚段再把 PNG 异步重绘进引擎精灵图集 `ASSETS.strip` 并 `toDataURL` 更新——渲染器 `Renderer.init` 已被加载器 hook，会先补图再建 GL 纹理。**因此自定义贴图必须与用到它的方块在同一个模组里注册。** 加载失败会 `aliasOnFail` 回退，不崩游戏。

> 图集里已用名共 2091 个、`count=2650`，所以从 2650 起追加不会与原版碰撞。

### 7.6 斜杠命令（“一大堆语句”）

```js
OpusMC.registerCommand('mycmd', {
  usage: '/mycmd <子命令>',
  description: '示例命令',
  fn: (ctx, args, g) => {          // ctx 与原版命令一致：{ g, pos, rot, entity, name, say }
    ctx.say('你好，' + ctx.name, '#66CCFF');
  }
});
OpusMC.listCommands() / unregisterCommand(name);
```

加载器在晚段 `wrap(window,'cmdExec')`，命中模组命令名就走你的 `fn`，否则原样交给原版命令表。

### 7.7 创造栏（进阶钩子）

```js
OpusMC.registerCreativeTab({ key:'my_tab', cn:'我的分类' });  // 登记并触发 'creative-tab'
OpusMC.listCreativeTabs();
```

> 真正在 UI 里新增一个分类标签页需要 `afterLoad` 里改写 `ui/screens` 的栏表；`registerCreativeTab` 提供登记与钩子点。把物品放进现有 `tab` 最简单直接。

### 7.8 改写一切（“允许修改所有 JS”）

```js
OpusMC.afterLoad((Opus, win) => {
  // 包裹任意对象的方法（可逆）
  const undo = Opus.wrap(win.Game.prototype, 'tick', function (orig, args, self){
    const r = orig.apply(self, args);
    // ...你的逻辑...
    return r;
  });
  // 完全替换
  Opus.override(win.Game.prototype, 'someFn', function(){ /* ... */ });
  Opus.g('Game');   // 安全读全局
});
```

`wrap`/`override` 返回 `undo()`，随时恢复。

> ⚠️ 引擎的 `Game`/`Renderer`/`Living`/`ITEMS`/`BLOCKS` 等是**顶层 `class`/`const`**，
> 在普通 `<script>` 里不会挂到 `window`（`window.Game` 是 `undefined`）。
> 加载器 v1.1.1 起在晚段用「间接 eval」把这些词法全局**自动桥回 `window`**，
> 所以模组里 `win.Game`、`win.ITEMS` 能直接拿到；也可用
> `OpusMC.g('Game')` / `OpusMC.resolve('Game')` 安全读取任意引擎全局。
> （顶层 `function` 如 `cmdExec` 本就在 `window` 上，不受影响。）

### 7.9 事件总线

```js
OpusMC.on(evt, fn);   // fn(ctx, OpusMC)
OpusMC.off(evt, fn);
OpusMC.emit(evt, ctx);
```

| 事件 | 时机 |
|---|---|
| `before-load` / `after-load` | 加载器早/晚段 |
| `game:pre-init` / `game:init` / `game:ready` | 游戏初始化（`ready` 在 async `init` 完成后） |
| `game:tick` / `game:frame` / `game:pre-render` / `game:render` | 主循环 |

### 7.10 模组上下文与资源

```js
OpusMC.self            // { id, dir, name, version, config }，当前模组
OpusMC.mods            // 启用模组数组
OpusMC.modUrl('assets/foo.png')  // -> /mods/<本模组目录>/assets/foo.png
```

### 7.11 调试

```js
OpusMC.stats();        // 数量统计（方块/物品/各类配方/命令/贴图/下一个可用 id）
OpusMC.list();         // 本次所有由模组新增的条目
OpusMC.version;        // 加载器版本
```

---

## 8. 工作原理（架构）

1. `启动OpusMC-模组版.bat` → `node _opus/server.js`。
2. `server.js` 扫描 `mods\`（读 `manifest.json` + `mods.config.json`），按 `priority` 排序。
3. 浏览器请求 `/index.html` 时，服务器**在内存里**给原始 `index.html` 打两段补丁（磁盘文件不变）：
   - **早段**：在 `recipedata.js` 之后、`blocks.js` 之前插入 `opus-loader.js` 与每个模组的 `main.js`（用 `OpusMC.__begin(id)/__end()` 包裹切换模组上下文）。
   - **晚段**：在 `main.js`（bootstrap）之前插入 `OpusMC.__late()`。
4. `opus-loader.js` 早段把注册写进 `self.BLOCK_DATA/ITEM_DATA/RECIPE_DATA/ASSETS`；晚段把模组数据灌进引擎、改写 `Game.prototype`、安装模组命令、注入自定义贴图。

---

## 9. 配置 `_opus/mods.config.json`

```json
{
  "mods": {
    "example-mod": { "enabled": true, "priority": 0, "config": { "greeting": "喵～" } }
  }
}
```

`enabled:false` 干净禁用；`priority` 越大越先加载；`config` 覆盖 manifest 的同名字段。

---

## 10. 开发提示 / 常见问题

- **注册时序**：方块/物品/配方在 `main.js` 顶层同步注册；改写 Game / 命令 / 贴图相关放 `afterLoad` 或 `game:ready`。
- **贴图名必须存在**：`tex` 里的名字要么用引擎已有名（地形用裸名、物品图标用 `i_名`），要么先 `registerTexture`。查不到会告警并回退白色（不会崩）。
- **端口**：模组版默认 `8017`（占用会自动+1），原版默认 `8016`。访问用 `127.0.0.1`，别用 `localhost`。
- **想改回纯净**：用 `启动OpusMC-原版.bat`，或运行卸载脚本。
- **调试**：F12 控制台看 `[OpusMC]` 与 `[你的模组]` 前缀日志；进游戏输 `/opus info`、`/opusstat`（示例模组自带）。
- **只影响内存**：模组改动不落盘、不改原始文件，禁用即恢复。

---

## 11. 示例

见 `mods\example-mod\`：自带一张 PNG 资源、注册了发光自定义方块、可放置物品、有序/无序/熔炉/切石配方、标签、两条斜杠命令，并在 `game:ready` 打印统计。把 `main.js` 当模板抄即可。
