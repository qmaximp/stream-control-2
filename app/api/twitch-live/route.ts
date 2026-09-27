export const dynamic = "force-dynamic";

import { verifySession } from "@/lib/session";
import { helix, safe } from "@/lib/twitch";

// Статус канала: живой ли стрим прямо сейчас.
// Панель опрашивает это, чтобы перезагрузить превью-плеер, когда стример начал стрим
// (иначе плеер, загруженный в оффлайне, так и остаётся «на паузе»).
export async function GET(req: Request) {
  const m = (req.headers.get("cookie") || "").match(/sc_session=([^;]+)/);
  const session = m ? verifySession(decodeURIComponent(m[1])) : null;
  if (!session) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const channel = (new URL(req.url).searchParams.get("channel") || "").trim().toLowerCase().replace(/^@/, "");
  if (!channel) {
    return Response.json({ error: "channel required" }, { status: 400 });
  }
  const data = await safe(() => helix(`streams?user_login=${encodeURIComponent(channel)}`));
  const stream = data?.data?.[0] ?? null;
  // live: null — статус неизвестен (нет ключей/ошибка сети): клиент ничего не меняет
  return Response.json({
    live: data ? !!stream : null,
    startedAt: stream?.started_at ?? null,
  });
}
