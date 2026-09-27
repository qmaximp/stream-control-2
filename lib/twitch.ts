// Общие Helix-хелперы (используются роутами emotes и twitch-live)

export async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); } catch { return null; }
}

// app access token для Helix (действует час, кэшируем)
let appToken: { token: string; expires: number } | null = null;
export async function getAppToken(): Promise<string | null> {
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

export async function helix(path: string): Promise<any | null> {
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
export async function twitchUserId(login: string): Promise<string | null> {
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
