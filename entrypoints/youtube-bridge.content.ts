const SOURCE = 'uct-yt';

interface YtCaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
  name?: { simpleText?: string; runs?: { text?: string }[] };
}

interface YtPlayerResponse {
  videoDetails?: { videoId?: string };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: YtCaptionTrack[];
    };
  };
}

interface YtPlayer {
  getPlayerResponse?: () => YtPlayerResponse | undefined;
  loadModule?: (name: string) => void;
  getOption?: (module: string, option: string) => unknown;
  setOption?: (module: string, option: string, value: unknown) => void;
}

interface CaptionOption {
  languageCode?: string;
}

interface PageRequest {
  source?: string;
  type?: string;
  requestId?: string;
  url?: string;
  videoId?: string;
  languageCode?: string;
}

interface CapturedCaption {
  url: string;
  text: string;
  videoId: string;
  lang: string;
}

export default defineContentScript({
  matches: ['*://www.youtube.com/*', '*://youtube.com/*'],
  runAt: 'document_start',
  world: 'MAIN',
  // YouTube 自己监听 postMessage，不需要 WXT 再发一条启动消息
  noScriptStartedPostMessage: true,
  main() {
    const marker = '__uctYtBridge';
    const page = window as Window & { ytInitialPlayerResponse?: YtPlayerResponse; [marker]?: boolean };
    if (page[marker]) return;
    page[marker] = true;

    const captures: CapturedCaption[] = [];
    installCaptionTap(captures);
    window.addEventListener('yt-navigate-start', () => {
      captures.length = 0;
    });

    window.addEventListener('message', (event) => {
      if (event.source !== window || event.origin !== location.origin) return;
      const data = event.data as PageRequest | null;
      if (!data || data.source !== SOURCE || typeof data.requestId !== 'string') return;
      if (data.type === 'GET_TRACKS') {
        const state = readTracks(page);
        window.postMessage({ source: SOURCE, type: 'TRACKS', requestId: data.requestId, ...state }, '*');
        return;
      }
      if (data.type === 'FETCH_CAPTION' && typeof data.url === 'string') {
        void fetchCaption(data.requestId, data.url);
        return;
      }
      if (data.type === 'TAKE_CAPTION' && typeof data.videoId === 'string') {
        void ensureCaption(captures, data.requestId, data.videoId, data.languageCode ?? '');
      }
    });
  },
});

/** 播放器自己的 timedtext 请求带 pot，直接用字幕列表里的地址则经常是空正文 */
function installCaptionTap(captures: CapturedCaption[]): void {
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await originalFetch(input, init);
    const url = requestUrl(input);
    if (url.includes('/api/timedtext')) {
      void response
        .clone()
        .text()
        .then((text) => remember(captures, url, text))
        .catch(() => undefined);
    }
    return response;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest & { __uctUrl?: string },
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ) {
    this.__uctUrl = String(url);
    return origOpen.call(this, method, url, async ?? true, username, password);
  };
  XMLHttpRequest.prototype.send = function (
    this: XMLHttpRequest & { __uctUrl?: string },
    body?: Document | XMLHttpRequestBodyInit | null,
  ) {
    this.addEventListener('load', () => {
      const url = this.__uctUrl ?? '';
      if (!url.includes('/api/timedtext')) return;
      try {
        const text =
          this.responseType === 'json' && this.response != null
            ? JSON.stringify(this.response)
            : this.responseType === '' || this.responseType === 'text'
              ? this.responseText
              : '';
        remember(captures, url, text);
      } catch {
        // responseType 不是 text 时读 responseText 会抛
      }
    });
    return origSend.call(this, body);
  };
}

function remember(captures: CapturedCaption[], rawUrl: string, text: string): void {
  if (!looksLikeCaptions(text)) return;
  let videoId = '';
  let lang = '';
  try {
    const url = new URL(rawUrl, location.origin);
    videoId = url.searchParams.get('v') ?? '';
    lang = url.searchParams.get('lang') ?? '';
  } catch {
    return;
  }
  const next = { url: rawUrl, text, videoId, lang };
  const index = captures.findIndex((item) => item.videoId === videoId && item.lang === lang);
  if (index >= 0) captures[index] = next;
  else captures.push(next);
  if (captures.length > 8) captures.shift();
}

async function ensureCaption(
  captures: CapturedCaption[],
  requestId: string,
  videoId: string,
  languageCode: string,
): Promise<void> {
  const ready = findCapture(captures, videoId, languageCode);
  if (ready) {
    reply(requestId, true, ready);
    return;
  }

  // 网页播放器给的字幕地址带 exp=xpe，直接请求是空的。安卓客户端的地址没有这层限制。
  try {
    const androidText = await fetchAndroidCaption(videoId, languageCode);
    if (androidText) {
      reply(requestId, true, androidText);
      return;
    }
  } catch {
    // 继续等播放器自己的请求
  }

  const deadline = Date.now() + 7000;
  let forced = false;
  armPlayer(languageCode, false);
  while (Date.now() < deadline) {
    if (pageVideoId() !== videoId) {
      reply(requestId, false, '', '视频已切换');
      return;
    }
    const found = findCapture(captures, videoId, languageCode) ?? readVideoTextTracks(languageCode);
    if (found) {
      reply(requestId, true, found);
      return;
    }
    if (!forced && Date.now() + 5500 > deadline) {
      forced = true;
      armPlayer(languageCode, true);
    }
    await delay(250);
  }
  reply(requestId, false, '', '播放器没有返回字幕内容');
}

async function fetchAndroidCaption(videoId: string, languageCode: string): Promise<string | null> {
  const response = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      context: {
        client: {
          clientName: 'ANDROID',
          clientVersion: '20.10.38',
          hl: 'en',
          gl: 'US',
        },
      },
      videoId,
    }),
  });
  if (!response.ok) return null;
  const data = (await response.json()) as YtPlayerResponse;
  const tracks = data.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const track = pickAndroidTrack(tracks, languageCode);
  if (!track?.baseUrl || !isTimedTextUrl(track.baseUrl)) return null;
  const timed = await fetch(track.baseUrl, { credentials: 'include' });
  if (!timed.ok) return null;
  const text = await timed.text();
  return looksLikeCaptions(text) ? text : null;
}

function pickAndroidTrack(tracks: YtCaptionTrack[], languageCode: string): YtCaptionTrack | null {
  const wanted = languageCode.toLowerCase();
  const pool = tracks.filter((track) => langMatches(track.languageCode ?? '', wanted));
  const list = pool.length > 0 ? pool : tracks;
  return (
    list.find((track) => track.baseUrl && track.kind !== 'asr') ??
    list.find((track) => track.baseUrl) ??
    null
  );
}

function findCapture(captures: CapturedCaption[], videoId: string, languageCode: string): string | null {
  for (let index = captures.length - 1; index >= 0; index -= 1) {
    const item = captures[index];
    if (!item || (item.videoId && item.videoId !== videoId)) continue;
    if (item.lang && !langMatches(item.lang, languageCode)) continue;
    return item.text;
  }
  return null;
}

function armPlayer(languageCode: string, forceClick: boolean): void {
  const player = document.getElementById('movie_player') as (HTMLElement & YtPlayer) | null;
  if (player?.setOption) {
    try {
      player.loadModule?.('captions');
    } catch {
      // 模块已经加载过
    }
    const list = player.getOption?.('captions', 'tracklist');
    const tracks = Array.isArray(list) ? list.filter(isCaptionOption) : [];
    const wanted = languageCode.toLowerCase();
    const match =
      tracks.find((track) => (track.languageCode ?? '').toLowerCase() === wanted) ??
      tracks.find((track) => (track.languageCode ?? '').toLowerCase().startsWith(wanted.slice(0, 2))) ??
      tracks[0];
    if (match) {
      try {
        player.setOption('captions', 'track', match);
      } catch {
        // 播放器还没准备好字幕模块
      }
    }
  }
  if (forceClick) turnCaptionsOn();
}

function turnCaptionsOn(): void {
  const button = document.querySelector('.ytp-subtitles-button');
  if (!(button instanceof HTMLElement)) return;
  const on =
    button.getAttribute('aria-pressed') === 'true' || button.classList.contains('ytp-subtitles-button-active');
  if (!on) button.click();
}

function readVideoTextTracks(languageCode: string): string | null {
  const video = document.querySelector('video.html5-main-video');
  if (!(video instanceof HTMLVideoElement)) return null;
  const wanted = languageCode.toLowerCase();
  for (const track of video.textTracks) {
    const lang = (track.language || '').toLowerCase();
    if (wanted && lang && !langMatches(lang, wanted)) continue;
    if (track.mode === 'disabled') track.mode = 'hidden';
    if (!track.cues || track.cues.length === 0) continue;
    const events = Array.from(track.cues).map((cue) => ({
      tStartMs: Math.round(cue.startTime * 1000),
      dDurationMs: Math.round((cue.endTime - cue.startTime) * 1000),
      segs: [{ utf8: cueText(cue) }],
    }));
    return JSON.stringify({ events });
  }
  return null;
}

function readTracks(page: Window & { ytInitialPlayerResponse?: YtPlayerResponse }): {
  videoId: string;
  tracks: { baseUrl: string; languageCode: string; kind: string; name: string }[];
} {
  const player = document.getElementById('movie_player') as (HTMLElement & YtPlayer) | null;
  const response = player?.getPlayerResponse?.() ?? page.ytInitialPlayerResponse;
  const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  return {
    videoId: response?.videoDetails?.videoId ?? '',
    tracks: tracks.flatMap((track) => {
      if (!track.baseUrl || !track.languageCode || !isTimedTextUrl(track.baseUrl)) return [];
      return [
        {
          baseUrl: track.baseUrl,
          languageCode: track.languageCode,
          kind: track.kind ?? '',
          name: trackName(track),
        },
      ];
    }),
  };
}

async function fetchCaption(requestId: string, rawUrl: string): Promise<void> {
  if (!isTimedTextUrl(rawUrl)) {
    reply(requestId, false, '', '字幕地址无效');
    return;
  }
  try {
    const response = await fetch(rawUrl, { credentials: 'include' });
    const text = await response.text();
    if (!response.ok) {
      reply(requestId, false, '', `字幕请求失败（${response.status}）`);
      return;
    }
    if (!text.trim()) {
      reply(requestId, false, '', '字幕内容为空');
      return;
    }
    reply(requestId, true, text);
  } catch (err) {
    reply(requestId, false, '', err instanceof Error && err.message ? err.message : '字幕请求失败');
  }
}

function reply(requestId: string, ok: boolean, text: string, error?: string): void {
  window.postMessage({ source: SOURCE, type: 'CAPTION_TEXT', requestId, ok, text, error }, '*');
}

function trackName(track: YtCaptionTrack): string {
  if (track.name?.simpleText) return track.name.simpleText;
  const runs = track.name?.runs?.map((run) => run.text ?? '').join('');
  return runs || track.languageCode || '';
}

function isTimedTextUrl(raw: string): boolean {
  try {
    const url = new URL(raw, location.origin);
    return (
      (url.hostname === 'www.youtube.com' || url.hostname === 'youtube.com') &&
      url.pathname === '/api/timedtext'
    );
  } catch {
    return false;
  }
}

function looksLikeCaptions(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2) return false;
  if (/^<!doctype html/i.test(trimmed) || trimmed.startsWith('<html')) return false;
  return trimmed.includes('<text ') || trimmed.includes('<p ') || trimmed.includes('"segs"') || trimmed.includes('"utf8"');
}

function langMatches(actual: string, wanted: string): boolean {
  const left = actual.toLowerCase();
  const right = wanted.toLowerCase();
  if (!right) return true;
  if (!left) return false;
  return left === right || left.startsWith(right) || right.startsWith(left);
}

function cueText(cue: TextTrackCue): string {
  return 'text' in cue && typeof cue.text === 'string' ? cue.text : '';
}

function isCaptionOption(value: unknown): value is CaptionOption {
  return typeof value === 'object' && value !== null;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
  return '';
}

function pageVideoId(): string {
  return new URLSearchParams(location.search).get('v') ?? '';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
