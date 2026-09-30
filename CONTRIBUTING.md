# Contributing

> [NOTE]!
> This guide is adapted from [Spatie's](https://spatie.be/guidelines)

Please read and understand the contribution guide before creating an issue or pull request.

## Etiquette

This project is open source, and as such, the maintainers give their free time to build and maintain the source code
held within. They make the code freely available in the hope that it will be of use to other developers. It would be
extremely unfair for them to suffer abuse or anger for their hard work.

Please be considerate towards maintainers when raising issues or presenting pull requests. Let's show the
world that developers are civilized and selfless people.

It's the duty of the maintainer to ensure that all submissions to the project are of sufficient
quality to benefit the project. Many developers have different skillsets, strengths, and weaknesses. Respect the maintainer's decision, and do not be upset or abusive if your submission is not used.

We consider ourselves the owner and maintainer of the GitHub Issues page. The issues list should only contain items that we intend to work on. An exceptions to this is bug reports, which should follow the provided template.
The repo's GitHub Discussions page should be used for all other issues, such as feature requests, suggestions, recommendations, etc.

## Viability

When requesting or submitting new features, first consider whether it might be useful to others. Open
source projects are used by many developers, who may have entirely different needs to your own. Think about
whether or not your feature is likely to be used by other users of the project. Hence, PRs deemed to not apply to a majority of users will most likely not get merged

## Procedure

Before filing an issue:

- Attempt to replicate the problem, to ensure that it wasn't a coincidental incident.
- Check the pull requests tab to ensure that the bug doesn't have a fix in progress.
- Check the pull requests tab to ensure that the feature isn't already in progress.

Before submitting a pull request:

- Check the codebase to ensure that your feature doesn't already exist.
- Check the pull requests to ensure that another person hasn't already submitted the feature or fix.
- Ensure your commit messages are descriptive. This is because [it is our changelog](https://github.com/damms005/devdb-vscode/blob/4fb5ccc2cbf81f79a334e89be2a39f4280fadfa6/CHANGELOG.md#L1)

## Requirements

We adhere to [Spatie's JavaScript guidelines](https://spatie.be/guidelines/javascript) as much as possible. For your PR to get approved, please ensure your code complies with the recommendations therein.

- **Add tests!** - Where necessary, ensure your contribution has tests. Your patch may not be accepted if it doesn't have tests when it should.

- **Document any change in behaviour** - Make sure the `README.md` and any other relevant documentation are kept up-to-date.

- **Consider our release cycle** - We try to follow [SemVer v2.0.0](http://semver.org/). Randomly breaking public APIs is not an option.

- **One pull request per feature** - If you want to do more than one thing, send multiple pull requests.

- **Send coherent history** - Make sure each individual commit in your pull request is meaningful. If you had to make multiple intermediate commits while developing, please [squash them](http://www.git-scm.com/book/en/v2/Git-Tools-Rewriting-History#Changing-Multiple-Commit-Messages) before submitting.

## Running Tests

Tests use [Mocha](https://mochajs.org) and [Testcontainers](https://testcontainers.com). You need Docker running.

```bash
bun install            # or: npm install
npm run check-types    # tsc --noEmit
npm run lint
npm test               # runs every suite in src/test/suite/**
```

Run one suite:

```bash
npx mocha --timeout 180000 --require ts-node/register 'src/test/suite/engines/redis.test.ts'
```

- Containers have fixed names (`devdb-test-container-*`) and use `withReuse()`, so later runs start fast. The first run downloads images and can take several minutes.
- If a run stops with "container name already in use" (HTTP 409), wait for the other run to finish or remove the container with `docker rm -f <name>`.
- `publish.sh` removes all `devdb-test-container-*` containers before it runs the tests. When you add a container, add its name to `cleanup_test_containers` in `publish.sh`.

## Adding a Database Engine

1. **Engine**: add `src/database-engines/<name>-engine.ts` that implements `DatabaseEngine` from `src/types.ts`. `rawQuery(sql, options)` must enforce `options.readOnly` at the database level (MCP queries use it).
2. **Config type**: add the config type to `src/types.ts`. For file or config-based loading, add the schema to `schemas/devdbrc.json` and a snippet to `snippets/devdbrc.json`.
3. **Provider or connection form**: add a provider in `src/providers/<name>/` and register it in the `providers` list in `src/services/messenger.ts`, or add a remote connection type in `src/services/remote-connection-storage-service.ts`.
4. **Native drivers**: bundle the driver with esbuild when possible. If it has a native `.node` binding that esbuild cannot bundle, add it to `external` in `esbuild.js`, allow it in `.vscodeignore`, and make sure `.github/scripts/prepare-native-deps.js` ships the correct binding for each VSIX target.
5. **Tests**: add `src/test/suite/engines/<name>.test.ts` with a Testcontainers container named `devdb-test-container-<name>`.
6. **Docs**: update `README.md` (Supported Databases and setup) and `CHANGELOG.md`.

**Happy coding**!
