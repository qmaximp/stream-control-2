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

// экран «нет регистрации»: доступ только после входа через Twitch.
// next — куда вернуть пользователя после успешного входа (относительный путь)
export function notRegisteredScreen(next?: string): React.ReactNode {
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/cabinet";
  const loginHref = `/api/auth/twitch?next=${encodeURIComponent(safeNext)}`;
  return (
    <main className="min-h-screen bg-bg flex flex-col items-center justify-center px-4 text-center">
      <span className="w-14 h-14 rounded-full bg-[#9146FF] flex items-center justify-center mb-4">
        <svg viewBox="0 0 24 24" fill="#fff" width="26" height="26">
          <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714H20.57z" />
        </svg>
      </span>
      <h1 className="text-xl font-semibold text-white mb-2">Вы не зарегистрированы</h1>
      <p className="text-sm text-gray-500 max-w-sm mb-6">
        Вход через Twitch не выполнен — пока нет доступа к этой странице. Войдите, чтобы получить кабинет и ссылки для панели.
      </p>
      <a
        href={loginHref}
        className="flex items-center gap-3 px-6 py-3 rounded-lg text-white font-medium text-base transition-colors bg-[#9146FF] hover:bg-[#772ce8]"
      >
        <svg viewBox="0 0 24 24" fill="#fff" width="20" height="20">
          <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714H20.57z" />
        </svg>
        Войти через Twitch
      </a>
    </main>
  );
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

// экран «доступ временно отключён стримером» (модератор, попавший под suspend)
export function accessSuspendedScreen(ownerLogin: string): React.ReactNode {
  return (
    <main className="min-h-screen bg-bg flex flex-col items-center justify-center px-4 text-center">
      <div className="bg-panel border border-border rounded-2xl p-8 max-w-sm w-full">
        <div className="text-5xl mb-4">🔒</div>
        <h1 className="text-lg font-semibold text-white mb-2">Доступ временно отключён</h1>
        <p className="text-sm text-gray-400 mb-6">
          Стример <span className="text-gray-200">{ownerLogin}</span> приостановил ваш доступ к панели.
          Напишите ему, чтобы вернуть.
        </p>
        <a
          href="/cabinet"
          className="inline-block px-6 py-3 rounded-lg bg-accent hover:bg-violet-700 text-white text-sm transition-colors"
        >
          В личный кабинет
        </a>
      </div>
    </main>
  );
}
