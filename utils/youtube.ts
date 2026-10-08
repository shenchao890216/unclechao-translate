/** 桌面版 YouTube 观看页。Shorts 和移动版播放器结构不同，不在这次范围内。 */
export function isYouTubeWatchUrl(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return (
      (url.hostname === 'www.youtube.com' || url.hostname === 'youtube.com') &&
      url.pathname === '/watch' &&
      url.searchParams.has('v')
    );
  } catch {
    return false;
  }
}

export function isDesktopYouTube(): boolean {
  return location.hostname === 'www.youtube.com' || location.hostname === 'youtube.com';
}

export function currentWatchVideoId(): string {
  return new URLSearchParams(location.search).get('v') ?? '';
}
