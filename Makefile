.PHONY: dev verify api-build api-test zip

dev:
	docker compose -f infra/docker-compose.yml up --build

api-build:
	cd apps/api && npm ci && npx prisma generate && npm run build

api-test:
	cd apps/api && npm test

verify:
	bash scripts/verify.sh

zip:
	cd .. && zip -r gpubnb-enterprise-final.zip gpubnb-enterprise -x '*/node_modules/*' '*/.git/*' '*/.env'
