import { cookies, headers } from "next/headers";
import { notRegisteredScreen, isValidRoomToken } from "@/lib/links";
import { tokenForLogin, verifySession } from "@/lib/session";
import CabinetClient from "@/components/CabinetClient";

export const dynamic = "force-dynamic";

export default function Cabinet({ searchParams }: { searchParams?: { invite?: string } }) {
  const c = cookies().get("sc_session");
  const session = c ? verifySession(c.value) : null;
  if (!session) return notRegisteredScreen();

  // ?invite=<токен> приходит после входа по ссылке стримера — кабинет открывается
  // сразу на вкладке «Доступ к панели», где видно приглашение (выдаётся только по нику)
  const inviteToken = searchParams?.invite;
  const cameFromRoomLink = !!inviteToken && isValidRoomToken(inviteToken);

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
      defaultTab={cameFromRoomLink ? "access" : "links"}
    />
  );
}
