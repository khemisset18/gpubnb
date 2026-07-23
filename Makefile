.PHONY: dev verify api-build api-test agent-install agent-test typecheck build zip

dev:
	docker compose -f infra/docker-compose.yml up --build

api-build:
	cd apps/api && npm ci && npx prisma generate && npm run build

api-test:
	cd apps/api && npm test

agent-install:
	python3 -m pip install -e agent

agent-test:
	python3 -m unittest discover -s agent/tests -v

typecheck:
	cd apps/api && npm run build

build: api-build agent-test

verify:
	bash scripts/verify.sh

zip:
	cd .. && zip -r gpubnb-enterprise-final.zip gpubnb-enterprise -x '*/node_modules/*' '*/.git/*' '*/.env'
