import type { ContentScriptContext } from '#imports';
import type { SelectionTarget } from './detector';

export interface SelectionTranslateButton {
  show(target: SelectionTarget): void;
  hide(): void;
  isVisible(): boolean;
  containsTarget(event: Event): boolean;
}

/**
 * 划词后的翻译按钮。只负责出现和点击，译文写回页面，不在浮层里展示结果。
 */
export async function createSelectionTranslateButton(
  ctx: ContentScriptContext,
  onTranslate: (target: SelectionTarget) => void,
): Promise<SelectionTranslateButton> {
  let visible = false;
  let current: SelectionTarget | null = null;
  let controller: SelectionTranslateButton | null = null;

  const ui = await createShadowRootUi(ctx, {
    name: 'uct-selection-popup',
    position: 'overlay',
    anchor: 'body',
    isolateEvents: ['mousedown', 'mouseup', 'click'],
    onMount(container) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'uct-translate';
      button.textContent = '翻译';
      button.style.display = 'none';
      button.addEventListener('mousedown', (event) => {
        event.preventDefault();
      });
      button.addEventListener('click', () => {
        if (!current) return;
        const target = current;
        hideButton();
        onTranslate(target);
      });
      container.append(button, createStyle());

      function hideButton() {
        button.style.display = 'none';
        visible = false;
        current = null;
      }

      function positionButton(point: { x: number; y: number }) {
        const margin = 8;
        const gap = 8;
        const width = button.offsetWidth || 50;
        const height = button.offsetHeight || 28;
        let left = point.x - width / 2;
        let top = point.y + gap;
        if (top + height > window.innerHeight - margin) {
          top = point.y - height - gap;
        }
        left = Math.min(Math.max(left, margin), window.innerWidth - width - margin);
        top = Math.max(top, margin);
        button.style.left = `${left}px`;
        button.style.top = `${top}px`;
      }

      const api: SelectionTranslateButton = {
        show(target) {
          current = target;
          button.style.display = 'block';
          visible = true;
          positionButton(target.point);
        },
        hide: hideButton,
        isVisible: () => visible,
        containsTarget(event) {
          return event.composedPath().includes(button);
        },
      };
      controller = api;
      return api;
    },
    onRemove(api) {
      api?.hide();
    },
  });

  ui.mount();

  return (
    controller ?? {
      show: () => {},
      hide: () => {},
      isVisible: () => false,
      containsTarget: () => false,
    }
  );
}

function createStyle(): HTMLElement {
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .uct-translate {
      position: fixed;
      left: 0;
      top: 0;
      z-index: 2147483647;
      border: 1px solid #4f7cff;
      background: #4f7cff;
      color: #fff;
      border-radius: 999px;
      padding: 4px 12px;
      font: 12px/1.4 system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif;
      cursor: pointer;
      box-shadow: 0 6px 16px rgba(79, 124, 255, 0.28);
    }
    .uct-translate:hover { background: #3b6aef; }
  `;
  return style;
}
