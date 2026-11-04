import type { AutoModePolicy } from './types'

/**
 * A starting point for the auto-approve rules, offered in Settings and never
 * applied on its own: rules a person did not write are rules they cannot see.
 * Named the way Claude Code's auto mode names them, so the judge can cite one.
 */
export const SUGGESTED_AUTO_MODE: AutoModePolicy = {
  environment: [
    "A developer's own laptop. Each conversation's working folder is a git checkout the person is working in.",
    "Trusted: the working folder, /tmp, the project's own git remotes and the package registries the project already uses."
  ],
  allow: [
    'Local Work: reading, creating, editing and deleting files inside the working folder, and running its builds, tests, linters and formatters.',
    'Local Git: commits, branches, stashes and rebases of work that has not been pushed.',
    'Project Dependencies: installing the dependencies the project declares, into the project (npm/pnpm install, pip install -r, uv sync).'
  ],
  deny: [
    'Git Push: pushing to any remote or opening a pull request, unless the person asked for it in this conversation.',
    'Git Destructive: force-pushing, deleting remote branches or tags, or rewriting history that has been pushed.',
    'Outside Writes: creating, changing or deleting files outside the working folder and /tmp.',
    'Credentials: reading, printing, copying or changing secrets — ~/.ssh, ~/.aws, ~/.config/gcloud, .env files, keychains, tokens in the environment.',
    'Data Out: sending files, code or data to a service outside the trusted list — uploads, POSTs, pastebins, webhooks, email.',
    'System Changes: installing or removing software globally (brew, sudo, npm -g), editing shell profiles, launch agents, cron or system settings.',
    'Cloud Changes: creating, changing or deleting cloud resources or infrastructure (terraform apply or destroy; gcloud, aws or kubectl commands that change state).',
    'Code From Outside: downloading and running a script from the internet (curl … | sh, running a tool cloned a moment ago).'
  ]
}
