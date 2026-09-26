import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { tokenForLogin, verifySession } from "@/lib/session";
import CabinetClient from "@/components/CabinetClient";

export default function Cabinet() {
  const c = cookies().get("sc_session");
  const session = c ? verifySession(c.value) : null;
  if (!session) redirect("/");

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
    />
  );
}
