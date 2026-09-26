export const dynamic = "force-dynamic";

import { verifySession } from "@/lib/session";
import { readLinks, writeLinks } from "@/lib/links";

type Emote = { platform: "twitch" | "7tv" | "bttv" | "ffz"; code: string; url: string };

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); } catch { return null; }
}

// app access token для Helix (действует час, кэшируем)
let appToken: { token: string; expires: number } | null = null;
async function getAppToken(): Promise<string | null> {
  const cid = process.env.TWITCH_CLIENT_ID;
  const sec = process.env.TWITCH_CLIENT_SECRET;
  if (!cid || !sec) return null;
  if (appToken && appToken.expires > Date.now() + 60000) return appToken.token;
  const res = await safe(() =>
    fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: cid, client_secret: sec, grant_type: "client_credentials" }),
    }).then((r) => r.json())
  );
  if (!res?.access_token) return null;
  appToken = { token: res.access_token, expires: Date.now() + (res.expires_in ?? 3600) * 1000 };
  return appToken.token;
}

async function helix(path: string): Promise<any | null> {
  const token = await getAppToken();
  const cid = process.env.TWITCH_CLIENT_ID;
  if (!token || !cid) return null;
  const res = await safe(() =>
    fetch(`https://api.twitch.tv/helix/${path}`, {
      headers: { "Client-Id": cid, Authorization: `Bearer ${token}` },
    })
  );
  if (!res || !res.ok) return null;
  return res.json();
}

// логин -> id канала (Helix, при отсутствии ключей — публичный ivr.fi)
const userIdCache = new Map<string, string>();
async function twitchUserId(login: string): Promise<string | null> {
  const key = login.toLowerCase();
  if (userIdCache.has(key)) return userIdCache.get(key)!;
  const helixData = await helix(`users?login=${encodeURIComponent(key)}`);
  const id = helixData?.data?.[0]?.id ?? null;
  if (id) { userIdCache.set(key, id); return id; }
  const ivr = await safe(() =>
    fetch(`https://api.ivr.fi/v2/twitch/user?login=${encodeURIComponent(key)}`).then((r) => r.json())
  );
  if (Array.isArray(ivr) && ivr[0]?.id) { userIdCache.set(key, ivr[0].id); return ivr[0].id; }
  return null;
}

// user-токен Helix для chat/emotes/channel (с app-токеном Twitch возвращает 404).
// Приоритет: токен владельца канала из links.json (корректен для user_id-эндпоинтов),
// затем токен из cookie-сессии. Просроченный обновляем по refresh_token.
async function refreshEntryToken(channel: string): Promise<string | null> {
  const links = readLinks();
  const entry = links[channel];
  if (!entry?.refreshToken) return null;
  const cid = process.env.TWITCH_CLIENT_ID;
  const sec = process.env.TWITCH_CLIENT_SECRET;
  if (!cid || !sec) return null;
  const refreshed = await safe(() =>
    fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: cid, client_secret: sec, grant_type: "refresh_token", refresh_token: entry.refreshToken! }),
    }).then((r) => r.json())
  );
  if (!refreshed?.access_token) return null;
  entry.userToken = refreshed.access_token;
  entry.userTokenExpires = Date.now() + (refreshed.expires_in ?? 14400) * 1000;
  entry.refreshToken = refreshed.refresh_token ?? entry.refreshToken;
  writeLinks(links);
  return refreshed.access_token;
}

async function resolveUserToken(req: Request, channel: string): Promise<{ token: string; isOwner: boolean } | null> {
  const links = readLinks();
  const entry = links[channel];
  if (entry?.userToken) {
    const token = (entry.userTokenExpires ?? 0) > Date.now() + 30000
      ? entry.userToken
      : await refreshEntryToken(channel);
    if (token) return { token, isOwner: true };
  }
  const m = (req.headers.get("cookie") || "").match(/sc_session=([^;]+)/);
  if (m) {
    const session = verifySession(decodeURIComponent(m[1]));
    if (session?.access_token && (session.token_expires ?? 0) > Date.now() + 30000) {
      return { token: session.access_token, isOwner: session.login === channel };
    }
  }
  return null;
}

async function twitchEmotes(broadcasterId: string | null, user: { token: string; isOwner: boolean } | null): Promise<Emote[]> {
  const out: Emote[] = [];
  const img = (e: any) => e.images?.url_4x || e.images?.url_2x || e.images?.url_1x;
  const glob = await safe(() => helix("chat/emotes/global"));
  for (const e of glob?.data ?? []) if (img(e)) out.push({ platform: "twitch", code: e.name, url: img(e) });
  if (!broadcasterId || !user) return out;

  const headers = { "Client-Id": process.env.TWITCH_CLIENT_ID!, Authorization: `Bearer ${user.token}` };
  // 1) прямые канальные смайлики
  const ch = await safe(() =>
    fetch(`https://api.twitch.tv/helix/chat/emotes/channel?broadcaster_id=${broadcasterId}`, { headers }).then((r) => r.json())
  );
  if (ch?.data?.length) {
    for (const e of ch.data) if (img(e)) out.push({ platform: "twitch", code: e.name, url: img(e) });
    return out;
  }
  // 2) фолбэк: смайлики, доступные аккаунту, отфильтрованные по владельцу канала
  //    (эндпоинт требует user_id, совпадающий с токеном)
  if (!user.isOwner) return out;
  const own = await safe(() =>
    fetch(`https://api.twitch.tv/helix/chat/emotes/user?user_id=${broadcasterId}`, { headers }).then((r) => r.json())
  );
  for (const e of own?.data ?? []) {
    if (img(e) && (!e.owner_id || String(e.owner_id) === String(broadcasterId))) {
      out.push({ platform: "twitch", code: e.name, url: img(e) });
    }
  }
  return out;
}

async function sevenTv(broadcasterId: string | null): Promise<Emote[]> {
  const out: Emote[] = [];
  const url = (e: any) => {
    const host = e.data?.host;
    if (!host?.url) return null;
    const names: string[] = (host.files ?? []).map((f: any) => f.name);
    const file = names.find((n) => n === "3x.webp") || names.find((n) => n === "2x.webp") || names[0] || "2x.webp";
    return `https:${host.url}/${file}`;
  };
  const g = await safe(() => fetch("https://7tv.io/v3/emote-sets/global").then((r) => r.json()));
  for (const e of g?.emotes ?? []) { const u = url(e); if (u) out.push({ platform: "7tv", code: e.name, url: u }); }
  if (broadcasterId) {
    const u = await safe(() => fetch(`https://7tv.io/v3/users/twitch/${broadcasterId}`).then((r) => r.json()));
    for (const e of u?.emote_set?.emotes ?? []) { const eu = url(e); if (eu) out.push({ platform: "7tv", code: e.name, url: eu }); }
  }
  return out;
}

async function bttv(broadcasterId: string | null): Promise<Emote[]> {
  const out: Emote[] = [];
  const push = (arr: any) => { for (const e of arr ?? []) if (e.id && e.code) out.push({ platform: "bttv", code: e.code, url: `https://cdn.betterttv.net/emote/${e.id}/3x` }); };
  const g = await safe(() => fetch("https://api.betterttv.net/3/cached/emotes/global").then((r) => r.json()));
  push(g);
  if (broadcasterId) {
    const u = await safe(() => fetch(`https://api.betterttv.net/3/cached/users/twitch/${broadcasterId}`).then((r) => r.json()));
    push(u?.channelEmotes); push(u?.sharedEmotes);
  }
  return out;
}

async function ffz(broadcasterId: string | null): Promise<Emote[]> {
  const out: Emote[] = [];
  const parseSets = (sets: any) => {
    for (const set of Object.values(sets ?? {})) {
      for (const e of (set as any)?.emoticons ?? []) {
        const u = e.urls?.["4"] || e.urls?.["2"] || e.urls?.["1"];
        if (u) out.push({ platform: "ffz", code: e.name, url: u.startsWith("//") ? `https:${u}` : u });
      }
    }
  };
  const g = await safe(() => fetch("https://api.frankerfacez.com/v1/set/global").then((r) => r.json()));
  parseSets(g?.sets);
  if (broadcasterId) {
    const r = await safe(() => fetch(`https://api.frankerfacez.com/v1/room/id/${broadcasterId}`).then((x) => x.json()));
    parseSets(r?.sets);
  }
  return out;
}

export async function GET(req: Request) {
  const channel = (new URL(req.url).searchParams.get("channel") || "").trim().toLowerCase().replace(/^@/, "");
  // без кэша: каждый запрос — живые данные всех платформ

  let broadcasterId: string | null = null;
  if (channel) broadcasterId = await twitchUserId(channel);
  const user = await resolveUserToken(req, channel);
  const [t, s, b, f] = await Promise.all([
    safe(() => twitchEmotes(broadcasterId, user)), safe(() => sevenTv(broadcasterId)),
    safe(() => bttv(broadcasterId)), safe(() => ffz(broadcasterId)),
  ]);
  // дедупликация в рамках платформы (канальные наборы частично пересекаются с глобальными)
  const seen = new Set<string>();
  const emotes = [...(t ?? []), ...(s ?? []), ...(b ?? []), ...(f ?? [])].filter((e) => {
    const key = `${e.platform}|${e.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return json({ channel, emotes });
}
