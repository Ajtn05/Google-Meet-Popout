# Meet Popout

This extension brings Google Meet popouts to Firefox and Zen. Switching tabs
opens a floating video window, and returning to Meet closes it. A separate
one-click window adds microphone, camera, and leave controls. Firefox cannot
automatically open that controls window in the same way Chrome can.

## How it works

Firefox includes the difficult part already. Firefox 130 added a feature that
opens Picture-in-Picture automatically when a tab becomes hidden. The same
feature closes the window when you return to the tab. The pref is
`media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled`.
That pref is **disabled** by default. See [Required setup](#required-setup).

The feature never starts on Meet. `PictureInPictureChild.sys.mjs` shows how
Firefox selects a video when a tab becomes hidden:

```js
findVideoToPiP(doc) {
  let video = doc.activeElement;                    // 1. a focused <video> wins
  if (!HTMLVideoElement.isInstance(video)) {        // 2. else first playing one
    ...
  }
}
```

Firefox then requires both of these checks to pass:

```js
videoIsPlaying(v)     // !paused && !ended && readyState > 2
videoIsPiPEligible(v) // duration >= 45s, clientWidth/Height >= 140, v.mozHasAudio
```

Meet fails the `mozHasAudio` check. Meet's tiles are video-only
`MediaStream`s, and the audio arrives on separate elements. Therefore no Meet
video is ever eligible, and no window opens.

Firefox latches `mozHasAudio` when an element first reaches `HAVE_METADATA`.
`HTMLMediaElement::UpdateReadyStateInternal` builds the `MediaInfo` only while
`mReadyState < HAVE_METADATA`. An audio track added to Meet's own `<video>`
after that moment has no effect.

Therefore this extension keeps its own **shadow `<video>`** element. The
element has these properties:

- Its `MediaStream` holds the current speaker's video track and **a silent
  audio track that is present from the start**. `mozHasAudio` therefore
  latches true.
- Its layout size is 144x144 px, which passes the 140 px minimum. Its opacity
  is 0.01 and it sits behind all other content, so you never see it.
  Picture-in-Picture renders the decoded frames and ignores the CSS, so the
  floating window looks normal.
- Elements backed by a `MediaStream` report `duration === Infinity`. The
  45-second minimum therefore passes.

When the tab becomes hidden, the extension focuses that element, and
`findVideoToPiP` selects it. The extension restores your previous focus when
you return. Firefox does the rest of the work, and Firefox closes the window
when you return.

The shadow element satisfies the real eligibility rules. Therefore you do not
need to relax those rules in `about:config`, and other sites behave normally.
You must still enable the auto-PiP pref. See [Required
setup](#required-setup).

### Keeping the window above other applications

Firefox creates the Picture-in-Picture window with the `alwaysontop` chrome
flag (`PLAYER_FEATURES` in `PictureInPicture.sys.mjs`). The window therefore
floats above other applications after it opens.

The difficulty is to make the window open. Firefox starts auto-PiP when the
tab's document becomes *hidden*. A switch to another application hides
nothing, because the meeting is still the selected tab.

When Firefox loses focus, the extension opens a small placeholder tab in front
of the meeting. The extension detects the focus loss through
`windows.onFocusChanged` when it reports no focused window. The extension
waits 400 ms first, to ignore moves between two Firefox windows. The
placeholder tab deselects the Meet tab. This hides the Meet document, and
Firefox's own auto-PiP does the rest.

When Firefox regains focus, the extension reselects the meeting and closes the
placeholder. That closure is the signal that returns the video to the page.

This is a workaround and not a supported hook. It is therefore a separate,
optional switch in the toolbar popup and is off by default. Turn it on only if
you want the meeting to keep floating after you leave Firefox.

## Required setup

Automatic video PiP requires Firefox's auto-PiP setting. Firefox disables it
by default. `browser/app/profile/firefox.js` sets:

```
pref("media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled", false);
```

Open `about:config` and set this pref before using automatic mode:

```
media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled = true
```

The same setting is available in Settings -> General -> Browsing. The one-click
controls window works without this setting.

## Install

The extension needs Firefox 140 or newer. The controls popout needs Firefox
151 or newer, because it uses the Document Picture-in-Picture API. The
automatic mode works on earlier versions. Firefox 130 added the auto-PiP
feature. The manifest minimum is 140 only because addons.mozilla.org now
requires the `data_collection_permissions` key.

### Temporary install (works immediately, removed on restart)

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on...**
3. Select the `manifest.json` file in this folder

### Permanent install

Firefox and Zen install signed extensions only. You have two options.

- **Sign the extension for yourself (free).** Create an addons.mozilla.org
  account, then run:
  ```bash
  npx web-ext sign --channel=unlisted --api-key=<JWT issuer> --api-secret=<JWT secret>
  ```
  This command writes a signed `.xpi` file to `web-ext-artifacts/`. That file
  installs permanently and updates itself. It stays private to you, because
  addons.mozilla.org does not publish unlisted add-ons.

- **Or disable signature enforcement**, if your build permits it. Set
  `xpinstall.signatures.required` to `false` in `about:config`. Then install
  the zipped folder as an `.xpi` file. Release Firefox ignores this pref.
  Unbranded builds such as Zen generally honour it, but verify this on your
  own install.

## Use

Join a meeting, then switch to another tab. By default the popout shows the
largest visible participant or presentation tile outside your self-view.
Switch back to the meeting tab and the video returns to the page.

Click the toolbar icon to choose what the popout shows. The choice is presented
as four source cards so its fallback behaviour is visible before you leave the
meeting:

- **Meeting stage** (default) selects another participant or a presentation
  before your self-view.
- **Shared screen** shows a presenter's screen. It shows the meeting stage
  when no person presents.
- **My camera** shows your self-view.
- **Largest video tile** shows the largest visible tile.

The extension saves your choice. It selects the automatic video popout and the
stage view in the controls window. The controls window opens in a participant
gallery by default. Screen-share detection uses the media
track's display-capture data and, when Firefox does not retain it for a remote
participant, the track label as a fallback.

## If no popout appears

For automatic video PiP, check the required pref above first. Firefox disables
it by default. The one-click controls window does not depend on this pref.

The popup shows **"Ready (fallback mode)"** if the extension could not make
the shadow element playable. The extension then focuses Meet's real video
instead. That method works only if you relax Firefox's eligibility check:

1. Open `about:config`
2. Set `media.videocontrols.picture-in-picture.video-toggle.always-show` to
   `true`

This pref makes Firefox omit the checks completely. **Other sites then open
popouts on a tab switch**, including background videos that play
automatically. This is a fallback and not the intended path.

## Controls: Chrome's method, and what transfers to Firefox

Chrome's Meet popout does not use Firefox's video player. It uses two separate
mechanisms:

1. **The Document Picture-in-Picture API.**
   `documentPictureInPicture.requestWindow()` opens an always-on-top window
   that contains a real document. Meet puts its own video tiles and buttons in
   that document. The buttons therefore work.
2. **Auto Picture-in-Picture for conferencing.** This is a Chrome permission.
   Chrome grants it automatically to sites that use the camera or the
   microphone, and exposes it as an `enterpictureinpicture` MediaSession
   action. On a tab switch, Chrome sends that action and permits the page to
   call `requestWindow()` *without* user activation.

Firefox has the first mechanism and not the second. Firefox 151 added Document
PiP (`dom.documentpip.enabled`, with `value: true` on desktop in
`StaticPrefList.yaml`). Gecko's `MediaSessionAction` enum contains only these
actions:

```
"play", "pause", "seekbackward", "seekforward",
"previoustrack", "nexttrack", "skipad", "seekto", "stop"
```

The enum has no `enterpictureinpicture` action. Also, `requestWindow()` throws
`NotAllowedError` without transient activation.

This difference is the reason the extension has two popout modes. No single
mode is both automatic and fully controllable.

| | Opens by itself | Real Meet buttons |
| --- | --- | --- |
| **With controls** (Document PiP) | No. Needs one click. | Yes |
| **Automatic** (Firefox video PiP) | Yes, on a tab switch; app switches are optional | Mute only |

### With controls

Click the **Pop out** button in the meeting. It is shown by default and can be
hidden from the toolbar popup. The window shows up to four participant tiles,
including live cameras and profile photos or initials when cameras are off.
The gallery button switches between those tiles and the selected stage video.
When more than four tiles are visible, the window shows a count of the others.
Microphone, camera, and hang-up buttons control the meeting; the first two
show Meet's real state. The controls window stays open through tab switches and
application switches. This mode replaces the
automatic mode, so the shadow element and the placeholder tab are both
inactive while the window is open.

The controls window can also open before Meet has a visible video tile. It
shows any available participant profiles, or a waiting message until a tile
appears. The gallery is limited to participants whose tiles Meet currently
renders in the page.

The window inherits Meet's Content Security Policy. The extension therefore
builds the window's interface through the CSSOM instead of `<style>` elements,
because a strict `style-src` rejects those elements.

### Automatic

This mode needs no click, but Firefox's video PiP can show only one video
source, so it cannot display the participant gallery or profile photos. Its
mute button still
controls your microphone. Firefox calls `setMuted()`. With no site wrapper
present, that call sets `video.muted` on the shadow element, and the content
script receives a `volumechange` event. The extension maps the state in both
directions. It also watches the full Meet controls subtree, so the link
survives a Meet control re-render while the tab is hidden. The shadow starts in
the current Meet mute state rather than always starting muted.

The camera and hang-up actions are keyboard shortcuts. Set them in Add-ons ->
gear icon -> Manage Extension Shortcuts.

| Action | Default (macOS) |
| --- | --- |
| Toggle microphone | `Ctrl+Shift+M` |
| Toggle camera | `Ctrl+Shift+V` |
| Leave the call | Unassigned by default |

The shortcuts work while Firefox has focus, including after you click the
floating window. They do not work while another application has focus, because
an extension cannot register OS-global hotkeys without a native messaging
host.

## Known limitations

- **Keeping the popout open after an application switch parks a placeholder
  tab.** No better method exists (see above). The optional switch is off by
  default. If you enable it, you see an extra tab in the tab strip while you
  are away.
- **If you change tabs while you are away**, Firefox leaves you on the tab you
  selected when you return. It does not return you to the meeting. The
  placeholder tab still closes.
- **The controls popout cannot open itself.** Firefox has no equivalent of
  Chrome's auto picture-in-picture permission, so the popout needs one click
  for each meeting. The window then stays open. The cost is one click for each
  meeting.
- **The search for Meet's buttons is best-effort.** Meet's markup is
  obfuscated and its labels are localised, so the matching in
  `CONTROL_MATCHERS` may need changes. The popup names each control that it
  could not find. This part is untested against a live meeting.
- **Meeting stage** selects the largest visible tile that is not mirrored.
  Meet can change its markup, or it can stop marking a self-view as mirrored
  in an unusual layout. If that happens, select **My camera**, **Shared
  screen**, or **Largest video tile** in the toolbar popup.
- **Automatic video PiP follows Meet's visible stage tile.** The extension
  checks for changes while the tab is hidden and swaps the video track when
  Meet changes the stage. Meet's internal active-speaker signal is not exposed,
  so this is based on the tile layout rather than that signal.

## Layout

```
manifest.json      MV3 manifest
src/content.js     shadow element and focus handling (the core mechanism)
src/participant-tiles.js  visible participant and profile discovery
src/background.js  placeholder tab for application switches
src/parked.html    the placeholder tab
src/popup.html     toolbar popup
src/popup.js       status and switches
icons/icon.svg
```

Run `node --test tests/*.test.js` to check the state and participant-selection logic.
