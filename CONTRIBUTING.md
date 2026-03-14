# Contributing to Open Walnut

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/EvanZhang008/open-walnut.git
cd open-walnut
npm install          # installs backend + frontend dependencies
npm run dev          # backend watch mode
cd web && npx vite   # frontend HMR on http://localhost:5173
```

The Vite dev server proxies `/api` and `/ws` to `localhost:3456`.

### Prerequisites

- Node.js >= 22
- npm

## Running Tests

```bash
npm test              # unit + integration + e2e (parallel)
npm run lint          # TypeScript type check
npm run test:all      # lint + all tests + Playwright browser tests
```

## Making Changes

1. **Fork** the repo and create a branch from `main`
2. **Write tests** for any new functionality
3. **Run `npm run lint`** — no type errors allowed
4. **Run `npm test`** — all tests must pass
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

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
