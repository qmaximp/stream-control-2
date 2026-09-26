import crypto from "crypto";
import { readLinks, writeLinks } from "@/lib/links";
import { verifySession } from "@/lib/session";

function sessionFrom(req: Request) {
  return verifySession(req.headers.get("cookie")?.match(/(?:^|;\s*)sc_session=([^;]+)/)?.[1]);
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

// сохранённые ссылки аккаунта (переживают F5 и рестарт, пока жив файл)
export async function GET(req: Request) {
  const session = sessionFrom(req);
  if (!session) return json({ error: "unauthorized" }, 401);
  const saved = readLinks()[session.login];
  return json({ token: saved?.token ?? null });
}

// генерация новой ссылки (старая перестаёт действовать); токены смайликов не трогаем
export async function POST(req: Request) {
  const session = sessionFrom(req);
  if (!session) return json({ error: "unauthorized" }, 401);
  const data = readLinks();
  const token = crypto.randomBytes(8).toString("hex");
  data[session.login] = {
    ...data[session.login],
    token,
    updatedAt: new Date().toISOString(),
  };
  writeLinks(data);
  return json({ token });
}
