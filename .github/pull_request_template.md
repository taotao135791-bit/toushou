## Summary

<!-- What changes for a user or maintainer? Keep this outcome-focused. -->

## Scope and contracts

<!-- List IPC, shared type, persistence, runtime/protocol, migration, or release
     contracts touched. Write "None" when there are none. -->

## Verification

<!-- Paste the commands you ran and their results. -->

- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] `pnpm test:omp` (required for runtime/protocol/settings changes)
- [ ] Manual UX path checked, including loading/error/keyboard state where relevant

## Safety checklist

- [ ] No secrets, user data, local paths, or generated release output were added.
- [ ] Main validates any new security-relevant renderer input.
- [ ] Documentation and tests reflect changed behavior.
- [ ] I requested code-owner review for security, IPC, runtime, or release changes.

## Follow-ups

<!-- Known limits, deferred work, or "None". -->
