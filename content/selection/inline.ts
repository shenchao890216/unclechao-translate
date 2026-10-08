import { formatFailureLabel, injectPageStyles } from '@/content/page-translate/injector';

/** 划词译过的原文节点。只标记选中的那一段，整页翻译收集文本时跳过 */
const translatedSource = new WeakSet<Text>();

export interface SelectionSourceSlice {
  node: Text;
  start: number;
  end: number;
}

export function isSelectionTranslatedText(node: Text): boolean {
  return translatedSource.has(node);
}

/** 选区里的文字是否都已经划词译过（含划词译文本身） */
export function isAlreadyTranslatedSelection(range: Range): boolean {
  const nodes = textNodesInRange(range).filter((node) => {
    const offsets = sliceOffsets(node, range);
    return offsets.end > offsets.start && !!node.data.slice(offsets.start, offsets.end).trim();
  });
  if (nodes.length === 0) return false;
  return nodes.every(
    (node) => translatedSource.has(node) || !!node.parentElement?.closest('[data-uct-selection]'),
  );
}

/** 在插入占位之前记下选区，避免占位文字被当成原文 */
export function captureSelectionSource(range: Range): SelectionSourceSlice[] {
  const slices: SelectionSourceSlice[] = [];
  for (const node of textNodesInRange(range)) {
    if (node.parentElement?.closest('[data-uct-selection]')) continue;
    const offsets = sliceOffsets(node, range);
    if (offsets.end <= offsets.start) continue;
    if (!node.data.slice(offsets.start, offsets.end).trim()) continue;
    slices.push({ node, ...offsets });
  }
  return slices;
}

/** 划词成功后，把选中的原文节点标成已译。节点会被切到刚好覆盖选区 */
export function applySelectionSourceMarks(slices: SelectionSourceSlice[]): void {
  for (const slice of slices) {
    const isolated = isolateSlice(slice);
    if (isolated) translatedSource.add(isolated);
  }
}

function textNodesInRange(range: Range): Text[] {
  const root = range.commonAncestorContainer;
  if (root instanceof Text) return [root];
  const ancestor = root instanceof Element ? root : root.parentElement;
  if (!ancestor) return [];
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(ancestor, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    if (current instanceof Text && rangeIntersects(range, current)) nodes.push(current);
    current = walker.nextNode();
  }
  return nodes;
}

function rangeIntersects(range: Range, node: Text): boolean {
  try {
    return range.intersectsNode(node);
  } catch {
    return false;
  }
}

function sliceOffsets(node: Text, range: Range): { start: number; end: number } {
  const start = node === range.startContainer ? range.startOffset : 0;
  const end = node === range.endContainer ? range.endOffset : node.length;
  return { start, end };
}

function isolateSlice(slice: SelectionSourceSlice): Text | null {
  const { node } = slice;
  if (!node.isConnected || translatedSource.has(node)) return node.isConnected ? node : null;
  if (node.parentElement?.closest('[data-uct-selection]')) return null;
  const start = Math.max(0, Math.min(slice.start, node.length));
  const end = Math.max(start, Math.min(slice.end, node.length));
  if (end <= start || !node.data.slice(start, end).trim()) return null;
  let target = node;
  if (end < target.length) target.splitText(end);
  if (start > 0) target = target.splitText(start);
  return target;
}

/** 在选区末尾插入「翻译中…」，返回占位节点，结果回来后原地替换 */
export function insertSelectionPending(range: Range): HTMLElement | null {
  if (!range.startContainer.isConnected) return null;
  injectPageStyles();
  const slot = document.createElement('span');
  slot.className = 'uct-pending';
  slot.dataset.uctSelection = '1';
  slot.setAttribute('translate', 'no');
  slot.textContent = '翻译中…';
  try {
    const at = range.cloneRange();
    at.collapse(false);
    at.insertNode(slot);
  } catch {
    return null;
  }
  return slot;
}

export function fillSelectionResult(slot: HTMLElement, text: string): void {
  slot.className = 'uct-tl';
  slot.textContent = text;
  slot.removeAttribute('title');
}

export function fillSelectionError(slot: HTMLElement, message: string): void {
  slot.className = 'uct-failed';
  slot.textContent = formatFailureLabel(message);
  slot.title = message;
}
