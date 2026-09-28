import { cookies, headers } from "next/headers";
import { notRegisteredScreen, isValidRoomToken } from "@/lib/links";
import { ensurePendingInvite, findOwnerByToken } from "@/lib/invites";
import { tokenForLogin, verifySession } from "@/lib/session";
import CabinetClient from "@/components/CabinetClient";

export const dynamic = "force-dynamic";

export default function Cabinet({ searchParams }: { searchParams?: { invite?: string } }) {
  const c = cookies().get("sc_session");
  const session = c ? verifySession(c.value) : null;
  if (!session) return notRegisteredScreen();

  // модератор после входа по ссылке стримера (/cabinet?invite=<токен>): фиксируем
  // приглашение в статусе pending — в кабинете появится карточка с кнопкой «Принять»
  const inviteToken = searchParams?.invite;
  if (inviteToken && isValidRoomToken(inviteToken)) {
    const owner = findOwnerByToken(inviteToken);
    if (owner && owner !== session.login) {
      ensurePendingInvite(owner, session.login);
    }
  }

  const host = headers().get("host") || "localhost:3000";
  const forwardedProto = headers().get("x-forwarded-proto");
  const proto = forwardedProto || (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");

  return (
    <CabinetClient
      login={session.login}
      displayName={session.display_name}
      avatar={session.avatar}
      token={tokenForLogin(session.login)}
      origin={`${proto}://${host}`}
      defaultTab={inviteToken && isValidRoomToken(inviteToken) ? "access" : "links"}
    />
  );
}
