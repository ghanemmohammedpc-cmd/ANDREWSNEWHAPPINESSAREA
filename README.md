# Team Razka Program

Windows BeamNG mod library with Arabic and English, Discord membership verification, and owner administration.

Download the [Windows installer or portable program](https://github.com/ghanemmohammedpc-cmd/ANDREWSNEWHAPPINESSAREA/releases/tag/program-0.1.3).

## Current build

- Discord sign-in and owner access have been verified in the running Windows app.
- Administration starts in English. The top bar switches between English and Arabic, with separate saved preferences for administration and the library.
- Catalog, favorites, pictures, downloads and administration require a verified Discord session.
- Membership is checked again at least once per minute during API use, and before downloads and sensitive owner actions.
- Uploads preserve mod names, creator names and ZIP filenames. Identical ZIPs are rejected even when renamed.
- Downloads support cancellation and resuming. ZIP structure, entry CRCs, size and SHA-256 are checked before installation.
- The default installation folder is BeamNG.drive's `current/mods/repo`. Cars, Maps and Extra have separate sections; car listings can be filtered and sorted by brand.
- Each section loads its complete listing automatically. Preview images load near the visible area.
- The hosted service allocates a shared 20 MB/s pool across active downloads in the program. Clients refresh their allocation every five seconds; abandoned leases expire after twenty seconds. Set the server-only `DOWNLOAD_BANDWIDTH_BYTES_PER_SECOND` variable to change the pool. This pacing applies to program downloads, not direct GitHub downloads or older clients.
- Members can report a car to the owner. Reports are private to the reporter and the owner administration service; the owner's dashboard supports resolving and reopening them.
- Verified material lighting updates carry the Team Razka lighting credit and `(0.40 update)` label.
- Replacing an existing ZIP requires confirmation and makes a verified backup. Uninstall only removes unchanged files installed by the program.
- The catalog starts empty. No sample listings, ratings, download counts or files are published automatically.

The member build connects to https://team-razka-program.team-razka-program.workers.dev. The hosted service uses Cloudflare Workers and D1, with GitHub Releases for ZIP storage.

Public Discord sign-in and owner identification have been verified in the Windows program. The hosted callback shows Arabic and English. Register its exact address in Discord's OAuth2 settings:

```text
https://team-razka-program.team-razka-program.workers.dev/api/v1/auth/discord/callback
```

Start sign-in from the program; opening the callback directly does not sign in.

## GitHub uploads and collection

The administration form contains Upload file, Picture, Name and Description. ZIPs are validated locally and sent in 32 MiB parts to a new draft release. The publishing workflow assembles the ZIP, verifies size, SHA-256 and CRCs, publishes it, then updates the catalog.

Original filenames are retained in the catalog, installer and asset labels. GitHub may normalize special characters in the storage filename. Release titles use the entered name. Editing, hiding and deleting listings retains the release assets.

Reviews use one real rating per member per listing. The catalog refreshes while open; new uploads do not require reinstalling the EXE.

Owner collection tools read all folders without modifying originals:

```powershell
pnpm exec tsx scripts/inventory-collection.ts 'E:/leaked mods'
pnpm exec tsx scripts/publish-collection.ts
```

The ignored data/collection journals record validation, names, sizes, SHA-256, archive fingerprints, creator evidence, actual thumbnails and publication status. Matching existing assets are imported without changing them. Failed archives are reported for attention. Prepared replacements add a new version to the existing listing; earlier release assets remain available.

Cloudflare secrets hold the Discord credentials, session key, owner allowlist, GitHub token and publication callback key. The GitHub workflow receives only its scoped workflow token and callback secret. Neither is included in the EXE.

## Run the server and bot

Requires Node.js 24 and pnpm 11.

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm db:migrate
pnpm server
```

In another terminal:

```powershell
pnpm bot:register
pnpm bot
```

Command registration updates only `/verify`; unrelated commands are preserved. The bot confirms membership privately. The program independently verifies identity and membership during sign-in.

These commands run the optional local backend. The hosted membership check calls Discord's bot API directly and does not depend on this PC remaining on. No automatic Windows startup task is installed.

## Private configuration

Copy `.env.example` to `.env` for a new installation. Existing configured `.env` files should be preserved.

- `DISCORD_CLIENT_ID`: the Discord application's public Application ID.
- `DISCORD_BOT_TOKEN`: bot credential, kept only on the server.
- `DISCORD_CLIENT_SECRET`: OAuth client secret, kept only on the server.
- `DISCORD_GUILD_ID`: the Team Razka server ID.
- `ADMIN_DISCORD_IDS`: comma-separated Discord user IDs allowed to administer the library.
- `DISCORD_REQUIRED_ROLE_ID`: optional role requirement; leave empty to admit all server members.
- `SESSION_SECRET`: a persistent random value of at least 32 characters; required in production.

On Windows, `pnpm setup` opens the private owner configuration window. The Client Secret field is masked. It does not put credentials into the desktop app.

The local redirect URL registered in Discord must match this exactly:

```text
http://127.0.0.1:8787/api/v1/auth/discord/callback
```

The desktop session is encrypted using Windows credentials. Bot credentials, the database, server code and `.env` are excluded from the client package.

## Host for other members

1. Run the backend on an owner-controlled server with persistent storage and HTTPS.
2. Set `NODE_ENV=production`, `SESSION_SECRET` and the Discord configuration on that server.
3. Set `APP_BASE_URL` to the HTTPS server origin and `DISCORD_REDIRECT_URI` to that origin plus `/api/v1/auth/discord/callback`.
4. Add the identical redirect URI in the Discord Developer Portal.
5. Set `PUBLIC_API_BASE_URL` to the public HTTPS origin before building the Windows client.
6. Keep the API and bot running with a service manager. Back up the database, objects, media and session encryption secret securely.

`PUBLIC_API_BASE_URL` is the only server connection value embedded into the desktop build. Credentials remain on the server.

Local storage defaults to private server disk; the local backend also supports private S3-compatible storage. The hosted service uses GitHub Releases. Release files are public even when the program requires Discord membership.

## Windows builds and checks

```powershell
pnpm typecheck
pnpm test
pnpm package:win
```

Outputs:

- `release/Team Razka Program Setup.exe`: per-user Windows installer.
- `release/Team Razka Program.exe`: portable Windows build.

The tests use temporary directories and do not touch the installed BeamNG mods folder. They cover sign-in, access checks, session revocation, uploads, duplicate ZIPs, download tickets, concurrent installation, backup integrity, corrupted archives and resume behavior.

## Remaining work

- Confirmed GitHub import and version selection in administration.
- Media deletion and gallery management.
- Production hosting and a distributable server connection.
- Broader installer checks against real mod archives, without changing the user's installed mods.
