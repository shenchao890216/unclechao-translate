export interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  kind: string;
  name: string;
}

export interface Cue {
  id: number;
  start: number;
  end: number;
  text: string;
}

interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: { utf8?: string }[];
}

interface RawSnippet {
  start: number;
  end: number;
  text: string;
  /** 前面有一个纯换行事件，表示自动字幕换行 */
  breakBefore: boolean;
}

const PREFERRED_LANGS = ['en', 'ja', 'ko', 'es', 'fr', 'de', 'ru', 'pt'];

/** 设置里的目标语言是显示名，这里只覆盖常见写法 */
const TARGET_PREFIXES: Record<string, string[]> = {
  中文: ['zh'],
  简体中文: ['zh-cn', 'zh-hans'],
  繁体中文: ['zh-tw', 'zh-hant', 'zh-hk'],
  英语: ['en'],
  英文: ['en'],
  日语: ['ja'],
  日文: ['ja'],
  韩语: ['ko'],
  韩文: ['ko'],
  法语: ['fr'],
  法文: ['fr'],
  德语: ['de'],
  德文: ['de'],
  西班牙语: ['es'],
  西语: ['es'],
  俄语: ['ru'],
  俄文: ['ru'],
};

export function trackMatchesTarget(languageCode: string, targetLang: string): boolean {
  const prefixes = TARGET_PREFIXES[targetLang.trim()];
  if (!prefixes) return false;
  const code = languageCode.toLowerCase();
  return prefixes.some(
    (prefix) => code === prefix || code.startsWith(`${prefix}-`) || (prefix === 'zh' && code.startsWith('zh')),
  );
}

/** 优先人工字幕，其次英语；目标语言的轨留到最后，调用方决定要不要提示「已是目标语言」 */
export function pickCaptionTrack(tracks: CaptionTrack[], targetLang: string): CaptionTrack | null {
  const usable = tracks.filter((track) => track.baseUrl && track.languageCode);
  if (usable.length === 0) return null;
  const foreign = usable.filter((track) => !trackMatchesTarget(track.languageCode, targetLang));
  const pool = foreign.length > 0 ? foreign : usable;
  const manual = pool.filter((track) => track.kind !== 'asr');
  const candidates = manual.length > 0 ? manual : pool;
  return [...candidates].sort((a, b) => langRank(a.languageCode) - langRank(b.languageCode))[0] ?? null;
}

export function isSoundCue(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return /^(\[[^\]\n]{1,40}\]|♪+|♫+)$/.test(trimmed);
}

/**
 * `exp=xpe` 的字幕地址缺播放器生成的 pot，直接请求会 200 但正文是空的。
 * 这种地址只能走播放器自己的请求。
 */
export function captionUrlNeedsPlayer(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).searchParams.get('exp') === 'xpe';
  } catch {
    return false;
  }
}

export function withCaptionFormat(baseUrl: string, fmt: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set('fmt', fmt);
  return url.toString();
}

/** json3 或 timedtext XML。解析失败返回空数组。 */
export function parseCaptionPayload(raw: string): Cue[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const data = JSON.parse(trimmed) as { events?: Json3Event[] };
      return eventsToCues(data.events ?? []);
    } catch {
      return [];
    }
  }
  if (trimmed.startsWith('<')) {
    try {
      return eventsToCues(parseTimedTextXml(trimmed));
    } catch {
      return [];
    }
  }
  return [];
}

function eventsToCues(events: Json3Event[]): Cue[] {
  const snippets = extractSnippets(events);
  const cues = isWordStream(snippets) ? mergeWordStream(snippets) : snippetsToCues(snippets);
  return closeOverlaps(cues);
}

function extractSnippets(events: Json3Event[]): RawSnippet[] {
  const snippets: RawSnippet[] = [];
  let breakBefore = false;
  for (const event of events) {
    const raw = (event.segs ?? []).map((seg) => seg.utf8 ?? '').join('');
    if (!raw) continue;
    if (!raw.trim()) {
      if (raw.includes('\n')) breakBefore = true;
      continue;
    }
    const start = (event.tStartMs ?? 0) / 1000;
    const duration = (event.dDurationMs ?? 0) / 1000;
    const text = decodeXml(raw).replace(/\s+/g, ' ').trim();
    if (!text) {
      breakBefore = true;
      continue;
    }
    snippets.push({
      start,
      end: duration > 0 ? start + duration : start,
      text,
      breakBefore,
    });
    breakBefore = raw.endsWith('\n');
  }
  return snippets;
}

/** 自动字幕按词给时间，人工字幕一条事件就是一句 */
function isWordStream(snippets: RawSnippet[]): boolean {
  if (snippets.some((snippet) => snippet.breakBefore)) return true;
  if (snippets.length < 8) return false;
  const short = snippets.filter((snippet) => snippet.text.length <= 16).length;
  return short / snippets.length > 0.7;
}

function snippetsToCues(snippets: RawSnippet[]): Cue[] {
  return snippets.map((snippet, id) => ({
    id,
    start: snippet.start,
    end: snippet.end > snippet.start ? snippet.end : snippet.start + 2,
    text: snippet.text,
  }));
}

function mergeWordStream(snippets: RawSnippet[]): Cue[] {
  const cues: Cue[] = [];
  let parts: string[] = [];
  let start = 0;
  let end = 0;

  const flush = () => {
    const text = parts.join(' ').replace(/\s+/g, ' ').trim();
    parts = [];
    if (!text) return;
    cues.push({
      id: cues.length,
      start,
      end: Math.max(end, start + 0.3),
      text,
    });
  };

  for (const snippet of snippets) {
    if (parts.length > 0 && /^[.!?。！？…,，、]+$/.test(snippet.text)) {
      const last = parts[parts.length - 1] ?? '';
      parts[parts.length - 1] = last + snippet.text;
      end = Math.max(end, snippet.end, snippet.start + 0.25);
      continue;
    }
    const gap = parts.length > 0 ? snippet.start - end : 0;
    const last = parts[parts.length - 1] ?? '';
    const sentenceDone = /[.!?。！？…]$/.test(last);
    const tooLong = parts.join(' ').length > 90;
    const tooSlow = parts.length > 0 && snippet.start - start > 7;
    if (parts.length > 0 && (snippet.breakBefore || gap > 1 || sentenceDone || tooLong || tooSlow)) {
      flush();
    }
    if (parts.length === 0) start = snippet.start;
    parts.push(snippet.text);
    end = Math.max(snippet.end, snippet.start + 0.25);
  }
  flush();
  return cues;
}

function closeOverlaps(cues: Cue[]): Cue[] {
  const sorted = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  const closed: Cue[] = [];
  for (const cue of sorted) {
    const prev = closed[closed.length - 1];
    if (prev && cue.start < prev.end) prev.end = cue.start;
    if (prev && prev.end <= prev.start) closed.pop();
    closed.push({ ...cue });
  }
  const last = closed[closed.length - 1];
  if (last && last.end <= last.start) closed.pop();
  return closed.map((cue, id) => ({ ...cue, id }));
}

function parseTimedTextXml(xml: string): Json3Event[] {
  const events: Json3Event[] = [];
  const paragraph = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  for (const match of xml.matchAll(paragraph)) {
    const attrs = match[1] ?? '';
    events.push({
      tStartMs: Number(/t="(\d+)"/.exec(attrs)?.[1] ?? 0),
      dDurationMs: Number(/d="(\d+)"/.exec(attrs)?.[1] ?? 0),
      segs: [{ utf8: stripTags(match[2] ?? '') }],
    });
  }
  if (events.length > 0) return events;

  const text = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
  for (const match of xml.matchAll(text)) {
    const attrs = match[1] ?? '';
    const start = Number(/start="([\d.]+)"/.exec(attrs)?.[1] ?? 0);
    const dur = Number(/dur="([\d.]+)"/.exec(attrs)?.[1] ?? 0);
    events.push({
      tStartMs: Math.round(start * 1000),
      dDurationMs: Math.round(dur * 1000),
      segs: [{ utf8: stripTags(match[2] ?? '') }],
    });
  }
  return events;
}

function fromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  return String.fromCodePoint(code);
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, '');
}

function decodeXml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function langRank(languageCode: string): number {
  const code = languageCode.toLowerCase();
  const index = PREFERRED_LANGS.findIndex((prefix) => code === prefix || code.startsWith(`${prefix}-`));
  return index === -1 ? PREFERRED_LANGS.length : index;
}
