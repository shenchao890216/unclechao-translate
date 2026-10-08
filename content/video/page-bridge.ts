import type { CaptionTrack } from './cues';

const SOURCE = 'uct-yt';

export interface PageTracks {
  videoId: string;
  tracks: CaptionTrack[];
}

interface TracksMessage extends PageTracks {
  source: typeof SOURCE;
  type: 'TRACKS';
  requestId: string;
}

interface CaptionMessage {
  source: typeof SOURCE;
  type: 'CAPTION_TEXT';
  requestId: string;
  ok: boolean;
  text: string;
  error?: string;
}

/** 播放器对象在页面主世界，隔离的 content script 读不到，只能让主世界脚本回传 */
export function requestCaptionTracks(): Promise<PageTracks | null> {
  return requestPage({ type: 'GET_TRACKS' }, 800).then((message) => {
    if (!message || message.type !== 'TRACKS') return null;
    return { videoId: message.videoId, tracks: sanitizeTracks(message.tracks) };
  });
}

/** 等播放器自己把带 pot 的字幕请求发出去，再把正文拿回来 */
export function requestPlayerCaption(videoId: string, languageCode: string): Promise<string | null> {
  return requestPage({ type: 'TAKE_CAPTION', videoId, languageCode }, 12_000).then((message) => {
    if (!message || message.type !== 'CAPTION_TEXT' || !message.ok || !message.text.trim()) return null;
    return message.text;
  });
}

export function requestCaptionText(url: string): Promise<{ ok: boolean; text: string; error?: string }> {
  if (!isYouTubeTimedTextUrl(url)) {
    return Promise.resolve({ ok: false, text: '', error: '字幕地址无效' });
  }
  return requestPage({ type: 'FETCH_CAPTION', url }, 15000).then((message) => {
    if (!message || message.type !== 'CAPTION_TEXT') {
      return { ok: false, text: '', error: '读取字幕超时' };
    }
    return { ok: message.ok, text: message.text, error: message.error };
  });
}

function requestPage(
  payload:
    | { type: 'GET_TRACKS' }
    | { type: 'FETCH_CAPTION'; url: string }
    | { type: 'TAKE_CAPTION'; videoId: string; languageCode: string },
  timeoutMs: number,
): Promise<TracksMessage | CaptionMessage | null> {
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener('message', onMessage);
      resolve(null);
    }, timeoutMs);

    const onMessage = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== location.origin) return;
      const data = event.data as { source?: string; requestId?: string; type?: string } | null;
      if (!data || data.source !== SOURCE || data.requestId !== requestId) return;
      if (data.type !== 'TRACKS' && data.type !== 'CAPTION_TEXT') return;
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(data as TracksMessage | CaptionMessage);
    };

    window.addEventListener('message', onMessage);
    window.postMessage({ source: SOURCE, requestId, ...payload }, '*');
  });
}

export function isYouTubeTimedTextUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      (url.hostname === 'www.youtube.com' || url.hostname === 'youtube.com') &&
      url.pathname === '/api/timedtext'
    );
  } catch {
    return false;
  }
}

function sanitizeTracks(value: unknown): CaptionTrack[] {
  if (!Array.isArray(value)) return [];
  const tracks: CaptionTrack[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const track = item as Partial<CaptionTrack>;
    if (typeof track.baseUrl !== 'string' || typeof track.languageCode !== 'string') continue;
    if (!isYouTubeTimedTextUrl(track.baseUrl)) continue;
    tracks.push({
      baseUrl: track.baseUrl,
      languageCode: track.languageCode,
      kind: typeof track.kind === 'string' ? track.kind : '',
      name: typeof track.name === 'string' ? track.name : track.languageCode,
    });
  }
  return tracks;
}
