# Commencer le développement de Jarvis

## 1. Créer le dépôt

Copier tout ce pack à la racine du nouveau dépôt Jarvis. Conserver les chemins : les pointeurs présents dans `AGENTS.md`, les glossaires et les tickets supposent cette arborescence.

## 2. Installer les skills de Matt Pocock

Choisir **une seule** méthode afin d'éviter de dupliquer les skills.

### Avec Codex ou un autre agent compatible skills.sh

```bash
npx skills@latest add mattpocock/skills
```

Sélectionner au minimum :

- `setup-matt-pocock-skills`
- `grill-with-docs`
- `to-spec`
- `to-tickets`
- `implement`
- `tdd`
- `code-review`
- `domain-modeling`
- `codebase-design`
- `research`
- `diagnosing-bugs`
- `writing-for-agents`

### Avec Claude Code

```bash
claude plugins install mattpocock-skills
```

## 3. Vérifier le setup du dépôt

Dans une session agentique ouverte à la racine :

```text
/setup-matt-pocock-skills
```

Le pack fournit déjà les fichiers attendus. Demander à l'agent de **vérifier et compléter sans écraser les décisions existantes**. Le tracker cible est GitHub Issues ; `.scratch/` sert de fallback local tant que le remote n'est pas prêt.

## 4. Lire avant de coder

Ordre minimal :

1. `AGENTS.md`
2. `CONTEXT-MAP.md`
3. `docs/product/MVP_SPEC.md`
4. `docs/architecture/SYSTEM.md`
5. les ADR applicables au ticket
6. le `CONTEXT.md` du bounded context touché
7. le ticket à implémenter

## 5. Initialiser la stack sans changer les décisions

Le premier ticket crée le walking skeleton :

- workspace `pnpm` pour le moteur TypeScript ;
- application SwiftUI macOS ;
- moteur Node.js enfant embarquable ;
- API locale versionnée ;
- écran natif affichant l'état de santé du moteur ;
- test traversant Swift → API → moteur.

Ne pas commencer par construire toutes les couches séparément. Chaque ticket doit livrer une tranche étroite, complète et démontrable.

## 6. Implémenter ticket par ticket

Pour chaque ticket prêt :

```text
/implement <chemin ou numéro du ticket>
```

Le comportement attendu est :

1. lire les sources de vérité liées ;
2. identifier le test seam le plus haut ;
3. utiliser `/tdd` à ce seam ;
4. implémenter la tranche verticale ;
5. lancer typecheck et tests ciblés régulièrement ;
6. lancer la suite complète à la fin ;
7. utiliser `/code-review` ;
8. corriger les constats ;
9. commit sur la branche courante.

## 7. Première démonstration cible

La première démonstration complète doit utiliser un repository fixture contenant un ticket simple et vérifiable, par exemple :

> Ajouter un endpoint `GET /health` et un test automatisé couvrant son résultat.

Le résultat attendu est une Pull Request créée automatiquement après passage du label `agent:ready`, sans besoin d'un bug préexistant.

## 8. Règle de changement d'architecture

Une préférence locale et réversible peut rester dans le code ou la spec. Une décision difficile à inverser, surprenante ou traversant plusieurs contexts exige un ADR. Ne pas réécrire silencieusement une décision existante.
