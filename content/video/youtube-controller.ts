import { MAX_CHARS_PER_BATCH, MAX_ITEMS_PER_BATCH } from '@/utils/constants';
import { requestTranslateBatch, requestYouTubeCaptions } from '@/utils/messaging';
import { loadSettings } from '@/utils/settings';
import type { ViewMode } from '@/utils/types';
import { currentWatchVideoId, isDesktopYouTube } from '@/utils/youtube';
import {
  captionUrlNeedsPlayer,
  isSoundCue,
  parseCaptionPayload,
  pickCaptionTrack,
  trackMatchesTarget,
  withCaptionFormat,
  type CaptionTrack,
  type Cue,
} from './cues';
import {
  isYouTubeTimedTextUrl,
  requestCaptionText,
  requestCaptionTracks,
  requestPlayerCaption,
} from './page-bridge';
import { setNativeCaptionsHidden, SubtitleOverlay } from './overlay';

const LOOKAHEAD_SEC = 40;
const LOOKBEHIND_SEC = 4;
const TICK_MS = 200;
const TRACK_RETRY_MS = 400;
/** 广告期间播放器里还是上一条视频的 id，多等一会儿 */
const TRACK_WAIT_MS = 20_000;

/**
 * YouTube 观看页字幕：读播放器字幕轨，只翻译当前时间附近的句子，叠在画面上。
 * session 在开关和切视频时递增，用来丢掉过期请求。
 */
export class YouTubeSubtitleController {
  private session = 0;
  private active = false;
  private viewMode: ViewMode = 'dual';
  private cues: Cue[] = [];
  private cache = new Map<number, string>();
  private textCache = new Map<string, string>();
  private translating = new Set<number>();
  private failed = new Set<number>();
  private lastError = '';
  private notice = '';
  private pumping = false;
  /** 完整字幕拿不到时，改译播放器正在显示的那一句 */
  private live = false;
  private liveCue: Cue | null = null;
  private liveSeen = '';
  private liveHadText = false;
  private liveClock = 0;
  private liveDebounce = 0;
  private nextLiveId = 1;
  private video: HTMLVideoElement | null = null;
  private lastTick = 0;
  private readonly overlay = new SubtitleOverlay();

  constructor() {
    if (!isDesktopYouTube()) return;
    document.addEventListener('yt-navigate-finish', () => {
      if (!this.active) return;
      if (!currentWatchVideoId()) {
        this.stop();
        return;
      }
      void this.start();
    });
  }

  setViewMode(mode: ViewMode): void {
    this.viewMode = mode;
    if (this.active) this.render();
  }

  toggle(): void {
    if (this.active) this.stop();
    else void this.start();
  }

  private async start(): Promise<void> {
    const session = ++this.session;
    this.active = true;
    this.pumping = false;
    this.cues = [];
    this.cache.clear();
    this.textCache.clear();
    this.translating.clear();
    this.failed.clear();
    this.lastError = '';
    this.notice = '';
    this.endLive();
    this.unbindVideo();

    const videoId = currentWatchVideoId();
    if (!videoId) {
      this.mountStatus(null, '请打开一个 YouTube 视频页');
      return;
    }

    const video = await waitForVideo(session, () => this.session);
    if (session !== this.session) return;
    if (!video) {
      this.mountStatus(findPlayer(), '没有找到视频');
      return;
    }
    const livePlayer = findPlayer() ?? video.parentElement;
    if (!(livePlayer instanceof HTMLElement)) return;

    this.overlay.mount(livePlayer);
    this.showNotice('正在读取字幕…');
    setNativeCaptionsHidden(true);
    this.beginLive(session);

    const loaded = await this.loadTracks(videoId, session);
    if (session !== this.session) return;
    if (!loaded.ok) {
      if (this.liveHadText) return;
      this.endLive();
      this.showNotice(
        loaded.reason === 'unavailable'
          ? '字幕组件没有加载，请刷新页面后再试'
          : '这个视频没有可用字幕',
      );
      setNativeCaptionsHidden(false);
      return;
    }
    const tracks = loaded.tracks;

    const settings = await loadSettings();
    if (session !== this.session) return;
    this.viewMode = settings.page.viewMode;
    const track = pickCaptionTrack(tracks, settings.targetLang);
    if (!track) {
      if (this.liveHadText) return;
      this.endLive();
      this.showNotice('这个视频没有可用字幕');
      setNativeCaptionsHidden(false);
      return;
    }
    if (trackMatchesTarget(track.languageCode, settings.targetLang)) {
      this.endLive();
      this.showNotice('当前字幕已是目标语言');
      setNativeCaptionsHidden(false);
      return;
    }

    const cues = await this.loadCues(track, session);
    if (session !== this.session) return;
    if (cues.length === 0) {
      if (this.liveHadText) return;
      this.endLive();
      this.showNotice(this.lastError || '没有读到字幕。请刷新页面后再打开翻译。');
      setNativeCaptionsHidden(false);
      return;
    }

    this.endLive();
    this.cache.clear();
    this.translating.clear();
    this.failed.clear();
    this.notice = '';
    this.cues = cues;
    this.bindVideo(video);
    this.pump(video.currentTime, session);
    this.render();
  }

  stop(): void {
    this.session += 1;
    this.active = false;
    this.pumping = false;
    this.unbindVideo();
    setNativeCaptionsHidden(false);
    this.endLive();
    this.overlay.unmount();
    this.notice = '';
    this.cues = [];
    this.cache.clear();
    this.translating.clear();
    this.failed.clear();
  }

  private mountStatus(player: HTMLElement | null, status: string): void {
    if (player) this.overlay.mount(player);
    else this.overlay.mount(document.body, 'viewport');
    this.showNotice(status);
  }

  private showNotice(message: string): void {
    this.notice = message;
    this.overlay.render({ mode: this.viewMode, status: message });
  }

  private async loadTracks(
    videoId: string,
    session: number,
  ): Promise<{ ok: true; tracks: CaptionTrack[] } | { ok: false; reason: 'empty' | 'unavailable' }> {
    const deadline = Date.now() + TRACK_WAIT_MS;
    let misses = 0;
    let emptyHits = 0;
    while (Date.now() < deadline) {
      if (session !== this.session || currentWatchVideoId() !== videoId) {
        return { ok: false, reason: 'unavailable' };
      }
      const page = await requestCaptionTracks();
      if (session !== this.session) return { ok: false, reason: 'unavailable' };
      if (!page) {
        misses += 1;
        if (misses >= 3) return { ok: false, reason: 'unavailable' };
        continue;
      }
      misses = 0;
      if (page.videoId === videoId && page.tracks.length > 0) {
        return { ok: true, tracks: page.tracks };
      }
      if (page.videoId === videoId) {
        emptyHits += 1;
        if (emptyHits >= 8) return { ok: false, reason: 'empty' };
      }
      await delay(TRACK_RETRY_MS);
    }
    return { ok: false, reason: 'empty' };
  }

  private async loadCues(track: CaptionTrack, session: number): Promise<Cue[]> {
    const downloaded = await requestYouTubeCaptions(currentWatchVideoId(), track.languageCode);
    if (session !== this.session) return [];
    if (downloaded.ok) {
      const cues = parseCaptionPayload(downloaded.text);
      if (cues.length > 0) {
        this.lastError = '';
        return cues;
      }
      this.lastError = '字幕内容无法解析';
    } else {
      this.lastError = downloaded.error;
    }

    const captured = await requestPlayerCaption(currentWatchVideoId(), track.languageCode);
    if (session !== this.session) return [];
    const fromPlayer = captured ? parseCaptionPayload(captured) : [];
    if (fromPlayer.length > 0) {
      this.lastError = '';
      return fromPlayer;
    }
    if (captionUrlNeedsPlayer(track.baseUrl)) return [];

    const urls = [
      ...new Set([
        track.baseUrl,
        withCaptionFormat(track.baseUrl, 'json3'),
        withCaptionFormat(track.baseUrl, 'srv3'),
      ]),
    ];
    for (const url of urls) {
      if (session !== this.session) return [];
      const raw = await this.readCaption(url, session);
      if (session !== this.session || !raw?.trim()) continue;
      const cues = parseCaptionPayload(raw);
      if (cues.length > 0) {
        this.lastError = '';
        return cues;
      }
    }
    return [];
  }

  /** 主世界请求最接近播放器；失败时再从 content script 拉一次 */
  private async readCaption(url: string, session: number): Promise<string | null> {
    const fromPage = await requestCaptionText(url);
    if (session !== this.session) return null;
    if (fromPage.ok) return fromPage.text.trim() ? fromPage.text : null;
    this.lastError = fromPage.error || '字幕请求失败';
    if (!isYouTubeTimedTextUrl(url)) return null;
    try {
      const response = await fetch(url, { credentials: 'include' });
      const text = await response.text();
      if (session !== this.session) return null;
      if (!response.ok) {
        this.lastError = `字幕请求失败（${response.status}）`;
        return null;
      }
      return text.trim() ? text : null;
    } catch (err) {
      if (session === this.session) {
        this.lastError = err instanceof Error ? err.message : this.lastError;
      }
      return null;
    }
  }

  private bindVideo(video: HTMLVideoElement): void {
    this.unbindVideo();
    this.video = video;
    video.addEventListener('timeupdate', this.onTime);
    video.addEventListener('seeked', this.onSeek);
  }

  private unbindVideo(): void {
    this.video?.removeEventListener('timeupdate', this.onTime);
    this.video?.removeEventListener('seeked', this.onSeek);
    this.video = null;
  }

  private readonly onTime = (): void => {
    if (!this.active || this.live) return;
    if (!this.video?.isConnected) {
      const next = findVideo();
      if (next) this.bindVideo(next);
      return;
    }
    const now = performance.now();
    if (now - this.lastTick < TICK_MS) return;
    this.lastTick = now;
    this.render();
    this.pump(this.video.currentTime, this.session);
  };

  private readonly onSeek = (): void => {
    if (!this.active || !this.video || this.live) return;
    this.render();
    this.pump(this.video.currentTime, this.session);
  };

  private beginLive(session: number): void {
    this.endLive();
    this.live = true;
    this.liveClock = window.setInterval(() => {
      if (session !== this.session || !this.live) return;
      this.pollLive(session);
    }, 300);
    this.pollLive(session);
  }

  private endLive(): void {
    this.live = false;
    window.clearInterval(this.liveClock);
    window.clearTimeout(this.liveDebounce);
    this.liveClock = 0;
    this.liveDebounce = 0;
    this.liveCue = null;
    this.liveSeen = '';
    this.liveHadText = false;
  }

  /** 画面上的字幕会逐词变长，停稳后再发给模型 */
  private pollLive(session: number): void {
    const text = readOnScreenCaption();
    if (text === this.liveSeen) return;
    this.liveSeen = text;
    window.clearTimeout(this.liveDebounce);
    if (!text) {
      this.liveCue = null;
      this.render();
      return;
    }
    const id = this.nextLiveId++;
    this.liveHadText = true;
    this.liveCue = { id, start: 0, end: Number.POSITIVE_INFINITY, text };
    const cached = this.textCache.get(text);
    if (cached) this.cache.set(id, cached);
    if (isSoundCue(text)) this.cache.set(id, text);
    this.render();
    if (cached || isSoundCue(text)) return;
    this.liveDebounce = window.setTimeout(() => {
      if (session !== this.session || this.liveCue?.text !== text) return;
      void this.translateLive(text, id, session);
    }, 400);
  }

  private async translateLive(text: string, id: number, session: number): Promise<void> {
    const cached = this.textCache.get(text);
    if (cached) {
      if (this.liveCue?.id === id) this.cache.set(id, cached);
      this.render();
      return;
    }
    this.translating.add(id);
    this.render();
    const response = await requestTranslateBatch([text], 'subtitle');
    this.translating.delete(id);
    if (session !== this.session) return;
    if (!response.ok) {
      this.lastError = response.error.message;
      if (this.liveCue?.id === id) this.failed.add(id);
      this.render();
      return;
    }
    const result = response.results[0];
    if (!result) {
      this.lastError = '返回结果缺失或为空';
      if (this.liveCue?.id === id) this.failed.add(id);
      this.render();
      return;
    }
    this.textCache.set(text, result);
    if (this.live && this.liveCue?.id === id) this.cache.set(id, result);
    this.render();
  }

  private render(): void {
    if (this.active && !this.overlay.isMounted()) {
      const player = findPlayer() ?? this.video?.parentElement ?? null;
      if (player instanceof HTMLElement) this.overlay.mount(player);
    }
    const time = this.video?.currentTime ?? 0;
    const cue = this.live ? this.liveCue : this.cues.find((item) => time >= item.start && time < item.end);
    if (!cue) {
      this.overlay.render({
        mode: this.viewMode,
        status: !this.liveHadText && this.cues.length === 0 ? this.notice || undefined : undefined,
      });
      return;
    }
    this.overlay.render({
      mode: this.viewMode,
      source: cue.text,
      target: this.cache.get(cue.id),
      pending: this.translating.has(cue.id),
      error: this.failed.has(cue.id) ? this.lastError || '翻译失败' : undefined,
    });
  }

  /** 只取当前时间前后一小段，避免一开就把整集字幕打给模型 */
  private pump(time: number, session: number): void {
    if (this.pumping || session !== this.session || !this.active) return;
    const batch = this.takeBatch(time);
    if (batch.length === 0) return;
    this.pumping = true;
    for (const cue of batch) this.translating.add(cue.id);
    this.render();
    void this.translateBatch(batch, session).finally(() => {
      if (session !== this.session) return;
      this.pumping = false;
      this.render();
      if (this.video) this.pump(this.video.currentTime, session);
    });
  }

  private takeBatch(time: number): Cue[] {
    const batch: Cue[] = [];
    let chars = 0;
    for (const cue of this.cues) {
      if (cue.start > time + LOOKAHEAD_SEC) break;
      if (cue.end < time - LOOKBEHIND_SEC) continue;
      if (this.cache.has(cue.id) || this.translating.has(cue.id) || this.failed.has(cue.id)) continue;
      if (isSoundCue(cue.text)) {
        this.cache.set(cue.id, cue.text);
        continue;
      }
      const cached = this.textCache.get(cue.text);
      if (cached) {
        this.cache.set(cue.id, cached);
        continue;
      }
      if (batch.length >= MAX_ITEMS_PER_BATCH) break;
      if (batch.length > 0 && chars + cue.text.length > MAX_CHARS_PER_BATCH) break;
      batch.push(cue);
      chars += cue.text.length;
    }
    return batch;
  }

  private async translateBatch(batch: Cue[], session: number): Promise<void> {
    const response = await requestTranslateBatch(
      batch.map((cue) => cue.text),
      'subtitle',
    );
    if (session !== this.session) return;
    if (!response.ok) {
      this.lastError = response.error.message;
      for (const cue of batch) {
        this.translating.delete(cue.id);
        this.failed.add(cue.id);
      }
      console.debug('[uct] subtitle batch failed:', response.error.code, response.error.message);
      return;
    }
    batch.forEach((cue, index) => {
      this.translating.delete(cue.id);
      const result = response.results[index];
      if (!result) {
        this.failed.add(cue.id);
        this.lastError = '返回结果缺失或为空';
        return;
      }
      this.cache.set(cue.id, result);
      this.textCache.set(cue.text, result);
    });
  }
}

function readOnScreenCaption(): string {
  const segments = document.querySelectorAll('#movie_player .ytp-caption-segment');
  const fromSegments = normalizeCaption(Array.from(segments).map((node) => node.textContent ?? '').join(' '));
  if (fromSegments) return fromSegments;
  const container = document.querySelector('#movie_player .ytp-caption-window-container');
  return normalizeCaption(container?.textContent ?? '');
}

function normalizeCaption(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function findPlayer(): HTMLElement | null {
  const player = document.getElementById('movie_player');
  return player instanceof HTMLElement ? player : null;
}

function findVideo(): HTMLVideoElement | null {
  const video = document.querySelector('video.html5-main-video');
  return video instanceof HTMLVideoElement ? video : null;
}

function waitForVideo(session: number, currentSession: () => number): Promise<HTMLVideoElement | null> {
  const existing = findVideo();
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const done = (video: HTMLVideoElement | null) => {
      observer.disconnect();
      window.clearTimeout(timer);
      resolve(video);
    };
    const observer = new MutationObserver(() => {
      if (currentSession() !== session) {
        done(null);
        return;
      }
      const video = findVideo();
      if (video) done(video);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    const timer = window.setTimeout(() => done(findVideo()), 8000);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
