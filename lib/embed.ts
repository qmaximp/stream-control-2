const YT_HOSTS = ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com", "youtu.be"];

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
      return u.toString();
    }
    if (videoId) return `https://www.youtube.com/embed/${videoId}`;

    const list = u.searchParams.get("list");
    if (list) return `https://www.youtube.com/embed/videoseries?list=${list}`;
    return u.toString();
  } catch {
    return raw;
  }
}
