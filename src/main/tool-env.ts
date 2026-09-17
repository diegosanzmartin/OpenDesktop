import { knownSecretValues } from '@shared/errors'

/**
 * The environment a command the agent asked for runs in.
 *
 * The app merges the login shell's environment into its own at startup, because
 * that is the only way a Finder launch can find `node` — or the API key the
 * README asks you to export from `~/.zshrc`. Every one of those variables was
 * then handed to every command the agent ran, and an agent looking for a
 * registry credential does the obvious thing: `env | grep -i token`. Its output
 * goes into the transcript on disk and to the model, so the app's own key ended
 * up in the provider's logs.
 *
 * Only the app's own credentials are removed — the values it resolved for
 * itself out of the keychain, a file or the environment. Everything else stays:
 * a session doing infrastructure work needs the same `gcloud`, `git` and `kube`
 * environment a person would have, and deciding by name which of those is too
 * sensitive to pass on is not this function's business.
 */
export function toolEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const secrets = knownSecretValues()
  if (secrets.length === 0) return { ...base }

  const out: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(base)) {
    if (typeof value === 'string' && secrets.includes(value.trim())) continue
    out[name] = value
  }
  return out
}
