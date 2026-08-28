# Workflow de développement avec les skills de Matt Pocock

## Philosophie retenue

Les skills sont utilisés comme des outils composables. Ils n'occupent pas le rôle d'un framework de projet unique : les sources de vérité restent les glossaires, ADR, specs, tickets et contrats de ce repository.

## Cycle de conception

```text
/grill-with-docs
    clarifie une décision et met à jour la bonne source de vérité
        ↓
/domain-modeling
    stabilise les termes ou crée un ADR si nécessaire
        ↓
/to-spec
    synthétise l'accord en une spec testable
        ↓
/to-tickets
    découpe la spec en tracer bullets avec blockers
```

Le pack fournit déjà la spec MVP et un premier découpage local. Après exploration du dépôt réel, `/to-tickets` peut publier ou ajuster les issues sans perdre les dépendances.

## Cycle d'implémentation

```text
/implement <ticket>
        ↓
/tdd au seam convenu
        ↓
typecheck et tests ciblés fréquents
        ↓
suite complète
        ↓
/code-review
        ↓
corrections
        ↓
commit
```

## Utilisation des skills de soutien

- `/codebase-design` : choisir une forme de code à l'intérieur d'une décision déjà actée ; ne pas contredire les ADR.
- `/research` : vérifier les APIs externes, versions de SDK, règles de distribution macOS et comportements actuels de CLI.
- `/diagnosing-bugs` : reproduire et isoler avant correction.
- `/writing-for-agents` : maintenir des pointeurs courts et éviter la duplication documentaire.
- `/domain-modeling` : challenger le vocabulaire et enregistrer les décisions qui cristallisent.

## Conditions de réussite d'un ticket

Un ticket n'est terminé que si :

- le comportement est démontrable à son seam principal ;
- les tests ciblés et la suite complète passent ;
- les contrats et exemples restent validables ;
- les logs ne contiennent pas de secrets ;
- la review agentique ne relève plus de problème bloquant ;
- la documentation source de vérité est cohérente avec le code ;
- le travail est commité sur la branche courante.
