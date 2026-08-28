# Issue tracker

## Tracker principal

Le tracker cible est **GitHub Issues** du remote courant. Utiliser `gh` pour lire, créer, modifier et relier les issues après vérification de `git remote -v` et `gh auth status`.

## Fallback local

Tant que le remote n'est pas créé ou accessible, utiliser :

```text
.scratch/<plan>/issues/<nn>-<slug>.md
```

Chaque fichier représente un ticket. Le passage vers GitHub doit préserver le titre, le corps, les critères d'acceptation, les blockers et le label de triage.

## Pull Requests

Les Pull Requests ne sont pas le backlog principal. Elles implémentent un ticket et doivent le référencer. Une PR ne remplace pas une issue de spécification ou un ticket de tranche verticale.

## Format d'un ticket

Un ticket doit contenir :

- le résultat utilisateur ou système observable ;
- la tranche verticale traversée ;
- les critères d'acceptation vérifiables ;
- le test seam attendu ;
- les blockers explicites ;
- les sources de vérité à lire ;
- le label de triage courant.

## Publication

Lors d'un `/to-spec`, publier une issue de spécification avec `ready-for-agent`.
Lors d'un `/to-tickets`, publier un ticket par tranche, créer les liens de blocage natifs lorsque disponibles et appliquer `ready-for-agent` uniquement aux tickets sans blocker non résolu.
