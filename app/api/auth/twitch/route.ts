import { NextResponse } from "next/server";
import { getOrigin, randomState, seeOther } from "@/lib/session";

export async function GET(req: Request) {
  const clientId = process.env.TWITCH_CLIENT_ID;
  if (!clientId || !process.env.TWITCH_CLIENT_SECRET) {
    return seeOther("/?error=config");
  }
  const redirectUri = process.env.TWITCH_REDIRECT_URI || `${getOrigin(req)}/api/auth/twitch/callback`;
  const state = randomState();
  const authUrl = new URL("https://id.twitch.tv/oauth2/authorize");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "user:read:email");
  authUrl.searchParams.set("state", state);
  const res = NextResponse.redirect(authUrl.toString());
  res.cookies.set("sc_oauth_state", state, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 600 });
  return res;
}
