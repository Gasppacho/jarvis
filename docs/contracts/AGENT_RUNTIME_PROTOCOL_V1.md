# Agent Runtime Protocol v1

## Goal

Découpler les modules agentiques des CLIs concrètes tout en conservant streaming, cancellation, usage et résultat structuré.

## Runtime descriptor

```ts
type RuntimeDescriptor = {
  id: string;
  provider: 'fake' | 'codex' | 'claude-code' | string;
  displayName: string;
  executablePath: string | null;
  version: string | null;
  capabilities: string[];
  status: 'available' | 'unavailable' | 'unauthenticated' | 'degraded';
};
```

## Run request

```ts
type AgentRunRequest = {
  projectId: string;
  executionId: string;
  workingDirectory: string;
  objective: string;
  systemInstructions: string[];
  contextArtifacts: string[];
  allowedMcpBindings: string[];
  environment: Record<string, string>;
  timeoutMs: number;
  outputLimitBytes: number;
};
```

`environment` est déjà filtré par le Project Runtime. Le module ne fournit pas de secret arbitraire.

## Stream events

```text
started
message
stdout
stderr
tool-started
tool-completed
file-changed
usage
warning
completed
failed
```

Chaque event possède timestamp et sequence. Les chunks bruts peuvent être redacted/tronqués avant persistence.

## Result

```ts
type AgentRunResult = {
  status: 'completed' | 'failed' | 'cancelled' | 'timed-out';
  summary: string;
  changedFiles: string[];
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  rawArtifactRef?: string;
  error?: { code: string; message: string; retryable: boolean };
};
```

Le résultat ne garantit pas que les tests passent. Le module propriétaire valide ensuite le workspace.

## Cancellation

Le runtime reçoit un `AbortSignal`. L'adapter tente interruption gracieuse, puis terminate process group après délai. Il doit attendre la fin des streams avant de rendre le résultat terminal.

## Adapter rules

- Toute logique spécifique de version/CLI reste dans l'adapter.
- Aucun prompt du module ne construit directement une commande shell.
- Le runtime ne publie aucun événement intermodule.
- Le runtime ne décide ni branche, ni commit, ni Pull Request.
