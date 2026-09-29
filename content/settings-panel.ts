const HOST_ID = 'uct-settings-host';

/**
 * 在网页右侧铺一条通高白栏，避开浏览器侧边栏自带的灰标题。
 * 再点一次「设置」、点关闭或按 Esc 都会收起。
 */
export function toggleSettingsPanel(): void {
  const existing = document.getElementById(HOST_ID);
  if (existing) {
    existing.remove();
    return;
  }

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.setAttribute('translate', 'no');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host {
        position: fixed;
        top: 0;
        right: 0;
        z-index: 2147483646;
        width: min(380px, 100vw);
        height: 100vh;
      }
      .sheet {
        position: relative;
        width: 100%;
        height: 100%;
        background: #fff;
        box-shadow: -12px 0 28px rgba(15, 23, 42, 0.08);
      }
      iframe {
        display: block;
        width: 100%;
        height: 100%;
        border: 0;
        background: #fff;
      }
      .close {
        position: absolute;
        top: 8px;
        right: 8px;
        z-index: 1;
        width: 28px;
        height: 28px;
        padding: 0;
        border: 0;
        border-radius: 6px;
        background: #fff;
        color: #1f2328;
        font: 18px/28px system-ui, sans-serif;
        cursor: pointer;
      }
      .close:hover {
        background: #f3f4f6;
      }
    </style>
    <div class="sheet">
      <iframe title="UncleChao Translate 设置"></iframe>
      <button type="button" class="close" aria-label="关闭">×</button>
    </div>
  `;

  const frame = shadow.querySelector('iframe');
  if (frame) frame.src = `${browser.runtime.getURL('/sidepanel.html')}?embed=1`;

  const close = (): void => host.remove();
  shadow.querySelector('.close')?.addEventListener('click', close);
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    close();
  };
  window.addEventListener('keydown', onKey, true);
  host.addEventListener('DOMNodeRemovedFromDocument', () => {
    window.removeEventListener('keydown', onKey, true);
  });

  document.documentElement.append(host);
}
