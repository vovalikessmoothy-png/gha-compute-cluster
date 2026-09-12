# gha-compute-cluster

Бесплатный инференс LLM на раннерах GitHub Actions. Передаём задачу → получаем ответ.

## В каком виде GHA принимает вычисления

GHA — это не сервер, а **событийный исполнитель**. Задача = событие, запускающее job.
Три способа передать задачу:

| Канал | Как передаём | Когда |
|---|---|---|
| `workflow_dispatch` | inputs через UI или `gh workflow run` | ручной тест |
| `repository_dispatch` | `POST /repos/{o}/{r}/dispatches` + `client_payload` (JSON до ~64 КБ) | **API-режим** |
| очередь (KV/Queue) | warm-pool воркер сам тянет `GET next-job` | низкая латентность |

## Как возвращаем ответ (обмен)

У job нет «return» — ответ отдаём по одному из каналов:

1. **Callback webhook** — job делает `POST` на твой Cloudflare Worker с результатом. Быстро, push-модель. ← основной.
2. **Artifact** — `result-<job_id>.json`, скачивается по API (`GET .../artifacts`). Фолбэк, живёт 1 день.
3. Gist / коммит в ветку результатов — если нужен простой polling без Worker.

```
клиент → CF Worker (кладёт job в KV, отдаёт dispatch) → GHA job
GHA job → инференс → POST callback → CF Worker → клиент (polling/SSE)
```

## Два режима

- **oneshot** (`oneshot.yml`) — 1 событие = 1 job. Холодный старт 30-60с (pull образа+модели). Для редких/батч-задач. 0 затрат в простое.
- **warm-pool** (`warm-pool.yml`) — долгоживущий job (до ~350 мин), модель один раз в RAM, в цикле тянет очередь. Латентность ≈ poll+инференс. Держи N таких как «тёплый пул».

> ⚠️ Реалистичная латентность: oneshot 30-90с, warm-pool 1-10с на инференс CPU. Обещанных ~5с на oneshot не будет — холодный старт GHA физически дольше.

## Матрица моделей под раннер (2 vCPU / 7 ГБ RAM, CPU-only)

| Модель | Квант | RAM | Скорость | Для чего |
|---|---|---|---|---|
| `qwen2.5:0.5b` | Q4 | ~1 ГБ | очень быстро | классификация, роутинг, короткие ответы |
| `qwen2.5:3b` | Q4 | ~3 ГБ | быстро | **дефолт** — чат, суммаризация, extract |
| `phi3.5:3.8b` | Q4 | ~3.5 ГБ | быстро | рассуждения, код-хелпер |
| `llama3.2:3b` | Q4 | ~3 ГБ | быстро | инструкции, RAG |
| `qwen2.5:7b` | Q4 | ~5.5 ГБ | медленно | макс. качество, влезает впритык |
| `nomic-embed-text` | — | ~0.5 ГБ | мгновенно | эмбеддинги для RAG |

7B Q4 — потолок для 7 ГБ. Всё крупнее (13B+) уйдёт в своп → бесполезно. Держи несколько warm-pool воркеров с разными моделями за одним шлюзом и роутируй задачи по размеру.

## Быстрый тест

```bash
gh workflow run oneshot.yml -f model=qwen2.5:3b -f prompt="Привет одним словом"
# или API:
curl -X POST https://api.github.com/repos/vovalikessmoothy-png/gha-compute-cluster/dispatches \
  -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
  -d '{"event_type":"infer","client_payload":{"job_id":"t1","model":"qwen2.5:3b","prompt":"hi"}}'
```

## Лимиты (важно для планирования)
- Public repo: бесплатные минуты **безлимит**. Private: 2000 мин/мес (Free) → делай репо **public** для максимума.
- Параллельных jobs: ~20 (Free tier). Это и есть размер warm-pool.
- Job ≤ 6 ч, payload dispatch ≤ 64 КБ (большие входы — ссылкой на R2/KV).
