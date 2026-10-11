# Privacy Policy

Last updated: October 9, 2026

This policy covers the Open Walnut iPhone app ("the app"). Open Walnut is open-source
software. The app is a companion for a Walnut server that you install and run
yourself, on your own computer or on a cloud machine in your own account.

## The short version

- The developers of Open Walnut do not receive, store, or have access to your data.
- The app sends your data only to the Walnut server you pair it with, and to Apple:
  for push notifications, and, if you turn Places on, to name the places you visit. It
  contacts another website only when your own content points there, for example to
  load an image in a chat or note that is hosted on that website.
- The app has no analytics, no advertising, no tracking, and no third-party SDKs.
- There is no Open Walnut account. You do not sign up with us.

## What the app stores on your phone

- **Connection settings**: your server's address and the device name you entered. The
  device token that lets the app talk to your server is kept in the iOS Keychain.
- **Cached copies of your server data**: conversations, messages, tasks, notes, letters,
  and images, so the app opens quickly and works offline.
- **Work that has not reached your server yet**: messages and attached photos waiting
  to be sent, and drafts.
- **Recently opened**: the last 40 tasks and sessions you opened in the app, and when,
  so the Tasks tab can list them again. The list's Clear button empties it.
- **Voice recordings waiting to be transcribed**. A recording is deleted once its text
  has been delivered. A recording that cannot be transcribed is kept for retry for 7
  days (at most 20 recordings), unless you discard it sooner, and is deleted the next
  time the app starts or records after that.
- **A diagnostic log** of what the app did (screens opened, sends, connection events,
  errors). It is kept on the phone (up to about 16 MB) until it has been uploaded to your
  server.
- **App preferences**, such as notification and calendar filter settings.
- **Apple Health sync progress**, if you turn Apple Health on: which Health records have
  already reached your server, so only new ones are sent. The app keeps no copy of your
  Health records themselves. For your date of birth, sex and the other characteristics
  it keeps only a fingerprint, to notice when one changes: a hash with a random value
  made on the phone, which is kept apart from this file in the iOS Keychain, on this
  iPhone only. This progress file is not included in iCloud backups.
- **Places you visited**, if you turn Places on: for each visit, when you arrived and
  left, its coordinates and their accuracy, your time zone, and the place's name and
  address. A visit is kept until your server has it. After that the phone keeps it, to
  show your recent visits, until two weeks after it ended, and removes it the next time
  the app starts, records a visit or sends one. When you turn Places off, the phone
  removes at once every visit your server has, and a visit your server does not have
  yet is removed once it has been sent. The phone keeps at most 3,000 visits. This file
  is not included in iCloud backups.

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
  and session. Each of these records carries a random identifier the app makes once per
  install, so your server counts each record only once.
- Your time zone: with Apple Health records and Places visits, so their times read
  right, and with a task you type in plain words, so a date like "tomorrow at 9" is read
  in your time zone.
- **Apple Health data, only once Apple Health is on in the app** (see Permissions below
  for the two ways it gets turned on), and only the kinds you allow on Apple's
  permission screen. The app asks to read nearly every kind Apple Health has: sleep,
  heart (including ECG readings and heart rhythm notifications), activity and workouts,
  body measurements, vital signs, nutrition, symptoms, cycle tracking and reproductive
  health, sexual activity, mood and the GAD-7 and PHQ-9 mental health questionnaires,
  hearing exposure, mindfulness, and your date of birth, sex, blood type, skin type,
  wheelchair use and activity move mode. Each record carries the name of the app and the
  device that recorded it. Each batch the phone sends also carries the id of your
  server's Health store, which the phone got from your server, so a batch meant for a
  store you have since deleted is refused and the phone starts over. The app does not
  read clinical records, medications, vision prescriptions, audiograms, heartbeat series
  or workout routes, so it reads no location from Apple Health. It reads on the phone
  and keeps your server up to date, including in the background. Only your main Walnut
  server stores it. A cloud companion passes it straight through to your main server and
  keeps none of it. The AI agents on your server can read it to answer your questions.
  When they do, what they read becomes part of that conversation, which your server
  sends to the AI provider you set up there. It is never used for advertising or
  marketing, never sold, and never stored in iCloud by the app.
- **Places, only once Places is on in the app** (see Permissions below). For each place
  you visit: when you arrived and when you left, in the time zone you were in, the
  coordinates and their accuracy, and the place's name and address. The app also says
  whether Places is on and what location access iOS gives it, when that changes and
  about once a day. Only your main Walnut server stores your places. A cloud companion
  passes them straight through to your main server and keeps none of them. The AI
  agents on your server can read them to answer questions about where you were. When
  they do, what they read becomes part of that conversation, which your server sends to
  the AI provider you set up there. Nothing is sent from a phone that never turned
  Places on.
- Your push notification token. If you choose to be notified only while the app is not
  open, the app also tells your server when it is open.

The app can reach your Walnut server in more than one way: at the address you paired
with, directly on your Wi-Fi network, through your own Tailscale network, or through a
cloud companion you run in your own cloud account. Your server tells the app these
addresses, and the app uses whichever one answers. Every one of them leads to your own
Walnut. The app checks an address with a request that carries no device token and no
data of yours.

What your server does with this data is under your control. For example, your server
sends prompts to the AI provider you set up on it, and it may transcribe voice on your
own computer or through a speech service you configure there. Those services are chosen
and configured by you, not by the app.

**To Apple:**

- If you allow notifications, iOS registers the app with Apple Push Notification
  service, and notifications from your server are delivered through Apple. Your server
  sends each notification to Apple, so its title and a short preview of the letter pass
  through Apple. Apple's handling of this data is covered by Apple's privacy policy.
- If you turn Places on, the app asks Apple's map service for the name and address of
  each place you visit, by sending it that place's coordinates. Apple's handling of
  this data is covered by Apple's privacy policy.

**To other websites, only when your own content points there:**

- If a chat message, session, or note contains an image hosted on another website, the
  app loads that image directly from that website, which can see your IP address and
  that the image was requested. Letters from your agents never load images from other
  websites.
- An HTML file you open from your server can load the resources it refers to.
- Links you tap open in Safari, or in the App Store app for an App Store link (for
  example the link to install Tailscale in Settings).

Apart from these, the app contacts no other server, and it never contacts the Open Walnut
developers.

## Permissions

Each permission is asked for at the moment described here.

- **Camera**: asked the first time you tap Scan QR from your console on the pairing
  screen, or Take Photo in a chat, a session or a note. QR codes are read on the phone.
  A photo you take is sent to your server only when you attach it, and the app never
  saves it to your photo library.
- **Photos**: no permission. The app uses the iOS photo picker, so it only sees the
  photos you pick, and sends them to your server when you attach them.
- **Microphone**: asked the first time you start a voice recording, with the microphone
  button or with Voice to Walnut on the app's Home Screen icon. The app records only
  while a recording you started is running. It keeps recording if the screen locks or
  you switch apps, until you stop it. The audio is sent to your server for
  transcription.
- **Calendars**: asked the first time you open the calendar view. Read only, to show
  your calendar events next to your tasks. Calendar events never leave your phone: the
  diagnostic log notes only how many events a month has. The built-in demo never asks:
  it shows sample events instead.
- **Notifications**: to tell you about new letters from your agents. Optional. Asked
  the first time you open the Inbox, and only when your server is set up to send
  notifications. If it is not yet, the app asks the next time you return to it after
  your server can send. The built-in demo never asks.
- **Local network**: asked the first time the app tries to reach your Walnut directly
  on your Wi-Fi network. This can happen soon after pairing, when your server tells the
  app its Wi-Fi address. The app connects only to your own Walnut there, and does not
  look for other devices on the network. The built-in demo never asks.
- **Apple Health**: read only. Apple's permission screen can come up at three moments.
  The first is when you tap Turn On Apple Health in Settings, Apple Health. The second
  is when one of your AI agents starts reading health data in a chat or session you
  have open in the app. If Apple's permission screen still has something to ask, it
  comes up by itself, with no step in the app before it. If you already answered
  Apple's screen but Apple Health is off in the app, the app first asks "Let Walnut Use
  Apple Health?". If iOS then lets the app read nothing, the app offers a button to the
  Settings app. The third is when you tap Health Permissions in Settings, Apple Health:
  Apple's screen comes up only if it has a kind of data it has not asked you about yet
  (after an app update that adds one), and otherwise the button opens the Settings app.
  Answering Apple's screen turns Apple Health on in the app if it was off, with exactly
  the kinds you allowed, and nothing is read if you allowed none. You can change your
  choices later in the Settings app, under Privacy & Security, Health, Walnut. The App
  Store version never writes to Apple Health, and the built-in demo never asks.
- **Location**: used only for Places, which is off until you turn it on in Settings,
  Places. When you tap Turn On Places, iOS asks for location access While Using the App,
  and then asks once whether to change it to Always. iOS reports visits only with
  Always, so until Always is given Places records nothing, and the Places screen says
  so with a button to the Settings app. The app asks for Always once; after that you
  change it in the Settings app. When one of your AI agents starts reading places in a
  chat or session you have open in the app, the app asks "Turn On Places?" if Places is
  off, lets iOS ask if it has not yet, and offers a button to the Settings app if
  location access is not Always. Places uses iOS visit monitoring: iOS tells the app
  when you arrive somewhere and when you leave, also while the app is closed, from the
  moment Places is on. The app does not follow your route, and nothing from before you
  turned Places on is included. Turn Off Places in Settings, Places stops recording,
  and the phone then removes the visits your server already has. The built-in demo
  never asks: it records nothing.
- **Clipboard**: no permission. The app reads the clipboard only when you tap Paste
  pairing link, or paste into a note yourself. iOS may ask you to allow the paste.

The app never asks for your contacts, Bluetooth, motion or speech recognition. You can
change any of these permissions in the iOS Settings app at any time.

## What the app does not do

- No analytics, crash reporting services, or advertising SDKs.
- No tracking across apps or websites, and no advertising identifier.
- No selling or sharing of data with anyone.
- No account with the developers.

## Deleting your data

- **On your phone**: in the app, Settings, Disconnect removes everything the app stored
  on the phone: the server address, the device token, cached conversations, tasks, notes,
  letters and images, unsent messages and drafts, the recently opened list, recordings
  waiting for transcription, the diagnostic log, Apple Health sync progress and its
  random value, the places kept on the phone, and app preferences. It also stops Places from recording. Disconnect also asks your server to
  stop sending notifications to the phone. If the server cannot be reached at that
  moment, it keeps sending them until you revoke the phone there, as described below.
- **Deleting the app** removes what it stored on the phone, with one exception: iOS
  keeps an app's Keychain items after the app is deleted, so the device token and the
  Apple Health random value stay in the Keychain. If you install the app again, it
  removes both the first time it opens. Once you revoke the phone on your server (below), your server refuses that
  token, so the phone can no longer connect with it.
- **Apple Health on your server**: in the app, Settings, Apple Health, Delete Health
  Data on Mac removes every Apple Health record your server keeps and turns Apple Health
  off on the phone. Nothing is removed from the Health app.
- **Places on your server**: in the app, Settings, Places, Delete Places on Mac removes
  every visit your server keeps and the copy on the phone, and turns Places off. Turning
  Places off stops recording and removes from the phone the visits your server has; the
  visits on your server stay until you delete them.
- **On your server**: your data lives on the server you run, and you manage or delete it
  there. Revoking the phone, from the Devices section of your Walnut console's Settings
  or with `walnut device revoke <name>`, stops notifications to it, and your server
  refuses its token from then on, so the phone can no longer connect.

## Children

The app is not directed at children.

## Changes

If this policy changes, the new version will be published in this file, with its
history visible in the repository.

## Contact

Questions or concerns: open an issue at
https://github.com/EvanZhang008/open-walnut/issues
