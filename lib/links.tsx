import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const LINKS_FILE = path.join(DATA_DIR, "links.json");
const OWNER_FILE = path.join(DATA_DIR, "owner.json");

export type LinksData = Record<string, {
  token: string;
  updatedAt: string;
  // user-токен Twitch для канальных смайликов (заполняется при OAuth-входе)
  userToken?: string;
  userTokenExpires?: number;
  refreshToken?: string;
}>;

export function readLinks(): LinksData {
  try {
    return JSON.parse(fs.readFileSync(LINKS_FILE, "utf8"));
  } catch {
    return {};
  }
}

export function writeLinks(data: LinksData) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LINKS_FILE, JSON.stringify(data, null, 2));
}

// токен валиден, только если совпадает с последним сгенерированным;
// прямой доступ без ?room= не блокируем
export function isValidRoomToken(room: string | undefined | null): boolean {
  if (!room) return true;
  const data = readLinks();
  return Object.values(data).some((e) => e.token === room);
}

// владелец панели — первый аккаунт, вошедший через Twitch; определяет канал смайликов/превью
export function readOwner(): string | null {
  try { return JSON.parse(fs.readFileSync(OWNER_FILE, "utf8")).login ?? null; } catch { return null; }
}

export function writeOwner(login: string) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OWNER_FILE, JSON.stringify({ login, setAt: new Date().toISOString() }, null, 2));
}

// экран «ссылка недействительна» вместо приложения
export function invalidLinkScreen(): React.ReactNode {
  return (
    <main className="min-h-screen bg-bg flex flex-col items-center justify-center px-4 text-center">
      <h1 className="text-xl font-semibold text-white mb-2">Ссылка недействительна</h1>
      <p className="text-sm text-gray-500 max-w-sm">
        Эта ссылка была отозвана или заменена новой. Попросите свежую ссылку в личном кабинете.
      </p>
      <a href="/" className="mt-4 text-sm text-accent2 hover:underline">
        На главную
      </a>
    </main>
  );
}
