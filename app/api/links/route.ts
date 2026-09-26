import crypto from "crypto";
import fs from "fs";
import path from "path";
import { verifySession } from "@/lib/session";

const DATA_DIR = path.join(process.cwd(), "data");
const LINKS_FILE = path.join(DATA_DIR, "links.json");

type LinksData = Record<string, { token: string; updatedAt: string }>;

function readLinks(): LinksData {
  try {
    return JSON.parse(fs.readFileSync(LINKS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeLinks(data: LinksData) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LINKS_FILE, JSON.stringify(data, null, 2));
}

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

// генерация новой ссылки (старая перестаёт действовать)
export async function POST(req: Request) {
  const session = sessionFrom(req);
  if (!session) return json({ error: "unauthorized" }, 401);
  const data = readLinks();
  const token = crypto.randomBytes(8).toString("hex");
  data[session.login] = { token, updatedAt: new Date().toISOString() };
  writeLinks(data);
  return json({ token });
}
