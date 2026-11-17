# Sign-in and the prelaunch approved list

People sign in to Schmeide with Google, Microsoft, Apple, or an email and password. While we are in prelaunch, only
email addresses on the approved list can have an account, so nobody else can spend model tokens.

This page covers approving people, the settings, registering with each provider, and connecting the hosted site
(schmeide.app on GitHub Pages) to a server.

## Local logins

On localhost, `make serve` runs `make db/seed` after the migrations, so there is no approval step for local work. It
leaves two approved logins, both with the password `schmeide-local-only`, and prints them:

- `admin@schmeide.localhost`: the platform admin role, in no business. Its grant is in the audit log like any other.
- `owner@schmeide.localhost`: the owner of the `demo` business, with no admin role.

To work on customer screens, sign in as the admin and view as `owner@schmeide.localhost`
([Viewing as a customer](#viewing-as-a-customer)).

Running it again adds only what is missing: it does not reset a changed password or sign anyone out. It refuses, and
writes nothing, unless `SCHMEIDE_PUBLIC_URL` is localhost, so a known password never reaches a deployed database. For
a real environment, use `make access/approve` and `make access/admin` below.

## Approve a person

```sh
make access/approve EMAIL=person@example.com   # approve, and print a set-password link
make access/list                               # who is approved, who has signed in, and who is an admin
make access/remove EMAIL=person@example.com    # take them off the list and sign them out
make access/admin EMAIL=person@example.com     # give an approved person who has signed in the admin role
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

## Admins

The people who run Schmeide have the platform `admin` role (`users.role`), separate from being an owner or editor of
a business. An admin sees an Admin entry in the navigation and the admin area at `/admin`, and only an admin can call
the server's `admin.*` procedures, the only ones that read across businesses. To anyone else they answer exactly as a
procedure that does not exist.

- `access/admin` works only for an approved address whose person has already set a password or signed in; it says
  what to run first otherwise. The role takes effect on their next request.
- Every admin write, `access/admin` included, is recorded in the audit log (`admin_actions`), shown at `/admin/audit`.
  The command line is recorded as `command line`.
- An admin is not given a business of their own, and lands on `/admin`. Approving them with `TENANT=...` puts them in
  one.
- `access/remove` takes an admin's access away like anyone else's: the role is kept but does nothing while the address
  is off the list.
- The role comes from Better Auth's admin plugin. Its own `/api/auth/admin/*` endpoints all answer 404; admin actions
  go through the `admin.*` procedures instead.

## Viewing as a customer

An admin can see and use the app exactly as a person does, to reproduce what they report: their businesses, their
projects, and the same guards. There is no page of its own: the control sits on a person's row in the admin area, on
the people screen and on a business's page (#132). The admin gives a reason, and the browser switches to a session
as that person (`admin.impersonation.start`, built on Better Auth's admin plugin, which records the admin on the
session as `sessions.impersonated_by`).

- Every page shows a banner naming the person, which cannot be dismissed. Its Stop button
  (`impersonation.stop`) returns the admin to their own session at `/admin`. Signing out from the account menu
  stops the view first.
- A view lasts an hour from its start, whatever renews the session. After that the browser is signed out, and the
  admin signs in again.
- The audit log records the start (with the reason), the stop, and, against the admin, every change made in
  between (`impersonation.write`, naming the person, the business, and the procedure, or `files.upload` for an
  upload), so the history never says the customer did it.
- Refused while viewing: every `/api/auth` route but reading the session, so the person's password, email,
  providers, account, and other sessions cannot be changed, and nothing about them is shown. Accepting a
  set-password link is refused too, and so will be anything that charges money.
- Not another admin, not yourself, and not a second view from inside one: while viewing, the admin is not an
  admin.
- A person whose approval was removed can still be viewed as ("I cannot get in" is worth seeing from their side);
  they still cannot sign in themselves. `access/remove` for the person leaves an admin's view of them alone.
- Taking the admin role or approval away from the admin ends every view they have open.
- Customers are not told at the time. The privacy text should say that staff can view an account to give support.

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
