/// <reference types="@figma/plugin-typings" />

/**
 * Figma 编号标注插件 — 沙箱主入口
 */

// ══════════════════════════════════════════════
// 常量
// ══════════════════════════════════════════════

const MARKER_COLOR: RGBA = { r: 0.29, g: 0.565, b: 0.851, a: 1 }; // #4A90D9 默认色
const MARKER_STROKE_COLOR: RGBA = { r: 1, g: 1, b: 1, a: 1 };
const MARKER_TEXT_COLOR: RGBA = { r: 1, g: 1, b: 1, a: 1 };
const ANNOTATION_PREFIX = '[Annotation]';

// PluginData 键名
const PD = {
  annotationId: 'ann_id',
  order: 'ann_order',
  targetNodeId: 'ann_target',
  offsetX: 'ann_offX',
  offsetY: 'ann_offY',
  note: 'ann_note',
  isLocked: 'ann_locked',
  backup: 'ann_backup',
  config: 'ann_config',
} as const;

/** 全局配置（作用于所有编号点） */
interface PluginConfig {
  color: RGB;          // 编号点颜色
  size: number;        // 编号点尺寸（px）
  charsPerLine: number; // 备注区域每行字符数（按标准字号 12px 计算）
  fontSize: number;    // 备注文字字号
}

/** 标准字号下每字符宽度（px），用于换算备注区域宽度 */
const CHAR_WIDTH = 7;

/** 默认配置 */
function defaultConfig(): PluginConfig {
  return {
    color: { r: 0.29, g: 0.565, b: 0.851 }, // #4A90D9
    size: 24,
    charsPerLine: 20,
    fontSize: 12,
  };
}

/** 获取全局配置（不存在或字段缺失则合并默认值） */
function getConfig(): PluginConfig {
  const raw = figma.root.getPluginData(PD.config);
  const base = defaultConfig();
  if (!raw) return base;

  try {
    const cfg = JSON.parse(raw) as Partial<PluginConfig>;
    const color =
      cfg.color &&
      typeof cfg.color.r === 'number' &&
      typeof cfg.color.g === 'number' &&
      typeof cfg.color.b === 'number'
        ? cfg.color
        : base.color;
    return {
      color,
      size: typeof cfg.size === 'number' ? cfg.size : base.size,
      charsPerLine: typeof cfg.charsPerLine === 'number' ? cfg.charsPerLine : base.charsPerLine,
      fontSize: typeof cfg.fontSize === 'number' ? cfg.fontSize : base.fontSize,
    };
  } catch {
    return base;
  }
}

/** 保存全局配置 */
function saveConfig(config: PluginConfig): void {
  figma.root.setPluginData(PD.config, JSON.stringify(config));
}

/** 当前配置下的编号点尺寸 */
function getMarkerSize(): number {
  return getConfig().size;
}

// 目标节点上的反向引用键
const REF_KEY = 'ann_refs';

// Annotation 数据接口
interface AnnotationData {
  annotationId: string;
  order: number;
  targetNodeId: string;
  offsetX: number;
  offsetY: number;
  note: string;
  isLocked: string;
  nodeId: string;
  x: number;
  y: number;
}

// ══════════════════════════════════════════════
// 全局状态
// ══════════════════════════════════════════════

/** 标记位：区分程序化移动（跟随目标图层/复位）与用户手动拖拽 */
let isProgrammaticMove = false;

/** 插件 UI 是否处于展开态（面板） */
let uiIsExpanded = false;

/** 程序化删除的节点 ID 集合（区分插件删除与用户画布删除，避免恢复被插删的编号点） */
const programmaticDeleteIds = new Set<string>();

/**
 * 程序化修改的编号点 ID 集合（延迟清理）。
 * documentchange 是异步触发的，同步标记（isProgrammaticMove）在回调时已复位，
 * 因此程序化修改必须登记节点 ID，回调时按 ID 跳过处理。
 */
const programmaticChangeIds = new Set<string>();

/** 登记程序化修改并自动延迟清理（documentchange 异步回调时仍有效） */
function markProgrammatic(nodeId: string): void {
  programmaticChangeIds.add(nodeId);
  setTimeout(() => {
    programmaticChangeIds.delete(nodeId);
  }, 500);
}

// ══════════════════════════════════════════════
// 初始化
// ══════════════════════════════════════════════

figma.showUI(__html__, {
  width: 48,
  height: 48,
  themeColors: true,
});

console.log('[编号标注] 插件已启动');

// ══════════════════════════════════════════════
// 消息分发
// ══════════════════════════════════════════════

figma.ui.onmessage = (msg: { type: string; [key: string]: unknown }) => {
  switch (msg.type) {
    case 'ready':
      // UI 就绪，发送初始数据
      syncAllAnnotations();
      break;
    case 'badge-clicked':
      handleBadgeClicked();
      break;
    case 'collapse-panel':
      handleCollapsePanel();
      break;
    case 'add-annotation':
      handleAddAnnotation();
      break;
    case 'update-config':
      handleUpdateConfig(msg.config as PluginConfig);
      break;
    case 'delete-annotation':
      handleDeleteAnnotation(msg.annotationId as string);
      break;
    case 'update-note':
      handleUpdateNote(msg.annotationId as string, msg.note as string);
      break;
    case 'toggle-lock':
      handleToggleLock(msg.annotationId as string);
      break;
    case 'select-annotation':
      handleSelectAnnotation(msg.annotationId as string);
      break;
    case 'locate-annotation':
      handleLocateAnnotation(msg.annotationId as string);
      break;
    default:
      console.log('[code] 未处理的消息:', msg.type);
  }
};

// ══════════════════════════════════════════════
// 面板展开/收起
// ══════════════════════════════════════════════

function handleBadgeClicked(): void {
  uiIsExpanded = true;
  figma.ui.resize(340, 480);
  figma.ui.postMessage({ type: 'panel-expanded' });
  syncAllAnnotations();
}

function handleCollapsePanel(): void {
  uiIsExpanded = false;
  figma.ui.resize(48, 48);
  figma.ui.postMessage({ type: 'panel-collapsed' });
}

// ══════════════════════════════════════════════
// 创建编号点
// ══════════════════════════════════════════════

/**
 * 添加编号点：
 * - 有选中图层 → 出现在图层左上角，自动绑定
 * - 无选中图层（或选中编号点本身）→ 提示先选择图层
 */
function handleAddAnnotation(): void {
  const selection = figma.currentPage.selection;

  if (selection.length === 1 && isBindableNode(selection[0])) {
    const target = selection[0];
    // 使用 absoluteBoundingBox（页面绝对坐标），兼容嵌套在 Frame/组件内的图层
    const box = target.absoluteBoundingBox;
    if (box) {
      void createAnnotationAt(box.x, box.y, target.id);
    } else {
      figma.notify('无法获取该图层的位置');
    }
  } else {
    figma.notify('请先选中要标注的图层');
  }
}

/**
 * 在指定画布坐标创建编号点
 * @param targetNodeId 绑定的目标图层 ID，空字符串则不绑定
 */
async function createAnnotationAt(
  x: number,
  y: number,
  targetNodeId: string,
): Promise<GroupNode | null> {
  const nextOrder = getNextOrder();
  const marker = await createMarkerNode(nextOrder, x, y);
  if (!marker) return null;

  const annotationId = generateId();
  marker.setPluginData(PD.annotationId, annotationId);
  marker.setPluginData(PD.order, String(nextOrder));
  marker.setPluginData(PD.note, '');
  marker.setPluginData(PD.isLocked, 'false');

  if (targetNodeId) {
    const target = figma.getNodeById(targetNodeId) as SceneNode | null;
    if (target) {
      bindAnnotation(annotationId, target);
    } else {
      setUnboundPosition(marker);
    }
  } else {
    setUnboundPosition(marker);
  }

  // 通知 UI
  figma.ui.postMessage({
    type: 'annotation-added',
    annotation: readAnnotationData(marker),
  });

  // 选中新建的编号点
  figma.currentPage.selection = [marker];

  // 自动显示备注浮窗：仅有关联图层时显示在图层右侧；无关联不显示
  if (marker.getPluginData(PD.targetNodeId)) {
    showOrCreatePopup(marker, 'auto');
  }

  // 更新备份
  backupAllAnnotations();

  return marker;
}

/** 无绑定目标时，偏移量即绝对坐标 */
function setUnboundPosition(marker: GroupNode): void {
  marker.setPluginData(PD.targetNodeId, '');
  marker.setPluginData(PD.offsetX, String(Math.round(marker.x)));
  marker.setPluginData(PD.offsetY, String(Math.round(marker.y)));
}

/**
 * 创建圆形编号点 Group
 *   Ellipse (圆形背景) + Text (数字)
 */
async function createMarkerNode(
  order: number,
  x: number,
  y: number,
): Promise<GroupNode> {
  // 加载字体（必须在使用前加载）
  await figma.loadFontAsync({ family: 'Inter', style: 'Medium' });

  const size = getMarkerSize();
  const config = getConfig();

  // -- 圆形 --
  const ellipse = figma.createEllipse();
  ellipse.resize(size, size);
  ellipse.fills = [{ type: 'SOLID', color: config.color }];
  ellipse.strokes = [{ type: 'SOLID', color: MARKER_STROKE_COLOR }];
  ellipse.strokeWeight = 2;
  ellipse.effects = [
    {
      type: 'DROP_SHADOW',
      color: { r: 0, g: 0, b: 0, a: 0.2 },
      offset: { x: 0, y: 1 },
      radius: 4,
      visible: true,
      blendMode: 'NORMAL',
    },
  ];

  // -- 文字（字号随尺寸，约一半） --
  const text = figma.createText();
  text.characters = String(order);
  text.fontSize = Math.max(10, Math.round(size / 2));
  text.fontName = { family: 'Inter', style: 'Medium' };
  text.fills = [{ type: 'SOLID', color: MARKER_TEXT_COLOR }];
  text.textAlignHorizontal = 'CENTER';
  text.textAlignVertical = 'CENTER';
  text.resize(size, size);

  // -- 组合 --
  // 先将 ellipse 和 text 创建在 (0,0)，组合后再移动到目标位置
  const group = figma.group([ellipse, text], figma.currentPage);
  group.name = `${ANNOTATION_PREFIX} #${order}`;
  // 程序化定位：登记节点 ID，防护 documentchange 重入（避免新建时立即触发自动重关联）
  markProgrammatic(group.id);
  isProgrammaticMove = true;
  try {
    group.x = x;
    group.y = y;
  } finally {
    isProgrammaticMove = false;
  }
  group.expanded = false;

  return group;
}

// ══════════════════════════════════════════════
// 删除编号点
// ══════════════════════════════════════════════

function handleDeleteAnnotation(annotationId: string): void {
  const marker = findAnnotationById(annotationId);
  if (!marker) return;

  const data = readAnnotationData(marker);

  // 清理目标节点上的反向引用
  if (data.targetNodeId) {
    removeAnnotationRef(data.targetNodeId, annotationId);
  }

  // 标记为程序化删除（documentchange 的 DELETE 事件据此跳过恢复逻辑）
  // 注意：documentchange 是异步触发的，标记必须延迟清理，否则插件删除会被误恢复
  programmaticDeleteIds.add(marker.id);
  marker.remove();
  setTimeout(() => {
    programmaticDeleteIds.delete(marker.id);
  }, 1000);

  // 同步删除对应的备注浮窗（含页面级兜底扫描）
  removePopupForcefully(annotationId);

  // 更新备份（不再包含被删节点）
  backupAllAnnotations();

  // 通知 UI
  figma.ui.postMessage({ type: 'annotation-removed', annotationId });

  // 触发重编号
  renumberAll();
}

// ══════════════════════════════════════════════
// 更新备注
// ══════════════════════════════════════════════

function handleUpdateNote(annotationId: string, note: string): void {
  const marker = findAnnotationById(annotationId);
  if (!marker) return;

  marker.setPluginData(PD.note, note);

  figma.ui.postMessage({
    type: 'annotation-updated',
    annotation: readAnnotationData(marker),
  });

  // 同步刷新画布上对应的备注浮窗内容
  updatePopupContent(annotationId);

  backupAllAnnotations();
}

/** 刷新浮窗中的备注内容（备注更新后同步显示） */
function updatePopupContent(annotationId: string): void {
  const popup = activePopups.get(annotationId);
  if (!popup || popup.removed) return;

  const marker = findAnnotationById(annotationId);
  if (!marker) return;

  const note = marker.getPluginData(PD.note) || '(暂无备注)';
  const text = note.length > 120 ? note.substring(0, 120) + '…' : note;

  const contentText = popup.children.find(
    (c) => c.type === 'TEXT' && c.name === 'popupContent',
  ) as TextNode | undefined;
  if (!contentText) return;

  contentText.characters = text;
  contentText.fontSize = getConfig().fontSize;
  contentText.lineHeight = { value: getConfig().fontSize + 6, unit: 'PIXELS' };

  // 重新计算尺寸（内容宽度 = 每行字符数 × 标准字符宽）
  const closeText = popup.children.find(
    (c) => c.type === 'TEXT' && c.name === 'popupClose',
  ) as TextNode | undefined;

  const contentW = getConfig().charsPerLine * CHAR_WIDTH;
  contentText.resize(contentW, contentText.height);
  const frameW = 44 + contentW + 24;
  const frameH = Math.max(44, contentText.y + contentText.height + 16);
  popup.resize(frameW, frameH);
  if (closeText) {
    closeText.x = frameW - closeText.width - 10;
  }

  // 尺寸变化后重排：仅图层右侧布局（auto 模式）的浮窗需要重排，
  // 临时查看（click 模式）的浮窗保持当前位置
  if (popup.getPluginData('popupMode') !== 'click') {
    layoutAllPopups();
  }
}

// ══════════════════════════════════════════════
// 锁定/解锁
// ══════════════════════════════════════════════

function handleToggleLock(annotationId: string): void {
  const marker = findAnnotationById(annotationId);
  if (!marker) return;

  const isLocked = marker.getPluginData(PD.isLocked) === 'true';
  marker.setPluginData(PD.isLocked, isLocked ? 'false' : 'true');

  // 更新节点外观
  updateMarkerAppearance(marker);

  figma.ui.postMessage({
    type: 'annotation-updated',
    annotation: readAnnotationData(marker),
  });

  // 锁定状态写入备份（画布删除恢复时保持锁定态）
  backupAllAnnotations();
}

/**
 * 根据锁定状态更新编号点的视觉样式
 */
function updateMarkerAppearance(marker: GroupNode): void {
  const isLocked = marker.getPluginData(PD.isLocked) === 'true';
  const ellipse = marker.children.find((c) => c.type === 'ELLIPSE') as EllipseNode | undefined;
  if (!ellipse) return;

  // 程序化修改：登记节点 ID，防护 documentchange 重入
  markProgrammatic(marker.id);
  isProgrammaticMove = true;
  try {
    if (isLocked) {
      ellipse.fills = [{ type: 'SOLID', color: { r: 0.753, g: 0.769, b: 0.8 } }]; // #C0C4CC
    } else {
      ellipse.fills = [{ type: 'SOLID', color: getConfig().color }];
    }
  } finally {
    isProgrammaticMove = false;
  }
}

// ══════════════════════════════════════════════
// 全局配置（颜色 / 尺寸 / 备注区域）
// ══════════════════════════════════════════════

/** 处理全局配置更新：保存并应用到所有编号点和浮窗 */
function handleUpdateConfig(config: PluginConfig): void {
  const sanitized: PluginConfig = {
    color: config.color || getConfig().color,
    size: clampNumber(config.size, 12, 60, 24),
    charsPerLine: clampNumber(config.charsPerLine, 8, 60, 20),
    fontSize: clampNumber(config.fontSize, 10, 24, 12),
  };

  saveConfig(sanitized);
  applyConfig(sanitized);

  // 同步 UI 显示当前配置
  figma.ui.postMessage({ type: 'config-updated', config: sanitized });
}

/** 将配置应用到所有编号点和浮窗（锁定编号点跳过） */
function applyConfig(config: PluginConfig): void {
  // 1. 颜色 + 尺寸应用到编号点
  for (const marker of findAllAnnotationGroups()) {
    if (marker.getPluginData(PD.isLocked) === 'true') continue;

    updateMarkerAppearance(marker);
    applySizeToMarker(marker, config.size);
  }

  // 2. 备注区域宽度 + 字号应用到所有浮窗（锁定的编号点浮窗跳过，保持一致性）
  for (const [annotationId, popup] of activePopups) {
    if (popup.removed) continue;
    const marker = findAnnotationById(annotationId);
    if (marker && marker.getPluginData(PD.isLocked) === 'true') continue;
    applyPopupStyle(popup, config);
  }
  layoutAllPopups();
}

/** 将配置尺寸应用到单个编号点（左上角锚定） */
function applySizeToMarker(marker: GroupNode, size: number): void {
  const ellipse = marker.children.find((c) => c.type === 'ELLIPSE') as EllipseNode | undefined;
  const text = marker.children.find((c) => c.type === 'TEXT') as TextNode | undefined;

  markProgrammatic(marker.id);
  isProgrammaticMove = true;
  try {
    if (ellipse) ellipse.resize(size, size);
    if (text) {
      text.resize(size, size);
      text.fontSize = Math.max(10, Math.round(size / 2));
    }
    marker.resize(size, size);
  } finally {
    isProgrammaticMove = false;
  }
}

/** 将配置应用到单个浮窗（序号圆颜色 + 内容宽度 + 字号） */
function applyPopupStyle(popup: FrameNode, config: PluginConfig): void {
  // 序号圆颜色同步
  const badge = popup.children.find(
    (c) => c.type === 'ELLIPSE' && c.name === 'popupBadge',
  ) as EllipseNode | undefined;
  if (badge) {
    badge.fills = [{ type: 'SOLID', color: config.color }];
  }

  const contentText = popup.children.find(
    (c) => c.type === 'TEXT' && c.name === 'popupContent',
  ) as TextNode | undefined;
  if (!contentText) return;

  contentText.fontSize = config.fontSize;
  contentText.lineHeight = { value: config.fontSize + 6, unit: 'PIXELS' };

  // 内容宽度 = 每行字符数 × 标准字符宽
  const contentW = config.charsPerLine * CHAR_WIDTH;
  contentText.resize(contentW, contentText.height);

  const frameW = 44 + contentW + 24;
  const frameH = Math.max(44, contentText.y + contentText.height + 16);
  popup.resize(frameW, frameH);

  const closeText = popup.children.find(
    (c) => c.type === 'TEXT' && c.name === 'popupClose',
  ) as TextNode | undefined;
  if (closeText) {
    closeText.x = frameW - closeText.width - 10;
  }
}

/** 数值范围约束 */
function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || isNaN(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

// ══════════════════════════════════════════════
// 位置自动关联（编号点在哪个图层内就跟哪个图层关联）
// ══════════════════════════════════════════════

/** 拖拽后自动关联的节流时间（ms） */
const RELINK_THROTTLE = 200;
let lastRelinkTime = 0;

/** trailing 补测：节流期间跳过的编号点，拖拽静止后补测最终位置 */
const pendingRelinkMarkers = new Set<GroupNode>();
let relinkFlushTimer: ReturnType<typeof setTimeout> | null = null;

/** 调度一次拖尾补测（250ms 后若位置未再变化则补测） */
function scheduleRelinkFlush(): void {
  if (relinkFlushTimer) return;
  relinkFlushTimer = setTimeout(() => {
    relinkFlushTimer = null;
    if (pendingRelinkMarkers.size === 0) return;
    const batch = Array.from(pendingRelinkMarkers);
    pendingRelinkMarkers.clear();
    for (const marker of batch) {
      if (!marker.removed) {
        detectAndUpdateBinding(marker, true);
      }
    }
  }, 250);
}

/** 命中检测：找到画布上位于指定点的最顶层图层 */
function hitTest(world: { x: number; y: number }): SceneNode | null {
  const topLevel = figma.currentPage.children;
  for (let i = topLevel.length - 1; i >= 0; i--) {
    const found = hitTestNode(topLevel[i], world);
    if (found) return found;
  }
  return null;
}

/** 递归命中检测（跳过编号点和浮窗） */
function hitTestNode(
  node: SceneNode,
  world: { x: number; y: number },
): SceneNode | null {
  if (node.name.startsWith(ANNOTATION_PREFIX)) return null;
  if (node.name.startsWith(POPUP_PREFIX)) return null;

  const box = node.absoluteBoundingBox;
  if (!box) return null;

  const inside =
    world.x >= box.x &&
    world.x <= box.x + box.width &&
    world.y >= box.y &&
    world.y <= box.y + box.height;
  if (!inside) return null;

  // 深入子节点寻找更精确的命中
  if ('children' in node && node.children.length > 0) {
    const children = node.children as SceneNode[];
    for (let i = children.length - 1; i >= 0; i--) {
      const found = hitTestNode(children[i], world);
      if (found) return found;
    }
  }

  return node;
}

/**
 * 检测编号点当前位置所在图层，自动更新关联：
 * - 命中图层且与当前绑定不同 → 切换到新图层
 * - 未命中任何图层 → 解除绑定（独立编号点）
 * @param force 是否跳过节流（trailing 补测时传 true）
 */
function detectAndUpdateBinding(marker: GroupNode, force = false): void {
  if (!force) {
    const now = Date.now();
    if (now - lastRelinkTime < RELINK_THROTTLE) {
      // 节流内：登记待补测，拖拽静止后补测最终位置
      pendingRelinkMarkers.add(marker);
      scheduleRelinkFlush();
      return;
    }
    lastRelinkTime = now;
  }

  const center = {
    x: marker.x + marker.width / 2,
    y: marker.y + marker.height / 2,
  };
  const hit = hitTest(center);

  const currentTargetId = marker.getPluginData(PD.targetNodeId);

  if (hit) {
    if (hit.id !== currentTargetId) {
      bindAnnotation(marker.getPluginData(PD.annotationId), hit);
    }
  } else if (currentTargetId) {
    // 拖到空白处 → 解除关联
    removeAnnotationRef(currentTargetId, marker.getPluginData(PD.annotationId));
    marker.setPluginData(PD.targetNodeId, '');
    marker.setPluginData(PD.offsetX, String(Math.round(marker.x)));
    marker.setPluginData(PD.offsetY, String(Math.round(marker.y)));
    figma.ui.postMessage({
      type: 'annotation-updated',
      annotation: readAnnotationData(marker),
    });
    backupAllAnnotations();
  }
}

/** 将编号点绑定到目标图层（可重复调用以重新绑定） */
function bindAnnotation(annotationId: string, target: SceneNode): void {
  const marker = findAnnotationById(annotationId);
  if (!marker || !target) return;

  // 先解除旧绑定
  const oldTargetId = marker.getPluginData(PD.targetNodeId);
  if (oldTargetId && oldTargetId !== target.id) {
    removeAnnotationRef(oldTargetId, annotationId);
  }

  marker.setPluginData(PD.targetNodeId, target.id);
  // 偏移量基于页面绝对坐标计算
  const box = target.absoluteBoundingBox;
  if (box) {
    marker.setPluginData(
      PD.offsetX,
      String(Math.round(marker.x - box.x)),
    );
    marker.setPluginData(
      PD.offsetY,
      String(Math.round(marker.y - box.y)),
    );
  }
  addAnnotationRef(target.id, annotationId);

  // 通知 UI
  figma.ui.postMessage({
    type: 'annotation-updated',
    annotation: readAnnotationData(marker),
  });

  // 绑定变化后重排浮窗（auto 模式浮窗跟随新图层位置）
  layoutAllPopups();

  backupAllAnnotations();
}

// ══════════════════════════════════════════════
// 选中与定位
// ══════════════════════════════════════════════

function handleSelectAnnotation(annotationId: string): void {
  const marker = findAnnotationById(annotationId);
  if (!marker) return;

  figma.currentPage.selection = [marker];
  figma.viewport.scrollAndZoomIntoView([marker]);
}

function handleLocateAnnotation(annotationId: string): void {
  handleSelectAnnotation(annotationId);
}

// ══════════════════════════════════════════════
// 自动重编号
// ══════════════════════════════════════════════

function renumberAll(): void {
  const allMarkers = findAllAnnotationGroups();
  allMarkers.sort(
    (a, b) =>
      Number(a.getPluginData(PD.order)) - Number(b.getPluginData(PD.order)),
  );

  allMarkers.forEach((marker, index) => {
    const newOrder = index + 1;
    const oldOrder = marker.getPluginData(PD.order);
    if (String(newOrder) !== oldOrder) {
      // 程序化修改：登记节点 ID，防护 documentchange 重入（避免触发自动重关联/假锁提示）
      markProgrammatic(marker.id);
      isProgrammaticMove = true;
      try {
        marker.setPluginData(PD.order, String(newOrder));
        // 更新文字（按类型查找，避免下标失效）
        const textNode = marker.children.find((c) => c.type === 'TEXT') as TextNode | undefined;
        if (textNode) {
          textNode.characters = String(newOrder);
        }
        // 更新名称
        marker.name = `${ANNOTATION_PREFIX} #${newOrder}`;
      } finally {
        isProgrammaticMove = false;
      }
      // 同步浮窗序号
      updatePopupNumber(marker.getPluginData(PD.annotationId), newOrder);
    }
  });

  // 兜底清理孤儿浮窗（编号点已删除但浮窗残留的情况）
  cleanupOrphanPopups();

  // 重排浮窗（编号变化后排列顺序可能改变）
  layoutAllPopups();

  // 同步到 UI
  syncAllAnnotations();

  // 更新备份
  backupAllAnnotations();
}

/** 重编号后同步浮窗中的序号 */
function updatePopupNumber(annotationId: string, order: number): void {
  const popup = activePopups.get(annotationId);
  if (!popup || popup.removed) return;

  const numText = popup.children.find(
    (c) => c.type === 'TEXT' && c.name === 'popupNum',
  ) as TextNode | undefined;
  if (numText) {
    numText.characters = String(order);
  }
  // 更新浮窗名称
  popup.name = `${POPUP_PREFIX} #${order}`;
}

// ══════════════════════════════════════════════
// 数据读取
// ══════════════════════════════════════════════

/** 从 Group 节点读取完整 Annotation 数据 */
function readAnnotationData(marker: GroupNode): AnnotationData {
  return {
    annotationId: marker.getPluginData(PD.annotationId),
    order: Number(marker.getPluginData(PD.order)),
    targetNodeId: marker.getPluginData(PD.targetNodeId),
    offsetX: Number(marker.getPluginData(PD.offsetX)),
    offsetY: Number(marker.getPluginData(PD.offsetY)),
    note: marker.getPluginData(PD.note),
    isLocked: marker.getPluginData(PD.isLocked),
    nodeId: marker.id,
    x: marker.x,
    y: marker.y,
  };
}

/** 全量同步：扫描页面上所有编号点，发送到 UI */
function syncAllAnnotations(): void {
  const all = findAllAnnotationGroups().map(readAnnotationData);
  all.sort((a, b) => a.order - b.order);
  figma.ui.postMessage({
    type: 'init',
    annotations: all,
    config: getConfig(),
  });
}

// ══════════════════════════════════════════════
// 查找工具
// ══════════════════════════════════════════════

/** 扫描当前页面所有编号点 Group（递归，以 PluginData 为准） */
function findAllAnnotationGroups(): GroupNode[] {
  return figma.currentPage.findAll(
    (n) => n.type === 'GROUP' && n.getPluginData(PD.annotationId) !== '',
  ) as GroupNode[];
}

/** 按 annotationId 查找编号点 */
function findAnnotationById(annotationId: string): GroupNode | null {
  if (!annotationId) return null;
  const found = figma.currentPage.findAll(
    (n) => n.type === 'GROUP' && n.getPluginData(PD.annotationId) === annotationId,
  );
  return (found[0] as GroupNode) || null;
}

/** 获取下一个可用序号 */
function getNextOrder(): number {
  const all = findAllAnnotationGroups();
  if (all.length === 0) return 1;
  const maxOrder = Math.max(
    ...all.map((g) => Number(g.getPluginData(PD.order)) || 0),
  );
  return maxOrder + 1;
}

// ══════════════════════════════════════════════
// 反向引用管理
// ══════════════════════════════════════════════

function addAnnotationRef(targetNodeId: string, annotationId: string): void {
  const target = figma.getNodeById(targetNodeId) as SceneNode | null;
  if (!target) return;

  const raw = target.getPluginData(REF_KEY);
  const refs: string[] = raw ? JSON.parse(raw) : [];
  if (!refs.includes(annotationId)) {
    refs.push(annotationId);
    target.setPluginData(REF_KEY, JSON.stringify(refs));
  }
}

function removeAnnotationRef(targetNodeId: string, annotationId: string): void {
  const target = figma.getNodeById(targetNodeId) as SceneNode | null;
  if (!target) return;

  const raw = target.getPluginData(REF_KEY);
  if (!raw) return;
  const refs: string[] = JSON.parse(raw);
  const updated = refs.filter((id) => id !== annotationId);
  target.setPluginData(REF_KEY, JSON.stringify(updated));
}

// ══════════════════════════════════════════════
// 工具函数
// ══════════════════════════════════════════════

/** 判断节点是否可以作为编号点的绑定目标 */
function isBindableNode(node: SceneNode): boolean {
  // 不能绑定到已有的编号点上
  return !node.name.startsWith(ANNOTATION_PREFIX);
}

/** 生成简单唯一 ID */
function generateId(): string {
  return (
    Math.random().toString(36).substring(2, 10) +
    Date.now().toString(36)
  );
}

// ══════════════════════════════════════════════
// 文档变更监听（拖拽检测 + 锁定复位）
// ══════════════════════════════════════════════

figma.on('documentchange', (event) => {
  for (const change of event.documentChanges) {
    // ── 删除事件：编号点只能通过插件删除，画布删除立即恢复 ──
    if (change.type === 'DELETE' && change.node.type === 'GROUP') {
      if (!programmaticDeleteIds.has(change.node.id)) {
        restoreDeletedMarker(change.node.id);
      }
      continue;
    }

    if (change.type !== 'PROPERTY_CHANGE') continue;
    const node = change.node as SceneNode;

    // 1. 编号点本身或其子节点发生变化（拖拽/缩放/改形状/改外观）
    //    → 更新偏移 或 锁定复位（锁定状态下任何修改都禁止）
    //    程序化修改（插件自身操作）按节点 ID 跳过，避免重入引发误解绑/假提示
    const marker = findMarkerOfNode(node);
    if (marker) {
      if (!programmaticChangeIds.has(marker.id)) {
        handleAnnotationChange(marker);
      }
      continue;
    }

    // 2. 目标图层被移动 → 关联的编号点跟随
    if (!isProgrammaticMove && hasPositionChanged(change.properties)) {
      handleTargetNodeMoved(node);
    }
  }
});

/** 向上回溯节点父链，找到所属的编号点 Group（含自身） */
function findMarkerOfNode(node: SceneNode): GroupNode | null {
  let current: BaseNode | null = node;
  while (current) {
    if (
      current.type === 'GROUP' &&
      current.name.startsWith(ANNOTATION_PREFIX)
    ) {
      return current as GroupNode;
    }
    current = current.parent;
  }
  return null;
}

/**
 * 备份所有编号点数据到 root PluginData
 * 用于画布删除时的恢复（DELETE 事件拿不到被删节点的 PluginData）
 */
function backupAllAnnotations(): void {
  const data = findAllAnnotationGroups().map(readAnnotationData);
  figma.root.setPluginData(PD.backup, JSON.stringify(data));
}

/** 用户从画布删除编号点：从备份恢复该编号点并提示 */
function restoreDeletedMarker(deletedId: string): void {
  const raw = figma.root.getPluginData(PD.backup);
  if (!raw) return;

  let list: AnnotationData[] = [];
  try {
    list = JSON.parse(raw);
  } catch {
    return;
  }

  const data = list.find((a) => a.nodeId === deletedId);
  if (!data) return;

  // 防重复：同 annotationId 的编号点已存在则不恢复
  // （场景：删除后用户按 Ctrl+Z 撤销，Figma 恢复了原始节点）
  if (findAnnotationById(data.annotationId)) return;

  figma.notify('编号点请通过插件面板删除');
  void restoreMarker(data);
}

/** 重建被删除的编号点并恢复全部数据 */
async function restoreMarker(data: AnnotationData): Promise<void> {
  const marker = await createMarkerNode(data.order, data.x, data.y);
  if (!marker) return;

  marker.setPluginData(PD.annotationId, data.annotationId);
  marker.setPluginData(PD.order, String(data.order));
  marker.setPluginData(PD.note, data.note);
  marker.setPluginData(PD.isLocked, data.isLocked);
  marker.setPluginData(PD.targetNodeId, data.targetNodeId);
  marker.setPluginData(PD.offsetX, String(data.offsetX));
  marker.setPluginData(PD.offsetY, String(data.offsetY));

  // 恢复锁定外观
  if (data.isLocked === 'true') {
    updateMarkerAppearance(marker);
  }

  // 恢复绑定关系
  if (data.targetNodeId) {
    const target = figma.getNodeById(data.targetNodeId) as SceneNode | null;
    if (target) {
      addAnnotationRef(data.targetNodeId, data.annotationId);
      // 立即把编号点放到绑定目标当前位置（备份可能过期）
      // 程序化定位：登记节点 ID，防护 documentchange 重入（避免恢复时立即触发自动重关联）
      const box = target.absoluteBoundingBox;
      if (box) {
        markProgrammatic(marker.id);
        isProgrammaticMove = true;
        try {
          marker.x = box.x + data.offsetX;
          marker.y = box.y + data.offsetY;
        } finally {
          isProgrammaticMove = false;
        }
      }
      // 恢复浮窗（有绑定目标时，浮窗一起回来）
      if (!activePopups.has(data.annotationId)) {
        showOrCreatePopup(marker, 'auto');
      }
    }
  }

  // 选中恢复的编号点
  figma.currentPage.selection = [marker];

  // 刷新备份（包含恢复的节点）
  backupAllAnnotations();
}

/** 清理孤儿浮窗：编号点已不存在但仍残留的浮窗 */
function cleanupOrphanPopups(): void {
  for (const [annotationId, popup] of activePopups) {
    if (popup.removed) {
      activePopups.delete(annotationId);
      continue;
    }
    if (!findAnnotationById(annotationId)) {
      popup.remove();
      activePopups.delete(annotationId);
    }
  }
  layoutAllPopups();
}

/**
 * 检测属性变更列表中是否包含位置相关属性
 */
function hasPositionChanged(properties: readonly string[]): boolean {
  return properties.includes('x') || properties.includes('y');
}

/**
 * 处理编号点及其子节点的属性变化
 * - 程序化移动：忽略
 * - 锁定状态下任何修改（拖拽/缩放/改形状/改外观）：完整复位并提示
 * - 正常状态下位置变化：更新偏移量
 */
function handleAnnotationChange(marker: GroupNode): void {
  if (isProgrammaticMove) return;

  if (marker.getPluginData(PD.isLocked) === 'true') {
    // 锁定 → 完整复位（位置 + 尺寸 + 外观）
    resetMarkerState(marker);
    notifyLockedThrottled();
    return;
  }

  // 正常拖拽 → 更新偏移量 + 自动重关联（编号点在哪个图层内就跟哪个图层关联）
  updateMarkerOffset(marker);
  detectAndUpdateBinding(marker);

  // 拖拽编号点时，其临时浮窗恢复到图层右侧布局
  const popup = activePopups.get(marker.getPluginData(PD.annotationId));
  if (popup && !popup.removed && popup.getPluginData('popupMode') === 'click') {
    restorePopupToAuto(popup, marker);
    layoutAllPopups();
  }

  // 同步 UI
  figma.ui.postMessage({
    type: 'annotation-updated',
    annotation: readAnnotationData(marker),
  });

  // 更新备份（位置变化）
  backupAllAnnotations();
}

/** 锁定提示节流：2 秒内最多提示一次（避免程序化复位触发连续弹窗） */
let lastLockedNotifyTime = 0;
function notifyLockedThrottled(): void {
  const now = Date.now();
  if (now - lastLockedNotifyTime > 2000) {
    figma.notify('该编号点已锁定，无法修改');
    lastLockedNotifyTime = now;
  }
}

/** 锁定状态下完整复位编号点：位置 + 尺寸 + 形状 + 外观 */
function resetMarkerState(marker: GroupNode): void {
  const ellipse = marker.children.find((c) => c.type === 'ELLIPSE') as EllipseNode | undefined;
  const text = marker.children.find((c) => c.type === 'TEXT') as TextNode | undefined;

  markProgrammatic(marker.id);
  isProgrammaticMove = true;
  try {
    // 1. 复位子节点局部位置与变换（解除翻转/镜像）
    if (ellipse) {
      ellipse.x = 0;
      ellipse.y = 0;
      ellipse.relativeTransform = IDENTITY_MATRIX;
      ellipse.rotation = 0;
    }
    if (text) {
      text.x = 0;
      text.y = 0;
      text.relativeTransform = IDENTITY_MATRIX;
      text.rotation = 0;
    }

    // 2. 尺寸复位（Group 及子节点恢复配置尺寸）
    const size = getMarkerSize();
    if (ellipse && (ellipse.width !== size || ellipse.height !== size)) {
      ellipse.resize(size, size);
    }
    if (text && (text.width !== size || text.height !== size)) {
      text.resize(size, size);
    }
    if (marker.width !== size || marker.height !== size) {
      marker.resize(size, size);
    }

    // 3. Group 自身变换复位（翻转/旋转）
    marker.rotation = 0;

    // 4. 外观复位
    updateMarkerAppearance(marker);

    // 5. 位置复位（基于存储的偏移量，放在最后以覆盖前面操作引起的位置变化）
    resetMarkerPosition(marker);
  } finally {
    isProgrammaticMove = false;
  }
}

/** 单位变换矩阵（用于解除翻转/镜像） */
const IDENTITY_MATRIX: Transform = [
  [1, 0, 0],
  [0, 1, 0],
] as Transform;

/**
 * 定时轮询：检查锁定编号点的状态完整性。
 * Figma 的部分操作（如垂直翻转）不触发 documentchange 事件，
 * 轮询作为兜底，发现状态与锁定基准不符立即复位。
 */
setInterval(checkLockedMarkers, 500);

/** 检查所有锁定编号点的状态 */
function checkLockedMarkers(): void {
  for (const marker of findAllAnnotationGroups()) {
    if (marker.getPluginData(PD.isLocked) !== 'true') continue;
    if (!isMarkerStateClean(marker)) {
      resetMarkerState(marker);
    }
  }
}

/** 校验锁定编号点状态是否与基准一致（位置/尺寸/形状/变换） */
function isMarkerStateClean(marker: GroupNode): boolean {
  // 位置
  const offsetX = Number(marker.getPluginData(PD.offsetX)) || 0;
  const offsetY = Number(marker.getPluginData(PD.offsetY)) || 0;
  let expectedX = offsetX;
  let expectedY = offsetY;
  const targetNodeId = marker.getPluginData(PD.targetNodeId);
  if (targetNodeId) {
    const target = figma.getNodeById(targetNodeId) as SceneNode | null;
    if (target) {
      const box = target.absoluteBoundingBox;
      if (box) {
        expectedX = box.x + offsetX;
        expectedY = box.y + offsetY;
      }
    }
  }
  if (Math.abs(marker.x - expectedX) > 0.5 || Math.abs(marker.y - expectedY) > 0.5) {
    return false;
  }

  // 尺寸与旋转
  const size = getMarkerSize();
  if (marker.width !== size || marker.height !== size) return false;
  if (marker.rotation !== 0) return false;

  // 子节点：局部位置、形状变换（翻转/镜像）
  const ellipse = marker.children.find((c) => c.type === 'ELLIPSE') as EllipseNode | undefined;
  const text = marker.children.find((c) => c.type === 'TEXT') as TextNode | undefined;

  if (ellipse) {
    if (ellipse.x !== 0 || ellipse.y !== 0) return false;
    if (ellipse.width !== size || ellipse.height !== size) return false;
    if (hasFlipTransform(ellipse.relativeTransform)) return false;
  }
  if (text) {
    if (text.x !== 0 || text.y !== 0) return false;
    if (hasFlipTransform(text.relativeTransform)) return false;
  }

  return true;
}

/** 检测变换矩阵是否包含翻转/镜像（矩阵的旋转缩放部分偏离单位矩阵） */
function hasFlipTransform(tr: Transform): boolean {
  return (
    Math.abs(tr[0][0] - 1) > 0.001 ||
    Math.abs(tr[0][1]) > 0.001 ||
    Math.abs(tr[1][0]) > 0.001 ||
    Math.abs(tr[1][1] - 1) > 0.001
  );
}

/** 用户拖拽后重新计算并存储偏移量 */
function updateMarkerOffset(marker: GroupNode): void {
  const targetNodeId = marker.getPluginData(PD.targetNodeId);

  if (targetNodeId) {
    const target = figma.getNodeById(targetNodeId) as SceneNode | null;
    if (target) {
      const box = target.absoluteBoundingBox;
      if (box) {
        marker.setPluginData(PD.offsetX, String(Math.round(marker.x - box.x)));
        marker.setPluginData(PD.offsetY, String(Math.round(marker.y - box.y)));
        return;
      }
    }
  }

  // 无绑定目标时，偏移量即绝对坐标
  marker.setPluginData(PD.offsetX, String(Math.round(marker.x)));
  marker.setPluginData(PD.offsetY, String(Math.round(marker.y)));
}

/** 将编号点复位到锁定时的位置（根据存储的偏移量 + 目标图层位置） */
function resetMarkerPosition(marker: GroupNode): void {
  const targetNodeId = marker.getPluginData(PD.targetNodeId);
  const offsetX = Number(marker.getPluginData(PD.offsetX)) || 0;
  const offsetY = Number(marker.getPluginData(PD.offsetY)) || 0;

  isProgrammaticMove = true;
  try {
    if (targetNodeId) {
      const target = figma.getNodeById(targetNodeId) as SceneNode | null;
      if (target) {
        const box = target.absoluteBoundingBox;
        if (box) {
          marker.x = box.x + offsetX;
          marker.y = box.y + offsetY;
          return;
        }
      }
    }
    marker.x = offsetX;
    marker.y = offsetY;
  } finally {
    isProgrammaticMove = false;
  }
}

/** 程序化移动编号点（由插件逻辑触发，不会被当作用户拖拽） */
function moveMarkerProgrammatically(marker: GroupNode, x: number, y: number): void {
  markProgrammatic(marker.id);
  isProgrammaticMove = true;
  try {
    marker.x = x;
    marker.y = y;
  } finally {
    isProgrammaticMove = false;
  }
}

/** 目标图层移动时，关联的编号点跟随，浮窗重排跟随 */
function handleTargetNodeMoved(targetNode: SceneNode): void {
  // 查找绑定到 targetNode 自身或其任意后代的编号点
  // （拖动顶层容器时，容器内子组件绑定的编号点也应跟随）
  const markers = findAllAnnotationGroups().filter((marker) => {
    const t = marker.getPluginData(PD.targetNodeId);
    return t && isNodeOrDescendant(targetNode, t);
  });
  if (markers.length === 0) return;

  // 每个编号点用自己的直接绑定目标的实时 absoluteBoundingBox 计算新位置
  // （容器移动后，子节点的 absoluteBoundingBox 已实时更新）
  for (const marker of markers) {
    const targetId = marker.getPluginData(PD.targetNodeId);
    const target = targetId ? (figma.getNodeById(targetId) as SceneNode | null) : null;
    if (!target) continue;
    const box = target.absoluteBoundingBox;
    if (!box) continue;

    const offsetX = Number(marker.getPluginData(PD.offsetX)) || 0;
    const offsetY = Number(marker.getPluginData(PD.offsetY)) || 0;
    moveMarkerProgrammatically(marker, box.x + offsetX, box.y + offsetY);
  }

  // 浮窗跟随：重排该容器下的所有浮窗
  layoutAllPopups();
}

/** 判断 targetId 是否为 node 自身或其后代节点 */
function isNodeOrDescendant(node: BaseNode, targetId: string): boolean {
  if (node.id === targetId) return true;
  if ('children' in node) {
    for (const child of node.children) {
      if (isNodeOrDescendant(child, targetId)) return true;
    }
  }
  return false;
}

/** 查找绑定到指定目标图层的所有编号点 */
function findAnnotationsByTargetId(targetNodeId: string): GroupNode[] {
  const results: GroupNode[] = [];
  for (const node of figma.currentPage.children) {
    if (
      node.type === 'GROUP' &&
      node.name.startsWith(ANNOTATION_PREFIX) &&
      node.getPluginData(PD.targetNodeId) === targetNodeId
    ) {
      results.push(node);
    }
  }
  return results;
}

// ══════════════════════════════════════════════
// 临时浮窗管理
// ══════════════════════════════════════════════

/** 活跃浮窗: annotationId → FrameNode */
const activePopups = new Map<string, FrameNode>();

const POPUP_PREFIX = '[Popup]';

/**
 * 选中变更监听：
 * - 选中编号点 → 显示/创建浮窗
 * - 选中浮窗（或其子节点）→ 关闭浮窗
 */
figma.on('selectionchange', () => {
  const selection = figma.currentPage.selection;

  if (selection.length === 1) {
    const node = selection[0];

    // 选中浮窗本身或其子节点 → 关闭它
    const popupFrame = findPopupFrameFromSelection(node);
    if (popupFrame) {
      closePopupByFrame(popupFrame);
      return;
    }

    // 选中编号点 → 显示浮窗 + 通知 UI 高亮
    if (node.type === 'GROUP' && node.name.startsWith(ANNOTATION_PREFIX)) {
      const annotationId = (node as GroupNode).getPluginData(PD.annotationId);
      showOrCreatePopup(node as GroupNode, 'click');
      figma.ui.postMessage({ type: 'annotation-selected', annotationId });
      return;
    }
  }

  // 选中其他内容 → 临时查看的浮窗恢复图层右侧布局，通知 UI 取消高亮
  restoreAllClickPopups();
  figma.ui.postMessage({ type: 'annotation-selected', annotationId: null });
});

/** 从选中节点回溯查找所属浮窗 Frame（含选中浮窗子节点的情况） */
function findPopupFrameFromSelection(node: SceneNode): FrameNode | null {
  let current: BaseNode | null = node;
  while (current) {
    if (
      current.type === 'FRAME' &&
      current.name.startsWith(POPUP_PREFIX)
    ) {
      return current as FrameNode;
    }
    current = current.parent;
  }
  return null;
}

/** 浮窗创建中的编号点 ID 集合（防止异步创建期间重复创建） */
const popupCreating = new Set<string>();

/** 刚由插件自动创建浮窗的编号点 ID（添加编号点后短暂生效，抑制自动选中触发的 click 移动） */
const autoCreatedIds = new Set<string>();

/**
 * 为编号点创建或刷新浮窗
 * - mode='auto'：创建后自动显示，位置在关联图层右侧（顶部对齐）；无关联则在编号点右侧
 * - mode='click'：点击编号点唤出，位置在编号点右侧
 */
function showOrCreatePopup(marker: GroupNode, mode: 'auto' | 'click'): void {
  const annotationId = marker.getPluginData(PD.annotationId);
  const existing = activePopups.get(annotationId);

  if (existing && !existing.removed) {
    // 已存在 → 点击唤出时移动到编号点旁，并刷新内容保证最新
    // （刚自动创建的不移动，避免添加时的自动选中把浮窗从图层右侧拉走）
    if (mode === 'click' && !autoCreatedIds.has(annotationId)) {
      positionPopupNearMarker(existing, marker);
      updatePopupContent(annotationId);
    }
    return;
  }

  // 创建中：忽略重复请求（添加时 auto 创建 + selectionchange 触发 click 的竞态）
  if (popupCreating.has(annotationId)) return;

  popupCreating.add(annotationId);
  if (mode === 'auto') {
    autoCreatedIds.add(annotationId);
  }

  // 创建新浮窗（异步加载字体）
  createPopupFrame(marker, mode)
    .then((popup) => {
      popupCreating.delete(annotationId);
      autoCreatedIds.delete(annotationId);
      if (!popup) return;
      // 竞态保护：创建期间编号点可能已被删除，此时丢弃刚创建的浮窗
      if (!findAnnotationById(annotationId)) {
        popup.remove();
        return;
      }
      activePopups.set(annotationId, popup);
      // 新建浮窗置顶：确保在页面最顶层，不被其他浮窗遮挡（利于编辑）
      figma.currentPage.appendChild(popup);
      // 创建完成后统一重排（考虑同容器多个浮窗）
      layoutAllPopups();
    })
    .catch(() => {
      // 创建失败（如字体加载失败）：清理标记，允许后续重试
      popupCreating.delete(annotationId);
      autoCreatedIds.delete(annotationId);
    });
}

/** 将浮窗移动到编号点右侧（点击模式：临时查看，不参与图层右侧布局） */
function positionPopupNearMarker(popup: FrameNode, marker: GroupNode): void {
  popup.x = marker.x + getMarkerSize() + 10;
  popup.y = marker.y;
  popup.setPluginData('popupMode', 'click');
}

/** 将浮窗恢复到图层右侧布局模式 */
function restorePopupToAuto(popup: FrameNode, marker: GroupNode): void {
  popup.setPluginData('popupMode', 'auto');
  positionPopupNearTarget(popup, marker);
}

/** 所有临时查看（click 模式）的浮窗恢复到图层右侧布局 */
function restoreAllClickPopups(): void {
  let changed = false;
  for (const [annotationId, popup] of activePopups) {
    if (popup.removed) continue;
    if (popup.getPluginData('popupMode') === 'click') {
      const marker = findAnnotationById(annotationId);
      if (marker) {
        restorePopupToAuto(popup, marker);
        changed = true;
      }
    }
  }
  if (changed) layoutAllPopups();
}

/**
 * 将浮窗定位到绑定图层的顶层容器右侧（顶部对齐）
 * 单个浮窗的初始定位，多浮窗排列由 layoutAllPopups 统一处理
 */
function positionPopupNearTarget(popup: FrameNode, marker: GroupNode): void {
  const targetNodeId = marker.getPluginData(PD.targetNodeId);
  if (!targetNodeId) {
    positionPopupNearMarker(popup, marker);
    return;
  }

  const target = figma.getNodeById(targetNodeId) as SceneNode | null;
  if (!target) {
    positionPopupNearMarker(popup, marker);
    return;
  }

  const container = getTopLevelAncestor(target);
  const box = container.absoluteBoundingBox;
  if (!box) {
    positionPopupNearMarker(popup, marker);
    return;
  }

  popup.x = box.x + box.width + 16;
  popup.y = box.y;
}

/** 获取节点的顶层祖先（父节点为 PAGE 的最外层节点） */
function getTopLevelAncestor(node: BaseNode): SceneNode {
  let current: BaseNode = node;
  while (current.parent && current.parent.type !== 'PAGE') {
    current = current.parent;
  }
  return current as SceneNode;
}

/**
 * 重新排列所有活跃浮窗：
 * 按顶层容器分组，同容器内的浮窗按编号从上到下排列，间隔 8px，互不重叠
 */
function layoutAllPopups(): void {
  // 收集: 顶层容器id → { container, popups }
  const groups = new Map<
    string,
    { container: SceneNode; popups: { marker: GroupNode; popup: FrameNode }[] }
  >();

  for (const [annotationId, popup] of activePopups) {
    if (popup.removed) continue;
    // 临时查看（click 模式）的浮窗不参与图层右侧布局
    if (popup.getPluginData('popupMode') === 'click') continue;
    const marker = findAnnotationById(annotationId);
    if (!marker) continue;

    const targetId = marker.getPluginData(PD.targetNodeId);
    if (!targetId) continue;
    const target = figma.getNodeById(targetId) as SceneNode | null;
    if (!target) continue;

    const container = getTopLevelAncestor(target);
    const key = container.id;
    if (!groups.has(key)) {
      groups.set(key, { container, popups: [] });
    }
    groups.get(key)!.popups.push({ marker, popup });
  }

  for (const { container, popups } of groups.values()) {
    // 按编号从小到大排序
    popups.sort((a, b) => {
      const oa = Number(a.marker.getPluginData(PD.order)) || 0;
      const ob = Number(b.marker.getPluginData(PD.order)) || 0;
      return oa - ob;
    });

    const box = container.absoluteBoundingBox;
    if (!box) continue;

    let cursorY = box.y;
    for (const { popup } of popups) {
      popup.x = box.x + box.width + 16;
      popup.y = cursorY;
      cursorY += popup.height + 8;
    }
  }
}

/**
 * 创建浮窗 Frame
 * 结构: [蓝色圆形序号 ①] [备注内容] [✕ 关闭]
 */
async function createPopupFrame(
  marker: GroupNode,
  mode: 'auto' | 'click',
): Promise<FrameNode | null> {
  const note = marker.getPluginData(PD.note) || '(暂无备注)';
  const order = marker.getPluginData(PD.order);
  const annotationId = marker.getPluginData(PD.annotationId);
  const config = getConfig();
  const badgeSize = getMarkerSize();

  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
  await figma.loadFontAsync({ family: 'Inter', style: 'Medium' });

  // ── 主 Frame ──
  const frame = figma.createFrame();
  frame.name = `${POPUP_PREFIX} #${order}`;
  frame.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  frame.cornerRadius = 8;
  frame.effects = [
    {
      type: 'DROP_SHADOW',
      color: { r: 0, g: 0, b: 0, a: 0.12 },
      offset: { x: 0, y: 4 },
      radius: 16,
      visible: true,
      blendMode: 'NORMAL',
    },
  ];
  frame.clipsContent = false;
  frame.setPluginData('popupFor', annotationId);

  // ── 圆形序号（与编号点同款颜色/尺寸） ──
  const badge = figma.createEllipse();
  badge.name = 'popupBadge';
  badge.resize(badgeSize, badgeSize);
  badge.fills = [{ type: 'SOLID', color: config.color }];
  badge.strokes = [{ type: 'SOLID', color: MARKER_STROKE_COLOR }];
  badge.strokeWeight = 2;
  badge.x = 10;
  badge.y = 10;

  // 序号数字（圆内居中）
  const numText = figma.createText();
  numText.name = 'popupNum';
  numText.characters = order;
  numText.fontSize = Math.max(10, Math.round(badgeSize / 2));
  numText.fontName = { family: 'Inter', style: 'Medium' };
  numText.fills = [{ type: 'SOLID', color: MARKER_TEXT_COLOR }];
  numText.x = 10 + (badgeSize - numText.width) / 2;
  numText.y = 10 + (badgeSize - numText.height) / 2;

  // ── 备注内容文字（字号用配置） ──
  const contentText = figma.createText();
  contentText.name = 'popupContent';
  contentText.characters = note.length > 120 ? note.substring(0, 120) + '…' : note;
  contentText.fontSize = config.fontSize;
  contentText.fontName = { family: 'Inter', style: 'Regular' };
  contentText.fills = [{ type: 'SOLID', color: { r: 0.102, g: 0.102, b: 0.102 } }];
  contentText.x = 44;
  contentText.y = 16;
  contentText.lineHeight = { value: config.fontSize + 6, unit: 'PIXELS' };

  // ── 关闭按钮 ──
  const closeText = figma.createText();
  closeText.name = 'popupClose';
  closeText.characters = '✕';
  closeText.fontSize = 13;
  closeText.fontName = { family: 'Inter', style: 'Regular' };
  closeText.fills = [{ type: 'SOLID', color: { r: 0.533, g: 0.533, b: 0.533 } }];

  // ── 组装与尺寸（内容宽度 = 每行字符数 × 标准字符宽） ──
  frame.appendChild(badge);
  frame.appendChild(numText);
  frame.appendChild(contentText);
  frame.appendChild(closeText);

  const contentW = config.charsPerLine * CHAR_WIDTH;
  contentText.resize(contentW, contentText.height);
  const frameW = 44 + contentW + 24;
  const frameH = Math.max(44, contentText.y + contentText.height + 16);
  frame.resize(frameW, frameH);
  closeText.x = frameW - closeText.width - 10;
  closeText.y = 8;

  // ── 位置 ──
  if (mode === 'auto') {
    positionPopupNearTarget(frame, marker);
  } else {
    positionPopupNearMarker(frame, marker);
  }

  // 插入当前页面（修复：此前未插入页面导致浮窗不可见）
  figma.currentPage.appendChild(frame);

  return frame;
}

/** 关闭并删除浮窗 Frame */
function closePopupByFrame(popupFrame: FrameNode): void {
  const annotationId = popupFrame.getPluginData('popupFor');
  if (annotationId) {
    activePopups.delete(annotationId);
  }
  popupFrame.remove();
  // 关闭后重排（剩余浮窗补位）
  layoutAllPopups();
}

/** 按 annotationId 关闭浮窗 */
function closePopup(annotationId: string): void {
  const popup = activePopups.get(annotationId);
  if (popup && !popup.removed) {
    popup.remove();
  }
  activePopups.delete(annotationId);
  layoutAllPopups();
}

/** 强制删除编号点对应的浮窗（含页面级兜底扫描，覆盖 map 状态异常） */
function removePopupForcefully(annotationId: string): void {
  // 1. 内存 map 清理
  const popup = activePopups.get(annotationId);
  if (popup && !popup.removed) {
    popup.remove();
  }
  activePopups.delete(annotationId);

  // 2. 页面兜底：扫描页面上所有浮窗，按 popupFor 标记强制删除
  for (const node of figma.currentPage.children) {
    if (node.type === 'FRAME' && node.name.startsWith(POPUP_PREFIX)) {
      const frame = node as FrameNode;
      if (frame.getPluginData('popupFor') === annotationId) {
        frame.remove();
      }
    }
  }

  layoutAllPopups();
}

// ══════════════════════════════════════════════
// 生命周期
// ══════════════════════════════════════════════

// 页面切换时重新同步列表和备份（跨页时编号点列表应跟随当前页）
figma.on('currentpagechange', () => {
  console.log('[编号标注] 页面切换，重新同步');
  syncAllAnnotations();
  backupAllAnnotations();
  cleanupOrphanPopups();
});

// 关闭插件时清理所有浮窗
figma.on('close', () => {
  for (const popup of activePopups.values()) {
    if (!popup.removed) popup.remove();
  }
  activePopups.clear();
  console.log('[编号标注] 插件已关闭');
});
