# Décisions d'architecture

## ADR-001 — Conserver l'architecture existante

**Contexte.** Le dépôt possède une API Fastify/Prisma testée et un frontend
statique déployé.  
**Décision.** Améliorer par migrations et modules progressifs, sans réécriture
Next.js.  
**Alternatives.** Réécrire en monolithe Next.js ou Supabase direct.  
**Conséquences.** Livraison plus sûre ; le découpage du gros `server.ts` reste
une dette à traiter.

## ADR-002 — Clé agent locale Ed25519

**Contexte.** L'agent doit prouver l'identité de la machine.  
**Décision.** Générer une graine Ed25519 de 32 octets, stockée uniquement dans
le dossier local avec permissions restrictives. Le serveur ne reçoit que la clé
publique Base58.  
**Alternatives.** Token serveur permanent ou clé privée centralisée.  
**Conséquences.** Compromission limitée à la machine ; rotation et révocation
seront ajoutées avant production.

## ADR-003 — Liaison par code à usage unique

**Contexte.** Copier des identifiants techniques est source d'erreurs.  
**Décision.** Le compte génère un code court stocké dans Redis pour dix minutes.
L'agent l'échange une seule fois contre son `machineId`.  
**Alternatives.** Coller la clé publique dans le site ou OAuth local.  
**Conséquences.** Parcours simple et sans secret durable ; nécessite une session
web pour créer le code.

## ADR-004 — Polling avant file de messages

**Contexte.** Aucun moteur de tâches n'existe encore.  
**Décision.** La Phase 3 commencera par un polling authentifié et borné par
machine, compatible avec une future file Redis/NATS.  
**Alternatives.** WebSocket ou RabbitMQ immédiatement.  
**Conséquences.** Test entre deux PC plus simple ; latence acceptable en Devnet.

