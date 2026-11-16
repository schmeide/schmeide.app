# Sign-in and the prelaunch approved list

People sign in to Schmeide with Google, Microsoft, Apple, or an email and password. While we are in prelaunch, only
email addresses on the approved list can have an account, so nobody else can spend model tokens.

This page covers approving people, the settings, registering with each provider, and connecting the hosted site
(schmeide.app on GitHub Pages) to a server.

## Approve a person

```sh
make access/approve EMAIL=person@example.com   # approve, and print a set-password link
make access/list                               # who is approved, and who has signed in
make access/remove EMAIL=person@example.com    # take them off the list and sign them out
```

- An approved person can sign in with any provider that is turned on, as long as the provider account uses that
  email address.
- To use a password, send them the link `access/approve` prints. It works once and for 7 days. The server sends no
  email yet, so you send the link yourself.
- A forgotten password: run `access/approve` again for the same address and send the new link. Using it sets a new
  password and signs the person out everywhere else. The newest link is the only one that works.
- `access/remove` takes effect on the person's next request. Their account and projects are kept, and approving the
  address again gives them back.
- `TENANT=demo` on `access/approve` puts the person in an existing business (here, the one that holds the projects
  made before sign-in existed). Without it, a new person gets an empty business of their own.
- These commands act on the database in `DATABASE_URL`. To approve someone on a hosted server, run them where that
  database is reachable, with `SCHMEIDE_PUBLIC_URL` set so the printed link has the right address.

## Settings

All are environment variables of the server (`make serve` reads them from `.env`). Only `VITE_API_URL` belongs to
the site build.

- `SCHMEIDE_PUBLIC_URL`: the address people open. Provider sign-ins return here, and only this origin may call
  the API from a browser. Default `http://localhost:5173`.
- `SCHMEIDE_API_URL`: the address the browser reaches `/api` at, when it differs from the public address. Default:
  the public address.
- `SCHMEIDE_AUTH_SECRET`: signs session cookies. At least 32 random characters (`openssl rand -base64 32`). On
  localhost a fixed value is used when it is unset.
- `SCHMEIDE_HOST`: the address the server listens on. Default `127.0.0.1`.
- `SCHMEIDE_GOOGLE_CLIENT_ID` and `SCHMEIDE_GOOGLE_CLIENT_SECRET`: turn on "Continue with Google".
- `SCHMEIDE_MICROSOFT_CLIENT_ID` and `SCHMEIDE_MICROSOFT_CLIENT_SECRET`: turn on "Continue with Microsoft".
- `SCHMEIDE_APPLE_CLIENT_ID` and `SCHMEIDE_APPLE_CLIENT_SECRET`: turn on "Continue with Apple".
- `VITE_API_URL` (site build): where the built site finds the API. Empty, the default, means its own origin.

Notes:

- The server will not start on a public address without `SCHMEIDE_AUTH_SECRET`. Changing the secret signs everyone
  out.
- A provider needs both of its values. With neither set, its button is not shown, and email and password still work.
- Secrets go in the server's environment only. Nothing secret goes in a `VITE_` variable: the site bundle is public.

## Register with each provider

Each provider needs the address it sends people back to. With `SCHMEIDE_API_URL` as `<api>`:

| Provider  | Return address                      |
| --------- | ----------------------------------- |
| Google    | `<api>/api/auth/callback/google`    |
| Microsoft | `<api>/api/auth/callback/microsoft` |
| Apple     | `<api>/api/auth/callback/apple`     |

For local work, `<api>` is `http://localhost:5173`. Google and Microsoft accept that address; Apple does not.

None of the three has been tried against the real provider yet: that needs the credentials below. Sign in once with
each after setting it up, with an approved and an unapproved address.

### Google

1. In the [Google Cloud console](https://console.cloud.google.com/), create or pick a project, and set up the OAuth
   consent screen (external users; the `email` and `profile` scopes are enough).
2. Create an OAuth client of type "Web application". Add the return address above as an authorized redirect URI.
3. Put its client ID and secret in `SCHMEIDE_GOOGLE_CLIENT_ID` and `SCHMEIDE_GOOGLE_CLIENT_SECRET`.

While the consent screen is in "testing", only the test users listed there can sign in. Publish it before inviting
people outside that list.

### Microsoft

1. In the [Entra admin center](https://entra.microsoft.com/), register an application. For supported account types,
   choose accounts in any organizational directory and personal Microsoft accounts.
2. Add the return address above as a redirect URI of type "Web".
3. Under "Certificates & secrets", create a client secret. It expires; note the date.
4. Under "Token configuration", add these optional claims to the ID token: `email`, `verified_primary_email`, and
   `verified_secondary_email`.
5. Put the application (client) ID and the secret value in `SCHMEIDE_MICROSOFT_CLIENT_ID` and
   `SCHMEIDE_MICROSOFT_CLIENT_SECRET`.

Step 4 matters. A Microsoft work account can carry any email address its own administrator typed in, so the server
accepts a Microsoft sign-in only when the token says the address is verified. Without those claims, people are
refused with "has not confirmed its email address". Check with a work account and a personal account that both get
in; if one kind still cannot, those people can use a password instead.

### Apple

Apple needs a paid Apple Developer account, an https address, and a domain it can verify, so it cannot be tried on
localhost.

1. In [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/), create an App ID with
   "Sign in with Apple" turned on, then a Services ID linked to it. The Services ID is the client ID.
2. On the Services ID, configure Sign in with Apple: add the API's domain and the return address above.
3. Create a key with "Sign in with Apple" turned on and download its `.p8` file.
4. Apple's client secret is not a fixed string. It is a token you sign with that key (ES256; issuer is your team ID,
   subject is the Services ID, audience is `https://appleid.apple.com`), and it lasts at most 6 months. Make one,
   put it in `SCHMEIDE_APPLE_CLIENT_SECRET`, and put a reminder in the calendar to replace it before it expires.
5. Put the Services ID in `SCHMEIDE_APPLE_CLIENT_ID`.

People who choose "Hide My Email" reach us under an Apple relay address, which will not be on the approved list.
They need to share their real address, or be approved under the relay address.

## Connect the hosted site to a server

schmeide.app is static files on GitHub Pages. Until it is built with an API address it shows "Coming soon".

1. Run the server somewhere with an https address on the same site as the UI, for example `api.schmeide.app`. It
   must be a subdomain of `schmeide.app`: the session cookie is not sent to an unrelated domain.
2. Put a proxy that ends https in front of it, forwarding to the server's port and passing the caller's address in
   `X-Forwarded-For` (sign-in attempts are limited per address).
3. Set on the server: `SCHMEIDE_PUBLIC_URL=https://schmeide.app`, `SCHMEIDE_API_URL=https://api.schmeide.app`,
   `SCHMEIDE_AUTH_SECRET`, and the provider values. Use the `api.schmeide.app` return addresses with each provider.
4. Run the migrations against its database (`make db/migrate`), and approve yourself.
5. In the GitHub repository, set the Actions variable `VITE_API_URL` to `https://api.schmeide.app`, and run the
   Continuous Deployment workflow. Removing the variable and deploying again turns the hosted app back off.

Before step 5, check:

- `https://api.schmeide.app/api/healthz` answers from outside.
- An unapproved address cannot sign in, by a provider or by password.
- Signed out, `https://api.schmeide.app/api/trpc/projects.list` answers 401.

What this does not do:

- It limits who can spend, not how much. One approved person can still start many builds; a spending limit is #83.
- The server still builds and runs apps on its own machine with the local `claude` login (#5). "Hosted" means that
  machine behind an https address until that changes. Built apps are served from the server's own ports and have no
  sign-in of their own (#84), so do not put business information in one yet.
- The session cookie belongs to the API's host only. Built apps must stay on another domain, as decided, so they
  never see it.
