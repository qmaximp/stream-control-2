import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import PanelClient from "@/components/PanelClient";
import {
  accessSuspendedScreen,
  invalidLinkScreen,
  isValidRoomToken,
  notRegisteredScreen,
} from "@/lib/links";
import { ensurePendingInvite, findOwnerByToken, getInviteStatus } from "@/lib/invites";
import { verifySession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default function Panel({ searchParams }: { searchParams?: { room?: string } }) {
  const room = searchParams?.room;
  // чистая ссылка /panel закрыта: панель открывается только по ссылке с токеном комнаты
  if (!room || !isValidRoomToken(room)) {
    return invalidLinkScreen();
  }

  const session = verifySession(cookies().get("sc_session")?.value);
  // не авторизован — после входа попадёт в кабинет, где будет висеть приглашение
  if (!session) return notRegisteredScreen(`/cabinet?invite=${encodeURIComponent(room)}`);

  const owner = findOwnerByToken(room);
  if (!owner) return invalidLinkScreen();

  // владелец комнаты — доступ всегда
  if (owner === session.login) {
    return <PanelClient channel={owner} room={room} />;
  }

  // модератор: доступ только по принятому приглашению
  const entry = getInviteStatus(owner, session.login);
  if (!entry || entry.status === "pending") {
    ensurePendingInvite(owner, session.login);
    // приглашение ждёт в личном кабинете (сразу на вкладке «Доступ к панели»)
    redirect(`/cabinet?invite=${encodeURIComponent(room)}`);
  }
  if (entry.suspended) {
    return accessSuspendedScreen(owner);
  }

  return <PanelClient channel={owner} room={room} />;
}
