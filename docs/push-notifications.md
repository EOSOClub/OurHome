# Instant phone alerts (Firebase Cloud Messaging)

Out of the box, the [Android app](https://github.com/EOSOClub/OurHomeApp)
checks the server about once an hour in the background. With Firebase set up,
the server pushes a "something changed" signal the moment a request is made,
assigned, accepted, finished or withdrawn, or a bug report comes in. The phone
then checks right away and alerts within seconds.

**What goes through Google:** only `{ type: "sync", reason: "request" }` and a
device token. The phone fetches the details from your server and builds the
notification itself, so request text, names and amounts never leave your
server, and the app's lock-screen rules apply exactly as before. The hourly
check stays on as a fallback.

You need both halves: a key on the **server**, and a config file in the **app
build**. Either one alone does nothing.

## 1. Create the Firebase project

1. Open the [Firebase console](https://console.firebase.google.com) and
   **Create a project** (any name; Google Analytics is not needed, so turn it off).
2. In the project, **Add app → Android**:
   - **Package name:** `com.eosoclub.ourhome` (must match exactly)
   - Nickname optional; skip the SHA-1.
3. **Download `google-services.json`.** Skip the remaining SDK steps; the app
   already has them.

## 2. App: add `google-services.json`

Put the file in the app module folder of the OurHomeApp repo:

```
OurHomeApp/
  OurHomeApp/
    google-services.json   ← here
    build.gradle.kts
```

It's gitignored. Rebuild and reinstall (`./gradlew installDebug`). Without the
file, the app still builds and works, just without instant alerts.

## 3. Server: add the service-account key

1. In Firebase: **Project settings → Service accounts → Generate new private
   key**. This downloads a JSON file. **Treat it like a password**: it can send
   messages to every install of your app.
2. Encode it onto one line and put it in the repo-root `.env`:

   ```bash
   base64 -w0 service-account.json
   ```

   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("service-account.json"))
   ```

   ```env
   SERVER_FIREBASE_SERVICE_ACCOUNT=ewogICJ0eXBlIjogInNlcnZpY2VfYWNjb3VudCIs...
   ```

3. Check your `docker/docker-compose.yml` passes it through (the template in
   `docker.example/` does):

   ```yaml
   FIREBASE_SERVICE_ACCOUNT: ${SERVER_FIREBASE_SERVICE_ACCOUNT:-}
   ```

4. Redeploy. The new `PushDevice` collection is created on start.

## 4. Check it works

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
