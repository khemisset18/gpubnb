from pathlib import Path

p = Path('apps/api/src/server.ts')
s = p.read_text()

old = "import { FilesystemArtifactStorage, RoutedArtifactStorage, S3ArtifactStorage, verifyArtifactBytes } from './artifact-storage.js';\n"
new = old + "import { createRedisCapabilityReadiness } from './redis-capability-readiness.js';\n"
if s.count(old) != 1:
    raise SystemExit(f'import marker count={s.count(old)}')
s = s.replace(old, new, 1)

old = "const app=Fastify({logger:{redact:['req.headers.authorization','req.headers.cookie','req.headers.x-agent-signature','res.headers.set-cookie']},trustProxy:config.TRUST_PROXY==='true',bodyLimit:config.MAX_BODY_BYTES,requestIdHeader:'x-request-id'}); const db=new PrismaClient(); const redis=new Redis(config.REDIS_URL,{maxRetriesPerRequest:2,enableReadyCheck:true});\n"
new = old + "const verifyRedisReadiness=createRedisCapabilityReadiness(redis);\n"
if s.count(old) != 1:
    raise SystemExit(f'redis construction marker count={s.count(old)}')
s = s.replace(old, new, 1)

old = "app.get('/ready',async(req,reply)=>{try{await db.$queryRaw`SELECT 1`;await redis.ping();return {ok:true}}catch(err){req.log.error(err);return reply.code(503).send({ok:false})}});\n"
new = "app.get('/ready',async(req,reply)=>{try{await db.$queryRaw`SELECT 1`;await redis.ping();await verifyRedisReadiness();return {ok:true}}catch(err){req.log.error(err);return reply.code(503).send({ok:false})}});\n"
if s.count(old) != 1:
    raise SystemExit(f'ready route marker count={s.count(old)}')
s = s.replace(old, new, 1)

p.write_text(s)
