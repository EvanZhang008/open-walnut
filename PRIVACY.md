# Privacy Policy

Last updated: October 3, 2026

This policy covers the Open Walnut iPhone app ("the app"). Open Walnut is open-source
software. The app is a companion for a Walnut server that you install and run
yourself, on your own computer or on a cloud machine in your own account.

## The short version

- The developers of Open Walnut do not receive, store, or have access to your data.
- The app sends your data only to the Walnut server you pair it with, and to Apple
  for push notifications.
- The app has no analytics, no advertising, no tracking, and no third-party SDKs.
- There is no Open Walnut account. You do not sign up with us.

## What the app stores on your phone

- **Connection settings**: your server's address and the device name you entered. The
  device token that lets the app talk to your server is kept in the iOS Keychain.
- **Cached copies of your server data**: conversations, messages, tasks, notes, letters,
  and images, so the app opens quickly and works offline.
- **Work that has not reached your server yet**: messages and attached photos waiting
  to be sent, and drafts.
- **Voice recordings waiting to be transcribed**. A recording is deleted once its text
  has been delivered. A recording that cannot be transcribed is kept for retry for up to
  7 days (at most 20 recordings), or until you discard it.
- **A diagnostic log** of what the app did (screens opened, sends, connection events,
  errors). It is kept on the phone (up to about 16 MB) until it has been uploaded to your
  server.
- **App preferences**, such as notification and calendar filter settings.
- **Apple Health sync progress**, if you turn Apple Health on: which Health records have
  already reached your server, so only new ones are sent. The app keeps no copy of your
  Health records themselves, and this progress file is not included in iCloud backups.

Like other app data, this data can be included in your iPhone backups.

## What the app sends, and to whom

**To your Walnut server only:**

- What you do in the app: messages, replies to letters, tasks, notes, photos you
  attach, and the actions you take (for example, allowing a tool request).
- Voice recordings, so your server can turn them into text.
- Basic device information: the hardware model identifier (for example "iPhone17,1"),
  the iOS version, the app version, and the device name you entered.
- The diagnostic log described above, including crash and hang reports that iOS
  provides to the app.
- How long each screen of the app is open, so your server can show time spent per task
  and session.
- **Apple Health data, only if you turn it on** (Settings, Apple Health) and only the
  kinds you allow on the Health permission screen: for example sleep, heart rate,
  activity, workouts, body measurements, nutrition, symptoms and the other Health data
  you choose. The app reads it on the phone and keeps your server up to date, including
  in the background. Your server keeps it on that computer, and the AI agents running
  there can read it to answer your questions. It is never used for advertising or
  marketing, never sold, and never stored in iCloud by the app.
- Your push notification token. If you choose to be notified only while the app is not
  open, the app also tells your server when it is open.

What your server does with this data is under your control. For example, your server
sends prompts to the AI provider you set up on it, and it may transcribe voice on your
own computer or through a speech service you configure there. Those services are chosen
and configured by you, not by the app.

**To Apple:**

- If you allow notifications, iOS registers the app with Apple Push Notification
  service, and notifications from your server are delivered through Apple. Apple's
  handling of this data is covered by Apple's privacy policy.

**To other websites, only when your own content points there:**

- If a chat message, session, or note contains an image hosted on another website, the
  app loads that image directly from that website, which can see your IP address and
  that the image was requested. Letters from your agents never load images from other
  websites.
- An HTML file you open from your server can load the resources it refers to.
- Links you tap open in Safari.

The app does not contact the Open Walnut developers or any other server.

## Permissions

- **Camera**: to scan the pairing QR code from your Walnut console, and to take photos
  you choose to attach. QR codes are read on the phone. A photo is sent to your server
  only when you attach it.
- **Photos**: the app uses the iOS photo picker, so it only sees the photos you pick.
- **Microphone**: used only while you record voice input. The audio is sent to your
  server for transcription.
- **Calendars**: read only, to show your calendar events next to your tasks in the
  calendar view. Calendar events never leave your phone.
- **Notifications**: to tell you about new letters from your agents. Optional. The app
  asks only when your server is set up to send notifications.
- **Apple Health**: read only, and only after you tap Turn On Apple Health. You choose
  each kind of data on Apple's permission screen, and can change it later in the Health
  app. The App Store version never writes to Apple Health.

You can change any of these in the iOS Settings app at any time.

## What the app does not do

- No analytics, crash reporting services, or advertising SDKs.
- No tracking across apps or websites, and no advertising identifier.
- No selling or sharing of data with anyone.
- No account with the developers.

## Deleting your data

- **On your phone**: in the app, Settings, Disconnect removes everything the app stored
  on the phone: the server address, the device token, cached conversations, tasks, notes,
  letters and images, unsent messages and drafts, recordings waiting for transcription,
  the diagnostic log, and app preferences. Deleting the app also removes everything it
  stored on the phone.
- **Apple Health on your server**: in the app, Settings, Apple Health, Delete Health
  Data on Mac removes every Apple Health record your server keeps and turns Apple Health
  off on the phone. Nothing is removed from the Health app.
- **On your server**: your data lives on the server you run. Revoke the phone from the
  Devices section of your Walnut console's Settings, or with `walnut device revoke <name>`,
  and manage or delete your data there.

## Children

The app is not directed at children.

## Changes

If this policy changes, the new version will be published in this file, with its
history visible in the repository.

## Contact

Questions or concerns: open an issue at
https://github.com/EvanZhang008/open-walnut/issues
