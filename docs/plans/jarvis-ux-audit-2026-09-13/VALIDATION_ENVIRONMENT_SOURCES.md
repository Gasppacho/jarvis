# L02 — Environnement de validation : sources et reproduction

Vérification du 13 septembre 2026, dans le worktree d’implémentation. Documentation OpenAI consultée directement et recoupée avec Context7 (`/openai/codex`).

## Ce que la plateforme garantit

Codex applique le sandbox aux commandes et à leurs sous-processus, donc aussi aux test runners. Sur macOS, il utilise Seatbelt. Le droit d’écrire dans le workspace n’accorde pas à lui seul un accès réseau. [Sandbox — documentation OpenAI](https://learn.chatgpt.com/docs/sandboxing)

En mode `workspace-write`, le réseau est désactivé par défaut. La politique d’approbation est distincte de cette frontière technique : supprimer les demandes d’approbation ne donne pas un accès réseau supplémentaire. Les règles du proxy réseau concernent les commandes ; les requêtes du client vers le modèle et l’authentification utilisent d’autres connexions. Un échange Codex réussi ne prouve donc pas qu’un serveur de test local peut écouter. [Autorisations et sécurité — documentation OpenAI](https://learn.chatgpt.com/docs/agent-approvals-security)

## Ce qui a été exécuté localement

CLI observé : `codex-cli 0.154.0`. Même programme Node, même répertoire, même environnement parent ; seule l’insertion du sandbox diffère :

```sh
rtk proxy node -e 'const net=require("node:net");const s=net.createServer();s.once("error",e=>{console.log(JSON.stringify({code:e.code,syscall:e.syscall,address:e.address}));process.exitCode=1});s.listen(0,"127.0.0.1",()=>{console.log("LISTEN_OK");s.close()});'

rtk proxy codex sandbox -c 'sandbox_mode="workspace-write"' -c 'sandbox_workspace_write.network_access=false' -- node -e 'const net=require("node:net");const s=net.createServer();s.once("error",e=>{console.log(JSON.stringify({code:e.code,syscall:e.syscall,address:e.address}));process.exitCode=1});s.listen(0,"127.0.0.1",()=>{console.log("LISTEN_OK");s.close()});'
```

| Exécution | Résultat observé |
| --- | --- |
| Hôte | Exit 0, `LISTEN_OK` |
| Sandbox `workspace-write`, réseau désactivé | Exit 1, `{"code":"EPERM","syscall":"listen","address":"127.0.0.1"}` |

Le diagnostic minimal reproduit un refus d’écoute loopback sous cette politique. Il ne reproduit pas les deux assertions d’intégration de #204 et ne prouve pas à lui seul toutes les permissions du processus Codex lancé par Jarvis.

Écart de documentation : la page de sécurité donne encore `codex sandbox macos …`. Le CLI installé expose directement `codex sandbox [OPTIONS] [COMMAND]…` dans `rtk proxy codex sandbox --help`. La [référence des commandes](https://learn.chatgpt.com/docs/developer-commands?surface=cli) documente bien le passage de la commande après `--`. Les commandes ci-dessus suivent l’aide du binaire réellement exécuté.

## Conséquence pour Jarvis

L’[adaptateur local](../../../packages/agent-runtime/src/codex-runtime.ts) lance `exec --json --ephemeral --ignore-user-config --ignore-rules --sandbox workspace-write`. Il n’active pas le réseau. La configuration globale personnelle ne permet donc pas de déduire les capacités de ce runner.

L’[autorité de validation](../../architecture/AGENT_RUNTIMES.md#validation-authority) appartient à Development : ses commandes configurées déterminent la réussite, après le travail de l’agent. Le Codex enfant peut produire des contrôles ciblés compatibles avec son sandbox et signaler ses refus d’accès ; répéter un gate nécessitant une écoute interdite ne constitue pas une réparation du code. Les commandes et leur environnement restent soumis aux [contraintes de sécurité du projet](../../architecture/SECURITY.md#command-execution).

Les erreurs `listen EPERM` de Codex doivent rester séparées des échecs `access-denied` et de l’assertion de texte public enregistrés par le validateur dans [le résultat audité de #204](RESULTAT_TEST.md). Aucune modification globale, aucun assouplissement du sandbox et aucun nouveau run GitHub n’ont été effectués pour cette recherche. La preuve réelle L10 reste à exécuter.
