/*
 * 绝对秒杀之剑 (Absolution Blade)  —  OpusMC 模组
 * ==================================================================
 * 目标：手持这把剑，左键命中「任何」生物 => 一击必杀，无视一切减伤与免疫，
 *       连末影龙这类分部位 BOSS 也直接处决；且永不磨损、常驻附魔光泽。
 *
 * 为什么不用「把攻击力数值堆到很高」的做法？
 *   引擎结算近战伤害读的是 def.attack（见 game.js attack()），而加载器
 *   registerItem 的字段白名单里只有 atk / dur，并不会写 attack/durability，
 *   所以模组注册的 atk 数值引擎根本不认——纯数值秒杀在此 API 下无效。
 *   正确姿势：用 afterLoad + wrap 改写 Game.prototype.attack，命中时直接处决，
 *   绕开 hurt() 的护甲减免 / 无敌帧 / fireproof / 难度缩放，实现真正的「绝对秒杀」。
 *
 * 生命周期：
 *   - 数据注册（贴图 / 物品 / 配方 / 命令）在 main.js 顶层【同步】完成（早段）。
 *   - 改写攻击逻辑放 afterLoad（晚段），此时 Game / ITEMS / Living 才存在。
 * ==================================================================
 */
(function () {
  'use strict';
  var M = window.OpusMC;
  if (!M) { console.error('[绝对秒杀之剑] 找不到 OpusMC，加载器未注入'); return; }

  var SWORD_KEY = 'absolution_blade';
  var SWORD_TEX = 'absolution_tex';

  console.log('[绝对秒杀之剑] 载入中 by', M.self && M.self.id);

  // ---------------------------------------------------------------
  // 1) 自定义贴图：从本模组 assets/sword.png 读取（16x16 PNG，由用户提供）
  //    加载失败会 aliasOnFail 回退到钻石剑图标，不会崩。
  //    注意：自定义贴图必须与用到它的物品「在同一模组里注册」。
  // ---------------------------------------------------------------
  try {
    M.registerTexture(SWORD_TEX, M.modUrl('assets/sword.png'), { aliasOnFail: 'i_diamond_sword' });
  } catch (e) {
    console.warn('[绝对秒杀之剑] registerTexture 失败，改用别名：', e.message);
    try { M.aliasTexture(SWORD_TEX, 'i_diamond_sword'); } catch (_) {}
  }

  // ---------------------------------------------------------------
  // 2) 武器物品本体
  //    stack:1 武器不堆叠；tab:'combat' 归入「战斗」创造栏；glint 常驻附魔光泽。
  //    刻意不给 durability（引擎只认 def.durability 才扣耐久）=> 永不磨损。
  // ---------------------------------------------------------------
  var sword;
  try {
    sword = M.registerItem({
      key: SWORD_KEY,
      cn: '绝对秒杀之剑',
      tab: 'combat',
      stack: 1,
      rar: 'epic',
      glint: true,
      tex: SWORD_TEX
    });
  } catch (e) {
    console.error('[绝对秒杀之剑] 物品注册失败：', e.message);
    return;
  }

  // ---------------------------------------------------------------
  // 3) 合成配方（史诗级材料；即便个别 key 在本版本不存在，也只是合不出来，
  //    不影响武器本体与秒杀逻辑）。钻石剑 + 下界之星 + 信标 => 秒杀之剑。
  // ---------------------------------------------------------------
  try {
    M.registerShapedRecipe({
      result: SWORD_KEY,
      count: 1,
      pattern: [
        ' A ',
        ' E ',
        ' S '
      ],
      key: { 'A': 'beacon', 'E': 'nether_star', 'S': 'diamond_sword' }
    });
  } catch (e) {
    console.warn('[绝对秒杀之剑] 配方注册跳过：', e.message);
  }

  // ---------------------------------------------------------------
  // 4) 斜杠命令：/absolution  —— 直接把秒杀之剑塞进背包，方便立刻拿到
  // ---------------------------------------------------------------
  M.registerCommand('absolution', {
    usage: '/absolution',
    description: '获得「绝对秒杀之剑」',
    fn: function (ctx) {
      var p = (ctx.g && ctx.g.player) || ctx.entity;
      var it = M.getItem(SWORD_KEY);
      if (!p || !p.inv || !p.inv.slots || !it) { ctx.say('§c背包或物品未就绪', '#FF5555'); return; }
      var sel = p.inv.sel || 0;
      var slot = null;
      if (!p.inv.slots[sel]) slot = sel;
      else { for (var i = 0; i < p.inv.slots.length; i++) { if (!p.inv.slots[i]) { slot = i; break; } } }
      if (slot == null) slot = sel;
      p.inv.slots[slot] = { id: it.id, count: 1 };
      try { if (p.inventoryChanged) p.inventoryChanged(); } catch (_) {}
      ctx.say('§d已给予 §l绝对秒杀之剑 §d：手持左键命中即秒杀一切（含末影龙等 BOSS）', '#FF66FF');
    }
  });

  // ---------------------------------------------------------------
  // 5) 核心：改写 Game.prototype.attack —— 持剑命中 => 一击处决
  //    这是「绝对」的来源：不经过 hurt() 的减伤链，直接清空血并触发死亡。
  // ---------------------------------------------------------------
  M.afterLoad(function (Opus, win) {
    var GameCls = win.Game;
    if (!GameCls || !GameCls.prototype || typeof GameCls.prototype.attack !== 'function') {
      console.warn('[绝对秒杀之剑] 未找到 Game.prototype.attack，秒杀未启用');
      return;
    }

    function isBladeHeld(self) {
      var p = self && self.player;
      var held = p && p.inv && p.inv.held;
      var def = (held && win.ITEMS) ? win.ITEMS[held.id] : null;
      return p && def && def.key === SWORD_KEY ? p : null;
    }

    function executeBlade(p, e, self) {
      // 一个「玩家近战」性质的伤害来源，供 die() 记录击杀归属 / 掉落
      var src = { type: 'player', attacker: p, knockFrom: p.pos, knock: 0, player: true, looting: 0 };
      try {
        e.invuln = 0;      // 清无敌帧，保证穿透
        e.hurtTime = 10;   // 受击红闪反馈
        if (typeof e.health === 'number') {
          // Living 生物（含 BOSS、末影龙分部位）：直接清空血并走正常死亡流程
          e.health = 0;
          if (typeof e.die === 'function') e.die(src);
          else if (typeof e.hurt === 'function') e.hurt(Infinity, src);
        } else if (typeof e.hurt === 'function') {
          // 非生物可伤害实体（盔甲架 / 船 等）：用天文数字伤害兜底
          e.hurt(Infinity, src);
        }
      } catch (err) {
        console.error('[绝对秒杀之剑] 处决异常：', err);
      }
      // 保留挥砍动画与冷却手感；不扣耐久（本剑无 durability 字段）
      try { if (p && p.swing) p.swing(); } catch (_) {}
      try { self.attackCd = 2; } catch (_) {}
    }

    Opus.wrap(GameCls.prototype, 'attack', function (orig, args, self) {
      var e = args[0];
      var p = e ? isBladeHeld(self) : null;
      if (p) { executeBlade(p, e, self); return; }   // 命中即秒杀，不走原伤害计算
      return orig.apply(self, args);                 // 其余情况原样交给游戏
    });

    console.log('[绝对秒杀之剑] 一击必杀已挂载。物品 id=' + sword.id + '，贴图=' + (M.hasTexture(SWORD_TEX) ? '已注入' : '未就绪'));
  });
})();
