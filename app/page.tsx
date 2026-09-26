import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { verifySession } from "@/lib/session";

export default function Home({ searchParams }: { searchParams?: { error?: string } }) {
  const c = cookies().get("sc_session");
  const session = c ? verifySession(c.value) : null;
  if (session) redirect("/cabinet");
  const error = searchParams?.error;

  return (
    <main className="min-h-screen bg-bg flex flex-col items-center justify-center px-4">
      <div className="flex items-center gap-3 mb-3">
        <span className="w-11 h-11 rounded-xl bg-[#9146FF] flex items-center justify-center">
          <svg viewBox="0 0 24 24" fill="#fff" width="24" height="24">
            <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714H20.57z" />
          </svg>
        </span>
        <h1 className="text-2xl font-semibold text-white">Stream Control</h1>
      </div>
      <p className="text-sm text-gray-500 mb-8 text-center">
        Панель управления оверлеем для модераторов и стримера
      </p>

      {error && (
        <p className="mb-6 max-w-md text-center text-sm text-red-400 bg-red-950/40 border border-red-900/50 rounded-lg px-4 py-3">
          {error === "config"
            ? "Вход не настроен: заполните TWITCH_CLIENT_ID и TWITCH_CLIENT_SECRET в .env.local (см. README)."
            : "Не удалось войти через Twitch. Попробуйте ещё раз."}
        </p>
      )}

      <a
        href="/api/auth/twitch"
        className="flex items-center gap-3 px-6 py-3.5 rounded-lg text-white font-medium text-base transition-colors bg-[#9146FF] hover:bg-[#772ce8]"
      >
        <svg viewBox="0 0 24 24" fill="#fff" width="22" height="22">
          <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714H20.57z" />
        </svg>
        Войти через Twitch
      </a>

      <a href="/panel" className="mt-4 text-sm text-gray-500 hover:text-gray-300 transition-colors">
        Продолжить без входа
      </a>
    </main>
  );
}
