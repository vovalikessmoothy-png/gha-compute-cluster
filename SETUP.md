# Как поднять кластер с нуля

## 0. Починить GitHub-токен (сейчас 401)
Текущий токен невалиден — API создание репо не проходит. Обнови classic-токен
(scopes: `repo`, `read:org`, для dispatch ещё `workflow`) через форму бота, затем
я создам репозитории и запушу этот скелет автоматически.

## 1. Cloudflare Worker (API + очередь)
```
cd cloudflare
npx wrangler kv namespace create QUEUE
npx wrangler kv namespace create RESULTS
# подставь id в wrangler.toml
npx wrangler secret put QUEUE_KEY      # общий секрет
npx wrangler deploy
```
Получишь URL вида `https://gha-cluster-api.<acc>.workers.dev`.

## 2. Репозитории-воркеры (публичные!)
- Создать 1..20 публичных репо (`gha-worker-01 ... -20`) — по 20 jobs каждый.
- В каждом repo → Settings → Secrets:
  - `QUEUE_URL` = URL Worker'а из шага 1
  - `QUEUE_KEY` = тот же секрет
- Запушить в каждый содержимое этого скелета.

## 3. Запуск warm-пула
Для каждого репо и профиля:
```
gh workflow run worker.yml -f profile=embed -f lifetime_min=340
```
Cron в worker.yml сам перезапускает пул каждые 5 часов.

## 4. Использование API
```
# положить задачу
curl -H "Authorization: Bearer $KEY" -X POST $URL/submit \
  -d '{"profile":"embed","task":{"inputs":["hello","world"]}}'
# -> {"id":"..."}

# забрать результат
curl -H "Authorization: Bearer $KEY" $URL/result/<id>
```

## Масштаб и лимиты
- 20 репо × 20 jobs = ~400 тёплых воркеров на аккаунт.
- Больше — добавляй аккаунты/организации, каждый со своим лимитом 20.
- Следи за fair-use GitHub: это для коротких batch-нагрузок, не для 24/7 майнинга.
