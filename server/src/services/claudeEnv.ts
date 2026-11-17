// The only environment a `claude` subprocess (or a project's make) gets: an allow list, so the
// server's secrets (DATABASE_URL, SCHMEIDE_*, OAuth client secrets) and anything added to the pod
// later never reach a model that reads untrusted files and websites.
// - PATH, HOME, USER: find tools and the logged-in CLI (macOS keeps the login in the keychain,
//   which claude looks up by USER; HOME alone reads as logged out).
// - ANTHROPIC_*: the API key (ANTHROPIC_API_KEY) and provider settings such as Foundry's
//   ANTHROPIC_FOUNDRY_RESOURCE / ANTHROPIC_FOUNDRY_API_KEY. CLAUDE_CODE_*: switches such as
//   CLAUDE_CODE_USE_FOUNDRY. CLAUDE_CONFIG_DIR: where a login lives when not under HOME.
// - DOCKER_*: a project's make runs Docker Compose.
const ALLOWED =
  /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TERM|TZ|LANG|LC_[A-Z_]+|NODE_EXTRA_CA_CERTS|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|ANTHROPIC_[A-Z0-9_]+|CLAUDE_CODE_[A-Z0-9_]+|CLAUDE_CONFIG_DIR|DOCKER_HOST|DOCKER_CONTEXT|DOCKER_CONFIG)$/;

export const claudeEnv = (
  source: Readonly<Record<string, string | undefined>> = process.env
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && ALLOWED.test(entry[0])
    )
  );
