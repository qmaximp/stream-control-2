import { getOrigin, seeOther, signSession, tokenForLogin } from "@/lib/session";
import { readLinks, writeLinks, readOwner, writeOwner } from "@/lib/links";

export async function GET(req: Request) {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = req.headers.get("cookie")?.match(/sc_oauth_state=([^;]+)/)?.[1];

  if (!clientId || !clientSecret || !code) {
    return seeOther("/?error=auth");
  }
  if (!state || !expectedState || state !== expectedState) {
    return seeOther("/?error=state");
  }

  const redirectUri = process.env.TWITCH_REDIRECT_URI || `${getOrigin(req)}/api/auth/twitch/callback`;

  const tokenRes = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  const token = await tokenRes.json();
  if (!token.access_token) {
    return seeOther("/?error=token");
  }

  const userRes = await fetch("https://api.twitch.tv/helix/users", {
    headers: { "Client-Id": clientId, Authorization: `Bearer ${token.access_token}` },
  });
  const userData = await userRes.json();
  const u = userData?.data?.[0];
  if (!u) {
    return seeOther("/?error=user");
  }

  const session: import("@/lib/session").TwitchSession = {
    login: u.login,
    display_name: u.display_name,
    avatar: u.profile_image_url,
    access_token: token.access_token,
    token_expires: Date.now() + (token.expires_in ?? 14400) * 1000,
  };

  // сохраняем токен на диск: канал-владелец панели сможет отдавать свои канальные смайлики,
  // даже когда панель открыта без входа (панелью пользуется модератор по room-ссылке)
  const links = readLinks();
  links[u.login] = {
    ...(links[u.login] ?? { token: tokenForLogin(u.login), updatedAt: new Date().toISOString() }),
    userToken: token.access_token,
    userTokenExpires: session.token_expires!,
    refreshToken: token.refresh_token ?? links[u.login]?.refreshToken,
  };
  writeLinks(links);

  // первый вошедший аккаунт считается владельцем панели
  if (!readOwner()) writeOwner(u.login);

  const res = seeOther("/cabinet");
  res.headers.append("Set-Cookie", `sc_session=${signSession(session)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`);
  res.headers.append("Set-Cookie", "sc_oauth_state=; Path=/; Max-Age=0");
  return res;
}
