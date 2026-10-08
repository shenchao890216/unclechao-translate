import type { ViewMode } from '@/utils/types';

const HOST_ID = 'uct-video-overlay';
const HIDE_STYLE_ID = 'uct-hide-yt-cc-style';

export interface SubtitleView {
  mode: ViewMode;
  source?: string;
  target?: string;
  pending?: boolean;
  error?: string;
  status?: string;
}

/** 盖在播放器内部，全屏时跟着走。点击穿透，不挡住控制条。 */
export class SubtitleOverlay {
  private host: HTMLDivElement | null = null;
  private stack: HTMLDivElement | null = null;

  mount(player: HTMLElement, placement: 'player' | 'viewport' = 'player'): void {
    this.unmount();
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.dataset.placement = placement;
    host.style.cssText = [
      placement === 'viewport' ? 'position:fixed' : 'position:absolute',
      'left:0',
      'right:0',
      'bottom:0',
      placement === 'viewport' ? 'z-index:2147483646' : 'z-index:40',
      'pointer-events:none',
      'display:flex',
      'justify-content:center',
      placement === 'viewport' ? 'padding:0 16px 24px' : 'padding:0 8% 72px',
      'box-sizing:border-box',
    ].join(';');

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = OVERLAY_STYLE;
    const stack = document.createElement('div');
    stack.className = 'stack';
    stack.setAttribute('aria-live', 'polite');
    shadow.append(style, stack);

    player.appendChild(host);
    this.host = host;
    this.stack = stack;
  }

  isMounted(): boolean {
    return this.host?.isConnected ?? false;
  }

  unmount(): void {
    this.host?.remove();
    this.host = null;
    this.stack = null;
  }

  render(view: SubtitleView): void {
    const stack = this.stack;
    const player = document.getElementById('movie_player');
    if (!stack || !this.host) return;
    const controlsOpen = player ? !player.classList.contains('ytp-autohide') : true;
    if (this.host.dataset.placement !== 'viewport') {
      this.host.style.paddingBottom = controlsOpen ? '72px' : '6%';
    }
    stack.replaceChildren();

    if (view.status && !view.source) {
      stack.append(pill(view.status, 'status'));
      return;
    }
    if (!view.source) return;

    const same = !view.target || view.target === view.source;
    const showSource = view.mode !== 'target' || !view.target;
    const showTarget = view.mode !== 'source' && !!view.target && !same;

    if (showSource) stack.append(pill(view.source, showTarget ? 'source' : 'target'));
    if (showTarget && view.target) stack.append(pill(view.target, 'target'));
    if (view.mode !== 'source' && view.pending && !view.target) stack.append(pill('翻译中…', 'status'));
    if (view.mode !== 'source' && view.error && !view.target) stack.append(pill(view.error, 'error'));
  }
}

export function setNativeCaptionsHidden(hidden: boolean): void {
  ensureHideStyle();
  document.getElementById('movie_player')?.classList.toggle('uct-hide-yt-cc', hidden);
}

function ensureHideStyle(): void {
  let style = document.getElementById(HIDE_STYLE_ID);
  if (!style) {
    style = document.createElement('style');
    style.id = HIDE_STYLE_ID;
    document.documentElement.appendChild(style);
  }
  // 用透明而不是 display:none，节点还在，才能读到播放器正在显示的那句
  style.textContent =
    '#movie_player.uct-hide-yt-cc .ytp-caption-window-container{opacity:0!important;pointer-events:none!important}';
}

function pill(text: string, kind: 'source' | 'target' | 'status' | 'error'): HTMLDivElement {
  const node = document.createElement('div');
  node.className = `pill ${kind}`;
  node.textContent = text;
  return node;
}

const OVERLAY_STYLE = `
  .stack {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    max-width: 100%;
  }
  .pill {
    display: inline-block;
    max-width: 100%;
    box-sizing: border-box;
    padding: 3px 10px;
    border-radius: 6px;
    background: rgba(8, 8, 8, 0.78);
    color: #fff;
    text-align: center;
    line-height: 1.45;
    font-family: system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif;
  }
  .source { font-size: 14px; color: #f3f4f6; }
  .target { font-size: 20px; font-weight: 600; }
  .status { font-size: 13px; color: #e5e7eb; }
  .error { font-size: 12px; color: #fecaca; }
`;
