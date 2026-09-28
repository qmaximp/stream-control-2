import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import PanelClient from "@/components/PanelClient";
import {
  accessSuspendedScreen,
  invalidLinkScreen,
  isValidRoomToken,
  noInviteScreen,
  notRegisteredScreen,
} from "@/lib/links";
import { findOwnerByToken, getInviteStatus } from "@/lib/invites";
import { verifySession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default function Panel({ searchParams }: { searchParams?: { room?: string } }) {
  const room = searchParams?.room;
  // чистая ссылка /panel закрыта: панель открывается только по ссылке с токеном комнаты
  if (!room || !isValidRoomToken(room)) {
    return invalidLinkScreen();
  }

  const session = verifySession(cookies().get("sc_session")?.value);
  // не авторизован — после входа попадёт в кабинет (приглашение выдаёт стример по нику)
  if (!session) return notRegisteredScreen(`/cabinet?invite=${encodeURIComponent(room)}`);

  const owner = findOwnerByToken(room);
  if (!owner) return invalidLinkScreen();

  // владелец комнаты — доступ всегда
  if (owner === session.login) {
    return <PanelClient channel={owner} room={room} />;
  }

  // модератор: приглашение создаётся ТОЛЬКО стримером по нику в кабинете.
  // Просто открыв ссылку (даже угадав токен), доступ не получишь
  const entry = getInviteStatus(owner, session.login);
  if (!entry) {
    return noInviteScreen(owner);
  }
  if (entry.status === "pending") {
    // приглашён по нику — принимает в кабинете, сразу на вкладке «Доступ к панели»
    redirect(`/cabinet?invite=${encodeURIComponent(room)}`);
  }
  if (entry.suspended) {
    return accessSuspendedScreen(owner);
  }

  return <PanelClient channel={owner} room={room} />;
}
