# Prompt de démarrage pour l'agent de code

Utilise ce prompt après avoir créé le repository et copié le pack documentaire.

```text
Tu vas développer Jarvis à partir des documents présents dans ce repository.

1. Installe ou vérifie les skills de Matt Pocock, puis exécute setup-matt-pocock-skills sans écraser les décisions existantes.
2. Lis AGENTS.md, CONTEXT-MAP.md, docs/product/MVP_SPEC.md, docs/architecture/SYSTEM.md et les ADR.
3. Inspecte les contrats machine-readable sous contracts/ et valide leurs exemples.
4. Ne redéfinis pas l'architecture. Signale toute contradiction précise entre les documents avant de coder.
5. Commence par .scratch/jarvis-mvp/issues/01-walking-skeleton.md.
6. Utilise /implement pour ce ticket, /tdd au seam le plus haut décrit dans le ticket et /code-review avant le commit.
7. Ne travaille que sur ce ticket. Garde le dépôt vert et produis une démonstration traversant l'application SwiftUI, l'API locale et le moteur TypeScript.
8. Mets à jour une source de vérité uniquement lorsqu'une nouvelle décision est réellement prise. Ajoute un ADR pour toute décision structurelle difficile à inverser.
```
