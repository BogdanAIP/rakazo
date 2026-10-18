# Linked local PAPER journal

This optional local gateway lets an existing Rakazo login open an independently
running PAPER journal from the account menu. Main chats, settings and identity
continue to use the main API. Financial requests use an explicitly configured,
finite owner grant. No account, journal event, position or owner ID is migrated.

The gateway validates the main session on every financial request, including
revocation and expiry, then checks the exact configured main user. It forwards
only the configured PAPER procedure names. The browser never receives the
grant. Incoming cookies, actor headers and space selection are not forwarded
to PAPER. Commands are never retried by the gateway. Grant expiry or revocation
fails closed; this component never creates or renews grants or trading sessions.

## Setup

Build the existing reviewed UI outside either Git checkout:

~~~sh
node scripts/local-paper-journal/build.mjs <reviewed-ui-tree> <full-commit> <new-assets-directory>
~~~

Create a private configuration outside Git:

~~~json
{
  "publicOrigin": "http://127.0.0.1:5173",
  "authApi": "http://127.0.0.1:3100",
  "allowedUserId": "example-main-user",
  "paperApi": "http://127.0.0.1:3008",
  "paperOrigin": "http://localhost:5188",
  "paperSpaceId": "example-paper-space",
  "procedures": ["trading/perpetualJournalList", "trading/perpetualJournalRead"],
  "expiresAt": "2030-01-01T00:00:00Z",
  "credentialEnv": "LOCAL_PAPER_GRANT",
  "assetsDir": "/absolute/private/journal-assets",
  "port": 5190
}
~~~

Use the actual existing grant's scope and expiry. The example is read-only.
The optional authOrigin is the main API's trusted web origin when verifying on
a separate local preview origin. All origins must be HTTP loopback origins.
Supply the existing grant in the named server-process environment variable
through the local protected credential launcher; do not place it in a URL,
client environment variable, configuration file or command-line argument.

Start the server with:

~~~sh
node scripts/local-paper-journal/server.mjs <private-config>
~~~

Use the local platform's hidden/background process launcher. Set
RAKAZO_LINKED_PAPER_URL to the gateway's loopback origin for the main web process.
The main API and PAPER services retain their existing launchers and finite
authority. The gateway binds only to 127.0.0.1. It does not start trading.

When Electron uses the configured external local web server, its bundled renderer
passes journal requests through to that server. The main web/Electron account menu shows “Журнал PAPER” only when the gateway
confirms access. Its page embeds the already reviewed futures journal with a
return link to the main application. Unsupported/unconfigured deployments
show no menu item; a direct link fails closed. This optional loopback view
requires a browser on the local host; it does not provision a remote mobile
connection. Electron’s managed Docker stack is also unsupported by this host-only
gateway: the container does not share the host loopback address or protected
credential launcher. Leave it unconfigured there; its menu remains hidden and
a direct link fails closed. This setup does not expose the gateway beyond loopback.

## Validation

~~~sh
node --test scripts/local-paper-journal/server.test.mjs
~~~

The web E2E checks primary sign-in, account-menu navigation, embedded view,
return to existing chats, unavailable-link behavior and the signed-out deep
link. The frame fixture contains synthetic text and checks the new host UI;
it is not a financial integration test. Verify an actual local owner session
against the existing reviewed UI and immutable journals before rollout.
