# Plan d'exécution — rendre Jarvis fiable et simple

## Résultat attendu

Un utilisateur qui ignore la configuration de Jarvis choisit son dépôt, le scénario « Développer une issue GitHub », son compte GitHub et son agent, confirme les commandes proposées, comprend ce qui va démarrer, puis suit une issue jusqu'à une PR. Le chemin recommandé ne nécessite ni JSON, ni identifiant de module, ni slot, ni contrat d'événement, ni terminal.

Conserver quatre étapes : **Dépôt → Workflow → Accès et agent → Vérification**. Dans Workflow, un schéma graphique lisible et des réglages usuels ; dans chaque étape une action principale et des choix contextuels. L'édition complète reste disponible sous Réglages avancés avec retour explicite au guide.

Le modèle de référence est désormais : issue ouverte avec `ready-to-dev`, aucune dépendance GitHub native ouverte, une issue développée à la fois, validation puis commit/push, événement de création de PR traité par GitHub, relecture et merge manuels. Les anciennes notes de run restent des archives de preuve.

## Règles d'exécution

1. Lire ETAT_DES_LIEUX.md et RESULTAT_TEST.md ; reproduire les défauts dans le worktree de travail. Les captures sont des preuves, le code peut avoir changé depuis l'audit.
2. Travailler sur une branche isolée ; préserver les modifications locales existantes. Ne pas modifier la base de données réelle pour simuler un succès.
3. Une tranche verticale à la fois, avec un contrôle au plus haut niveau réaliste. Utiliser implement/tdd et code-review selon les instructions du dépôt. Les numéros L01–L10 ci-dessous sont des tickets locaux ; la publication GitHub des améliorations n'est pas nécessaire pour démarrer.
4. Réutiliser modèles, API, formulaires et contrats existants. Extraire seulement ce qui permet de partager un contrôle réel entre guide et mode avancé. Pas de nouveau framework UI ni de moteur de workflow.
5. Ne pas supprimer de contrôle de sécurité, d'assertion ou de validation pour contourner une panne. Ne pas transformer toute exécution Codex en accès sans restriction.
6. Mettre à jour contrats source, types générés, exemples et tests ensemble lorsqu'un état doit changer. Swift présente la décision de l'Engine.
7. Rapporter séparément : implémenté, tests exécutés, vérification visuelle, commit, push et PR. Aucun merge automatique et aucune fermeture d'issue sans preuve et merge manuel.
8. Chaque tranche reste utilisable ; vérifier le rendu natif. Des tests de modèles verts ne valent pas une session visuelle réussie.

## Ordre et dépendances

`L01 → L02 → L03 → L04 → L05 → L06 → L07 → L08 → L09 → L10`.

L01 et L02 rétablissent la confiance. L03 fixe le langage et le contrat visuel. L04–L07 livrent le parcours complet. L08 traite le quotidien après activation. L09 ferme accessibilité et documentation. L10 est la preuve finale. Certains travaux sont indépendants, mais cette session peut les exécuter séquentiellement pour garder une intégration simple.

## L01 — P0 : des états d'exécution qui disent la vérité

**Problème :** F01, F09. Les checks sont verts dès qu'une preuve existe, même après échec.

**Changement :** faire correspondre chaque étape au dernier résultat effectif et à sa tentative : pas commencé, en cours, réussi, échoué, réparation en cours, annulé, inconnu seulement si la donnée manque réellement. Un contrôle échoué reste visible pendant une réparation. Une réparation réussie affiche le succès de la nouvelle tentative et conserve l'historique. L'agent ne reste pas « en cours » quand seule une validation tourne. Résumer d'abord la cause, puis proposer les détails.

**Points d'entrée :** `apps/engine/src/projects/execution-detail.ts`, contrats ExecutionDetailV1, `ProjectExecutionDetailView` et ses modèles. Faire `graft callers buildSteps --depth all` avant modification.

**Acceptation :** le même checkpoint validation.failed que #204 ne produit jamais une coche verte ; validation.started sans résultat n'est pas un succès ; plusieurs checks dont un échoue ne donnent pas une étape globale réussie ; deuxième tentative verte efface l'alerte active mais pas l'historique ; annulation n'est pas échec ; perte du flux garde la dernière donnée avec âge/état de connexion.

**Preuve :** scénario Engine avec vrai stockage et snapshots consommés par Swift pendant échec → réparation → succès. Vérification visuelle des trois états.

## L02 — P0 : exécuter les validations dans un environnement supporté

**Problème :** F02. Le Codex enfant et le validateur Development n'ont pas le même environnement ; des tests d'intégration échouent dans le vrai run.

**Changement :** isoler et reproduire séparément les EPERM du sandbox, le résultat access-denied et l'apparition de `<path>`. Comparer les tests inchangés hors/dans l'environnement filtré du module, avec le même checkout. Le validateur du module doit rester la source d'autorité des checks ; éviter de demander au Codex enfant de répéter un gate qu'il n'a pas le droit d'exécuter. S'il a besoin de contrôles durant la réparation, proposer le mécanisme borné existant ou une capability étroite, sans relâcher globalement l'isolation.

**Compléments :** rendre explicites les outils nécessaires (Git, Node, pnpm, Swift/Xcode), les droits nécessaires et les délais. Distinguer échec du code, indisponibilité de l'outil, restriction d'accès, timeout et panne du moteur. Ne pas demander à l'agent de modifier des fichiers hors de l'issue pour réparer l'environnement.

**Points d'entrée :** `packages/agent-runtime/src/codex-runtime.ts`, `request-builder.ts`, `apps/engine/src/projects/runtime-readiness.ts`, tests `project-runtime-bindings.integration.test.ts` et `execution-detail.integration.test.ts`, préparation/validation de Development.

**Acceptation :** preflight donne un diagnostic utile des prérequis sans promettre la réussite des tests ; documentation seule n'entraîne pas une réparation des tests hors scope ; un worktree propre peut passer `pnpm verify` via le même validateur que le produit ; la capture publique ne contient ni chemin interdit, ni secret, ni marqueur de redaction accidentel ; erreur environnementale persistante arrête les tentatives inutiles avec remède explicite.

**Preuve :** repro rouge conservé, correction minimale, test avec environnement filtré et faux exécutables contrôlés, puis nouveau test réel mono-issue. Faire passer les assertions existantes, pas les affaiblir.

## L03 — P1 : figer une expérience cohérente et ses états

**Problème :** F05, F07, F10, F12. Des descriptions UX contradictoires ont produit des surfaces juxtaposées.

**Changement :** réécrire les sections concernées de `docs/product/UX.md` autour des quatre étapes et d'une seule navigation projet. Utiliser la maquette précédente pour les espacements, le schéma et l'ordre des informations. Une rangée de quatre étapes dans le contenu remplace le second panneau de navigation vide ; la sidebar principale privilégie les projets, puis la bibliothèque. Adapter le schéma en liste verticale à petite largeur.

**Contrat visuel :** en-tête projet/dépôt, état et prochaine action ; largeur de lecture raisonnable alignée à gauche ; bouton principal visible ; état de sauvegarde (« Modifications à enregistrer », « Enregistrement… », « Enregistré », « Échec — Réessayer »). Champs avec libellés permanents. Icône + texte, jamais couleur seule. Libellés français cohérents, sauf marques et noms propres.

**Acceptation :** décision documentée, inventaire des états vierge/incomplet/prêt/en cours/échec/déconnecté ; aucun nouveau parcours concurrent. Le schéma raconte le résultat métier tout en restant une projection de la composition canonique.

**Preuve :** captures de référence avec états réels/fixtures explicitement distingués, vérifiées à 1100×800 et 1512×949, apparences claire et sombre.

## L04 — P1 : import et navigation qui conduisent au bon endroit

**Problème :** F03, F05, F11.

**Changement :** rendre « Ajouter un projet » visible dans la sidebar et dans l'état vide. Inspection du dossier puis résumé nom, dépôt GitHub, branche de base ; édition du nom. Si le dépôt est déjà importé, proposer Ouvrir ce projet. Après création d'un brouillon, sélectionner immédiatement ce projet et afficher la prochaine étape. Les corrections mènent au champ concerné et le mode avancé possède « Revenir à la configuration guidée ».

**Points d'entrée :** `RootView.swift`, `ProjectImportSheet.swift`, `ProjectsModel`, `ProjectOnboardingView.swift`.

**Acceptation :** dossier non Git et accès refusé conservent une erreur actionnable sans projet partiel ; annuler ne crée rien ; doublon proposé explicitement ; changer d'écran ne perd pas une édition et n'ouvre pas silencieusement un autre projet ; réouverture reprend le brouillon ; suppression reste distincte des actions usuelles.

**Preuve :** tests existants d'import étendus au doublon et à la destination ; vrai sélecteur natif, import et reprise d'un dépôt de test dans une racine isolée.

## L05 — P1 : configurer tout le workflow dans le guide

**Problème :** F03, F04, F05.

**Changement :** afficher une carte « Développer une issue GitHub » et un schéma Issue prête → Développement → Vérifications → Pull Request. Cliquer une carte donne son explication et les réglages usuels. Le modèle vient de la proposition Engine existante. Afficher le label, une issue à la fois et la relecture manuelle ; sous une section « Préparer et vérifier le projet », proposer les commandes détectées et demander leur confirmation explicite. Pour Jarvis, proposer l'installation gelée et `pnpm verify` une seule fois, sans cocher en plus lint/typecheck/test déjà inclus.

**État des étapes :** calculé depuis la configuration, les choix locaux et les résultats courants. « Workflow configuré » décrit une configuration complète ; ce n'est pas une validation de ses commandes. Toute modification invalide la disponibilité concernée sans détruire les autres valeurs.

**Points d'entrée :** `ProjectOnboardingView`, `ProjectOnboardingPresentation`, `ProjectConfigurationModel`, contrôles Workflow choices de `ProjectDetailView`, réponses composition-guide/choices existantes.

**Acceptation :** dépôt vierge → modèle → label → préparation → validations sans Advanced ; draft sauvegardable incomplet ; custom préservé ; changer de modèle annonce exactement les valeurs remplacées ; template inchangé n'est pas présenté comme un choix à refaire ; le schéma ne persiste aucun second graphe et n'invente pas le routage.

**Preuve :** test Swift avec vraie API de la séquence complète et conservation des éditions ; test visuel sans saisir d'ID/JSON ; contrats portable/local inchangés sauf besoin prouvé.

## L06 — P1 : accès et agent compréhensibles

**Problème :** F04, F06.

**Changement :** deux cartes : Compte GitHub et Agent de développement. Préselection visuelle d'un candidat pertinent possible, mais aucune autorisation sans action explicite. Une fois choisi : coche « Utilisé par ce projet », dépôt accessible, dernier contrôle et bouton Modifier. Distinguer « Choisissez d'abord un workflow », « Codex non installé », « Connexion requise », « Version non prise en charge », « Outil manquant », « Prêt ». Présenter un lien de réparation contextualisé.

**Modèle et limites :** afficher au moins le profil/modèle réellement sélectionné ou « Modèle par défaut de Codex » si c'est effectivement ce qui est utilisé. Ne pas afficher un modèle déduit de la configuration globale que le runner ignore. Délais et permissions détaillés restent sous Advanced ; une durée limite utile à l'utilisateur peut être présentée en minutes.

**Acceptation :** Codex valide sans workflow ne devient pas « Version incompatible » ; compte sélectionné ne reste pas « Prêt à être accordé » ; permissions par projet conservées ; pas d'accès implicite aux autres projets ; comptes multiples, aucun compte, compte expiré et outils introuvables ont une suite possible.

**Preuve :** matrice de readiness sur vraies réponses Engine, plus interface avec compte réel et choix explicite ; assertion qu'aucun secret n'est ajouté à la configuration portable.

## L07 — P1 : vérifier puis démarrer sans ambiguïté

**Problème :** F07.

**Changement :** renommer le préflight « Vérifier la configuration ». Résumé simple des accès, commandes, déclencheur et sortie attendue ; détails techniques repliés. Messages de succès factuels, erreurs avec action « Corriger » vers la bonne étape. Carte « Première exécution » avec issue choisie et portée explicite. Séparer « Tester avec cette issue » de « Surveiller les issues prêtes » ; le bouton final reprend l'intention et le numéro d'issue.

**Acceptation :** aucune activation sans rapport courant et fingerprint exact ; modifier invalide ; réponse périmée ignorée ; dépendances inconnues bloquent ; absence d'issue n'est pas une panne du projet ; erreur GitHub ne ressemble pas à une liste vide ; le choix mono-issue survit à la vérification et ne déclenche aucune autre issue ; pas de déplacement imprévisible de l'action principale.

**Preuve :** réutiliser les tests #198 de périmètre/fingerprint et les compléter au niveau navigation. Scénario UI avec une issue éligible et une autre bloquée.

## L08 — P1 : supervision graphique centrée sur le travail utile

**Problème :** F08, F09.

**Changement :** afficher d'abord l'issue active et son étape, durée, dernière mise à jour, action Ouvrir et Pause/Annuler selon la portée. Ensuite les actions requises et issues réellement éligibles ; les autres sont repliées derrière un compteur avec filtre. Montrer « Essai limité à #204 » tant que ce périmètre s'applique. Afficher premier chargement, reconnexion, données anciennes et échec distinctement.

**Détail :** titre/numéro/état, frise compacte des étapes, résultat ou erreur immédiatement visible, logs récents repliables, lien PR et bouton Copier le lien. UUID, enveloppes, chemins et corrélations sous Détails techniques. Le bouton retour doit ramener à l'écran d'origine. Examiner #202 avant de dupliquer son travail.

**Acceptation :** issue active visible sans défilement à 1100×800 ; aucune issue sans label ne paraît déjà engagée ; réussite affiche une vraie PR vérifiée ; échec donne contrôle et remède et reste accessible depuis la dernière issue après fin d’exécution ; Pause bloque les nouveaux départs sans prétendre annuler l'actif ; annulation réelle répercutée ; redémarrage/reconnexion rétablit l'état sans duplication.

**Preuve :** UI réelle pendant préparation, agent, validation, échec et PR ; tests de read models et couverture existante de reprise/idempotence ; #202 intégré seulement avec preuve.

## L09 — P1 : accessibilité, documentation et cohérence finale

**Changement :** labels/hints/identifiants AX pour les actions critiques, parcours clavier complet, focus préservé après sauvegarde/erreur, textes lisibles et états sans dépendance à la couleur. Harmoniser les écrans globaux Connexions et Catalogue avec le langage du guide. Mettre README, UX, workflow de référence, guides locaux et checklists à jour ; distinguer le parcours recommandé `ready-to-dev` des données historiques.

**Acceptation :** un utilisateur peut créer/configurer/activer un projet au clavier ; VoiceOver nomme les boutons, valeurs et erreurs ; pas d'UUID exposé par défaut ; docs ne promettent aucune preuve non exécutée. Aucune certification de notarisation/Gatekeeper déduite de ce chantier.

**Preuve :** contrôle AX automatisable des noms, session VoiceOver documentée séparément, captures claire/sombre et fenêtre réduite ; liens de docs vérifiés et lint des fichiers modifiés.

## L10 — P0 de sortie : nouvelle preuve complète dans l'application

**Préparation :** build du commit candidat identifié ; racine de données isolée ; dépôt Jarvis accessible ; une issue de test courte et dédiée, aucun autre ticket ready activé. Vérifier l'état de #204 avant de la réutiliser : une nouvelle exécution ne doit pas dupliquer un travail existant. Ne pas toucher #202/#203 sans vérifier leur périmètre et dépendances.

**Scénario obligatoire :** ouvrir l'application, importer/configurer sans Advanced, choisir explicitement GitHub et Codex, confirmer les commandes, vérifier, sélectionner une seule issue, activer, observer GitHub → Development → préparation → Codex → checks → commit/push → request PR → PR réelle. Ouvrir et copier le lien. Mettre le projet en pause à la fin, laisser la PR à relire sans merge.

**Scénarios de non-régression :** issue bloquée puis libérée ; deux issues avec concurrence 1 ; erreur de connexion et retry ; commande invalide ; validation échouée puis réparée ; arrêt/reprise du moteur ; annulation ; réponse API périmée ; configuration custom conservée. Les scénarios coûteux peuvent rester au harness si la preuve réelle minimale ci-dessus est faite ; ne pas les appeler tests GitHub réels.

**Gates :** `rtk pnpm verify` dans le worktree propre, contrôles ciblés L01/L02, rendu natif, session réelle. Si un gate échoue, livrer le diagnostic et l'état exact, ne pas déclarer la tranche terminée.

**Preuves à enregistrer :** commit app/Engine, heures par étape, captures, numéro issue/PR, SHA de branche distante, résultats des checks, nombre de runs agent/branches/PR et état final du projet. Aucune donnée secrète ni contenu privé de credential. Mesurer le nombre d'actions et le temps de configuration sur un passage continu, sans inclure le temps de développement. Viser moins de 5 minutes de configuration avec outils déjà installés ; c'est une cible à mesurer, pas une garantie annoncée.

## Définition de terminé

- Parcours nominal intégral sans Advanced, JSON, ID ni terminal.
- Aucun état vert pour une opération échouée ou non exécutée.
- Configuration sauvegardée et réouverte sans perte ; custom et isolation par projet préservés.
- Une issue réelle produit une seule PR réelle par les modules, avec validations réussies et sans merge automatique.
- Tests pertinents et gate complet passent dans le worktree propre ; limites visuelles/accessibilité explicitement consignées.
- Diff relu, commits et éventuelle PR d'implémentation prêts pour revue humaine ; aucune modification forcée de main.
