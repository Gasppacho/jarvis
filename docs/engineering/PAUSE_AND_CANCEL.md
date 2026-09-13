# Mettre en pause ou annuler une exécution

Dans votre projet, ouvrez **Supervision** pour choisir l’action adaptée
et suivre le résultat du travail.

## Empêcher les nouveaux départs

Choisissez **Mettre les nouveaux départs en pause** pour mettre le projet en pause.
Cette action bloque les nouveaux départs ; elle ne tue pas le travail actif.
Celui-ci continue et reste consultable depuis **Supervision**.
Avant de choisir **Reprendre les nouveaux départs**, vérifiez la portée du projet :
essai limité à une issue ou surveillance des issues prêtes.

## Arrêter le travail actif

Dans la carte **Travail en cours**, choisissez **Ouvrir le travail**.
Dans la fiche, choisissez **Annuler l’exécution** lorsque cette action est disponible.
La confirmation **Annuler cette exécution ?** permet de confirmer l’annulation
ou de choisir **Continuer l’exécution** pour laisser le travail se poursuivre.
L’annulation est une action distincte de la pause du projet.
Pour bloquer aussi les nouveaux départs, mettez le projet en pause.
Consultez ensuite l’état final dans la fiche : la demande seule ne prouve pas l’arrêt.
Jarvis conserve le résultat final ; la conservation du dossier de travail dépend
de la politique configurée, elle n’est pas garantie par cette action.

## Retrouver le résultat et comprendre un échec

Depuis **Supervision**, utilisez **Ouvrir le travail** dans **Travail en cours**
ou **Dernier travail** pour retrouver les étapes et le résultat enregistré.
Dans **Historique des vérifications**, consultez le nom de chaque validation,
sa tentative, son résultat, sa durée et sa sortie lorsqu’elles sont disponibles.
Après un redémarrage, rouvrez le même projet et le travail concerné :
les contrôles échoués restent consultables, même si le label déclencheur a été retiré.
En cas de reconnexion ou de données anciennes, distinguez le dernier état conservé
d’un état courant ; une information indisponible ne signifie pas une réussite.

Une validation échouée doit être diagnostiquée avant toute relance : lisez
**Échec à examiner**, la sortie du contrôle et l’action de correction proposée.
Corrigez la cause avant d’utiliser **Relancer l’exécution**, si l’action est proposée.
Les validations configurées doivent réussir avant publication du travail.
Lorsqu’une PR est créée, **Ouvrir la PR** permet de retrouver la proposition :
une personne doit encore la relire et la fusionner.

Pour le parcours complet, consultez [l’UX macOS](../product/UX.md)
et le [workflow de référence](../architecture/REFERENCE_WORKFLOW.md).
