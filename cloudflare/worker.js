// Cloudflare Worker — API-шлюз кластера.
// Роли:
//   POST /submit    { profile, task }  -> { id }         клиент кладёт задачу
//   GET  /pull?profile=embed          -> задача | 204    warm-воркер тянет задачу
//   POST /result    { id, result }                        воркер возвращает результат
//   GET  /result/{id}                 -> { status,result} клиент забирает результат
// Хранилище: KV namespace QUEUE (очередь по профилю) и RESULTS (результаты).
// Авторизация воркеров/клиентов: заголовок Authorization: Bearer <QUEUE_KEY>.

const enc = (o) => new Response(JSON.stringify(o), {
  headers: { "content-type": "application/json" },
});

function auth(req, env) {
  const h = req.headers.get("authorization") || "";
  return h === `Bearer ${env.QUEUE_KEY}`;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (!auth(req, env)) return new Response("unauthorized", { status: 401 });

    // --- клиент кладёт задачу ---
    if (req.method === "POST" && p === "/submit") {
      const { profile, task } = await req.json();
      const id = crypto.randomUUID();
      // очередь профиля: список id + payload задачи
      await env.QUEUE.put(`task:${profile}:${id}`, JSON.stringify({ id, task }), {
        expirationTtl: 3600,
      });
      await env.RESULTS.put(id, JSON.stringify({ status: "queued" }), {
        expirationTtl: 3600,
      });
      return enc({ id });
    }

    // --- warm-воркер тянет одну задачу ---
    if (req.method === "GET" && p === "/pull") {
      const profile = url.searchParams.get("profile") || "embed";
      const list = await env.QUEUE.list({ prefix: `task:${profile}:`, limit: 1 });
      if (!list.keys.length) return new Response(null, { status: 204 });
      const key = list.keys[0].name;
      const val = await env.QUEUE.get(key);
      if (!val) return new Response(null, { status: 204 });
      await env.QUEUE.delete(key); // claim: удалили из очереди
      const { id, task } = JSON.parse(val);
      await env.RESULTS.put(id, JSON.stringify({ status: "running" }), {
        expirationTtl: 3600,
      });
      return enc({ id, task });
    }

    // --- воркер возвращает результат ---
    if (req.method === "POST" && p === "/result") {
      const { id, result, error } = await req.json();
      await env.RESULTS.put(
        id,
        JSON.stringify({ status: error ? "error" : "done", result, error }),
        { expirationTtl: 3600 }
      );
      return enc({ ok: true });
    }

    // --- клиент забирает результат ---
    if (req.method === "GET" && p.startsWith("/result/")) {
      const id = p.slice("/result/".length);
      const val = await env.RESULTS.get(id);
      if (!val) return new Response("not found", { status: 404 });
      return new Response(val, { headers: { "content-type": "application/json" } });
    }

    return new Response("ok"); // healthcheck
  },
};
