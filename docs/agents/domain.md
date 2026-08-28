# Domain documentation layout

Jarvis possède plusieurs bounded contexts. Le vocabulaire canonique est distribué ainsi :

- `CONTEXT-MAP.md` : carte des contexts et règles de relation ;
- `<context>/CONTEXT.md` : glossaire local, termes et formulations à éviter ;
- `docs/adr/` : décisions système difficiles à inverser ;
- `<context>/docs/adr/` : réservé aux futures décisions strictement locales à un context.

## Règles de consommation

1. Lire `CONTEXT-MAP.md` lorsqu'une tâche traverse plusieurs packages ou lorsqu'un terme est ambigu.
2. Lire uniquement les glossaires des contexts modifiés.
3. Utiliser les termes du glossaire dans les specs, tickets, types, événements et UI.
4. Ne pas ajouter d'implémentation, de plan ou de justification longue dans un `CONTEXT.md`.
5. Ajouter un terme seulement lorsqu'il résout une ambiguïté réelle.
6. Ajouter un ADR seulement pour une décision durable, surprenante ou coûteuse à renverser.
