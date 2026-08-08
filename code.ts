/**
 * Figma 编号标注插件 — 沙箱主入口
 */

// ══════════════════════════════════════════════
// 常量
// ══════════════════════════════════════════════

const MARKER_SIZE = 24;
const MARKER_COLOR: RGBA = { r: 0.29, g: 0.565, b: 0.851, a: 1 }; // #4A90D9
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
} as const;

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
  figma.ui.resize(320, 480);
  figma.ui.postMessage({ type: 'panel-expanded' });
  syncAllAnnotations();
}

function handleCollapsePanel(): void {
  figma.ui.resize(48, 48);
  figma.ui.postMessage({ type: 'panel-collapsed' });
}

// ══════════════════════════════════════════════
// 创建编号点
// ══════════════════════════════════════════════

async function handleAddAnnotation(): Promise<void> {
  // 1. 确定位置与绑定目标
  let startX: number;
  let startY: number;
  let targetNodeId = '';

  const selection = figma.currentPage.selection;

  if (selection.length === 1 && isBindableNode(selection[0])) {
    const node = selection[0];
    startX = node.x + node.width + 40;
    startY = node.y;
    targetNodeId = node.id;
  } else {
    startX = figma.viewport.center.x;
    startY = figma.viewport.center.y;
  }

  // 2. 分配序号
  const nextOrder = getNextOrder();

  // 3. 加载字体并创建标记节点
  const marker = await createMarkerNode(nextOrder, startX, startY);

  // 4. 写入 PluginData
  const annotationId = generateId();
  marker.setPluginData(PD.annotationId, annotationId);
  marker.setPluginData(PD.order, String(nextOrder));
  marker.setPluginData(PD.note, '');
  marker.setPluginData(PD.isLocked, 'false');

  if (targetNodeId) {
    marker.setPluginData(PD.targetNodeId, targetNodeId);
    const target = figma.getNodeById(targetNodeId) as SceneNode;
    marker.setPluginData(PD.offsetX, String(Math.round(marker.x - target.x)));
    marker.setPluginData(PD.offsetY, String(Math.round(marker.y - target.y)));
    addAnnotationRef(targetNodeId, annotationId);
  } else {
    marker.setPluginData(PD.targetNodeId, '');
    marker.setPluginData(PD.offsetX, String(Math.round(marker.x)));
    marker.setPluginData(PD.offsetY, String(Math.round(marker.y)));
  }

  // 5. 通知 UI
  const data = readAnnotationData(marker);
  figma.ui.postMessage({ type: 'annotation-added', annotation: data });

  // 6. 选中新建的编号点
  figma.currentPage.selection = [marker];
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

  // -- 圆形 --
  const ellipse = figma.createEllipse();
  ellipse.resize(MARKER_SIZE, MARKER_SIZE);
  ellipse.fills = [{ type: 'SOLID', color: MARKER_COLOR }];
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

  // -- 文字 --
  const text = figma.createText();
  text.characters = String(order);
  text.fontSize = 12;
  text.fontName = { family: 'Inter', style: 'Medium' };
  text.fills = [{ type: 'SOLID', color: MARKER_TEXT_COLOR }];
  text.textAlignHorizontal = 'CENTER';
  text.textAlignVertical = 'CENTER';
  text.resize(MARKER_SIZE, MARKER_SIZE);

  // -- 组合 --
  // 先将 ellipse 和 text 创建在 (0,0)，组合后再移动到目标位置
  const group = figma.group([ellipse, text], figma.currentPage);
  group.name = `${ANNOTATION_PREFIX} #${order}`;
  group.x = x;
  group.y = y;
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

  // 删除节点
  marker.remove();

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
}

/**
 * 根据锁定状态更新编号点的视觉样式
 */
function updateMarkerAppearance(marker: GroupNode): void {
  const isLocked = marker.getPluginData(PD.isLocked) === 'true';
  const ellipse = marker.children[0] as EllipseNode;

  if (isLocked) {
    ellipse.fills = [{ type: 'SOLID', color: { r: 0.753, g: 0.769, b: 0.8 } }]; // #C0C4CC
  } else {
    ellipse.fills = [{ type: 'SOLID', color: MARKER_COLOR }];
  }
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
      marker.setPluginData(PD.order, String(newOrder));
      // 更新文字
      const textNode = marker.children[1] as TextNode;
      textNode.characters = String(newOrder);
      // 更新名称
      marker.name = `${ANNOTATION_PREFIX} #${newOrder}`;
    }
  });

  // 同步到 UI
  syncAllAnnotations();
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
  figma.ui.postMessage({ type: 'init', annotations: all });
}

// ══════════════════════════════════════════════
// 查找工具
// ══════════════════════════════════════════════

/** 扫描当前页面所有编号点 Group */
function findAllAnnotationGroups(): GroupNode[] {
  const results: GroupNode[] = [];
  for (const node of figma.currentPage.children) {
    if (
      node.type === 'GROUP' &&
      node.name.startsWith(ANNOTATION_PREFIX)
    ) {
      results.push(node);
    }
  }
  return results;
}

/** 按 annotationId 查找编号点 */
function findAnnotationById(annotationId: string): GroupNode | null {
  for (const node of figma.currentPage.children) {
    if (
      node.type === 'GROUP' &&
      node.name.startsWith(ANNOTATION_PREFIX) &&
      node.getPluginData(PD.annotationId) === annotationId
    ) {
      return node;
    }
  }
  return null;
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
    // ── 删除事件：若删除的是 GROUP（可能为编号点），触发重编号 ──
    if (change.type === 'DELETE' && change.node.type === 'GROUP') {
      handleCanvasDelete();
      continue;
    }

    // ── 属性变更：位置移动 ──
    if (
      change.type !== 'PROPERTY_CHANGE' ||
      !hasPositionChanged(change.properties)
    ) {
      continue;
    }

    const node = change.node as SceneNode;

    // 1. 编号点本身被拖拽 → 更新偏移或锁定复位
    if (
      node.type === 'GROUP' &&
      node.name.startsWith(ANNOTATION_PREFIX)
    ) {
      handleAnnotationPositionChange(node as GroupNode);
    }

    // 2. 目标图层被移动 → 关联的编号点跟随
    if (!isProgrammaticMove) {
      handleTargetNodeMoved(node);
    }
  }
});

/** 用户从画布上直接删除编号点（按 Delete 键等），触发重编号 */
function handleCanvasDelete(): void {
  console.log('[code] 检测到 GROUP 被从画布删除，触发重编号');
  renumberAll();
}

/**
 * 检测属性变更列表中是否包含位置相关属性
 */
function hasPositionChanged(properties: readonly string[]): boolean {
  return properties.includes('x') || properties.includes('y');
}

/**
 * 处理编号点的位置变化
 * - 程序化移动：忽略
 * - 锁定状态下用户拖拽：复位并提示
 * - 正常状态下用户拖拽：更新偏移量
 */
function handleAnnotationPositionChange(marker: GroupNode): void {
  if (isProgrammaticMove) return;

  if (marker.getPluginData(PD.isLocked) === 'true') {
    // 锁定 → 复位
    resetMarkerPosition(marker);
    figma.notify('该编号点已锁定，无法移动');
    return;
  }

  // 正常拖拽 → 更新偏移量
  updateMarkerOffset(marker);

  // 同步 UI
  figma.ui.postMessage({
    type: 'annotation-updated',
    annotation: readAnnotationData(marker),
  });
}

/** 用户拖拽后重新计算并存储偏移量 */
function updateMarkerOffset(marker: GroupNode): void {
  const targetNodeId = marker.getPluginData(PD.targetNodeId);

  if (targetNodeId) {
    const target = figma.getNodeById(targetNodeId) as SceneNode | null;
    if (target) {
      marker.setPluginData(PD.offsetX, String(Math.round(marker.x - target.x)));
      marker.setPluginData(PD.offsetY, String(Math.round(marker.y - target.y)));
      return;
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
        marker.x = target.x + offsetX;
        marker.y = target.y + offsetY;
        return;
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
  isProgrammaticMove = true;
  try {
    marker.x = x;
    marker.y = y;
  } finally {
    isProgrammaticMove = false;
  }
}

/** 目标图层移动时，关联的编号点跟随 */
function handleTargetNodeMoved(targetNode: SceneNode): void {
  const markers = findAnnotationsByTargetId(targetNode.id);
  if (markers.length === 0) return;

  for (const marker of markers) {
    const offsetX = Number(marker.getPluginData(PD.offsetX)) || 0;
    const offsetY = Number(marker.getPluginData(PD.offsetY)) || 0;
    moveMarkerProgrammatically(marker, targetNode.x + offsetX, targetNode.y + offsetY);
  }
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
 * - 选中浮窗本身 → 关闭浮窗
 */
figma.on('selectionchange', () => {
  const selection = figma.currentPage.selection;

  if (selection.length === 1) {
    const node = selection[0];

    // 选中浮窗 Frame → 关闭它
    if (node.type === 'FRAME' && node.name.startsWith(POPUP_PREFIX)) {
      closePopupByFrame(node as FrameNode);
      return;
    }

    // 选中编号点 → 显示浮窗 + 通知 UI 高亮
    if (node.type === 'GROUP' && node.name.startsWith(ANNOTATION_PREFIX)) {
      const annotationId = (node as GroupNode).getPluginData(PD.annotationId);
      showOrCreatePopup(node as GroupNode);
      figma.ui.postMessage({ type: 'annotation-selected', annotationId });
      return;
    }
  }

  // 选中其他内容 → 通知 UI 取消高亮（但不自动关闭浮窗，浮窗需手动关闭）
  figma.ui.postMessage({ type: 'annotation-selected', annotationId: null });
});

/** 为编号点创建或刷新浮窗 Frame */
function showOrCreatePopup(marker: GroupNode): void {
  const annotationId = marker.getPluginData(PD.annotationId);
  const existing = activePopups.get(annotationId);

  if (existing && !existing.removed) {
    // 已存在 → 更新位置（编号点可能被拖拽了）
    existing.x = marker.x + MARKER_SIZE + 10;
    existing.y = marker.y;
    return;
  }

  // 创建新浮窗（异步加载字体）
  createPopupFrame(marker).then((popup) => {
    if (popup) {
      activePopups.set(annotationId, popup);
    }
  });
}

/** 创建浮窗 Frame */
async function createPopupFrame(marker: GroupNode): Promise<FrameNode | null> {
  const note = marker.getPluginData(PD.note) || '(暂无备注)';
  const order = marker.getPluginData(PD.order);
  const annotationId = marker.getPluginData(PD.annotationId);

  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });

  // 主 Frame
  const frame = figma.createFrame();
  frame.name = `${POPUP_PREFIX} #${order}`;
  frame.x = marker.x + MARKER_SIZE + 10;
  frame.y = marker.y;
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

  // 存储关联的编号点 ID
  frame.setPluginData('popupFor', annotationId);

  // 关闭提示文字（右上角）
  const closeText = figma.createText();
  closeText.characters = '✕ 点击此处关闭';
  closeText.fontSize = 10;
  closeText.fontName = { family: 'Inter', style: 'Regular' };
  closeText.fills = [{ type: 'SOLID', color: { r: 0.533, g: 0.533, b: 0.533 } }];
  closeText.x = 12;
  closeText.y = 8;

  // 备注内容文字
  const contentText = figma.createText();
  contentText.characters = note.length > 120 ? note.substring(0, 120) + '…' : note;
  contentText.fontSize = 12;
  contentText.fontName = { family: 'Inter', style: 'Regular' };
  contentText.fills = [{ type: 'SOLID', color: { r: 0.102, g: 0.102, b: 0.102 } }];
  contentText.x = 12;
  contentText.y = 28;
  contentText.lineHeight = { value: 18, unit: 'PIXELS' };

  // 调整 Frame 尺寸
  const maxWidth = Math.min(Math.max(contentText.width + 24, 200), 260);
  frame.resize(maxWidth, contentText.y + contentText.height + 16);
  contentText.resize(maxWidth - 24, contentText.height);

  // 组装
  frame.appendChild(closeText);
  frame.appendChild(contentText);

  return frame;
}

/** 关闭并删除浮窗 Frame */
function closePopupByFrame(popupFrame: FrameNode): void {
  const annotationId = popupFrame.getPluginData('popupFor');
  if (annotationId) {
    activePopups.delete(annotationId);
  }
  popupFrame.remove();
}

/** 按 annotationId 关闭浮窗 */
function closePopup(annotationId: string): void {
  const popup = activePopups.get(annotationId);
  if (popup && !popup.removed) {
    popup.remove();
  }
  activePopups.delete(annotationId);
}

// ══════════════════════════════════════════════
// 生命周期
// ══════════════════════════════════════════════

// 关闭插件时清理所有浮窗
figma.on('close', () => {
  for (const popup of activePopups.values()) {
    if (!popup.removed) popup.remove();
  }
  activePopups.clear();
  console.log('[编号标注] 插件已关闭');
});
