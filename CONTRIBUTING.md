# Contributing

Patches are welcome from anyone. There is no CLA and no copyright assignment.

## Licensing of contributions

This project is dedicated to the public domain under
[CC0 1.0 Universal](LICENSE). By submitting a contribution, you dedicate it to the public domain
on the same terms, waiving your copyright and related rights in it to the fullest extent the law
allows.

If you cannot make that dedication — because your employer holds rights in your work, or because
you are incorporating code that carries its own license — say so in the pull request rather than
submitting it. Third-party code under a permissive license can still be used, but it needs to be
identified so its terms travel with it.

## Before opening a pull request

```bash
npm install
npm run typecheck
npm test
```

Both must pass. The test suite needs no network access and no Discord credentials, so there is
nothing to configure first.

## Scope

The bridge is deliberately narrow: it mirrors a Teamup calendar into one Discord channel and does
nothing else. Changes that keep it working, make it clearer, or fix a bug are easy yeses.
Anything that adds a second responsibility is worth raising as an issue before you build it.

Chapter-specific values belong in configuration, not in code — see the table at the end of
[DEPLOY.md](DEPLOY.md). Another organization should be able to run this by changing environment
variables alone.
