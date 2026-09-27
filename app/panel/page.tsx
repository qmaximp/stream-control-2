import { cookies } from "next/headers";
import PanelClient from "@/components/PanelClient";
import { invalidLinkScreen, isValidRoomToken, notRegisteredScreen, readLinks, readOwner } from "@/lib/links";
import { verifySession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default function Panel({ searchParams }: { searchParams?: { room?: string } }) {
  const room = searchParams?.room;
  // чистая ссылка /panel закрыта: панель открывается только по персональной ссылке с токеном комнаты
  if (!room || !isValidRoomToken(room)) {
    return invalidLinkScreen();
  }
  const session = verifySession(cookies().get("sc_session")?.value);
  // доступ только для зарегистрированных через Twitch — даже по персональной ссылке;
  // после входа вернём модератора на эту же ссылку
  if (!session) return notRegisteredScreen(`/panel?room=${encodeURIComponent(room)}`);

  // канал для превью/смайликов: аккаунт, чья персональная ссылка открыта,
  // иначе владелец панели, иначе единственный зарегистрировавшийся, иначе залогиненный
  let channel: string | null = null;
  {
    const entry = Object.entries(readLinks()).find(([, e]) => e.token === room);
    if (entry) channel = entry[0];
  }
  if (!channel) channel = readOwner();
  if (!channel) {
    const logins = Object.keys(readLinks());
    if (logins.length === 1) channel = logins[0];
  }
  if (!channel) channel = session?.login ?? null;
  return <PanelClient channel={channel} room={room} />;
}
