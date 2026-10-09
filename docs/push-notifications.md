# Instant phone alerts (Firebase Cloud Messaging)

Out of the box, the [Android app](https://github.com/EOSOClub/OurHomeApp)
checks the server about once an hour in the background. With Firebase set up,
the server pushes a "something changed" signal the moment a request is made,
assigned, accepted, finished or withdrawn, a bug report comes in, a new app
build is announced, or the 15-minute reminder sweep creates a new bell reminder
(overdue task, low or soon-depleted stock, bill coming due). The phone then
checks right away and alerts within seconds.

**What goes through Google:** only `{ type: "sync", reason: "request" }` and a
device token. The phone fetches the details from your server and builds the
notification itself, so request text, names and amounts never leave your
server, and the app's lock-screen rules apply exactly as before. The hourly
check stays on as a fallback.

You need both halves: a key on the **server**, and a config file in the **app
build**. Either one alone does nothing. Each household uses its own Firebase
project; it's free (Cloud Messaging has no cost or message limit).

> [!TIP]
> **The easy way:** run `./deploy.sh -s` (or `.\deploy.ps1 -Setup`) in
> `docker/` and answer yes to instant alerts. It asks for your app id, links
> each Firebase page below, waits while you create things, takes the key file's
> path, checks it, and prints what to put in the app. The steps below are the
> same thing by hand.

## 1. Pick your app id

Android apps are identified by an id like `com.<name>.ourhome`. Choose your own
`<name>` (lowercase letters and digits, e.g. your family name). Firebase and
the app you build must use the same id. No source folders are renamed: the
app's code stays in `com.eosoclub.ourhome`; only the installed id changes.

## 2. Create the Firebase project

1. Open the [Firebase console](https://console.firebase.google.com) and
   **Create a project** (any name; Google Analytics is not needed, so turn it off).
2. In the project, **Add app → Android**:
   - **Package name:** your app id, e.g. `com.smithfamily.ourhome` (must match exactly)
   - Nickname optional; skip the SHA-1.
3. **Download `google-services.json`.** Skip the remaining SDK steps; the app
   already has them.

## 3. App: set the id and add `google-services.json`

In the OurHomeApp repo, set the id in its `settings.yml` (template:
`settings.example.yml`):

```yaml
app:
  id: com.smithfamily.ourhome
```

and put the file in the app module folder:

```
OurHomeApp/
  settings.yml
  OurHomeApp/
    google-services.json   ← here
    build.gradle.kts
```

Both are gitignored. Rebuild and reinstall (`./gradlew installDebug`). If the
app was installed under a different id, uninstall that one first (it's a
separate app to Android; you sign in once more). Without `google-services.json`
the app still builds and works, just without instant alerts.

## 4. Server: add the service-account key

1. In Firebase: **Project settings → Service accounts → Generate new private
   key**. This downloads a JSON file. **Treat it like a password**: it can send
   messages to every install of your app.
2. Encode it onto one line and put it in the repo-root `.env` (it's a secret):

   ```bash
   base64 -w0 service-account.json
   ```

   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("service-account.json"))
   ```

   ```env
   FIREBASE_SERVICE_ACCOUNT=ewogICJ0eXBlIjogInNlcnZpY2VfYWNjb3VudCIs...
   DEV_FIREBASE_SERVICE_ACCOUNT=
   ```

   The empty `DEV_FIREBASE_SERVICE_ACCOUNT` keeps it off for `npm run dev`.

3. Redeploy. The new `PushDevice` collection is created on start.

## 5. Check it works

1. Open the app and sign in (or just open it if you're already signed in): it
   registers the phone with the server.
2. From another account, create a request for that person (or a movie request
   for the head).
3. The phone should alert within a few seconds. The server log shows a line like:

   ```
   [push] sync (request): 1/1 device(s) reached
   ```

| Log line | Meaning |
| --- | --- |
| No `[push]` lines at all | `FIREBASE_SERVICE_ACCOUNT` isn't reaching the container, or the person has no registered phone. |
| `FIREBASE_SERVICE_ACCOUNT is not valid JSON…` | The value is cut off or wrongly encoded. Re-encode the whole file. |
| `token exchange failed (400/401)` | The key was deleted or revoked in Firebase. Generate a new one. |
| `0/1 device(s) reached` + `FCM send failed (403)` | The key is from a different Firebase project than the app's `google-services.json`. |
| App build fails: `No matching client found for package name` | The app's `app.id` isn't the package name registered in that `google-services.json`. |
| `dead token(s) removed` | Normal: an install was uninstalled or its data cleared. |

## Behaviour notes

- A push only wakes the phone. It alerts for **new** waiting requests, new bug
  reports and deadline milestones. Anything it already alerted about stays
  quiet until the hourly reminder repeats it.
- Signing out in the app removes that phone from the server. A phone that
  signs in as someone else moves to the new account.
- Phones with aggressive battery savers (some Samsung, Xiaomi, OnePlus models)
  can still delay pushes. Setting the app's battery use to **Unrestricted**
  fixes that.
