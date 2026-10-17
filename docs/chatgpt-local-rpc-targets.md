# Local RPC targets for ChatGPT through R

The R bridge can keep its ordinary Rakazo connection while routing an explicit set of procedures to another local instance. This is useful when PAPER runs separately from the main application.

A signed-in owner creates a finite grant with `rpcAccess/grantCreate`. Its allowed procedures come from the shared PAPER allowlist, its user and space come from the authenticated request, and its lifetime is at most fourteen days. Only a token hash is stored in the database. Grant tokens cannot sign in, create other grants, manage credentials, control a computer, or select another space. Revoke them through `rpcAccess/grantRevoke`.

Set `RAKAZO_RPC_TARGETS_FILE` to a private JSON configuration outside the repository:

```json
{
  "targets": [{
    "name": "paper",
    "apiUrl": "http://127.0.0.1:3008",
    "origin": "http://127.0.0.1:5188",
    "spaceId": "<grant-space-id>",
    "accessTokenEnv": "RAKAZO_RPC_KEY_PAPER",
    "procedures": ["trading/perpetualWorkspaceRead"]
  }]
}
```

Supply the newly issued token in the named environment variable from the operating system's protected credential storage. Do not copy an existing browser session or put tokens in tracked files or command-line arguments. The private configuration may also supply an explicit accessToken when the host provides an appropriately protected configuration file.

Each procedure has one exact destination. Destinations must be loopback origins. The bridge uses the target's own credential and space, refuses redirects, and never retries a failed target against the default instance. Procedures without a target retain the existing connection. Token expiry or revocation does not stop an already authorized PAPER protection worker; it stops further connector access.
