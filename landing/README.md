# ContextPro website

Optional Next.js website for ContextPro. It is not the MCP runtime. Development and production preview use port **6767**.

## Run

From this directory:

```sh
npm ci
npm run dev
```

Open `http://localhost:6767`. `npm run build` and `npm start` build and serve a production preview. The npm lockfile is canonical for this app.

## Instructions and setup samples

The copy panel and `/api/instructions` read `src/generated/agent-instructions.json`, generated from the repository's [INSTRUCTIONS.md](../INSTRUCTIONS.md). npm lifecycle hooks synchronize it before `dev`, `build`, `cf:build`, `cf:preview`, and `cf:deploy`. Use these npm scripts so synchronization runs before Next.js or OpenNext; calling the underlying CLIs directly bypasses the hooks. From the repository root, run `npm run docs:sync` after editing the policy and `npm run docs:check` before committing. Generated JSON is committed so both surfaces have identical content and deployment needs no runtime filesystem read.

Configuration examples in `src/components/IdeSetup.tsx` use canonical provider keys and the workflow profile. They omit optional cloud chat settings and include a placeholder project root. Package-runner samples require access to the selected published package; for this checkout's unreleased code use the local launch instructions in [INSTALL.md](../INSTALL.md).

## Deployment

Cloudflare build/preview/deploy scripts are defined in `package.json` and use OpenNext. Inspect the configured account and worker in `wrangler.jsonc` before deploying; this repository cleanup does not deploy the site. API behavior should be verified after a production build, not assumed from the markdown source alone.
