interface CaptionTrackPayload {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
}

interface PlayerPayload {
  playabilityStatus?: { status?: string; reason?: string };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: CaptionTrackPayload[];
    };
  };
}

const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';

/** 不走网页播放器的空地址，直接拿 timedtext 正文 */
export async function fetchYouTubeCaptionText(
  videoId: string,
  languageCode: string,
): Promise<string> {
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    throw new Error('视频编号无效');
  }
  const response = await fetch(PLAYER_URL, {
    method: 'POST',
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
  if (!response.ok) {
    throw new Error(`字幕列表请求失败（${response.status}）`);
  }
  const data = (await response.json()) as PlayerPayload;
  const playability = data.playabilityStatus?.status;
  if (playability && playability !== 'OK') {
    throw new Error(data.playabilityStatus?.reason || '视频无法播放');
  }
  const tracks = data.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const track = pickTrack(tracks, languageCode);
  if (!track?.baseUrl) throw new Error('这个视频没有字幕');
  assertTimedTextUrl(track.baseUrl);
  const timed = await fetch(track.baseUrl);
  if (!timed.ok) throw new Error(`字幕下载失败（${timed.status}）`);
  const text = await timed.text();
  if (!text.trim()) throw new Error('字幕内容为空');
  return text;
}

function pickTrack(tracks: CaptionTrackPayload[], languageCode: string): CaptionTrackPayload | null {
  const wanted = languageCode.toLowerCase();
  const pool = tracks.filter((track) => langMatches(track.languageCode ?? '', wanted));
  const list = pool.length > 0 ? pool : tracks;
  return list.find((track) => track.baseUrl && track.kind !== 'asr') ?? list.find((track) => track.baseUrl) ?? null;
}

function langMatches(actual: string, wanted: string): boolean {
  const left = actual.toLowerCase();
  const right = wanted.toLowerCase();
  if (!right) return true;
  if (!left) return false;
  return left === right || left.startsWith(right) || right.startsWith(left);
}

function assertTimedTextUrl(raw: string): void {
  const url = new URL(raw);
  const hostOk = url.hostname === 'www.youtube.com' || url.hostname === 'youtube.com';
  if (!hostOk || url.pathname !== '/api/timedtext') {
    throw new Error('字幕地址无效');
  }
}
