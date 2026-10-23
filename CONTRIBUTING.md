# Contributing to Open Walnut

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/EvanZhang008/open-walnut.git
cd open-walnut
bun install            # installs backend + frontend dependencies (bun.lock, web/bun.lock)
bun run dev            # backend watch mode
cd web && bun x vite   # frontend HMR on http://localhost:5173
```

The Vite dev server proxies `/api` and `/ws` to `localhost:3456`.

### Prerequisites

- git and [Bun](https://bun.sh) >= 1.4.4, nothing else: bun installs the dependencies and runs the server, the build and the tests (`package.json` pins the version as `packageManager`)

A dependency change is a `package.json` edit plus the `bun.lock` that `bun install`
writes for it; commit both. Patches to dependencies live in `patches/` and are made
with `bun patch <package>` (Bun applies them on every install).

## Running Tests

```bash
bun run test          # unit + integration + e2e (parallel)
bun run lint          # TypeScript type check
bun run test:all      # lint + all tests + Playwright browser tests
```

## Making Changes

1. **Fork** the repo and create a branch from `main`
2. **Write tests** for any new functionality
3. **Run `bun run lint`**: no type errors allowed
4. **Run `bun run test`**: all tests must pass
5. **Keep changes focused** — one feature or fix per PR

## Code Style

- TypeScript everywhere (backend + frontend)
- Brief comments for tricky logic; no boilerplate docstrings
- Keep files under ~500 lines when feasible
- Follow existing patterns in the codebase

## Pull Request Process

1. Open a PR against `main`
2. Describe **what** changed and **why**
3. Include steps to verify the change (screenshots for UI changes)
4. All CI checks must pass

## Reporting Issues

- Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md) for bugs
- Use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md) for ideas
- Search existing issues before creating a new one

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold its terms.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
