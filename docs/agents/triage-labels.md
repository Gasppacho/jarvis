# Triage labels

Les cinq rôles canoniques sont :

| Rôle | Label | Sens |
|---|---|---|
| À trier | `needs-triage` | Le ticket existe mais son prochain état n'est pas décidé |
| Information manquante | `needs-info` | Une décision ou une donnée externe bloque le travail |
| Prêt pour agent | `ready-for-agent` | Le ticket est autonome, vérifiable et sans blocker ouvert |
| Prêt pour humain | `ready-for-human` | Une validation humaine est requise |
| Ne sera pas fait | `wontfix` | Le ticket est fermé sans implémentation |

## Invariants

- Un ticket possède au maximum un rôle de triage actif.
- `ready-for-agent` signifie qu'un agent frais peut réussir sans interroger à nouveau l'utilisateur.
- Un blocker ouvert prime sur le label : le ticket ne doit pas rester `ready-for-agent`.
- Les labels de domaine ou de priorité peuvent s'ajouter, mais ne remplacent pas ces rôles.
