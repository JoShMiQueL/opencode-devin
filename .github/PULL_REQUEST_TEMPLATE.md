## What

One or two sentences. What changes for a user?

## Why

The problem being fixed. Link the issue if there is one.

## How

Anything a reviewer should know before reading the diff: the approach, the
trade-off you took, and the alternative you rejected.

## Testing

- [ ] `bun test` passes
- [ ] Added or updated tests for the change
- [ ] Exercised against the real API, if the change touches the Cascade
      protocol: `DEVIN_LLM_API_KEY='devin-session-token$...' bun test test/live.test.ts`

For a change to `src/protocol/`, say which field numbers you verified. Those
were reverse-engineered, so a test against our own encoder proves nothing about
whether Cognition still speaks it.

## Notes for the reviewer

Anything optional: a follow-up you deliberately left out, a risk you did not
think you could close, or a platform you could not test on.
