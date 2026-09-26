import { cookies } from "next/headers";
import PanelClient from "@/components/PanelClient";
import { invalidLinkScreen, isValidRoomToken, readLinks, readOwner } from "@/lib/links";
import { verifySession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default function Panel({ searchParams }: { searchParams?: { room?: string } }) {
  if (!isValidRoomToken(searchParams?.room)) {
    return invalidLinkScreen();
  }
  // канал для превью/смайликов: аккаунт, чья персональная ссылка открыта,
  // иначе владелец панели, иначе единственный зарегистрировавшийся, иначе залогиненный
  let channel: string | null = null;
  const room = searchParams?.room;
  if (room) {
    const entry = Object.entries(readLinks()).find(([, e]) => e.token === room);
    if (entry) channel = entry[0];
  }
  if (!channel) channel = readOwner();
  if (!channel) {
    const logins = Object.keys(readLinks());
    if (logins.length === 1) channel = logins[0];
  }
  if (!channel) {
    const session = verifySession(cookies().get("sc_session")?.value);
    channel = session?.login ?? null;
  }
  return <PanelClient channel={channel} />;
}
