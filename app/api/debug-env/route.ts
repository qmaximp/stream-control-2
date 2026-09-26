// ВРЕМЕННЫЙ диагностический эндпоинт: показать ключи окружения с TWITCH (без значений).
// После починки удалить файл.
export async function GET() {
  const keys = Object.keys(process.env).filter((k) => k.toUpperCase().includes("TWITCH"));
  return new Response(
    JSON.stringify(
      {
        keys,
        clientIdPresent: !!process.env.TWITCH_CLIENT_ID,
        clientSecretPresent: !!process.env.TWITCH_CLIENT_SECRET,
        clientIdLength: process.env.TWITCH_CLIENT_ID?.length ?? 0,
      },
      null,
      2
    ),
    { headers: { "Content-Type": "application/json" } }
  );
}
