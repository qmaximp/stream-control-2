const YT_HOSTS = ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com", "youtu.be"];

// автозапуск видео: параметр autoplay=1 имеет смысл только для embed-плеера YouTube
export function withAutoplay(url: string, on?: boolean): string {
  if (!on || !/youtube(-nocookie)?\.com\/embed\//.test(url)) return url;
  return url + (url.includes("?") ? "&" : "?") + "autoplay=1";
}

// embed-плеер YouTube стартует без звука: звук включается вручную в самом iframe
export function withMuted(url: string): string {
  if (!isYouTubeEmbed(url)) return url;
  return url + (url.includes("?") ? "&" : "?") + "mute=1";
}

export function isYouTubeEmbed(url: string): boolean {
  return /youtube(-nocookie)?\.com\/embed\//.test(url || "");
}

export function isYouTubeSrc(src: string): boolean {
  return isYouTubeEmbed(toEmbedUrl(src || ""));
}

// YouTube принимает postMessage-команды и шлёт состояние (infoDelivery) только
// при origin, совпадающем со страницей-хостом: без него пауза/плей/громкость
// из панели молча не доходят до оверлея
export function withOrigin(url: string): string {
  if (!isYouTubeEmbed(url) || typeof window === "undefined") return url;
  return url + (url.includes("?") ? "&" : "?") + "origin=" + encodeURIComponent(window.location.origin);
}

// «чистый» плеер: без родной панели управления и рекомендаций. Управление берёт
// на себя элемент панели (своя плашка), а оверлей всегда показывает чистый кадр —
// родной UI YouTube на паузе не прячется и оставался бы в стриме
export function withCleanPlayer(url: string): string {
  if (!isYouTubeEmbed(url)) return url;
  return url + (url.includes("?") ? "&" : "?") + "controls=0&rel=0&iv_load_policy=3&disablekb=1";
}

// ID видео из youtube-ссылки (для превью-заставки); "" — если это не одиночное видео
export function youtubeId(src: string): string {
  const embed = toEmbedUrl(src || "");
  if (embed.includes("videoseries")) return ""; // плейлист — одиночной заставки нет
  const m = /\/embed\/([A-Za-z0-9_-]+)/.exec(embed);
  return m ? m[1] : "";
}

export function toEmbedUrl(raw: string): string {
  let url = (raw || "").trim();
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  try {
    const u = new URL(url);
    if (!YT_HOSTS.includes(u.hostname.toLowerCase())) return u.toString();

    let videoId = "";
    if (u.hostname.toLowerCase() === "youtu.be") {
      videoId = u.pathname.slice(1);
    } else if (u.pathname === "/watch") {
      videoId = u.searchParams.get("v") || "";
    } else if (u.pathname.startsWith("/shorts/") || u.pathname.startsWith("/live/")) {
      videoId = u.pathname.split("/")[2] || "";
    } else if (u.pathname.startsWith("/embed/")) {
      u.searchParams.set("enablejsapi", "1");
      return u.toString();
    }
    if (videoId) return `https://www.youtube.com/embed/${videoId}?enablejsapi=1`;

    const list = u.searchParams.get("list");
    if (list) return `https://www.youtube.com/embed/videoseries?list=${list}&enablejsapi=1`;
    return u.toString();
  } catch {
    return raw;
  }
}
